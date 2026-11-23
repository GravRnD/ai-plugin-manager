import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./scripts/pi-plugins", import.meta.url));
const actions = {
  add: "Добавить Git-источник",
  plugins: "Плагины текущего проекта",
  update: "Обновить Git-источник",
};

type Catalog = { checkout: string; plugins: string[] };

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
    if (dirname(path) === root && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(basename(path))) {
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
    description: "Git-источники плагинов: добавить, обновить, подключить к текущему проекту",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      if (!ctx.isIdle()) {
        ctx.ui.notify("Дождитесь окончания текущего запроса, затем откройте /plugin.", "warning");
        return;
      }
      try {
        const sources: Record<string, string> = JSON.parse(await run(ctx, "sources"));
        const aliases = Object.keys(sources).sort();
        const action = await ctx.ui.select("Плагины Pi", aliases.length ? [actions.plugins, actions.update, actions.add] : [actions.add]);
        if (!action) return;
        if (action === actions.add) {
          const url = (await ctx.ui.input("Git-адрес поставки", "git@host:team/tools.git"))?.trim();
          if (!url) return;
          const name = (await ctx.ui.input("Короткое имя источника", "team-tools"))?.trim();
          if (!name) return;
          ctx.ui.notify(`Скачиваю источник ${name}…`, "info");
          await run(ctx, "source-add", name, "--source", url);
          ctx.ui.notify(`Источник ${name} добавлен. Откройте /plugin → «${actions.plugins}».`, "info");
          return;
        }

        if (action === actions.plugins && !ctx.isProjectTrusted()) {
          ctx.ui.notify("Чтобы изменить плагины проекта, сначала разрешите его настройки через /trust.", "warning");
          return;
        }
        const alias = aliases.length === 1 ? aliases[0] : await ctx.ui.select("Выберите Git-источник", aliases);
        if (!alias) return;
        const sourceArgs = ["--source", sources[alias]];
        if (action === actions.update) {
          ctx.ui.notify(`Обновляю ${alias}…`, "info");
          await run(ctx, "update", ...sourceArgs);
          ctx.ui.notify(`${alias} обновлён. В других открытых проектах используйте /reload.`, "info");
          if (ctx.isProjectTrusted()) await ctx.reload();
          return;
        }

        const { checkout, plugins }: Catalog = JSON.parse(await run(ctx, "catalog", ...sourceArgs));
        const connected = await connectedPlugins(ctx.cwd, checkout);
        const available = new Set(plugins);
        const names = [...new Set([...plugins, ...connected])].sort();
        if (names.length === 0) {
          ctx.ui.notify(`В ${alias} нет плагинов.`, "info");
          return;
        }
        const options = new Map(names.map((name) => [
          `${name} — ${connected.has(name) ? (available.has(name) ? "подключён" : "подключён, убран из поставки") : "доступен"}`,
          name,
        ]));
        const choice = await ctx.ui.select(`${alias} · ${basename(ctx.cwd)}`, [...options.keys()]);
        const plugin = choice ? options.get(choice) : undefined;
        if (!plugin) return;
        const removing = connected.has(plugin);
        const confirmed = await ctx.ui.confirm(
          removing ? `Отключить ${plugin}?` : `Подключить ${plugin}?`,
          removing ? "Только для текущего проекта." : "Только для текущего проекта. Расширения запускаются с правами Pi.",
        );
        if (!confirmed) return;
        // The child CLI does not inherit the active session's project-trust decision.
        await run(ctx, removing ? "remove" : "install", plugin, ...sourceArgs, "--approve");
        ctx.ui.notify(`${plugin}: ${removing ? "отключён" : "подключён"} в текущем проекте.`, "info");
        await ctx.reload();
      } catch (error) {
        ctx.ui.notify(`/plugin: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
