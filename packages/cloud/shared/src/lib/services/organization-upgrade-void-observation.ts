/** Read-only proof of a void original upgrade. Never authorizes another provider mutation. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import type { OrganizationUpgradeReview } from "./organization-plan-change-contract";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import type { OrganizationUpgradeProviderBinding } from "./organization-upgrade-provider-binding";
import { settlementDigest } from "./settlement-digest";
import { invoiceSchema } from "./stripe-invoice-observation";
import { organizationSubscriptionObservationSchema } from "./stripe-organization-subscription-observation";
import { resolveSubscriptionPlanDefinition } from "./subscription-catalog";

const seconds = z.number().int().nonnegative().safe();
const invoiceShape = invoiceSchema.extend({
  status: z.literal("void"),
  paid: z.literal(false),
  paid_out_of_band: z.literal(false),
  amount_paid: z.literal(0),
  amount_remaining: z.number().int().nonnegative().safe(),
  billing_reason: z.literal("subscription_update"),
  collection_method: z.literal("charge_automatically"),
  on_behalf_of: z.null(),
  transfer_data: z.null(),
  application_fee_amount: z.null(),
  pre_payment_credit_notes_amount: z.literal(0),
  post_payment_credit_notes_amount: z.literal(0),
  created: seconds,
  status_transitions: z.object({
    finalized_at: seconds,
    paid_at: z.null(),
    voided_at: seconds.nullable(),
    marked_uncollectible_at: z.null(),
  }),
});
const intentShape = z.object({
  id: z.string(),
  object: z.literal("payment_intent"),
  invoice: z.string(),
  customer: z.string(),
  livemode: z.boolean(),
  currency: z.literal("usd"),
  status: z.literal("canceled"),
  amount_received: z.literal(0),
  amount_capturable: z.literal(0),
  canceled_at: seconds,
  on_behalf_of: z.null(),
  transfer_data: z.null(),
  application_fee_amount: z.null(),
});
export function voidUpgradeUnavailable(reason: string): never {
  throw new ElizaError("Original upgrade failure is not yet proven", {
    code: "SUBSCRIPTION_UPGRADE_VOID_UNVERIFIED",
    context: { reason },
  });
}
export function observeVoidedOrganizationUpgrade(input: {
  rawInvoice: unknown;
  rawSubscription: unknown;
  rawPaymentIntent: unknown;
  source: BillingSubscription;
  review: OrganizationUpgradeReview;
  binding: OrganizationUpgradeProviderBinding;
  origin: {
    invoice_id: string;
    customer_id: string;
    subscription_id: string;
    livemode: boolean;
    invoice_created_at: Date;
  };
  observedAt: Date;
}) {
  const { source, review, binding, origin } = input;
  assertOrganizationSubscription(source);
  const parsed = invoiceShape.safeParse(input.rawInvoice);
  const live = organizationSubscriptionObservationSchema
    .extend({ collection_method: z.literal("charge_automatically") })
    .safeParse(input.rawSubscription);
  if (!parsed.success || !live.success)
    voidUpgradeUnavailable("incomplete_original_void_or_live_subscription");
  const invoice = parsed.data,
    subscription = live.data,
    item = subscription.items.data[0]!;
  if (!source.current_period_start || !source.current_period_end)
    voidUpgradeUnavailable("source_period_missing");
  const now = input.observedAt.getTime();
  const plan = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
  if (
    !Number.isFinite(now) ||
    source.provider !== "stripe" ||
    source.billing_scope_id !== null ||
    source.merchant_key !== "platform" ||
    source.status !== "active" ||
    source.cancel_at_period_end ||
    source.pending_plan_key !== null ||
    source.ended_at !== null ||
    source.dunning_started_at !== null ||
    source.grace_expires_at !== null ||
    review.subscriptionId !== source.id ||
    review.expectedSubscriptionRevision !== String(source.lifecycle_revision) ||
    review.sourcePlanKey !== source.plan_key ||
    review.catalogVersion !== source.catalog_version ||
    review.currentPeriodStart !== source.current_period_start.toISOString() ||
    review.currentPeriodEnd !== source.current_period_end.toISOString() ||
    invoice.id !== origin.invoice_id ||
    invoice.customer !== origin.customer_id ||
    invoice.subscription !== origin.subscription_id ||
    invoice.livemode !== origin.livemode ||
    invoice.currency !== "usd" ||
    invoice.created * 1000 !== origin.invoice_created_at.getTime() ||
    invoice.created < review.prorationDate ||
    invoice.status_transitions.finalized_at < invoice.created ||
    invoice.status_transitions.finalized_at * 1000 > now ||
    (invoice.status_transitions.voided_at !== null &&
      (invoice.status_transitions.voided_at < invoice.status_transitions.finalized_at ||
        invoice.status_transitions.voided_at * 1000 > now)) ||
    source.stripe_customer_id !== origin.customer_id ||
    source.stripe_subscription_id !== origin.subscription_id ||
    binding.livemode !== origin.livemode ||
    (source.provider_environment === "live") !== origin.livemode ||
    subscription.id !== origin.subscription_id ||
    subscription.customer !== origin.customer_id ||
    subscription.livemode !== origin.livemode ||
    item.id !== source.stripe_subscription_item_id ||
    item.price.id !== binding.sourcePriceId ||
    item.price.product !== binding.sourceProductId ||
    item.price.livemode !== binding.livemode ||
    item.price.unit_amount !== plan.amountCents ||
    subscription.cancel_at_period_end ||
    subscription.cancel_at !== null ||
    (subscription.canceled_at !== null &&
      subscription.canceled_at * 1000 !== source.canceled_at?.getTime()) ||
    (subscription.trial_end !== null && subscription.trial_end * 1000 > now) ||
    subscription.current_period_start * 1000 > now ||
    subscription.current_period_end * 1000 <= now ||
    subscription.current_period_end <= subscription.current_period_start ||
    !(
      (subscription.current_period_start * 1000 === source.current_period_start.getTime() &&
        subscription.current_period_end * 1000 === source.current_period_end.getTime()) ||
      subscription.current_period_start * 1000 >= source.current_period_end.getTime()
    )
  )
    voidUpgradeUnavailable("original_void_or_source_terms_changed");
  let intent: z.infer<typeof intentShape> | null = null;
  if (invoice.payment_intent !== null) {
    const pi = intentShape.safeParse(input.rawPaymentIntent);
    if (!pi.success) voidUpgradeUnavailable("original_payment_intent_not_canceled");
    intent = pi.data;
    if (
      intent.id !== invoice.payment_intent ||
      intent.invoice !== origin.invoice_id ||
      intent.customer !== origin.customer_id ||
      intent.livemode !== origin.livemode ||
      intent.canceled_at < invoice.created ||
      intent.canceled_at * 1000 > now
    )
      voidUpgradeUnavailable("original_payment_intent_identity_changed");
  } else if (input.rawPaymentIntent !== null || invoice.charge !== null)
    voidUpgradeUnavailable("unattributed_payment_evidence");
  return {
    kind: "original_invoice_void" as const,
    invoiceId: invoice.id,
    invoiceDigest: settlementDigest(invoice),
    paymentIntentId: intent?.id ?? null,
    paymentIntentDigest: intent ? settlementDigest(intent) : null,
    liveDigest: settlementDigest(subscription),
    livePeriodStart: new Date(subscription.current_period_start * 1000).toISOString(),
    livePeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
    observedAt: input.observedAt.toISOString(),
  };
}
