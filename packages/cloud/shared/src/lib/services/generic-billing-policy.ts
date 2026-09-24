/**
 * Derives app access and noncash allowance from verified subscription and
 * invoice observations. The finalizer evaluates this policy with its locked
 * database clock; redirects and webhook payloads are not entitlement evidence.
 */

import { ElizaError } from "@elizaos/core";
import type {
  BillingProviderInvoice,
  BillingProviderSubscription,
} from "./generic-billing-provider-types";

export interface AppBillingPolicyPlan {
  id: string;
  stripe_price_id: string;
  stripe_product_id: string;
  currency: string;
  minimum_quantity: number;
  maximum_quantity: number;
  trial_days: number;
  trial_allowance_usd: string;
  paid_allowance_usd: string;
  expired_access: "read_only" | "denied";
  entitlements: {
    features: string[];
    completionsRpm: number;
    embeddingsRpm: number;
    standardRpm: number;
    strictRpm: number;
  };
}

export interface AppBillingPolicyTrial {
  id: string;
  starts_at: Date;
  ends_at: Date;
  /** Allowance from the original claim's immutable plan, even after a plan change. */
  allowanceUsd: string;
}

export interface AppBillingPaidPeriod {
  subscriptionId: string;
  planRevisionId: string;
  priceId: string;
  quantity: number;
  periodStart: Date;
  periodEnd: Date;
}

export interface AppBillingPolicyDecision {
  state: BillingProviderSubscription["status"];
  entitlementEffective: boolean;
  access: "granted" | "read_only" | "denied";
  effectiveFrom: Date;
  effectiveUntil: Date;
  features: string[];
  quantity: number;
  rateLimits: {
    completionsRpm: number;
    embeddingsRpm: number;
    standardRpm: number;
    strictRpm: number;
  };
  grant: {
    source: "trial_claim" | "paid_invoice";
    amountUsd: string;
    periodStart: Date;
    periodEnd: Date;
    trialClaimId: string | null;
    invoiceId: string | null;
  } | null;
  qualifyingPaidPeriod: (AppBillingPaidPeriod & { invoiceId: string }) | null;
}

export interface AppBillingPolicyInput {
  plan: AppBillingPolicyPlan;
  subscription: BillingProviderSubscription;
  invoice: BillingProviderInvoice | null;
  trial: AppBillingPolicyTrial | null;
  /** Previously settled authority from this subscription, never a client assertion. */
  paidPeriod: AppBillingPaidPeriod | null;
  databaseNow: Date;
}

function requirePolicy(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new ElizaError(message, {
      code: "APP_BILLING_POLICY_INVALID",
      severity: "fatal",
    });
  }
}

function providerDate(seconds: number): Date {
  requirePolicy(
    Number.isSafeInteger(seconds) && seconds > 0,
    "Provider period must use valid UTC seconds",
  );
  const date = new Date(seconds * 1000);
  requirePolicy(Number.isFinite(date.getTime()), "Provider period exceeds supported date bounds");
  return date;
}

function amount(value: string): string {
  requirePolicy(
    /^(?:0|[1-9]\d{0,9})\.\d{6}$/u.test(value),
    "App allowance must be an exact nonnegative USD amount",
  );
  return value;
}

