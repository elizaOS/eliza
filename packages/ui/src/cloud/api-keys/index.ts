/**
 * API-keys cloud domain — barrel + canonical section mount.
 *
 * Lifted from `@elizaos/cloud-frontend/src/dashboard/api-keys/*` and its data
 * hook (`src/lib/data/api-keys.ts`). There is exactly ONE mount for this
 * surface: the Settings → Developer section. {@link ApiKeysSection} is the
 * zero-prop component registered as the `api-keys` settings section (see
 * `cloud/settings/register-cloud-settings.ts`, behind `viewKind: "developer"`).
 *
 * Legacy `/dashboard/api-keys` deep links resolve to that section via the
 * `dashboard/api-keys → /settings#api-keys` compat redirect in
 * `CloudRouterShell`; there is no standalone `/dashboard/api-keys` route.
 */

export { ApiKeysSurface } from "./ApiKeysRoute";
export { ApiKeysSection } from "./ApiKeysSection";
export { ApiKeysView } from "./ApiKeysView";
export { copyApiKeyToClipboard } from "./copy-api-key";
export {
  API_KEYS_QUERY_KEY,
  type ApiKeyRecord,
  useApiKeys,
} from "./use-api-keys";

/** Stable settings-section id + URL hash for the API-keys surface. */
export const API_KEYS_SECTION_ID = "api-keys";
