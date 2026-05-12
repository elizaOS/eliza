import { pathToFileURL } from "node:url";
import type { AgentRuntime, Plugin } from "@elizaos/core";
import { PluginCompiler } from "../services/plugin-compiler.ts";
import type { VirtualFilesystemService } from "../services/virtual-filesystem.ts";

export interface LoadPluginFromVfsOptions {
  runtime: AgentRuntime;
  vfs: VirtualFilesystemService;
  /** Project id is informational; the VFS already binds to a project. */
  projectId?: string;
  /**
   * Virtual entry path. When `compileFirst` is true, this points at TS/TSX
   * source. When false, it points at already-built JS.
   */
  entry: string;
  /** Override the compiler output path. Defaults to PluginCompiler's default. */
  outFile?: string;
  /** Compile `entry` with `PluginCompiler` first. Default true. */
  compileFirst?: boolean;
  /** Optional pre-built compiler instance (useful for tests/DI). */
  compiler?: PluginCompiler;
}

export interface LoadedVfsPlugin {
  pluginName: string;
  vfsPath: string;
  diskPath: string;
  projectId: string | null;
  loadedAt: number;
}

export interface LoadedVfsPluginView {
  pluginName: string;
  vfsPath: string;
  projectId: string | null;
  loadedAt: number;
}

const loadedPlugins = new Map<string, LoadedVfsPlugin>();

/**
 * Compile (optional) → import → register a plugin sourced from a VFS.
 *
 * The compiled JS is dynamically imported via `pathToFileURL` with a cache-bust
 * query so callers can hot-reload by recompiling the same VFS path.
 */
export async function loadPluginFromVfs(
  options: LoadPluginFromVfsOptions,
): Promise<{ pluginName: string; unloaded: false }> {
  const {
    runtime,
    vfs,
    entry,
    outFile,
    compileFirst = true,
    compiler,
  } = options;

  if (typeof runtime.registerPlugin !== "function") {
    throw new Error(
      "loadPluginFromVfs: runtime.registerPlugin is not available",
    );
  }

  let importPath = entry;
  if (compileFirst) {
    const compilerInstance = compiler ?? new PluginCompiler();
    const compileResult = await compilerInstance.compile({
      vfs,
      entry,
      ...(outFile !== undefined ? { outFile } : {}),
    });
    importPath = compileResult.outFile;
  }

  const diskPath = vfs.resolveDiskPath(importPath);
  // `?t=` cache-busts Node's ESM loader so a recompile reloads the module.
  const moduleUrl = `${pathToFileURL(diskPath).href}?t=${Date.now()}`;
  const mod = (await import(moduleUrl)) as Record<string, unknown>;

  const plugin = extractPlugin(mod);
  if (!plugin) {
    throw new Error(
      `loadPluginFromVfs: no valid plugin export in ${importPath} (expected default export with a string \`name\`, or a named \`plugin\` export)`,
    );
  }

  await runtime.registerPlugin(plugin);

  const record: LoadedVfsPlugin = {
    pluginName: plugin.name,
    vfsPath: importPath,
    diskPath,
    projectId: options.projectId ?? null,
    loadedAt: Date.now(),
  };
  loadedPlugins.set(plugin.name, record);

  return { pluginName: plugin.name, unloaded: false };
}

export interface UnloadPluginFromVfsOptions {
  runtime: AgentRuntime;
  pluginName: string;
}

/**
 * Unload a plugin previously registered via `loadPluginFromVfs`. Delegates to
 * the runtime's `unloadPlugin` (installed by `installRuntimePluginLifecycle`).
 */
export async function unloadPluginFromVfs(
  options: UnloadPluginFromVfsOptions,
): Promise<{ pluginName: string; unloaded: boolean }> {
  const { runtime, pluginName } = options;
  const runtimeWithLifecycle = runtime as AgentRuntime & {
    unloadPlugin?: (
      name: string,
    ) => Promise<{ pluginName: string } | null | undefined>;
  };

  if (typeof runtimeWithLifecycle.unloadPlugin !== "function") {
    throw new Error(
      "unloadPluginFromVfs: runtime.unloadPlugin is not available — ensure installRuntimePluginLifecycle has run",
    );
  }

  const result = await runtimeWithLifecycle.unloadPlugin(pluginName);
  loadedPlugins.delete(pluginName);
  return { pluginName, unloaded: result != null };
}

/** Read-only view of plugins currently tracked as loaded from VFS. */
export function getLoadedVfsPlugins(): readonly LoadedVfsPlugin[] {
  return [...loadedPlugins.values()];
}

/** Public API view that does not expose host filesystem paths. */
export function getLoadedVfsPluginViews(): readonly LoadedVfsPluginView[] {
  return [...loadedPlugins.values()].map(
    ({ pluginName, vfsPath, projectId, loadedAt }) => ({
      pluginName,
      vfsPath,
      projectId,
      loadedAt,
    }),
  );
}

/** Test helper — clears the in-memory tracking map. */
export function _resetLoadedVfsPluginsForTests(): void {
  loadedPlugins.clear();
}

function extractPlugin(mod: Record<string, unknown>): Plugin | null {
  const candidates: unknown[] = [mod.default, mod.plugin, mod];
  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      "name" in (candidate as Record<string, unknown>) &&
      typeof (candidate as { name?: unknown }).name === "string" &&
      (candidate as { name: string }).name.length > 0
    ) {
      return candidate as Plugin;
    }
  }
  return null;
}
