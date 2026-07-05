/**
 * Standalone Connectors console page mounted by the cloud router shell at
 * `dashboard/connectors` — the cloud-hosted connector management surface
 * (OAuth-redirect + token-credential connectors) on the apex console
 * (elizacloud.ai), where the in-app Settings view never mounts. Thin wrapper
 * around the self-loading {@link CloudConnectorsSection} (the same body the
 * connectors Settings section renders in the app). Backend OAuth-connect
 * return URLs (`dashboard/settings?tab=connections`) redirect here via the
 * CloudRouterShell legacy-settings-tab redirect.
 *
 * Default export for `React.lazy` code-splitting from the route registration.
 */

import { ConsolePage } from "../shell/ConsolePage";
import { CloudConnectorsSection } from "./CloudConnectorsSection";

export function ConnectorsPage() {
  return (
    <ConsolePage
      titleKey="cloud.connectors.metaTitle"
      titleDefault="Connectors"
    >
      <CloudConnectorsSection />
    </ConsolePage>
  );
}

export default ConnectorsPage;
