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

import { ConsolePage } from "../shell/ConsolePage";
import { MonetizationView } from "./MonetizationSection";

export function MonetizationPage() {
  return (
    <ConsolePage
      titleKey="cloud.monetization.metaTitle"
      titleDefault="Monetization"
    >
      <MonetizationView />
    </ConsolePage>
  );
}

export default MonetizationPage;
