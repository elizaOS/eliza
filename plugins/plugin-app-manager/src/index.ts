/**
 * @elizaos/plugin-app-manager — app lifecycle plugin.
 *
 * Owns hosted-app launch / list / close, run state persistence
 * (`app-run-store`), and the `/api/apps/*` HTTP surface (`apps-routes`).
 *
 * Extracted from `@elizaos/agent` in Phase 4G. The agent re-imports
 * `AppManager` and `handleAppsRoutes` from this plugin for the central
 * server dispatcher; downstream consumers should import from
 * `@elizaos/plugin-app-manager` directly.
 */

export {
  type AppManagerLike,
  type AppsRouteContext,
  type FavoriteAppsStore,
  handleAppsRoutes,
} from "./api/apps-routes.ts";
export {
  type AppLaunchResult,
  type AppRunActionResult,
  type AppRunSummary,
  type AppStopResult,
  type AppViewerAuthMessage,
  AppManager,
  type InstalledAppInfo,
} from "./services/app-manager.ts";
export {
  readAppRunStore,
  resolveAppRunStoreFilePath,
  resolveLegacyAppRunStoreFilePath,
  writeAppRunStore,
} from "./services/app-run-store.ts";
