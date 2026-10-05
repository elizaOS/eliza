/** Verifies an ephemeral payment continuation for the original upgrade. No provider or database writes. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import type { OrganizationUpgradeReview } from "./organization-plan-change-contract";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import { observeOpenOrganizationUpgradeInvoice } from "./organization-upgrade-invoice";
import type { OrganizationUpgradeProviderBinding } from "./organization-upgrade-provider-binding";
import { organizationSubscriptionObservationSchema } from "./stripe-organization-subscription-observation";
import { resolveSubscriptionPlanDefinition } from "./subscription-catalog";

const seconds = z.number().int().nonnegative().safe();
const priceId = z
  .union([z.string(), z.object({ id: z.string() })])
  .transform((value) => (typeof value === "string" ? value : value.id));
// Pinned Acacia PendingUpdate, independent of the installed SDK's newer API shape.
const pendingShape = z
  .object({
    billing_cycle_anchor: z.null(),
    expires_at: seconds,
    subscription_items: z
      .array(
        z.object({
          id: z.string(),
          price: priceId,
          quantity: z.literal(1),
        }),
      )
      .length(1),
    trial_end: z.null(),
    trial_from_plan: z.union([z.literal(false), z.null()]),
  })
  .strict();
const liveShape = organizationSubscriptionObservationSchema.extend({
  collection_method: z.literal("charge_automatically"),
  pending_update: pendingShape,
});
const intentShape = z.object({
  object: z.literal("payment_intent"),
  id: z.string(),
  invoice: priceId,
  customer: priceId,
  livemode: z.boolean(),
  currency: z.literal("usd"),
  status: z.enum(["requires_action", "requires_payment_method"]),
  amount: z.number().int().positive().safe(),
  amount_received: z.literal(0),
  amount_capturable: z.literal(0),
  capture_method: z.enum(["automatic", "automatic_async"]),
  canceled_at: z.null(),
  on_behalf_of: z.null(),
  transfer_data: z.null(),
  application_fee_amount: z.null(),
});
function reject(reason: string): never {
  throw new ElizaError("Original upgrade payment continuation is unavailable", {
    code: "SUBSCRIPTION_UPGRADE_PAYMENT_UNAVAILABLE",
    context: { reason },
  });
}
/** Sensitive result: release only after rechecking current manager/session and command/source authority. Never log, persist, or add it to generic command history. */
export function observeOrganizationUpgradePaymentContinuation(input: {
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
  const invoice = observeOpenOrganizationUpgradeInvoice({
    ...input,
    raw: input.rawInvoice,
    expectedInvoiceId: origin.invoice_id,
    expectedCreated: origin.invoice_created_at.getTime() / 1000,
  });
  const live = liveShape.safeParse(input.rawSubscription);
  const parsedIntent = intentShape.safeParse(input.rawPaymentIntent);
  if (!live.success || !parsedIntent.success) reject("incomplete_pending_target_or_payment");
  const subscription = live.data,
    intent = parsedIntent.data;
  const item = subscription.items.data[0]!,
    pending = subscription.pending_update;
  const target = pending.subscription_items[0]!;
  const now = input.observedAt.getTime();
  const plan = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
  const targetPlan = resolveSubscriptionPlanDefinition(review.targetPlanKey, review.catalogVersion);
  if (
    source.provider !== "stripe" ||
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
    target.id !== item.id ||
    target.price !== binding.targetPriceId ||
    targetPlan.amountCents !== review.targetBaseAmountCents ||
    targetPlan.amountCents <= plan.amountCents ||
    targetPlan.allowance.amountUsd !== review.targetAllowanceUsd ||
    subscription.current_period_start * 1000 !== source.current_period_start?.getTime() ||
    subscription.current_period_end * 1000 !== source.current_period_end?.getTime() ||
    subscription.current_period_start * 1000 > now ||
    subscription.current_period_end * 1000 <= now ||
    pending.expires_at * 1000 <= now ||
    pending.expires_at > subscription.current_period_end ||
    subscription.cancel_at_period_end ||
    subscription.cancel_at !== null ||
    (subscription.canceled_at !== null &&
      subscription.canceled_at * 1000 !== source.canceled_at?.getTime()) ||
    (subscription.trial_end !== null && subscription.trial_end * 1000 > now) ||
    intent.id !== invoice.paymentIntentId ||
    intent.invoice !== origin.invoice_id ||
    intent.customer !== origin.customer_id ||
    intent.livemode !== origin.livemode ||
    intent.amount !== invoice.amountDueCents
  )
    reject("original_pending_target_or_payment_changed");
  return {
    kind: "hosted_invoice" as const,
    hostedInvoiceUrl: invoice.hostedInvoiceUrl,
    amountDueCents: invoice.amountDueCents,
    currency: invoice.currency,
    paymentState: intent.status,
    expiresAt: new Date(pending.expires_at * 1000).toISOString(),
  };
}
