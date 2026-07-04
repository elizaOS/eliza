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

import { useDocumentTitle } from "../lib/use-document-title";
import { useCloudT } from "../shell/CloudI18nProvider";
import { CloudConnectorsSection } from "./CloudConnectorsSection";

export function ConnectorsPage() {
  const t = useCloudT();
  useDocumentTitle(
    t("cloud.connectors.metaTitle", { defaultValue: "Connectors" }),
  );
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6 md:py-8">
      <CloudConnectorsSection />
    </div>
  );
}

export default ConnectorsPage;
