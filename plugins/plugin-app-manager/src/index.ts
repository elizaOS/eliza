/**
 * @elizaos/plugin-app-manager
 *
 * App lifecycle plugin for elizaOS — hosted-app launch / list / close,
 * run-state store, and the `/api/apps/*` route surface.
 *
 * Phase 4G: extracted from `@elizaos/agent` so the runtime package no
 * longer owns hosted-app lifecycle code. The agent re-exports the
 * public surface from its existing api/services barrels during the
 * transition; new callers should import from this package directly.
 */

// === API routes ===
export {
  type AppManagerLike,
  type AppsRouteContext,
  type FavoriteAppsStore,
  handleAppsRoutes,
} from "./api/apps-routes.ts";

// === Services ===
export { AppManager } from "./services/app-manager.ts";
export {
  readAppRunStore,
  resolveAppRunStoreFilePath,
  resolveLegacyAppRunStoreFilePath,
  writeAppRunStore,
} from "./services/app-run-store.ts";
