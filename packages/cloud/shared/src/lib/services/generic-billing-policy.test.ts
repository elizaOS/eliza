/**
 * Exercises the real app entitlement policy with deterministic provider
 * observations. These tests prevent unpaid upgrades, repeated allowance, and
 * access after trial expiry; provider wire and database atomicity have separate suites.
 */

import { describe, expect, test } from "bun:test";
import { type AppBillingPolicyInput, deriveAppBillingPolicy } from "./generic-billing-policy";

function paidInput(): AppBillingPolicyInput {
  const start = Date.parse("2026-10-01T12:00:00Z") / 1000;
  const end = Date.parse("2026-11-01T12:00:00Z") / 1000;
  return {
    plan: {
      id: "plan-basic-v1",
      stripe_price_id: "price_basic",
      stripe_product_id: "prod_app",
      currency: "usd",
      minimum_quantity: 1,
      maximum_quantity: 20,
      trial_days: 7,
      trial_allowance_usd: "2.000000",
      paid_allowance_usd: "10.000000",
      expired_access: "read_only",
      entitlements: {
        features: ["workspace:write"],
        completionsRpm: 10,
        embeddingsRpm: 10,
        standardRpm: 20,
        strictRpm: 5,
      },
    },
    subscription: {
      subscriptionId: "sub_primary",
      customerId: "cus_primary",
      itemId: "si_primary",
      status: "active",
      quantity: 2,
      priceId: "price_basic",
      productId: "prod_app",
      currentPeriodStart: start,
      currentPeriodEnd: end,
      trialStart: null,
      trialEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      endedAt: null,
      latestInvoiceId: "in_cycle",
      pendingUpdate: false,
    },
    invoice: {
      hostedInvoiceUrl: null,
      invoiceId: "in_cycle",
      subscriptionId: "sub_primary",
      customerId: "cus_primary",
      chargeId: "ch_cycle",
      paymentIntentId: "pi_cycle",
      status: "paid",
      paid: true,
      paidOutOfBand: false,
      payment: {
        paymentIntentId: "pi_cycle",
        status: "succeeded",
        amountReceivedCents: 2000,
        customerId: "cus_primary",
        currency: "usd",
        invoiceId: "in_cycle",
      },
      amountPaidCents: 2000,
      amountDueCents: 2000,
      billingReason: "subscription_cycle",
      subtotalCents: 2000,
      subtotalExcludingTaxCents: 2000,
      totalCents: 2000,
      taxCents: 0,
      discountCents: 0,
      currency: "usd",
      periodStart: start,
      periodEnd: end,
      lines: [
        {
          lineId: "il_cycle",
          lineType: "subscription",
          subscriptionId: "sub_primary",
          subscriptionItemId: "si_primary",
          priceId: "price_basic",
          quantity: 2,
          discountAmountsCents: [],
          taxAmountsCents: [],
          amountCents: 2000,
          periodStart: start,
          periodEnd: end,
          proration: false,
        },
      ],
    },
    trial: null,
    paidPeriod: null,
    databaseNow: new Date("2026-10-02T12:00:00Z"),
  };
}

function trialInput(): AppBillingPolicyInput {
  const input = paidInput();
  // This week crosses the US daylight-saving transition; the contract is UTC.
  const start = new Date("2026-10-29T14:00:00Z");
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  input.databaseNow = new Date(start.getTime() + 1000);
  input.trial = { id: "trial_original", starts_at: start, ends_at: end, allowanceUsd: "2.000000" };
  input.subscription.status = "trialing";
  input.subscription.currentPeriodStart = start.getTime() / 1000;
  input.subscription.currentPeriodEnd = end.getTime() / 1000;
  input.subscription.trialStart = start.getTime() / 1000;
  input.subscription.trialEnd = end.getTime() / 1000;
  input.invoice = null;
  return input;
}

