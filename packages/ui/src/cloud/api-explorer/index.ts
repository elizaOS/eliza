/**
 * API Explorer cloud domain — the single surface for generation/media/API
 * testing. The static endpoint catalog + OpenAPI generator come from
 * `@elizaos/cloud-shared/lib/swagger/*`; the live pricing overlay is
 * `GET /api/v1/pricing/summary`; the explorer key is auto-minted via
 * `GET /api/v1/api-keys/explorer`; the tester runs REAL, BILLED calls (hence
 * the "API calls are billed" banner). Auth-gated, never public.
 *
 *  - {@link ApiExplorerSurface} is the zero-prop embeddable surface. It gates
 *    on the Steward session itself, so it is safe to mount bare.
 *  - {@link apiExplorerCloudRoute} registers `dashboard/api-explorer` at import
 *    time. This path is the *target* of the CloudRouterShell
 *    `dashboard/{image,video,gallery,voices}` redirects (the legacy media
 *    generators were folded into the explorer), so it must stay registered for
 *    those redirects to land.
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
