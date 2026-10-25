/** Carries only verified provider lookup hints; none of these fields grants object ownership or access. */
import type { BillingProviderEvent } from "../lib/services/generic-billing-provider-types";
export interface AppBillingWebhookTrigger {
  event: BillingProviderEvent;
  merchantKey: string;
  subscriptionIdHint: string | null;
  customerIdHint: string | null;
  commandIdHint: string | null;
  requestDigestHint: string | null;
}