describe("app subscription entitlement policy", () => {
  test("paid renewal grants the configured account allowance and retains paid proof", () => {
    const result = deriveAppBillingPolicy(paidInput());
    expect(result.access).toBe("granted");
    expect(result.grant?.source).toBe("paid_invoice");
    expect(result.grant?.amountUsd).toBe("10.000000");
    expect(result.qualifyingPaidPeriod?.invoiceId).toBe("in_cycle");
  });

  test("a paid plan without included usage still establishes access authority", () => {
    const input = paidInput();
    input.plan.paid_allowance_usd = "0.000000";
    const result = deriveAppBillingPolicy(input);
    expect(result.entitlementEffective).toBe(true);
    expect(result.grant).toBeNull();
    expect(result.qualifyingPaidPeriod).not.toBeNull();
  });

  test("active provider state alone cannot grant paid access", () => {
    const input = paidInput();
    input.invoice = null;
    const result = deriveAppBillingPolicy(input);
    expect(result.access).toBe("read_only");
    expect(result.features).toEqual([]);
    expect(result.grant).toBeNull();
  });

  test("an out-of-band paid marker or uncaptured payment cannot mint recurring allowance", () => {
    const marked = paidInput();
    if (!marked.invoice) throw new Error("Paid fixture must have invoice evidence");
    marked.invoice.paidOutOfBand = true;
    expect(deriveAppBillingPolicy(marked).grant).toBeNull();
    for (const status of ["processing", "requires_capture", "canceled"] as const) {
      const input = paidInput();
      if (!input.invoice?.payment) throw new Error("Paid fixture must have payment evidence");
      input.invoice.payment.status = status;
      const result = deriveAppBillingPolicy(input);
      expect(result.entitlementEffective).toBe(false);
      expect(result.grant).toBeNull();
    }
    const input = paidInput();
    if (!input.invoice?.payment) throw new Error("Paid fixture must have payment evidence");
    input.invoice.payment.amountReceivedCents = 0;
    expect(deriveAppBillingPolicy(input).qualifyingPaidPeriod).toBeNull();
  });

  test("payment evidence for another invoice cannot authorize this subscription", () => {
    const input = paidInput();
    if (!input.invoice?.payment) throw new Error("Paid fixture must have payment evidence");
    input.invoice.payment.invoiceId = "in_other";
    expect(() => deriveAppBillingPolicy(input)).toThrow("payment does not belong");
  });

  test("zero-value trial invoice cannot grant paid allowance or paid access", () => {
    const input = paidInput();
    if (!input.invoice) throw new Error("Paid fixture must have invoice evidence");
    input.invoice.amountPaidCents = 0;
    input.invoice.billingReason = "subscription_create";
    const result = deriveAppBillingPolicy(input);
    expect(result.entitlementEffective).toBe(false);
    expect(result.grant).toBeNull();
    expect(result.qualifyingPaidPeriod).toBeNull();
  });

  test("invoice customer, currency and line ownership must match the subscription", () => {
    for (const field of ["customerId", "subscriptionId", "currency"] as const) {
      const input = paidInput();
      if (!input.invoice) throw new Error("Paid fixture must have invoice evidence");
      input.invoice[field] = "other";
      expect(() => deriveAppBillingPolicy(input)).toThrow("Invoice does not belong");
    }
    const input = paidInput();
    if (!input.invoice?.lines[0]) throw new Error("Paid fixture must have a recurring line");
    input.invoice.lines[0].subscriptionItemId = "si_other";
    expect(deriveAppBillingPolicy(input).entitlementEffective).toBe(false);
  });

  test("payment of an unrelated invoice fee cannot fund a fully discounted subscription line", () => {
    const input = paidInput();
    if (!input.invoice?.lines[0]) throw new Error("Paid fixture must have a recurring line");
    input.invoice.amountPaidCents = 100;
    input.invoice.lines[0].discountAmountsCents = [input.invoice.lines[0].amountCents];
    const result = deriveAppBillingPolicy(input);
    expect(result.entitlementEffective).toBe(false);
    expect(result.grant).toBeNull();
  });

  test("trial expiry denies paid capabilities at the exact UTC boundary", () => {
    const input = trialInput();
    if (!input.trial) throw new Error("Trial fixture must have a claim");
    input.databaseNow = new Date(input.trial.ends_at.getTime() - 1);
    expect(deriveAppBillingPolicy(input).entitlementEffective).toBe(true);
    input.databaseNow = input.trial.ends_at;
    const expired = deriveAppBillingPolicy(input);
    expect(expired.entitlementEffective).toBe(false);
    expect(expired.grant).toBeNull();
    expect(expired.rateLimits.completionsRpm).toBe(0);
  });

  test("plan and seat changes do not extend a trial or increase its original budget", () => {
    const input = trialInput();
    input.plan.id = "plan-expanded-v2";
    input.plan.trial_allowance_usd = "50.000000";
    input.subscription.quantity = 10;
    const changed = deriveAppBillingPolicy(input);
    expect(changed.grant?.amountUsd).toBe("2.000000");
    expect(changed.grant?.trialClaimId).toBe("trial_original");
    input.subscription.trialEnd = (input.subscription.trialEnd ?? 0) + 1;
    expect(() => deriveAppBillingPolicy(input)).toThrow("original claim end");
  });

  test("provider trial without eligibility authority is rejected", () => {
    const input = trialInput();
    input.trial = null;
    expect(() => deriveAppBillingPolicy(input)).toThrow("durable eligibility claim");
  });

  test("a prepared future trial does not grant access early", () => {
    const input = trialInput();
    if (!input.trial) throw new Error("Trial fixture must have a claim");
    input.databaseNow = new Date(input.trial.starts_at.getTime() - 1);
    expect(deriveAppBillingPolicy(input).entitlementEffective).toBe(false);
  });

  test.each([
    "canceled",
    "paused",
    "unpaid",
    "past_due",
    "incomplete",
    "incomplete_expired",
  ] as const)("%s cannot retain paid capabilities", (status) => {
    const input = paidInput();
    input.subscription.status = status;
    const result = deriveAppBillingPolicy(input);
    expect(result.entitlementEffective).toBe(false);
    expect(result.grant).toBeNull();
  });

  test("cancellation scheduled for period end expires even if the webhook is late", () => {
    const input = paidInput();
    input.subscription.cancelAtPeriodEnd = true;
    expect(deriveAppBillingPolicy(input).entitlementEffective).toBe(true);
    input.databaseNow = new Date(input.subscription.currentPeriodEnd * 1000);
    expect(deriveAppBillingPolicy(input).entitlementEffective).toBe(false);
  });

  test("an earlier paid plan cannot authorize unpaid target price or quantity", () => {
    const input = paidInput();
    const proof = deriveAppBillingPolicy(input).qualifyingPaidPeriod;
    if (!proof) throw new Error("Paid fixture must produce paid-period proof");
    input.paidPeriod = proof;
    input.invoice = null;
    expect(deriveAppBillingPolicy(input).entitlementEffective).toBe(true);
    input.subscription.quantity = 3;
    input.subscription.pendingUpdate = true;
    expect(deriveAppBillingPolicy(input).entitlementEffective).toBe(false);
  });

  test("paid proration authorizes the new seats without refilling the period allowance", () => {
    const input = paidInput();
    input.paidPeriod = deriveAppBillingPolicy(input).qualifyingPaidPeriod;
    if (!input.invoice?.lines[0]) throw new Error("Paid fixture must have a recurring line");
    input.subscription.quantity = 3;
    input.invoice.billingReason = "subscription_update";
    input.invoice.lines[0].quantity = 3;
    input.invoice.lines[0].proration = true;
    input.invoice.lines[0].periodStart += 86_400;
    const result = deriveAppBillingPolicy(input);
    expect(result.entitlementEffective).toBe(true);
    expect(result.qualifyingPaidPeriod?.quantity).toBe(3);
    expect(result.grant).toBeNull();
  });

  test("an uncaptured positive proration cannot authorize an upgrade", () => {
    const input = paidInput();
    input.paidPeriod = deriveAppBillingPolicy(input).qualifyingPaidPeriod;
    if (!input.invoice?.lines[0] || !input.invoice.payment)
      throw new Error("Missing paid evidence");
    input.subscription.quantity = 3;
    input.invoice.billingReason = "subscription_update";
    input.invoice.lines[0].quantity = 3;
    input.invoice.lines[0].proration = true;
    input.invoice.payment.status = "processing";
    const result = deriveAppBillingPolicy(input);
    expect(result.entitlementEffective).toBe(false);
    expect(result.qualifyingPaidPeriod).toBeNull();
    expect(result.grant).toBeNull();
  });

  test.each([0, -500])(
    "a settled %s-cent downgrade preserves existing paid access without a refill",
    (total) => {
      const input = paidInput();
      input.paidPeriod = deriveAppBillingPolicy(input).qualifyingPaidPeriod;
      if (!input.invoice?.lines[0]) throw new Error("Missing paid evidence");
      input.subscription.quantity = 1;
      input.invoice.billingReason = "subscription_update";
      input.invoice.lines[0].quantity = 1;
      input.invoice.lines[0].proration = true;
      input.invoice.payment = null;
      input.invoice.paymentIntentId = null;
      input.invoice.amountPaidCents = 0;
      input.invoice.amountDueCents = 0;
      input.invoice.totalCents = total;
      const result = deriveAppBillingPolicy(input);
      expect(result.entitlementEffective).toBe(true);
      expect(result.qualifyingPaidPeriod?.quantity).toBe(1);
      expect(result.grant).toBeNull();
      input.paidPeriod = null;
      expect(deriveAppBillingPolicy(input).entitlementEffective).toBe(false);
    },
  );

  test("a paid invoice for a prior period cannot prepay an unpaid renewal", () => {
    const input = paidInput();
    input.paidPeriod = deriveAppBillingPolicy(input).qualifyingPaidPeriod;
    input.subscription.currentPeriodStart = input.subscription.currentPeriodEnd;
    input.subscription.currentPeriodEnd += 30 * 86_400;
    input.databaseNow = new Date((input.subscription.currentPeriodStart + 1) * 1000);
    expect(deriveAppBillingPolicy(input).entitlementEffective).toBe(false);
  });
});
