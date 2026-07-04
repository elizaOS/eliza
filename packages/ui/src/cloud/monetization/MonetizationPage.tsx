/**
 * Standalone Monetization console page mounted by the cloud router shell at
 * `dashboard/monetization` — the tabbed Earnings + Affiliates surface on the
 * apex console (elizacloud.ai), where the in-app Settings view never mounts.
 * Thin wrapper around the self-loading {@link MonetizationView} (the same body
 * the `cloud-monetization` Settings section renders in the app). Legacy
 * `dashboard/earnings` and `dashboard/affiliates` deep links redirect here via
 * the CloudRouterShell compat redirects.
 *
 * Default export for `React.lazy` code-splitting from the route registration.
 */

import { useDocumentTitle } from "../lib/use-document-title";
import { useCloudT } from "../shell/CloudI18nProvider";
import { MonetizationView } from "./MonetizationSection";

export function MonetizationPage() {
  const t = useCloudT();
  useDocumentTitle(
    t("cloud.monetization.metaTitle", { defaultValue: "Monetization" }),
  );
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6 md:py-8">
      <MonetizationView />
    </div>
  );
}

export default MonetizationPage;
