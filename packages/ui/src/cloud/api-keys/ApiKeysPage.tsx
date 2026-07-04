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

import { PageHeaderProvider } from "../../cloud-ui";
import { useDocumentTitle } from "../lib/use-document-title";
import { useCloudT } from "../shell/CloudI18nProvider";
import { ApiKeysSurface } from "./ApiKeysSurface";

export function ApiKeysPage() {
  const t = useCloudT();
  useDocumentTitle(t("cloud.apiKeys.metaTitle", { defaultValue: "API Keys" }));
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6 md:py-8">
      <PageHeaderProvider>
        <ApiKeysSurface />
      </PageHeaderProvider>
    </div>
  );
}

export default ApiKeysPage;
