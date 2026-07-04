/**
 * Standalone Account console page mounted by the cloud router shell at
 * `dashboard/account` — profile/identity management on the apex console
 * (elizacloud.ai), where the in-app Settings view never mounts. Thin wrapper
 * around the self-loading {@link AccountSurface} (the same body the
 * `cloud-account` Settings section renders in the app).
 *
 * Default export for `React.lazy` code-splitting from the route registration.
 */

import { PageHeaderProvider } from "../../cloud-ui/components/layout";
import { useDocumentTitle } from "../lib/use-document-title";
import { useCloudT } from "../shell/CloudI18nProvider";
import { AccountSurface } from "./AccountSurface";

export function AccountPage() {
  const t = useCloudT();
  useDocumentTitle(t("cloud.account.metaTitle", { defaultValue: "Account" }));
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6 md:py-8">
      <PageHeaderProvider>
        <AccountSurface />
      </PageHeaderProvider>
    </div>
  );
}

export default AccountPage;
