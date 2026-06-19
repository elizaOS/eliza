/**
 * Settings-section wrapper for the API-keys surface (Wave 3 mount point).
 *
 * The canonical home for API keys is a Settings → Cloud section
 * (DECISIONS / PLAN §"`dashboard/api-keys` → SECTION (API keys)"; the legacy
 * `/dashboard/api-keys` path is a compat redirect to `/settings#api-keys` in
 * `CloudRouterShell`). The settings-section registry renders a no-prop
 * `Component`, so this is the zero-prop adapter Wave 3 hands to
 * `registerSettingsSection({ id: "api-keys", Component: ApiKeysSection, ... })`.
 *
 * It reuses the exact same {@link ApiKeysSurface} as the standalone route, so
 * the section and any direct mount stay byte-for-byte identical.
 */

import { ApiKeysSurface } from "./ApiKeysRoute";

export function ApiKeysSection() {
  return <ApiKeysSurface />;
}
