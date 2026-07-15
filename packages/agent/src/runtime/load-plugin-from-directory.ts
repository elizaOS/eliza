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
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AgentRuntime,
  ElizaError,
  getViewModalities,
  type Plugin,
} from "@elizaos/core";
import { bindPluginPackageDirectory, getView } from "../api/views-registry.ts";
import { extractPlugin } from "./load-plugin-from-vfs.ts";
import { installRuntimePluginLifecycle } from "./plugin-lifecycle.ts";

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
let moduleImportNonce = 0;
const requireFromAgent = createRequire(import.meta.url);

function isContainedPath(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isUnavailableAssetError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  return (
    typeof code === "string" && ["ENOENT", "ENOTDIR", "EISDIR"].includes(code)
  );
}

async function importFreshPluginModule(
  diskPath: string,
  directory: string,
): Promise<Record<string, unknown>> {
  if (process.versions.bun) {
    // Bun currently keys ESM compilation by disk path even when import() gets a
    // unique query string. Its interoperable require cache is invalidatable, so
    // clear the package graph and reload through that API on Bun-based hosts.
    for (const cachedPath of Object.keys(requireFromAgent.cache)) {
      if (isContainedPath(directory, cachedPath)) {
        delete requireFromAgent.cache[cachedPath];
      }
    }
    return requireFromAgent(diskPath) as Record<string, unknown>;
  }

  const moduleUrl = `${pathToFileURL(diskPath).href}?t=${Date.now()}-${moduleImportNonce++}`;
  return (await import(moduleUrl)) as Record<string, unknown>;
}

async function isUsableLocalViewAsset(
  directory: string,
  declaredPath: unknown,
): Promise<boolean> {
  if (typeof declaredPath !== "string" || declaredPath.trim().length === 0) {
    return false;
  }

  const candidate = path.resolve(directory, declaredPath);
  if (!isContainedPath(directory, candidate)) return false;

  let realAsset: string;
  try {
    realAsset = await realpath(candidate);
  } catch (error) {
    // error-policy:J3 a missing or non-file replacement asset is an explicit
    // invalid candidate; other I/O failures remain observable.
    if (isUnavailableAssetError(error)) return false;
    throw new ElizaError(
      "loadPluginFromDirectory: failed to inspect a declared view asset",
      {
        code: "PLUGIN_DIRECTORY_VIEW_ASSET_INSPECTION_FAILED",
        cause: error,
        context: { directory, declaredPath },
      },
    );
  }
  if (!isContainedPath(directory, realAsset)) return false;

  try {
    return (await readFile(realAsset)).byteLength > 0;
  } catch (error) {
    // error-policy:J3 directories and paths that disappear during preflight are
    // invalid candidates, while permission/device failures are surfaced.
    if (isUnavailableAssetError(error)) return false;
    throw new ElizaError(
      "loadPluginFromDirectory: failed to read a declared view asset",
      {
        code: "PLUGIN_DIRECTORY_VIEW_ASSET_INSPECTION_FAILED",
        cause: error,
        context: { directory, declaredPath },
      },
    );
  }
}

async function findUnavailableDeclaredViews(
  plugin: Plugin,
  directory: string,
): Promise<string[]> {
  const unavailableViews: string[] = [];
  if (!plugin.views) return unavailableViews;
  for (const view of plugin.views) {
    const requiresFrameDocument =
      view.surface?.isolation === "sandboxed-iframe";
    const hasRemoteAsset = requiresFrameDocument
      ? typeof view.frameUrl === "string" && view.frameUrl.trim().length > 0
      : [view.bundleUrl, view.frameUrl].some(
          (assetUrl) =>
            typeof assetUrl === "string" && assetUrl.trim().length > 0,
        );
    const localAssetPaths = requiresFrameDocument
      ? [view.framePath]
      : [view.bundlePath, view.framePath];

    let hasLocalAsset = false;
    for (const assetPath of localAssetPaths) {
      if (await isUsableLocalViewAsset(directory, assetPath)) {
        hasLocalAsset = true;
        break;
      }
    }
    if (hasRemoteAsset || hasLocalAsset) continue;

    unavailableViews.push(
      ...getViewModalities(view).map((viewType) => `${viewType}:${view.id}`),
    );
  }
  return unavailableViews;
}

