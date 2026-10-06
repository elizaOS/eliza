/** Validates settled platform Stripe invoices for first activation and adjacent renewals; unsupported billing adjustments never become allowance authority. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { BillingSubscription } from "../../db/schemas/billing-subscriptions";
import type { proveOriginalConfiguredTarget } from "./organization-schedule-target-authority";
import {
  observeScheduledTargetLiveSubscription,
  observeScheduledTargetSubscription,
} from "./organization-schedule-target-observation";
import { assertOrganizationSubscription } from "./organization-subscription-source";
import { createRenewalInvoiceAuthority } from "./renewal-invoice-authority";
import { createRenewalInvoiceDetails } from "./renewal-invoice-details";
import { createRenewalSettlementDetails } from "./renewal-settlement-details";

import { validateCancellationCustomer } from "./stripe-period-end-cancellation";
import { observeOrdinaryRenewalLiveSubscription } from "./stripe-renewal-live-observation";
import { initialInvoiceSchema, renewalInvoiceSchema } from "./stripe-settled-invoice-schema";
import {
  renewalUnavailable,
  validateSettledRenewalPayment,
} from "./stripe-settled-renewal-payment";
import {
  resolveSubscriptionPlanDefinition,
  resolveSubscriptionProviderBinding,
} from "./subscription-catalog";
import { SUBSCRIPTION_PAYMENT_GRACE_MS } from "./subscription-payment-grace";

export {
  initialInvoiceSchema,
  renewalInvoiceSchema,
  renewalUnavailable,
  validateSettledRenewalPayment,
};

const seconds = z.number().int().nonnegative().safe();
export interface PaidRenewalObjects {
  /** Current account retrieved alongside a persisted purchase contract; absent for legacy authority. */
  providerAccountId?: string;
  invoice: unknown;
  subscription: unknown;
  customer: unknown;
  paymentIntent: unknown;
  charge: unknown;
  /** Complete canonical customer invoice-balance history when starting credit is present. */
  balanceHistory?: unknown;
  /** Fresh authenticated schedule for an originally configured pending target. */
  scheduledSchedule?: unknown;
}
export function validatePaidRenewal(
  input: PaidRenewalObjects & {
    source: BillingSubscription;
    organizationCustomerId: string | null;
    environment: Record<string, string | undefined>;
    databaseNow: Date;
    replayPeriod?: boolean;
    initialPayment?: boolean;
    scheduledTarget?: ReturnType<typeof proveOriginalConfiguredTarget>;
  },
) {
  const invoiceResult = (
    input.initialPayment ? initialInvoiceSchema : renewalInvoiceSchema
  ).safeParse(input.invoice);
  const subResult = z
    .object({
      latest_invoice: z.string(),
      status: z.enum(["active", "past_due", "unpaid"]),
      trial_start: z.null(),
      trial_end: z.null(),
      cancel_at_period_end: z.literal(false),
      cancel_at: z.null(),
      canceled_at: seconds.nullable(),
    })
    .safeParse(input.subscription);
  if (!invoiceResult.success || !subResult.success)
    renewalUnavailable("unsupported_provider_shape_or_adjustment");
  const invoice = invoiceResult.data;
  const line = invoice.lines.data[0];
  if (!line) renewalUnavailable("missing_recurring_line");
  const source = input.source;
  assertOrganizationSubscription(source);
  if (
    !source.current_period_start ||
    !source.current_period_end ||
    !Number.isFinite(source.current_period_start.getTime()) ||
    !Number.isFinite(source.current_period_end.getTime()) ||
    !Number.isFinite(input.databaseNow.getTime())
  )
    renewalUnavailable("invalid_source_period_or_clock");
  const target = input.scheduledTarget;
  if (
    target &&
    (input.initialPayment ||
      input.replayPeriod ||
      target.currentSubscriptionRevision !== source.lifecycle_revision ||
      target.targetPlanKey !== source.pending_plan_key)
  )
    renewalUnavailable("scheduled_target_source_changed");
  const plan = resolveSubscriptionPlanDefinition(
    target?.targetPlanKey ?? source.plan_key,
    source.catalog_version,
  );
  const binding = target
    ? {
        priceId: target.binding.targetPriceId,
        productId: target.binding.targetProductId,
        expectedLivemode: target.binding.livemode,
      }
    : resolveSubscriptionProviderBinding(
        input.environment,
        source.plan_key,
        source.catalog_version,
      );
  const start = new Date(line.period.start * 1000),
    end = new Date(line.period.end * 1000);
  const historicalPeriod = !input.initialPayment && !input.replayPeriod && end <= input.databaseNow;
  // A renewal paid after failed attempts settles dunning: the stored period is
  // still the one that came due, so adjacency below is unchanged.
  const dunning = source.status !== "active";
  if (
    !["active", "grace", "past_due", "unpaid"].includes(source.status) ||
    (dunning && (source.dunning_started_at === null || input.initialPayment)) ||
    (!dunning && (source.dunning_started_at !== null || source.grace_expires_at !== null)) ||
    source.cancel_at_period_end ||
    source.ended_at !== null ||
    (!target && source.pending_plan_key !== null) ||
    source.catalog_version !== "v1" ||
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start >= end ||
    (target &&
      (start.getTime() !== target.phase.start.getTime() ||
        end.getTime() !== target.phase.end.getTime())) ||
    start > input.databaseNow ||
    (!historicalPeriod && end <= input.databaseNow) ||
    (input.replayPeriod || input.initialPayment
      ? start.getTime() !== source.current_period_start.getTime() ||
        end.getTime() !== source.current_period_end.getTime()
      : start.getTime() !== source.current_period_end.getTime()) ||
    subResult.data.canceled_at !==
      (source.canceled_at === null ? null : source.canceled_at.getTime() / 1000)
  )
    renewalUnavailable("unsupported_source_or_period");
  if (!target)
    validateCancellationCustomer({
      raw: input.customer,
      source,
      organizationCustomerId: input.organizationCustomerId,
      environment: input.environment,
    });
  // This is structural validation of the new period; the old→new adjacency above remains authoritative.
  const targetInput = target
    ? {
        source,
        authority: target,
        organizationCustomerId: input.organizationCustomerId,
        rawSubscription: input.subscription,
        rawCustomer: input.customer,
        invoiceId: invoice.id,
        observedAt: input.databaseNow,
        retainedCanceledAt: source.canceled_at,
      }
    : null;
  const ordinaryObservation = targetInput
    ? null
    : observeOrdinaryRenewalLiveSubscription({
        source,
        raw: input.subscription,
        observedAt: input.databaseNow,
        paidStart: start,
        paidEnd: end,
        historical: historicalPeriod,
        binding,
        amountCents: plan.amountCents,
      });
  const historicalObservation = historicalPeriod
    ? targetInput
      ? observeScheduledTargetLiveSubscription(targetInput, subResult.data.status)
      : ordinaryObservation
    : null;
  const targetObservation = targetInput
    ? (historicalObservation ?? observeScheduledTargetSubscription(targetInput))
    : null;
  const observed = targetObservation ?? ordinaryObservation;
  if (!observed) renewalUnavailable("live_observation_missing");
  const subscriptionItemId =
    historicalObservation && target
      ? line.subscription_item
      : (targetObservation?.subscriptionItemId ?? source.stripe_subscription_item_id);
  if (
    historicalObservation
      ? subResult.data.latest_invoice === invoice.id ||
        !/^si_[A-Za-z0-9]+$/.test(line.subscription_item) ||
        invoice.status_transitions.paid_at * 1000 > input.databaseNow.getTime()
      : subResult.data.latest_invoice !== invoice.id
  )
    renewalUnavailable("payment_invoice_or_catalog_identity_mismatch");
  if (!source.stripe_subscription_id || !source.stripe_customer_id || !subscriptionItemId)
    renewalUnavailable("missing_payment_owner");
  const { payment, charge, adjustmentDigest, settlementDigest } = validateSettledRenewalPayment({
    invoice: input.invoice,
    paymentIntent: input.paymentIntent,
    charge: input.charge,
    balanceHistory: input.balanceHistory,
    initialPayment: input.initialPayment,
    expected: {
      subscriptionId: source.stripe_subscription_id,
      customerId: source.stripe_customer_id,
      subscriptionItemId,
      priceId: binding.priceId,
      productId: binding.productId,
      livemode: binding.expectedLivemode,
      amountCents: plan.amountCents,
      start,
      end,
    },
  });
  const laterDunning = historicalObservation && historicalObservation.providerStatus !== "active";
  const graceExpiresAt = laterDunning
    ? new Date(end.getTime() + SUBSCRIPTION_PAYMENT_GRACE_MS)
    : null;
  const status: "active" | "grace" | "past_due" | "unpaid" = !laterDunning
    ? "active"
    : historicalObservation.providerStatus === "unpaid"
      ? "unpaid"
      : input.databaseNow < graceExpiresAt!
        ? "grace"
        : "past_due";
  const grantDigest = createHash("sha256")
    .update(
      JSON.stringify([
        source.organization_id,
        source.id,
        source.provider,
        source.provider_environment,
        invoice.id,
        source.stripe_customer_id,
        source.stripe_subscription_id,
        subscriptionItemId,
        plan.key,
        source.catalog_version,
        line.id,
        line.period.start,
        line.period.end,
        plan.allowance.amountUsd,
        payment?.id ?? null,
        charge?.id ?? null,
        plan.amountCents,
        ...(adjustmentDigest ? [adjustmentDigest] : []),
        ...(settlementDigest ? [settlementDigest] : []),
      ]),
    )
    .digest("hex");
  const invoiceAuthority = createRenewalInvoiceAuthority({
    kind: "renewal_invoice_authority",
    version: 1,
    organizationId: source.organization_id,
    subscriptionId: source.id,
    providerAccountId: input.providerAccountId ?? null,
    invoiceId: invoice.id,
    customerId: invoice.customer,
    providerSubscriptionId: invoice.subscription,
    subscriptionItemId,
    invoiceLineId: line.id,
    priceId: line.price.id,
    productId: line.price.product,
    livemode: invoice.livemode,
    currency: invoice.currency,
    periodStart: line.period.start,
    periodEnd: line.period.end,
    invoiceTotal: invoice.total,
    amountPaid: invoice.amount_paid,
    paymentIntentId: payment?.id ?? null,
    chargeId: charge?.id ?? null,
    adjustmentDigest: adjustmentDigest ?? null,
    settlementDigest: settlementDigest ?? null,
    grantDigest,
  });
  const invoiceDetails = createRenewalInvoiceDetails(input.invoice, invoiceAuthority);
  return {
    invoiceId: invoice.id,
    planKey: plan.key,
    subscriptionItemId,
    scheduledTarget: target !== undefined,
    status,
    dunningStartedAt: laterDunning ? end : null,
    graceExpiresAt,
    start,
    end,
    amount: plan.allowance.amountUsd,
    providerObjectDigest: observed.providerObjectDigest,
    grantDigest,
    invoiceAuthority,
    invoiceDetails,
    settlementDetails: createRenewalSettlementDetails(
      { payment, charge, balanceHistory: input.balanceHistory },
      invoiceDetails,
      invoiceAuthority,
    ),
  };
}
