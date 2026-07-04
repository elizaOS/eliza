/**
 * Runtime (un)loader for built plugins that live in an on-disk package
 * directory: it resolves the directory's built JS entry (an explicit relative
 * path, or package.json `module`/`main`/`exports["."]` falling back to
 * `dist/index.js`), guards that entry against escaping the plugin directory
 * (including through a symlink), dynamically imports and registers it, and
 * tracks the loaded set so it can later be unloaded. Built JS only — never a
 * build step. Disk-directory sibling of `load-plugin-from-vfs.ts`, whose
 * `extractPlugin` module→Plugin resolver it reuses.
 */
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentRuntime, Plugin } from "@elizaos/core";
import { extractPlugin } from "./load-plugin-from-vfs.ts";

/**
 * Live-load a plugin from an on-disk directory into the running runtime.
 *
 * This is the disk-directory counterpart to {@link loadPluginFromVfs}: it
 * resolves the directory's built entry point, dynamically imports it, and
 * registers the plugin via `runtime.registerPlugin` — which (through the
 * runtime plugin-lifecycle wrapper) also registers any `Plugin.views` so a
 * freshly scaffolded/edited view plugin actually shows up in the catalog
 * without an agent restart.
 *
 * It is intentionally NOT a build step: the caller (e.g. the VIEWS/APP create
 * verification pipeline) is expected to have compiled the plugin already, so
 * the entry must point at built JS, not TS source.
 */

export interface LoadPluginFromDirectoryOptions {
  runtime: AgentRuntime;
  /** Absolute path to the plugin's package directory. */
  directory: string;
  /**
   * Explicit entry file relative to `directory`. When omitted the loader reads
   * package.json (`module` → `main` → `exports["."]`) and falls back to
   * `dist/index.js`.
   */
  entry?: string;
}

export interface LoadedDirectoryPlugin {
  pluginName: string;
  directory: string;
  diskPath: string;
  loadedAt: number;
}

const loadedPlugins = new Map<string, LoadedDirectoryPlugin>();

function asRelativeEntry(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    return null;
  }
  // Only built JS is loadable here; ignore a TS `main` left over from source.
  if (value.endsWith(".ts") || value.endsWith(".tsx")) return null;
  return value;
}

function assertPathInsideDirectory(directory: string, file: string): void {
  const relative = path.relative(directory, file);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `loadPluginFromDirectory: entry must stay inside plugin directory (${path.relative(
        process.cwd(),
        file,
      )})`,
    );
  }
}

async function resolveEntryFile(
  directory: string,
  explicitEntry?: string,
): Promise<string> {
  const realDirectory = await realpath(directory);
  if (explicitEntry) {
    const relativeEntry = asRelativeEntry(explicitEntry);
    if (!relativeEntry) {
      throw new Error(
        "loadPluginFromDirectory: explicit entry must be a relative built JavaScript path inside the plugin directory",
      );
    }
    const entry = await realpath(path.resolve(realDirectory, relativeEntry));
    assertPathInsideDirectory(realDirectory, entry);
    return entry;
  }

  const candidates: string[] = [];
  const pkgRaw = await readFile(
    path.join(realDirectory, "package.json"),
    "utf8",
  ).catch(() => null);
  if (pkgRaw) {
    let pkg: Record<string, unknown> | null = null;
    try {
      pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
    } catch {
      pkg = null;
    }
    if (pkg) {
      const fromModule = asRelativeEntry(pkg.module);
      const fromMain = asRelativeEntry(pkg.main);
      const exportsField = pkg.exports;
      let fromExports: string | null = null;
      if (exportsField && typeof exportsField === "object") {
        const dot = (exportsField as Record<string, unknown>)["."];
        if (typeof dot === "string") fromExports = asRelativeEntry(dot);
        else if (dot && typeof dot === "object") {
          const rec = dot as Record<string, unknown>;
          fromExports =
            asRelativeEntry(rec.import) ??
            asRelativeEntry(rec.default) ??
            asRelativeEntry(rec.require);
        }
      }
      for (const c of [fromModule, fromMain, fromExports]) {
        if (c) candidates.push(path.resolve(realDirectory, c));
      }
    }
  }
  candidates.push(path.resolve(realDirectory, "dist/index.js"));

  for (const candidate of candidates) {
    const entry = await realpath(candidate).catch(() => null);
    if (!entry) continue;
    assertPathInsideDirectory(realDirectory, entry);
    const exists = await readFile(entry)
      .then(() => true)
      .catch(() => false);
    if (exists) return entry;
  }
  throw new Error(
    `loadPluginFromDirectory: no built entry found in ${realDirectory} (looked for ${candidates
      .map((c) => path.relative(realDirectory, c))
      .join(", ")}). Build the plugin first.`,
  );
}