function viewAssetError(
  directory: string,
  pluginName: string,
  unavailableViews: string[],
): ElizaError {
  return new ElizaError(
    `loadPluginFromDirectory: declared views are missing built assets (${unavailableViews.join(", ")})`,
    {
      code: "PLUGIN_DIRECTORY_VIEW_ASSET_MISSING",
      context: { directory, pluginName, unavailableViews },
    },
  );
}

async function restoreIncumbentAfterFailedReload(
  runtime: AgentRuntime,
  incumbent: Plugin,
  directory: string,
  reloadError: unknown,
): Promise<never> {
  try {
    await runtime.unloadPlugin(incumbent.name);
    await runtime.registerPlugin(incumbent);
  } catch (rollbackError) {
    // error-policy:J2 retain both failure stages when lifecycle restoration
    // itself fails, because the runtime can no longer promise either version.
    throw new ElizaError(
      `loadPluginFromDirectory: reload failed and incumbent plugin "${incumbent.name}" could not be restored`,
      {
        code: "PLUGIN_DIRECTORY_RELOAD_ROLLBACK_FAILED",
        cause: rollbackError,
        severity: "fatal",
        context: {
          directory,
          pluginName: incumbent.name,
          reloadError:
            reloadError instanceof Error
              ? reloadError.message
              : String(reloadError),
        },
      },
    );
  }

  // error-policy:J2 the replacement failure remains the cause after the
  // supported lifecycle API has restored the last known-good plugin.
  throw new ElizaError(
    `loadPluginFromDirectory: reload failed; restored incumbent plugin "${incumbent.name}"`,
    {
      code: "PLUGIN_DIRECTORY_RELOAD_FAILED",
      cause: reloadError,
      context: { directory, pluginName: incumbent.name },
    },
  );
}

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
  installRuntimePluginLifecycle(runtime);
  if (typeof runtime.registerPlugin !== "function") {
    throw new Error(
      "loadPluginFromDirectory: runtime.registerPlugin is not available — ensure installRuntimePluginLifecycle has run",
    );
  }

  const diskPath = await resolveEntryFile(directory, options.entry);
  const realDirectory = await realpath(directory);
  const mod = await importFreshPluginModule(diskPath, realDirectory);

  const plugin: Plugin | null = extractPlugin(mod);
  if (!plugin) {
    throw new Error(
      `loadPluginFromDirectory: no valid plugin export in ${diskPath} (expected a default export, a named \`plugin\` export, or a module with a string \`name\`)`,
    );
  }

  bindPluginPackageDirectory(plugin, realDirectory);
  const unavailableDeclaredViews = await findUnavailableDeclaredViews(
    plugin,
    realDirectory,
  );
  if (unavailableDeclaredViews.length > 0) {
    throw viewAssetError(realDirectory, plugin.name, unavailableDeclaredViews);
  }

  const incumbent = runtime.plugins.find(
    (registered) => registered.name === plugin.name,
  );
  const findUnavailableRegisteredViews = (): string[] => {
    if (!plugin.views) return [];
    return plugin.views.flatMap((view) =>
      getViewModalities(view).flatMap((viewType) => {
        const entry = getView(view.id, { viewType });
        return entry?.pluginName === plugin.name && entry.available
          ? []
          : [`${viewType}:${view.id}`];
      }),
    );
  };

  if (incumbent) {
    try {
      await runtime.reloadPlugin(plugin);
      // The preflight protects the normal path. Re-check the registered entries
      // to catch an asset that disappears between disk validation and lifecycle
      // registration without committing a broken replacement.
      const unavailableViews = findUnavailableRegisteredViews();
      if (unavailableViews.length > 0) {
        throw viewAssetError(realDirectory, plugin.name, unavailableViews);
      }
    } catch (error) {
      // error-policy:J2 restore the last known-good lifecycle ownership, then
      // rethrow with the replacement failure preserved as the cause.
      return restoreIncumbentAfterFailedReload(
        runtime,
        incumbent,
        realDirectory,
        error,
      );
    }
  } else {
    await runtime.registerPlugin(plugin);
    const unavailableViews = findUnavailableRegisteredViews();
    if (unavailableViews.length > 0) {
      await runtime.unloadPlugin(plugin.name);
      throw viewAssetError(realDirectory, plugin.name, unavailableViews);
    }
  }

  loadedPlugins.set(plugin.name, {
    pluginName: plugin.name,
    directory: realDirectory,
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
