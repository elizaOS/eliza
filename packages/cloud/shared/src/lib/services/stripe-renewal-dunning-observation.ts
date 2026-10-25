/** Historical failed-invoice proof changes lifecycle only and never advances the paid interval. */
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import { failedRenewalInvoiceSchema } from "./organization-schedule-dunning-observation";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import { renewalUnavailable } from "./stripe-paid-renewal-validation";
import { validateCancellationCustomer } from "./stripe-period-end-cancellation";
import { observeOrdinaryRenewalLiveSubscription } from "./stripe-renewal-live-observation";
import {
  resolveSubscriptionPlanDefinition,
  resolveSubscriptionProviderBinding,
} from "./subscription-catalog";
export interface HistoricalDunningObjects {
  invoice: unknown;
  customer: unknown;
  subscription: unknown;
  providerAccountId?: string;
}
export function validateHistoricalDunningObjects(input: {
  source: BillingSubscription;
  objects: HistoricalDunningObjects;
  environment: Record<string, string | undefined>;
  organizationCustomerId: string | null;
  observedAt: Date;
}) {
  const { source, objects } = input,
    parsed = failedRenewalInvoiceSchema.safeParse(objects.invoice);
  if (!parsed.success) renewalUnavailable("historical_failed_invoice_unverified");
  const invoice = parsed.data,
    line = invoice.lines.data[0]!;
  assertOrganizationSubscription(source);
  validateCancellationCustomer({
    raw: objects.customer,
    source,
    organizationCustomerId: input.organizationCustomerId,
    environment: input.environment,
  });
  const binding = resolveSubscriptionProviderBinding(
    input.environment,
    source.plan_key,
    source.catalog_version,
  );
  const plan = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
  const observed = observeOrdinaryRenewalLiveSubscription({
    source,
    raw: objects.subscription,
    observedAt: input.observedAt,
    paidStart: new Date(line.period.start * 1000),
    paidEnd: new Date(line.period.end * 1000),
    historical: true,
    binding,
    amountCents: plan.amountCents,
  });
  if (
    observed.providerStatus === "active" ||
    invoice.id === observed.invoiceId ||
    line.period.start * 1000 !== source.current_period_end?.getTime() ||
    invoice.subscription !== source.stripe_subscription_id ||
    invoice.customer !== source.stripe_customer_id ||
    invoice.livemode !== binding.expectedLivemode ||
    invoice.amount_remaining > invoice.amount_due ||
    line.subscription !== source.stripe_subscription_id ||
    line.subscription_item !== source.stripe_subscription_item_id ||
    line.price.id !== binding.priceId ||
    line.price.product !== binding.productId
  )
    renewalUnavailable("historical_failed_invoice_identity_mismatch");
  return {
    providerStatus: observed.providerStatus,
    providerObjectDigest: observed.providerObjectDigest,
    invoiceId: invoice.id,
  };
}
