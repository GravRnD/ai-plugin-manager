import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./scripts/pi-plugins", import.meta.url));
const extensionPath = fileURLToPath(import.meta.url);
const actions = {
  add: "Добавить Git-источник",
  personal: "Личные плагины проекта (вне репозитория)",
  list: "Плагины проекта (.pi/settings.json)",
  launcher: "Подключить запуск pi-with-plugins",
  update: "Обновить Git-источник",
  commands: "Команды подключённых пакетов",
  help: "Справка по /plugin",
};
type Action = keyof typeof actions;
const actionNames = Object.keys(actions) as Action[];
const addUsage = "/plugin add [Git-адрес] [имя]";

type Catalog = { checkout: string; plugins: string[]; rootPlugin?: string };

async function connectedPlugins(cwd: string, checkout: string): Promise<Set<string>> {
  const folder = join(cwd, CONFIG_DIR_NAME);
  const names = new Set<string>();
  let content: string;
  try {
    content = await readFile(join(folder, "settings.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return names;
    throw error;
  }
  const packages = JSON.parse(content)?.packages;
  if (!Array.isArray(packages)) return names;
  const root = resolve(checkout);
  for (const entry of packages) {
    const source = typeof entry === "string" ? entry : entry?.source;
    if (typeof source !== "string") continue;
    const path = source.startsWith("~/") ? resolve(homedir(), source.slice(2)) : resolve(folder, source);
    if (path === root) {
      names.add(".");
    } else if (dirname(path) === root && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(basename(path))) {
      names.add(basename(path));
    }
  }
  return names;
}

export default function (pi: ExtensionAPI) {
  async function run(ctx: ExtensionCommandContext, ...args: string[]): Promise<string> {
    const result = await pi.exec("python3", [script, ...args], { cwd: ctx.cwd, timeout: 120_000, maxBuffer: 256 * 1024 });
    if (result.code !== 0) {
      const message = result.killed ? "Команда не завершилась. Проверьте доступ к Git и SSH." :
        result.stderr.trim() || result.stdout.trim() || `код выхода ${result.code}`;
      throw new Error(message);
    }
    return result.stdout;
  }

  pi.registerCommand("plugin", {
    description: "Меню плагинов Pi · add, personal, list, launcher, update, commands, help",
    getArgumentCompletions: (prefix) => {
      const matches = actionNames.filter((name) => name.startsWith(prefix.trimStart().toLowerCase()));
      return matches.length ? matches.map((name) => ({
        value: name, label: name, description: name === "add" ? `${actions.add} · [Git-адрес] [имя]` : actions[name],
      })) : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if (!ctx.isIdle()) {
        ctx.ui.notify("Дождитесь окончания текущего запроса, затем откройте /plugin.", "warning");
        return;
      }
      try {
        const [requested, ...params] = args.trim().split(/\s+/);
        let action = actionNames.find((name) => name === requested.toLowerCase());
        if (requested && !action) {
          ctx.ui.notify(`Неизвестное действие: ${requested}. Список: /plugin help.`, "warning");
          return;
        }
        if (action === "add" ? params.length > 2 : params.length > 0) {
          ctx.ui.notify(`Использование: ${action === "add" ? addUsage : `/plugin ${action}`}`, "warning");
          return;
        }
        // Help and command discovery use the current session, not the Git catalog.
        const sources: Record<string, string> = action === "help" || action === "commands" || action === "launcher"
          ? {} : JSON.parse(await run(ctx, "sources"));
        const aliases = Object.keys(sources).sort();
        if (!action) {
          const menu: Action[] = aliases.length
            ? ["personal", "update", "add", "commands", "launcher", "list", "help"]
            : ["add", "commands", "launcher", "help"];
          const selected = await ctx.ui.select("Плагины Pi", menu.map((name) => actions[name]));
          action = menu.find((name) => actions[name] === selected);
          if (!action) return;
        }
        if (action === "help") {
          ctx.ui.notify(["/plugin — открыть меню", ...actionNames.map((name) =>
            `${name === "add" ? addUsage : `/plugin ${name}`} — ${actions[name]}`)].join("\n"), "info");
          return;
        }
        if (action === "commands") {
          const items = pi.getCommands()
            .filter((command) => command.sourceInfo.origin === "package" && command.sourceInfo.path !== extensionPath)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((command) => [command.description ? `/${command.name} — ${command.description}` : `/${command.name}`, `/${command.name}`] as const);
          if (!items.length) {
            ctx.ui.notify("В текущей сессии нет команд от подключённых пакетов.", "info");
            return;
          }
          const selected = await ctx.ui.select(actions.commands, items.map(([label]) => label));
          const command = items.find(([label]) => label === selected)?.[1];
          if (command) ctx.ui.setEditorText(`${command} `);
          return;
        }
        if (action === "launcher") {
          const path = (await run(ctx, "install-launcher")).trim();
          ctx.ui.notify(`${path} готов. Запускайте Pi из проекта командой pi-with-plugins.`, "info");
          return;
        }
        if (action === "add") {
          const input = params[0] ?? (await ctx.ui.input("Git-адрес поставки", "git@host:team/tools.git"))?.trim();
          if (!input) return;
          ctx.ui.notify("Скачиваю Git-источник…", "info");
          const alias = params[1] ? ["--", params[1]] : [];
          const name = (await run(ctx, "source-add", `--source=${input}`, ...alias)).trim();
          ctx.ui.notify(`Источник ${name} добавлен. Откройте /plugin personal, чтобы выбрать личные плагины проекта.`, "info");
          return;
        }

        if (!aliases.length) {
          ctx.ui.notify("Нет Git-источников. Добавьте первый через /plugin add.", "info");
          return;
        }
        if (action === "list" && !ctx.isProjectTrusted()) {
          ctx.ui.notify("Чтобы изменить плагины проекта, сначала разрешите его настройки через /trust.", "warning");
          return;
        }
        const alias = aliases.length === 1 ? aliases[0] : await ctx.ui.select("Выберите Git-источник", aliases);
        if (!alias) return;
        const sourceArgs = ["--source", sources[alias]];
        if (action === "update") {
          ctx.ui.notify(`Обновляю ${alias}…`, "info");
          await run(ctx, "update", ...sourceArgs);
          ctx.ui.notify(`${alias} обновлён. В других открытых проектах используйте /reload.`, "info");
          if (ctx.isProjectTrusted()) await ctx.reload();
          return;
        }

        const { checkout, plugins, rootPlugin }: Catalog = JSON.parse(await run(ctx, "catalog", ...sourceArgs));
        const personal = action === "personal";
        const connected = personal
          ? new Set<string>((JSON.parse(await run(ctx, "personal")) as Record<string, string[]>)[sources[alias]] ?? [])
          : await connectedPlugins(ctx.cwd, checkout);
        const available = new Set(plugins);
        if (rootPlugin) available.add(".");
        const names = [...new Set([...available, ...connected])].sort();
        const label = (name: string) => name === "." ? rootPlugin ?? "корневой пакет" : name;
        if (names.length === 0) {
          ctx.ui.notify(`В ${alias} нет плагинов.`, "info");
          return;
        }
        const options = new Map(names.map((name) => [
          `${label(name)} — ${connected.has(name) ? (available.has(name) ? "подключён" : "подключён, убран из поставки") : "доступен"}`,
          name,
        ]));
        const choice = await ctx.ui.select(`${alias} · ${basename(ctx.cwd)}${personal ? " · лично" : ""}`, [...options.keys()]);
        const plugin = choice ? options.get(choice) : undefined;
        if (!plugin) return;
        const removing = connected.has(plugin);
        const confirmed = await ctx.ui.confirm(
          removing ? `Отключить ${label(plugin)}?` : `Подключить ${label(plugin)}?`,
          personal
            ? "Личный выбор для проекта, без изменений .pi/settings.json. Расширения запускаются с правами Pi."
            : removing ? "Только для текущего проекта." : "Только для текущего проекта. Расширения запускаются с правами Pi.",
        );
        if (!confirmed) return;
        if (personal) {
          await run(ctx, removing ? "personal-remove" : "personal-add", plugin, ...sourceArgs);
          ctx.ui.notify(`${label(plugin)}: ${removing ? "отключён" : "подключён"} лично. Запустите pi-with-plugins из проекта, чтобы применить выбор.`, "info");
          return;
        }
        // The child CLI does not inherit the active session's project-trust decision.
        await run(ctx, removing ? "remove" : "install", plugin, ...sourceArgs, "--approve");
        ctx.ui.notify(`${label(plugin)}: ${removing ? "отключён" : "подключён"} в текущем проекте.`, "info");
        await ctx.reload();
      } catch (error) {
        ctx.ui.notify(`/plugin: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
