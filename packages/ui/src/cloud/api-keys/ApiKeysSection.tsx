/**
 * Settings-section wrapper for the API-keys surface — the single mount.
 *
 * The only home for API keys is the Settings → Developer section; legacy
 * `/dashboard/api-keys` deep links resolve here via the `dashboard/api-keys →
 * /settings#api-keys` compat redirect in `CloudRouterShell`. The settings-
 * section registry renders a no-prop `Component`, so this is the zero-prop
 * adapter handed to `registerSettingsSection({ Component: ApiKeysSection, ... })`.
 */

import { ApiKeysSurface } from "./ApiKeysRoute";

export function ApiKeysSection() {
  return <ApiKeysSurface />;
}
