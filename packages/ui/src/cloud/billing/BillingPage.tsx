/**
 * Standalone Billing console page mounted by the cloud router shell at
 * `dashboard/billing` — the canonical add-funds / payment-methods / invoices
 * surface on the apex console (elizacloud.ai), where the in-app Settings view
 * never mounts. Thin wrapper around the self-loading {@link BillingSectionBody}
 * (the same body the `cloud-billing` Settings section renders in the app); the
 * shell supplies the QueryClient, CloudI18nProvider, and Steward auth context.
 * The Stripe Checkout cancel URL lands here with `?canceled=true` and the body
 * reads it from `window.location.search` directly.
 *
 * Default export for `React.lazy` code-splitting from the route registration.
 */

import { ConsolePage } from "../shell/ConsolePage";
import { BillingSectionBody } from "./BillingSection";

export function BillingPage() {
  return (
    <ConsolePage titleKey="cloud.billing.metaTitle" titleDefault="Billing">
      <BillingSectionBody />
    </ConsolePage>
  );
}

export default BillingPage;
