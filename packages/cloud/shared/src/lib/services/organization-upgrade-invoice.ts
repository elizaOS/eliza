/** Validates the original organization upgrade invoice. This observation never grants allowance. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import {
  type OrganizationUpgradeReview,
  organizationUpgradeReviewSchema,
} from "./organization-plan-change-contract";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import {
  type OrganizationUpgradeProviderBinding,
  organizationUpgradeProviderBindingSchema,
} from "./organization-upgrade-provider-binding";
import { settlementDigest } from "./settlement-digest";
import { invoiceSchema, projectSubscriptionUpdateInvoice } from "./stripe-invoice-observation";

const cents = z.number().int().safe();
const seconds = z.number().int().positive().safe();
const settledInvoiceSchema = invoiceSchema.extend({
  id: z.string().regex(/^in_[A-Za-z0-9]+$/),
  status: z.literal("paid"),
  paid: z.literal(true),
  paid_out_of_band: z.literal(false),
  amount_remaining: z.literal(0),
  billing_reason: z.literal("subscription_update"),
  collection_method: z.literal("charge_automatically"),
  on_behalf_of: z.null(),
  transfer_data: z.null(),
  application_fee_amount: z.null(),
  starting_balance: cents,
  pre_payment_credit_notes_amount: z.literal(0),
  post_payment_credit_notes_amount: z.literal(0),
  created: seconds,
  status_transitions: z.object({
    finalized_at: seconds,
    paid_at: seconds,
    voided_at: z.null(),
    marked_uncollectible_at: z.null(),
  }),
  lines: z.object({
    has_more: z.literal(false),
    data: z.array(z.object({ currency: z.literal("usd") })),
  }),
  total_tax_amounts: z.array(
    z.object({ amount: cents.nonnegative(), inclusive: z.boolean(), tax_rate: z.string().min(1) }),
  ),
});
function reject(reason: string): never {
  throw new ElizaError("Organization upgrade payment requires its original verified invoice", {
    code: "SUBSCRIPTION_UPGRADE_INVOICE_UNVERIFIED",
    context: { reason },
  });
}
/** Invoice identity and non-secret price binding come from durable dispatch provenance, never from a caller, current environment or latest-invoice lookup. */
export function observePaidOrganizationUpgradeInvoice(input: {
  raw: unknown;
  expectedInvoiceId: string;
  source: BillingSubscription;
  review: OrganizationUpgradeReview;
  binding: OrganizationUpgradeProviderBinding;
  observedAt: Date;
}) {
  const { source } = input;
  assertOrganizationSubscription(source);
  const review = organizationUpgradeReviewSchema.parse(input.review);
  const parsed = settledInvoiceSchema.safeParse(input.raw);
  if (!parsed.success) reject("incomplete_or_unpaid_invoice");
  const wire = parsed.data;
  const binding = organizationUpgradeProviderBindingSchema.parse(input.binding);
  const observed = Math.floor(input.observedAt.getTime() / 1000);
  if (
    source.status !== "active" ||
    source.cancel_at_period_end ||
    source.pending_plan_key !== null ||
    source.ended_at !== null ||
    source.dunning_started_at !== null ||
    source.grace_expires_at !== null ||
    wire.id !== input.expectedInvoiceId ||
    review.subscriptionId !== source.id ||
    review.expectedSubscriptionRevision !== String(source.lifecycle_revision) ||
    review.sourcePlanKey !== source.plan_key ||
    review.catalogVersion !== source.catalog_version ||
    review.currentPeriodStart !== source.current_period_start?.toISOString() ||
    review.currentPeriodEnd !== source.current_period_end?.toISOString() ||
    binding.livemode !== (source.provider_environment === "live") ||
    binding.sourcePriceId === binding.targetPriceId ||
    !Number.isSafeInteger(observed) ||
    wire.created < review.prorationDate ||
    wire.status_transitions.finalized_at < wire.created ||
    wire.status_transitions.paid_at < wire.status_transitions.finalized_at ||
    wire.status_transitions.paid_at > observed ||
    wire.amount_paid !== wire.amount_due ||
    (wire.amount_due > 0 && wire.payment_intent === null)
  )
    reject("invoice_identity_or_payment_mismatch");
  const invoice = projectSubscriptionUpdateInvoice({
    raw: input.raw,
    livemode: binding.livemode,
    customerId: source.stripe_customer_id,
    subscriptionId: source.stripe_subscription_id,
    currency: "usd",
    prorationDate: review.prorationDate,
  });
  const tax = wire.total_tax_amounts.reduce((sum, x) => sum + x.amount, 0);
  const exclusiveTax = wire.total_tax_amounts.reduce(
    (sum, x) => sum + (x.inclusive ? 0 : x.amount),
    0,
  );
  const subtotal = invoice.lines.reduce((sum, x) => sum + x.amountCents, 0);
  const terms = {
    amountDueCents: invoice.amountDueCents,
    subtotalCents: invoice.subtotalCents,
    discountCents: invoice.discountCents,
    taxCents: tax,
    totalCents: invoice.totalCents,
    startingBalanceCents: wire.starting_balance,
  };
  if (
    !Number.isSafeInteger(tax) ||
    !Number.isSafeInteger(exclusiveTax) ||
    !Number.isSafeInteger(subtotal) ||
    subtotal !== invoice.subtotalCents ||
    (wire.tax === null ? tax !== 0 : wire.tax !== tax) ||
    wire.total !== wire.subtotal - invoice.discountCents + exclusiveTax ||
    settlementDigest(terms) !== settlementDigest(review.dueNow)
  )
    reject("reviewed_payment_terms_changed");
  const lines = invoice.lines;
  if (
    lines.length !== 2 ||
    new Set(lines.map((x) => x.lineId)).size !== 2 ||
    !lines.every(
      (x) =>
        x.lineType === "subscription" &&
        x.subscriptionId === source.stripe_subscription_id &&
        x.subscriptionItemId === source.stripe_subscription_item_id &&
        x.quantity === 1 &&
        x.proration &&
        x.periodStart === review.prorationDate &&
        x.periodEnd * 1000 === Date.parse(review.currentPeriodEnd),
    ) ||
    lines.filter((x) => x.priceId === binding.sourcePriceId && x.amountCents <= 0).length !== 1 ||
    lines.filter((x) => x.priceId === binding.targetPriceId && x.amountCents >= 0).length !== 1
  )
    reject("invoice_proration_scope_changed");
  return {
    invoiceId: wire.id,
    customerId: source.stripe_customer_id,
    subscriptionId: source.stripe_subscription_id,
    livemode: wire.livemode,
    currency: "usd" as const,
    amountPaidCents: wire.amount_paid,
    paymentIntentId: wire.payment_intent,
    chargeId: wire.charge,
    paidAt: new Date(wire.status_transitions.paid_at * 1000).toISOString(),
    terms,
    reviewDigest: settlementDigest(review),
    bindingDigest: settlementDigest(binding),
    invoiceDigest: settlementDigest({ invoice: wire, projection: invoice }),
  };
}
