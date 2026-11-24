import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./scripts/pi-plugins", import.meta.url));
const extensionPath = fileURLToPath(import.meta.url);
const actions = {
  add: "Скачать и подключить",
  local: "Только для меня",
  list: "Плагины в .pi",
  "setup-local": "Подключить личный список к обычному pi",
  update: "Обновить источник",
  commands: "Команды",
  help: "Справка",
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

  async function updateSource(ctx: ExtensionCommandContext, name: string, sourceArgs: string[]) {
    ctx.ui.notify(`Обновляю ${name}…`, "info");
    await run(ctx, "update", ...sourceArgs);
    ctx.ui.notify(`Обновлено: ${name}.`, "info");
    if (ctx.isProjectTrusted()) await ctx.reload();
  }

  async function setupLocal(ctx: ExtensionCommandContext) {
    if (!await ctx.ui.confirm("Подключить личные плагины к команде pi?",
      "Однократно добавим обёртку в PATH через .bashrc или .zshrc. Бинарник Pi и .pi/settings.json не меняются.")) return false;
    await run(ctx, "setup-local");
    return true;
  }

  pi.registerCommand("plugin", {
    description: "Плагины Pi",
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
        const verb = requested.toLowerCase();
        let action: Action | "launcher" | undefined = verb === "personal" || verb === "-l" ? "local" : verb === "launcher" ? "launcher" :
          actionNames.find((name) => name === verb);
        if (requested && !action) {
          ctx.ui.notify(`Неизвестное действие: ${requested}. Список: /plugin help.`, "warning");
          return;
        }
        if (action === "add" ? params.length > 2 : params.length > 0) {
          ctx.ui.notify(`Использование: ${action === "add" ? addUsage : `/plugin ${action}`}`, "warning");
          return;
        }
        // Help and command discovery use the current session, not the Git catalog.
        const sources: Record<string, string> = action === "help" || action === "commands" || action === "launcher" || action === "setup-local"
          ? {} : JSON.parse(await run(ctx, "sources"));
        const aliases = Object.keys(sources).sort();
        if (!action) {
          const menu: Action[] = aliases.length
            ? ["local", "update", "add", "commands", "list", "help"]
            : ["add", "commands", "help"];
          const selected = await ctx.ui.select("Плагины Pi", menu.map((name) => actions[name]));
          action = menu.find((name) => actions[name] === selected);
          if (!action) return;
        }
        if (action === "help") {
          ctx.ui.notify(["/plugin — открыть меню", ...actionNames.map((name) =>
            `${name === "add" ? addUsage : name === "local" ? "/plugin local (или /plugin -l)" : `/plugin ${name}`} — ${actions[name]}`)].join("\n"), "info");
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
        if (action === "setup-local") {
          if (await setupLocal(ctx)) ctx.ui.notify("Готово. Откройте новый терминал и запускайте обычный pi.", "info");
          return;
        }
        if (action === "launcher") {
          const path = (await run(ctx, "install-launcher")).trim();
          ctx.ui.notify(`${path} готов. Запускайте Pi из проекта командой pi-with-plugins.`, "info");
          return;
        }
        const adding = action === "add";
        let alias: string | undefined;
        if (adding) {
          const input = params[0] ?? (await ctx.ui.input("Git-адрес поставки", "git@github.com:team/tools.git"))?.trim();
          if (!input) return;
          ctx.ui.notify("Скачиваю Git-источник…", "info");
          const nameArgs = params[1] ? ["--", params[1]] : [];
          alias = (await run(ctx, "source-add", `--source=${input}`, ...nameArgs)).trim();
          const registered: Record<string, string> = JSON.parse(await run(ctx, "sources"));
          sources[alias] = registered[alias];
        } else {
          if (!aliases.length) {
            ctx.ui.notify("Нет Git-источников. Добавьте первый через /plugin add.", "info");
            return;
          }
          if (action === "list" && !ctx.isProjectTrusted()) {
            ctx.ui.notify("Чтобы изменить плагины проекта, сначала разрешите его настройки через /trust.", "warning");
            return;
          }
          alias = aliases.length === 1 ? aliases[0] : await ctx.ui.select("Выберите Git-источник", aliases);
          if (!alias) return;
        }
        const sourceArgs = ["--source", sources[alias]];
        if (action === "update") {
          await updateSource(ctx, alias, sourceArgs);
          return;
        }

        const { checkout, plugins, rootPlugin }: Catalog = JSON.parse(await run(ctx, "catalog", ...sourceArgs));
        const personal = adding || action === "local";
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
          `${label(name)} — ${connected.has(name) ? (available.has(name) ? "установлен" : "нет в источнике") : "доступен"}`,
          name,
        ]));
        const plugin = adding && names.length === 1 && !connected.has(names[0]) ? names[0] :
          options.get(await ctx.ui.select(`${alias} · ${basename(ctx.cwd)}${personal ? " · лично" : ""}`, [...options.keys()]) ?? "");
        if (!plugin) return;
        const name = label(plugin);
        const installed = connected.has(plugin);
        if (installed) {
          const action = await ctx.ui.select(name, ["Обновить", "Удалить"]);
          if (action === "Обновить") {
            await updateSource(ctx, name, sourceArgs);
            return;
          }
          if (action !== "Удалить") return;
        } else if (!await ctx.ui.confirm(`Установить ${name}?`, "Код плагина запускается с правами Pi.")) {
          return;
        }
        const notice = `${installed ? "Удалено" : "Установлено"}: ${name}.`;
        if (personal) {
          let next = "Перезапустите обычный pi.";
          if (!installed) {
            const status = (await run(ctx, "launcher-status")).trim();
            if (status === "needs-setup") {
              next = await setupLocal(ctx) ? "Откройте новый терминал и запустите обычный pi." :
                "Для запуска обычным pi выполните /plugin setup-local.";
            } else if (status === "configured") {
              next = "Запустите обычный pi заново (в новом терминале, если он открыт до настройки).";
            } else {
              next = "Для этой оболочки подключите /plugin launcher или настройте обёртку в bash/zsh.";
            }
          }
          await run(ctx, installed ? "personal-remove" : "personal-add", plugin, ...sourceArgs);
          ctx.ui.notify(`${notice} ${next}`, "info");
          return;
        }
        // The child CLI does not inherit the active session's project-trust decision.
        await run(ctx, installed ? "remove" : "install", plugin, ...sourceArgs, "--approve");
        ctx.ui.notify(notice, "info");
        await ctx.reload();
      } catch (error) {
        ctx.ui.notify(`/plugin: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
