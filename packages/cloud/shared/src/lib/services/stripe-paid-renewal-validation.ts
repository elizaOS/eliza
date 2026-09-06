/** Validates only full-price captured platform Stripe payments for adjacent historical-v1 renewals; unsupported billing adjustments never become allowance authority. */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import {
  validateCancellationCustomer,
  validatePeriodEndCancellationObservation,
} from "./stripe-period-end-cancellation";
import {
  resolveSubscriptionPlanDefinition,
  resolveSubscriptionProviderBinding,
} from "./subscription-catalog";

const seconds = z.number().int().nonnegative().safe();
const cents = z.number().int().positive().safe();
const empty = z.array(z.unknown()).length(0);
export function renewalUnavailable(reason: string): never {
  throw new ElizaError("Paid renewal requires a verified current invoice and payment", {
    code: "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
    context: { reason },
  });
}
export const renewalInvoiceSchema = z.object({
  id: z.string().regex(/^in_[A-Za-z0-9]+$/),
  object: z.literal("invoice"),
  subscription: z.string().regex(/^sub_[A-Za-z0-9]+$/),
  customer: z.string(),
  livemode: z.boolean(),
  billing_reason: z.literal("subscription_cycle"),
  status: z.literal("paid"),
  paid: z.literal(true),
  paid_out_of_band: z.literal(false),
  collection_method: z.literal("charge_automatically"),
  currency: z.literal("usd"),
  amount_paid: cents,
  amount_due: cents,
  total: cents,
  subtotal: cents,
  amount_remaining: z.literal(0),
  starting_balance: z.literal(0),
  ending_balance: z.literal(0),
  pre_payment_credit_notes_amount: z.literal(0),
  post_payment_credit_notes_amount: z.literal(0),
  discount: z.null(),
  discounts: empty,
  total_discount_amounts: empty,
  tax: z.union([z.null(), z.literal(0)]),
  total_tax_amounts: empty,
  automatic_tax: z.object({ enabled: z.literal(false) }),
  application: z.null(),
  application_fee_amount: z.null(),
  on_behalf_of: z.null(),
  transfer_data: z.null(),
  issuer: z.object({ type: z.literal("self") }),
  payment_intent: z.string().regex(/^pi_[A-Za-z0-9]+$/),
  charge: z.string().regex(/^ch_[A-Za-z0-9]+$/),
  status_transitions: z.object({ paid_at: seconds }),
  lines: z.object({
    has_more: z.literal(false),
    data: z
      .array(
        z.object({
          id: z.string(),
          type: z.literal("subscription"),
          subscription: z.string(),
          subscription_item: z.string(),
          quantity: z.literal(1),
          proration: z.literal(false),
          currency: z.literal("usd"),
          amount: cents,
          discount_amounts: empty,
          tax_amounts: empty,
          period: z.object({ start: seconds, end: seconds }),
          price: z.object({ id: z.string(), product: z.string() }),
        }),
      )
      .length(1),
  }),
});
const paymentSchema = z.object({
  id: z.string(),
  object: z.literal("payment_intent"),
  status: z.literal("succeeded"),
  customer: z.string(),
  invoice: z.string(),
  latest_charge: z.string(),
  livemode: z.boolean(),
  currency: z.literal("usd"),
  amount: cents,
  amount_received: cents,
  amount_capturable: z.literal(0),
  application: z.null(),
  application_fee_amount: z.null(),
  on_behalf_of: z.null(),
  transfer_data: z.null(),
});
const chargeSchema = z.object({
  id: z.string(),
  object: z.literal("charge"),
  status: z.literal("succeeded"),
  customer: z.string(),
  invoice: z.string(),
  payment_intent: z.string(),
  livemode: z.boolean(),
  currency: z.literal("usd"),
  amount: cents,
  amount_captured: cents,
  amount_refunded: z.literal(0),
  captured: z.literal(true),
  paid: z.literal(true),
  refunded: z.literal(false),
  disputed: z.literal(false),
  refunds: z.object({ has_more: z.literal(false), data: empty }),
  application: z.null(),
  application_fee: z.null(),
  application_fee_amount: z.null(),
  on_behalf_of: z.null(),
  transfer: z.null().optional(),
  transfer_data: z.null(),
});
export interface PaidRenewalObjects {
  invoice: unknown;
  subscription: unknown;
  customer: unknown;
  paymentIntent: unknown;
  charge: unknown;
}
export function validatePaidRenewal(
  input: PaidRenewalObjects & {
    source: BillingSubscription;
    organizationCustomerId: string | null;
    environment: Record<string, string | undefined>;
    databaseNow: Date;
    replayPeriod?: boolean;
  },
) {
  const invoiceResult = renewalInvoiceSchema.safeParse(input.invoice);
  const paymentResult = paymentSchema.safeParse(input.paymentIntent);
  const chargeResult = chargeSchema.safeParse(input.charge);
  const subResult = z
    .object({
      latest_invoice: z.string(),
      trial_start: z.null(),
      trial_end: z.null(),
      cancel_at_period_end: z.literal(false),
      cancel_at: z.null(),
      canceled_at: seconds.nullable(),
    })
    .safeParse(input.subscription);
  if (
    !invoiceResult.success ||
    !paymentResult.success ||
    !chargeResult.success ||
    !subResult.success
  )
    renewalUnavailable("unsupported_provider_shape_or_adjustment");
  const invoice = invoiceResult.data,
    payment = paymentResult.data,
    charge = chargeResult.data;
  const line = invoice.lines.data[0];
  if (!line) renewalUnavailable("missing_recurring_line");
  const source = input.source;
  if (
    !source.current_period_start ||
    !source.current_period_end ||
    !Number.isFinite(source.current_period_start.getTime()) ||
    !Number.isFinite(source.current_period_end.getTime()) ||
    !Number.isFinite(input.databaseNow.getTime())
  )
    renewalUnavailable("invalid_source_period_or_clock");
  const plan = resolveSubscriptionPlanDefinition(source.plan_key, source.catalog_version);
  const binding = resolveSubscriptionProviderBinding(
    input.environment,
    source.plan_key,
    source.catalog_version,
  );
  const start = new Date(line.period.start * 1000),
    end = new Date(line.period.end * 1000);
  if (
    source.status !== "active" ||
    source.cancel_at_period_end ||
    source.ended_at !== null ||
    source.pending_plan_key !== null ||
    source.dunning_started_at !== null ||
    source.grace_expires_at !== null ||
    source.catalog_version !== "v1" ||
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start >= end ||
    start > input.databaseNow ||
    end <= input.databaseNow ||
    (input.replayPeriod
      ? start.getTime() !== source.current_period_start.getTime() ||
        end.getTime() !== source.current_period_end.getTime()
      : start.getTime() !== source.current_period_end.getTime()) ||
    subResult.data.canceled_at !==
      (source.canceled_at === null ? null : source.canceled_at.getTime() / 1000)
  )
    renewalUnavailable("unsupported_source_or_period");
  validateCancellationCustomer({
    raw: input.customer,
    source,
    organizationCustomerId: input.organizationCustomerId,
    environment: input.environment,
  });
  // This is structural validation of the new period; the old→new adjacency above remains authoritative.
  const observed = validatePeriodEndCancellationObservation({
    source: { ...source, current_period_start: start, current_period_end: end },
    organizationCustomerId: input.organizationCustomerId,
    environment: input.environment,
    raw: input.subscription,
    observedAt: input.databaseNow,
    requireScheduled: false,
    allowRetainedCanceledAt: source.canceled_at,
  });
  if (
    invoice.subscription !== source.stripe_subscription_id ||
    invoice.customer !== source.stripe_customer_id ||
    invoice.livemode !== binding.expectedLivemode ||
    subResult.data.latest_invoice !== invoice.id ||
    line.subscription !== source.stripe_subscription_id ||
    line.subscription_item !== source.stripe_subscription_item_id ||
    line.price.id !== binding.priceId ||
    line.price.product !== binding.productId ||
    [
      invoice.amount_paid,
      invoice.amount_due,
      invoice.total,
      invoice.subtotal,
      line.amount,
      payment.amount,
      payment.amount_received,
      charge.amount,
      charge.amount_captured,
    ].some((amount) => amount !== plan.amountCents) ||
    payment.id !== invoice.payment_intent ||
    payment.invoice !== invoice.id ||
    payment.customer !== invoice.customer ||
    payment.latest_charge !== invoice.charge ||
    payment.livemode !== invoice.livemode ||
    charge.id !== invoice.charge ||
    charge.invoice !== invoice.id ||
    charge.payment_intent !== payment.id ||
    charge.customer !== invoice.customer ||
    charge.livemode !== invoice.livemode
  )
    renewalUnavailable("payment_invoice_or_catalog_identity_mismatch");
  return {
    invoiceId: invoice.id,
    start,
    end,
    amount: plan.allowance.amountUsd,
    providerObjectDigest: observed.providerObjectDigest,
    grantDigest: createHash("sha256")
      .update(
        JSON.stringify([
          source.organization_id,
          source.id,
          source.provider,
          source.provider_environment,
          invoice.id,
          source.stripe_customer_id,
          source.stripe_subscription_id,
          source.stripe_subscription_item_id,
          source.plan_key,
          source.catalog_version,
          line.id,
          line.period.start,
          line.period.end,
          plan.allowance.amountUsd,
          payment.id,
          charge.id,
          plan.amountCents,
        ]),
      )
      .digest("hex"),
  };
}
