/**
 * `@elizaos/app-core/services/plugin-installer` — thin forwarder to the
 * runtime implementation in `@elizaos/agent/services/plugin-installer`.
 *
 * Why the forwarder + lazy load: `@elizaos/agent` already depends on
 * `@elizaos/app-core`. Re-exporting the agent module statically here would
 * create a hard module-graph cycle (`app-core ↔ agent`) that breaks the
 * moment `app-core` is consumed in a context where `@elizaos/agent` is
 * not installed (e.g. a downstream package that only adds `app-core`).
 * Types re-export statically because TypeScript erases them at compile
 * time and never participates in the runtime cycle. The implementations
 * forward through `import()` so the cycle only resolves on first call,
 * when the consumer's bundler has finished walking the static graph.
 */

import type {
  InstallPhase,
  InstallProgress,
  InstallResult,
  ProgressCallback,
  UninstallResult,
} from "@elizaos/agent/services/plugin-installer";

export type {
  InstallPhase,
  InstallProgress,
  InstallResult,
  ProgressCallback,
  UninstallResult,
};

let cached: typeof import("@elizaos/agent/services/plugin-installer") | null =
  null;

async function load() {
  if (cached) return cached;
  cached = await import("@elizaos/agent/services/plugin-installer");
  return cached;
}

export async function installPlugin(
  ...args: Parameters<
    typeof import("@elizaos/agent/services/plugin-installer").installPlugin
  >
): ReturnType<
  typeof import("@elizaos/agent/services/plugin-installer").installPlugin
> {
  const mod = await load();
  return mod.installPlugin(...args);
}

export async function installAndRestart(
  ...args: Parameters<
    typeof import("@elizaos/agent/services/plugin-installer").installAndRestart
  >
): ReturnType<
  typeof import("@elizaos/agent/services/plugin-installer").installAndRestart
> {
  const mod = await load();
  return mod.installAndRestart(...args);
}

export async function uninstallPlugin(
  ...args: Parameters<
    typeof import("@elizaos/agent/services/plugin-installer").uninstallPlugin
  >
): ReturnType<
  typeof import("@elizaos/agent/services/plugin-installer").uninstallPlugin
> {
  const mod = await load();
  return mod.uninstallPlugin(...args);
}

export async function uninstallAndRestart(
  ...args: Parameters<
    typeof import("@elizaos/agent/services/plugin-installer").uninstallAndRestart
  >
): ReturnType<
  typeof import("@elizaos/agent/services/plugin-installer").uninstallAndRestart
> {
  const mod = await load();
  return mod.uninstallAndRestart(...args);
}

export async function listInstalledPlugins(
  ...args: Parameters<
    typeof import("@elizaos/agent/services/plugin-installer").listInstalledPlugins
  >
): ReturnType<
  typeof import("@elizaos/agent/services/plugin-installer").listInstalledPlugins
> {
  const mod = await load();
  return mod.listInstalledPlugins(...args);
}
