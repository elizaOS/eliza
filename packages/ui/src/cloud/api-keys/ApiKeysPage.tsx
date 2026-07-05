/**
 * Standalone API-keys console page mounted by the cloud router shell at
 * `dashboard/api-keys` — the key-management surface on the apex console
 * (elizacloud.ai), where the in-app Settings view never mounts. Thin wrapper
 * around the self-loading {@link ApiKeysSurface} (the same body the
 * `cloud-api-keys` Settings section renders in the app); the shell supplies
 * the QueryClient, CloudI18nProvider, and Steward auth context.
 *
 * Default export for `React.lazy` code-splitting from the route registration.
 */

import { ConsolePage } from "../shell/ConsolePage";
import { ApiKeysSurface } from "./ApiKeysSurface";

export function ApiKeysPage() {
  // No titleKey and no local PageHeaderProvider: the surface's useSetPageHeader
  // must reach ConsoleShell's provider so the top bar shows the title and the
  // header "Create API Key" CTA actually renders (a local provider is a dead
  // context nothing reads). Document title is set by ApiKeysSurface.
  return (
    <ConsolePage>
      <ApiKeysSurface />
    </ConsolePage>
  );
}

export default ApiKeysPage;
