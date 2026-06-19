/**
 * API Explorer cloud domain — barrel + route/section registration.
 *
 * Lifted from `@elizaos/cloud-frontend/src/dashboard/api-explorer/*`. The
 * static endpoint catalog + OpenAPI generator come from
 * `@elizaos/cloud-shared/lib/swagger/*` (already isomorphic + browser-safe); the
 * live pricing overlay is `GET /api/v1/pricing/summary`; the explorer key is
 * auto-minted via `GET /api/v1/api-keys/explorer`; the tester runs REAL, BILLED
 * calls (the "API calls are billed" banner is preserved). Auth-gated, never
 * public.
 *
 * The canonical home (PLAN §"`dashboard/api-explorer` → SECTION (Developer) or
 * VIEW (auth-gated)") is a developer view / settings section:
 *
 *  - {@link ApiExplorerSurface} is the zero-prop component Wave 3 hands to
 *    `registerSettingsSection({ id: "api-explorer", Component: ApiExplorerSurface })`
 *    or mounts as a standalone developer view. It gates on the Steward session
 *    itself, so it is safe to mount bare.
 *  - {@link apiExplorerCloudRoute} is registered **at import time** at
 *    `dashboard/api-explorer`. This path is the *target* of the
 *    `CloudRouterShell` `dashboard/{image,video,gallery,voices}` redirects (the
 *    legacy media generators were folded into the explorer) — it is not itself a
 *    `from` in that redirect map, so eager registration is safe and is what
 *    makes those redirects land. {@link registerApiExplorerCloudRoute} is also
 *    exported for re-registration at a custom path.
 */

import { lazy } from "react";
import {
  type CloudRouteDef,
  registerCloudRoute,
} from "../shell/cloud-route-registry";

export {
  ApiExplorerSurface,
  default as ApiExplorerRoute,
} from "./ApiExplorerPage";
export { ApiTester } from "./api-tester";
export { AuthManager } from "./auth-manager";
export {
  type ExplorerApiKey,
  type UseExplorerApiKeyResult,
  useExplorerApiKey,
} from "./use-explorer-api-key";

/** Stable view/section id + URL path slug for the API Explorer surface. */
export const API_EXPLORER_SECTION_ID = "api-explorer";
export const API_EXPLORER_ROUTE_PATH = "dashboard/api-explorer";

/** Lazy route element for the standalone API Explorer surface (code-split). */
const ApiExplorerRouteLazy = lazy(() => import("./ApiExplorerPage"));

/** Cloud-route definition for the standalone API Explorer surface. */
export const apiExplorerCloudRoute: CloudRouteDef = {
  path: API_EXPLORER_ROUTE_PATH,
  element: ApiExplorerRouteLazy,
  group: "dashboard",
};

/**
 * Register (or re-register) the standalone API Explorer route. Exported for an
 * explicit custom-path mount; the default registration below runs at import time
 * since `dashboard/api-explorer` is a redirect target, not a `from`, in the
 * shell's redirect map.
 */
export function registerApiExplorerCloudRoute(
  override?: Partial<CloudRouteDef>,
): void {
  registerCloudRoute({ ...apiExplorerCloudRoute, ...override });
}

registerApiExplorerCloudRoute();
