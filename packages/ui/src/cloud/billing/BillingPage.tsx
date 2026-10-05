/**
 * Standalone Billing console page mounted by the cloud router shell at
 * `dashboard/billing` — the canonical add-funds / payment-methods / invoices
 * surface on the managed Cloud app (cloud.eliza.app), where the in-app Settings view
 * never mounts. Thin wrapper around {@link DeveloperBillingSectionBody};
 * runtime-selected product navigation remains in native Settings. The
 * shell supplies the QueryClient, CloudI18nProvider, and Steward auth context.
 * The Stripe Checkout cancel URL lands here with `?canceled=true` and the body
 * reads it from `window.location.search` directly.
 *
 * Default export for `React.lazy` code-splitting from the route registration.
 */

import { ConsolePage } from "../shell/ConsolePage";
import { DeveloperBillingSectionBody } from "./BillingSection";

export function BillingPage() {
  return (
    <ConsolePage titleKey="cloud.billing.metaTitle" titleDefault="Billing">
      <DeveloperBillingSectionBody />
    </ConsolePage>
  );
}

export default BillingPage;
