/**
 * Standalone Security console page mounted by the cloud router shell at
 * `dashboard/security` — sessions / privacy-DSR / audit surface on the apex
 * console (elizacloud.ai), where the in-app Settings view never mounts. Thin
 * wrapper around the self-loading {@link SecuritySurface} (the same body the
 * `cloud-security` Settings section renders in the app).
 *
 * Default export for `React.lazy` code-splitting from the route registration.
 */

import { PageHeaderProvider } from "../../cloud-ui";
import { useDocumentTitle } from "../lib/use-document-title";
import { useCloudT } from "../shell/CloudI18nProvider";
import { SecuritySurface } from "./SecuritySurface";

export function SecurityPage() {
  const t = useCloudT();
  useDocumentTitle(t("cloud.security.metaTitle", { defaultValue: "Security" }));
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6 md:py-8">
      <PageHeaderProvider>
        <SecuritySurface />
      </PageHeaderProvider>
    </div>
  );
}

export default SecurityPage;