/**
 * Import a built plugin directory and register it with the runtime. Returns the
 * registered plugin name. Re-loading the same directory re-imports a fresh
 * module (cache-busted) so an edited+rebuilt plugin hot-reloads.
 */
export async function loadPluginFromDirectory(
  options: LoadPluginFromDirectoryOptions,
): Promise<{ pluginName: string; loaded: true }> {
  const { runtime, directory } = options;
  if (typeof runtime.registerPlugin !== "function") {
    throw new Error(
      "loadPluginFromDirectory: runtime.registerPlugin is not available — ensure installRuntimePluginLifecycle has run",
    );
  }

  const diskPath = await resolveEntryFile(directory, options.entry);
  // `?t=` cache-busts Node's ESM loader so a rebuild reloads the module.
  const moduleUrl = `${pathToFileURL(diskPath).href}?t=${Date.now()}`;
  const mod = (await import(moduleUrl)) as Record<string, unknown>;

  const plugin: Plugin | null = extractPlugin(mod);
  if (!plugin) {
    throw new Error(
      `loadPluginFromDirectory: no valid plugin export in ${diskPath} (expected a default export, a named \`plugin\` export, or a module with a string \`name\`)`,
    );
  }

  await runtime.registerPlugin(plugin);

  loadedPlugins.set(plugin.name, {
    pluginName: plugin.name,
    directory: await realpath(directory),
    diskPath,
    loadedAt: Date.now(),
  });

  return { pluginName: plugin.name, loaded: true };
}

export interface UnloadPluginFromDirectoryOptions {
  runtime: AgentRuntime;
  pluginName: string;
}

/**
 * Unload a plugin previously registered via {@link loadPluginFromDirectory}.
 * Delegates to the runtime's `unloadPlugin` (installed by the lifecycle
 * wrapper), which also deregisters the plugin's views.
 */
export async function unloadPluginFromDirectory(
  options: UnloadPluginFromDirectoryOptions,
): Promise<{ pluginName: string; unloaded: boolean }> {
  const { runtime, pluginName } = options;
  const runtimeWithLifecycle = runtime as AgentRuntime & {
    unloadPlugin?: (
      name: string,
    ) => Promise<{ pluginName: string } | null | undefined>;
  };
  if (typeof runtimeWithLifecycle.unloadPlugin !== "function") {
    throw new Error(
      "unloadPluginFromDirectory: runtime.unloadPlugin is not available — ensure installRuntimePluginLifecycle has run",
    );
  }
  const result = await runtimeWithLifecycle.unloadPlugin(pluginName);
  loadedPlugins.delete(pluginName);
  return { pluginName, unloaded: result != null };
}

/** Read-only view of plugins currently tracked as loaded from a directory. */
export function getLoadedDirectoryPlugins(): readonly LoadedDirectoryPlugin[] {
  return [...loadedPlugins.values()];
}

/** Test helper — clears the in-memory tracking map. */
export function _resetLoadedDirectoryPluginsForTests(): void {
  loadedPlugins.clear();
}
