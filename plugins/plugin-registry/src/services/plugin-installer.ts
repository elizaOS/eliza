/**
 * `@elizaos/plugin-registry/services/plugin-installer` — thin forwarder to
 * the runtime implementation in `@elizaos/agent/services/plugin-installer`.
 *
 * Moved here in Phase 4F as part of the plugin-registry consolidation. The
 * canonical agent install/uninstall implementation still lives in agent
 * because it relies on agent-internal config + restart wiring. The forwarder
 * lazy-loads agent at first call to keep the static `.d.ts` graph from
 * picking up a registry → agent edge.
 *
 * Types are re-exported statically because TypeScript erases them at compile
 * time and never participates in the runtime cycle.
 */

import type {
  InstallPhase,
  InstallProgress,
  InstallResult,
  ProgressCallback,
  UninstallResult,
} from "@elizaos/agent";

export type {
  InstallPhase,
  InstallProgress,
  InstallResult,
  ProgressCallback,
  UninstallResult,
};

let cached: typeof import("@elizaos/agent") | null = null;

async function load() {
  if (cached) return cached;
  cached = await import("@elizaos/agent");
  return cached;
}

export async function installPlugin(
  ...args: Parameters<typeof import("@elizaos/agent").installPlugin>
): ReturnType<typeof import("@elizaos/agent").installPlugin> {
  const mod = await load();
  return mod.installPlugin(...args);
}

export async function installAndRestart(
  ...args: Parameters<typeof import("@elizaos/agent").installAndRestart>
): ReturnType<typeof import("@elizaos/agent").installAndRestart> {
  const mod = await load();
  return mod.installAndRestart(...args);
}

export async function uninstallPlugin(
  ...args: Parameters<typeof import("@elizaos/agent").uninstallPlugin>
): ReturnType<typeof import("@elizaos/agent").uninstallPlugin> {
  const mod = await load();
  return mod.uninstallPlugin(...args);
}

export async function uninstallAndRestart(
  ...args: Parameters<typeof import("@elizaos/agent").uninstallAndRestart>
): ReturnType<typeof import("@elizaos/agent").uninstallAndRestart> {
  const mod = await load();
  return mod.uninstallAndRestart(...args);
}

export async function listInstalledPlugins(
  ...args: Parameters<typeof import("@elizaos/agent").listInstalledPlugins>
): Promise<ReturnType<typeof import("@elizaos/agent").listInstalledPlugins>> {
  const mod = await load();
  return mod.listInstalledPlugins(...args);
}
