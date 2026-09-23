/**
 * @elizaos/plugin-registry — public barrel.
 *
 * Consolidated plugin registry surfaces.
 *
 * This plugin owns the plugin-discovery / install / route surfaces that were
 * previously split between `@elizaos/agent` and `@elizaos/app-core`:
 *
 *   - `handlePluginRoutes` (agent-tier `/api/plugins/*` handler, formerly
 *     `packages/agent/src/api/plugin-routes.ts`)
 *   - `handlePluginsCompatRoutes` + `buildPluginListResponse` (app-core
 *     compat layer for `/api/agents/:agentId/plugins/*`, formerly
 *     `packages/app-core/src/api/plugins-routes.ts`)
 *   - `installPlugin` / `uninstallPlugin` / `installAndRestart` /
 *     `uninstallAndRestart` / `listInstalledPlugins` forwarders (formerly
 *     `packages/app-core/src/services/plugin-installer.ts`)
 *
 * The agent-internal canonical installer implementation (owns config +
 * restart wiring) still lives in `@elizaos/agent` because it depends on
 * agent-private runtime state; consumers should import through this
 * plugin's forwarder rather than reaching across into agent directly.
 */

export {
  buildPluginListResponse,
  handlePluginsCompatRoutes,
} from "./api/app-plugins-routes.ts";
export { handlePluginRoutes } from "./api/plugin-routes.ts";
export {
  type InstallPhase,
  type InstallProgress,
  type InstallResult,
  installAndRestart,
  installPlugin,
  listInstalledPlugins,
  type ProgressCallback,
  type UninstallResult,
  uninstallAndRestart,
  uninstallPlugin,
} from "./services/plugin-installer.ts";