/** Replaying a decision is safe only inside the authority's current revision and lease fence. */
export function deriveAppBillingPolicy(input: AppBillingPolicyInput): AppBillingPolicyDecision {
  const { plan, subscription, invoice, trial, paidPeriod, databaseNow } = input;
  requirePolicy(Number.isFinite(databaseNow.getTime()), "App billing requires the database clock");
  requirePolicy(
    plan.trial_days === 7 &&
      subscription.priceId === plan.stripe_price_id &&
      subscription.productId === plan.stripe_product_id &&
      Number.isSafeInteger(subscription.quantity) &&
      subscription.quantity >= plan.minimum_quantity &&
      subscription.quantity <= plan.maximum_quantity,
    "Observed subscription does not match its immutable app plan",
  );
  amount(plan.trial_allowance_usd);
  amount(plan.paid_allowance_usd);
  for (const rate of [
    plan.entitlements.completionsRpm,
    plan.entitlements.embeddingsRpm,
    plan.entitlements.standardRpm,
    plan.entitlements.strictRpm,
  ]) {
    requirePolicy(
      Number.isSafeInteger(rate) && rate >= 0,
      "App rate limits must be nonnegative safe integers",
    );
  }
  let effectiveFrom = providerDate(subscription.currentPeriodStart);
  let effectiveUntil = providerDate(subscription.currentPeriodEnd);
  requirePolicy(effectiveUntil > effectiveFrom, "Subscription period must have ordered bounds");
  let entitlementEffective = false;
  let grant: AppBillingPolicyDecision["grant"] = null;
  let qualifyingPaidPeriod: AppBillingPolicyDecision["qualifyingPaidPeriod"] = null;

  if (invoice) {
    requirePolicy(
      invoice.subscriptionId === subscription.subscriptionId &&
        invoice.customerId === subscription.customerId &&
        invoice.currency === plan.currency,
      "Invoice does not belong to the observed subscription customer and currency",
    );
    if (invoice.payment) {
      requirePolicy(
        invoice.payment.paymentIntentId === invoice.paymentIntentId &&
          invoice.payment.customerId === invoice.customerId &&
          invoice.payment.currency === invoice.currency &&
          (invoice.payment.invoiceId === null || invoice.payment.invoiceId === invoice.invoiceId),
        "Invoice payment does not belong to its stored provider invoice and customer",
      );
    }
  }

  if (trial) {
    requirePolicy(
      Number.isFinite(trial.starts_at.getTime()) &&
        trial.ends_at.getTime() - trial.starts_at.getTime() === 604_800_000,
      "Recorded trial must preserve its original seven-day UTC interval",
    );
    amount(trial.allowanceUsd);
  }

  if (subscription.status === "trialing") {
    requirePolicy(trial !== null, "A provider trial requires a durable eligibility claim");
    requirePolicy(
      subscription.trialStart !== null &&
        subscription.trialEnd !== null &&
        providerDate(subscription.trialEnd).getTime() === trial.ends_at.getTime() &&
        providerDate(subscription.trialStart).getTime() >= trial.starts_at.getTime() &&
        subscription.trialStart < subscription.trialEnd,
      "Provider trial must retain the original claim end without inventing earlier access",
    );
    effectiveFrom = trial.starts_at;
    effectiveUntil = trial.ends_at;
    entitlementEffective = databaseNow >= effectiveFrom && databaseNow < effectiveUntil;
    if (entitlementEffective && trial.allowanceUsd !== "0.000000") {
      grant = {
        source: "trial_claim",
        amountUsd: trial.allowanceUsd,
        periodStart: effectiveFrom,
        periodEnd: effectiveUntil,
        trialClaimId: trial.id,
        invoiceId: null,
      };
    }
  } else if (subscription.status === "active") {
    const paidLine = invoice?.lines.find(
      (line) =>
        !line.proration &&
        line.lineType === "subscription" &&
        line.subscriptionId === subscription.subscriptionId &&
        line.subscriptionItemId === subscription.itemId &&
        line.priceId === subscription.priceId &&
        line.quantity === subscription.quantity &&
        line.amountCents -
          line.discountAmountsCents.reduce((total, discount) => total + discount, 0) >
          0 &&
        line.periodStart === subscription.currentPeriodStart &&
        line.periodEnd === subscription.currentPeriodEnd,
    );
    const capturedPayment =
      invoice !== null &&
      invoice.amountPaidCents > 0 &&
      invoice.payment !== null &&
      invoice.payment.status === "succeeded" &&
      invoice.payment.amountReceivedCents >= invoice.amountPaidCents;
    const qualifyingInvoice =
      invoice !== null &&
      invoice.status === "paid" &&
      invoice.paid &&
      !invoice.paidOutOfBand &&
      capturedPayment &&
      (invoice.billingReason === "subscription_create" ||
        invoice.billingReason === "subscription_cycle") &&
      paidLine !== undefined;
    const priorPeriodCoversCurrent =
      paidPeriod !== null &&
      paidPeriod.subscriptionId === subscription.subscriptionId &&
      paidPeriod.periodStart.getTime() <= effectiveFrom.getTime() &&
      paidPeriod.periodEnd.getTime() >= effectiveUntil.getTime();
    const previouslySettled =
      priorPeriodCoversCurrent &&
      paidPeriod !== null &&
      paidPeriod.planRevisionId === plan.id &&
      paidPeriod.priceId === subscription.priceId &&
      paidPeriod.quantity === subscription.quantity;
    const paidProration =
      priorPeriodCoversCurrent &&
      invoice !== null &&
      invoice.status === "paid" &&
      invoice.paid &&
      !invoice.paidOutOfBand &&
      invoice.billingReason === "subscription_update" &&
      (capturedPayment ||
        (invoice.amountPaidCents === 0 &&
          invoice.amountDueCents === 0 &&
          invoice.totalCents <= 0)) &&
      invoice.lines.some(
        (line) =>
          line.proration &&
          line.lineType === "subscription" &&
          line.subscriptionId === subscription.subscriptionId &&
          line.subscriptionItemId === subscription.itemId &&
          line.priceId === subscription.priceId &&
          line.quantity === subscription.quantity &&
          line.amountCents > 0 &&
          line.periodStart >= subscription.currentPeriodStart &&
          line.periodStart < subscription.currentPeriodEnd &&
          line.periodEnd === subscription.currentPeriodEnd,
      );
    if ((qualifyingInvoice || paidProration) && invoice !== null) {
      qualifyingPaidPeriod = {
        subscriptionId: subscription.subscriptionId,
        planRevisionId: plan.id,
        priceId: subscription.priceId,
        quantity: subscription.quantity,
        invoiceId: invoice.invoiceId,
        periodStart: effectiveFrom,
        periodEnd: effectiveUntil,
      };
    }
    entitlementEffective =
      (qualifyingInvoice || previouslySettled || paidProration) &&
      databaseNow >= effectiveFrom &&
      databaseNow < effectiveUntil;
    // Proration and seat-change invoices preserve the current period's budget.
    // A new period receives the configured account allowance exactly once.
    if (entitlementEffective && qualifyingInvoice && plan.paid_allowance_usd !== "0.000000") {
      grant = {
        source: "paid_invoice",
        amountUsd: plan.paid_allowance_usd,
        periodStart: effectiveFrom,
        periodEnd: effectiveUntil,
        trialClaimId: null,
        invoiceId: invoice.invoiceId,
      };
    }
  }

  return {
    state: subscription.status,
    entitlementEffective,
    access: entitlementEffective ? "granted" : plan.expired_access,
    effectiveFrom,
    effectiveUntil,
    features: entitlementEffective ? [...plan.entitlements.features] : [],
    quantity: subscription.quantity,
    rateLimits: {
      completionsRpm: entitlementEffective ? plan.entitlements.completionsRpm : 0,
      embeddingsRpm: entitlementEffective ? plan.entitlements.embeddingsRpm : 0,
      standardRpm: entitlementEffective ? plan.entitlements.standardRpm : 0,
      strictRpm: entitlementEffective ? plan.entitlements.strictRpm : 0,
    },
    grant,
    qualifyingPaidPeriod,
  };
}
