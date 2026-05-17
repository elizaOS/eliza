/**
 * @elizaos/plugin-registry — public barrel.
 *
<<<<<<< Updated upstream
 * === Phase 4F ===
 *
 * This plugin owns the plugin-discovery / install / route surfaces that were
 * previously split between `@elizaos/agent` and `@elizaos/app-core`:
=======
 * Phase 4F consolidation: this plugin owns the plugin-discovery / install /
 * route surfaces that were previously split between `@elizaos/agent` and
 * `@elizaos/app-core`:
>>>>>>> Stashed changes
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
<<<<<<< Updated upstream
 * The agent-internal canonical installer implementation (owns config +
 * restart wiring) still lives in `@elizaos/agent` because it depends on
 * agent-private runtime state; consumers should import through this
 * plugin's forwarder rather than reaching across into agent directly.
 */

=======
 * The agent-internal canonical installer implementation (905 lines, owns
 * config + restart wiring) still lives in `@elizaos/agent` because it
 * depends on agent-private runtime state; consumers should import through
 * this plugin's forwarder rather than reaching across into agent directly.
 */

export { handlePluginRoutes } from "./api/plugin-routes.ts";
>>>>>>> Stashed changes
export {
  buildPluginListResponse,
  handlePluginsCompatRoutes,
} from "./api/app-plugins-routes.ts";
<<<<<<< Updated upstream
export { handlePluginRoutes } from "./api/plugin-routes.ts";
=======
>>>>>>> Stashed changes
export {
  installAndRestart,
  installPlugin,
  type InstallPhase,
  type InstallProgress,
  type InstallResult,
  listInstalledPlugins,
  type ProgressCallback,
  uninstallAndRestart,
  uninstallPlugin,
  type UninstallResult,
} from "./services/plugin-installer.ts";
