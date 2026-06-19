/**
 * API-keys cloud domain — barrel + route/section registration.
 *
 * Lifted from `@elizaos/cloud-frontend/src/dashboard/api-keys/*` and its data
 * hook (`src/lib/data/api-keys.ts`). The canonical home is a Settings → Cloud
 * section (PLAN: "`dashboard/api-keys` → SECTION (API keys)"); the legacy
 * `/dashboard/api-keys` path is a compat redirect to `/settings#api-keys`
 * carried by `CloudRouterShell`. So:
 *
 *  - {@link ApiKeysSection} is the zero-prop component Wave 3 hands to
 *    `registerSettingsSection({ id: "api-keys", Component: ApiKeysSection })`.
 *    This is the primary mount point.
 *  - {@link registerApiKeysCloudRoute} registers a standalone cloud route for
 *    the surface. It is **opt-in** (not called at import time) so it never
 *    shadows the documented `/dashboard/api-keys` → `/settings#api-keys`
 *    redirect: the shell maps registered routes before the redirect map, and a
 *    `dashboard/api-keys` registration would silently disable that redirect.
 *    The shell or Wave 3 calls this once the redirect is retired (or with a
 *    non-legacy path), keeping route ownership explicit.
 */

import { lazy } from "react";
import {
  type CloudRouteDef,
  registerCloudRoute,
} from "../shell/cloud-route-registry";

export { ApiKeysSurface, default as ApiKeysRoute } from "./ApiKeysRoute";
export { ApiKeysSection } from "./ApiKeysSection";
export { ApiKeysView } from "./ApiKeysView";
export { copyApiKeyPrefix, copyApiKeyToClipboard } from "./copy-api-key";
export {
  API_KEYS_QUERY_KEY,
  type ApiKeyRecord,
  useApiKeys,
} from "./use-api-keys";

/** Stable settings-section id + URL hash for the API-keys surface. */
export const API_KEYS_SECTION_ID = "api-keys";

/** Lazy route element for the standalone API-keys surface (code-split). */
const ApiKeysRouteLazy = lazy(() => import("./ApiKeysRoute"));

/**
 * Cloud-route definition for the standalone API-keys surface. Exported so the
 * shell/Wave 3 can mount it at an explicit, non-colliding path instead of the
 * legacy `dashboard/api-keys` (which is a redirect to the settings section).
 */
export const apiKeysCloudRoute: CloudRouteDef = {
  path: "dashboard/api-keys",
  element: ApiKeysRouteLazy,
  group: "dashboard",
};

/**
 * Opt-in registration of the standalone API-keys route. Call this only when the
 * `/dashboard/api-keys` → `/settings#api-keys` redirect is being retired (or
 * pass a custom path), so the route and the redirect never both claim the same
 * path. Not invoked at import time.
 */
export function registerApiKeysCloudRoute(
  override?: Partial<CloudRouteDef>,
): void {
  registerCloudRoute({ ...apiKeysCloudRoute, ...override });
}
