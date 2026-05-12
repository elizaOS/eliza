/**
 * Tests for the container-billing decision policy.
 *
 * This is the load-bearing rule of the survival-economics loop: when an
 * org has redeemable earnings available, the daily container charge
 * pulls from earnings BEFORE credits (when `pay_as_you_go_from_earnings`
 * is on). Without this ordering, an earning agent would burn through the
 * owner's credit balance even though their app is generating revenue.
 *
 * The policy lives in a standalone pure function (`computeContainerBillingPlan`)
 * so we can prove the rules without a real database.
 */

import { describe, expect, test } from "bun:test";

import { computeContainerBillingPlan } from "@/lib/services/container-billing-policy";

describe("computeContainerBillingPlan", () => {
  test("pay-as-you-go ON: earnings cover full cost → credits untouched", () => {
    const plan = computeContainerBillingPlan({
      dailyCost: 0.67,
      currentBalance: 10.0,
      ownerEarningsAvailable: 2.0,
      payAsYouGoFromEarnings: true,
    });

    expect(plan.action).toBe("billed");
    expect(plan.fromEarnings).toBe(0.67);
    expect(plan.fromCredits).toBe(0);
    expect(plan.earningsEligible).toBe(2.0);
    expect(plan.totalAvailable).toBe(12.0);
  });

  test("pay-as-you-go ON: earnings cover partial cost → credits cover the rest", () => {
    const plan = computeContainerBillingPlan({
      dailyCost: 1.0,
      currentBalance: 5.0,
      ownerEarningsAvailable: 0.3,
      payAsYouGoFromEarnings: true,
    });

    expect(plan.action).toBe("billed");
    expect(plan.fromEarnings).toBe(0.3);
    expect(plan.fromCredits).toBe(0.7);
    expect(plan.earningsEligible).toBe(0.3);
    expect(plan.totalAvailable).toBe(5.3);
  });

  test("pay-as-you-go ON with zero earnings → credits cover full cost", () => {
    const plan = computeContainerBillingPlan({
      dailyCost: 0.67,
      currentBalance: 5.0,
      ownerEarningsAvailable: 0,
      payAsYouGoFromEarnings: true,
    });

    expect(plan.action).toBe("billed");
    expect(plan.fromEarnings).toBe(0);
    expect(plan.fromCredits).toBe(0.67);
  });

  test("pay-as-you-go OFF: earnings preserved → credits cover full cost", () => {
    const plan = computeContainerBillingPlan({
      dailyCost: 0.67,
      currentBalance: 5.0,
      ownerEarningsAvailable: 100.0, // plenty of earnings but toggle is off
      payAsYouGoFromEarnings: false,
    });

    expect(plan.action).toBe("billed");
    expect(plan.fromEarnings).toBe(0);
    expect(plan.fromCredits).toBe(0.67);
    expect(plan.earningsEligible).toBe(0);
  });

  test("pay-as-you-go OFF, insufficient credits → insufficient (earnings ignored)", () => {
    const plan = computeContainerBillingPlan({
      dailyCost: 0.67,
      currentBalance: 0.5,
      ownerEarningsAvailable: 100.0, // would cover it, but toggle is off
      payAsYouGoFromEarnings: false,
    });

    expect(plan.action).toBe("insufficient");
    expect(plan.fromEarnings).toBe(0);
    expect(plan.fromCredits).toBe(0);
    expect(plan.totalAvailable).toBe(0.5);
  });

  test("pay-as-you-go ON, both empty → insufficient", () => {
    const plan = computeContainerBillingPlan({
      dailyCost: 0.67,
      currentBalance: 0,
      ownerEarningsAvailable: 0,
      payAsYouGoFromEarnings: true,
    });

    expect(plan.action).toBe("insufficient");
    expect(plan.totalAvailable).toBe(0);
  });

  test("pay-as-you-go ON, exact match on earnings + credits → still billed", () => {
    // Boundary case: total = dailyCost exactly.
    const plan = computeContainerBillingPlan({
      dailyCost: 1.0,
      currentBalance: 0.5,
      ownerEarningsAvailable: 0.5,
      payAsYouGoFromEarnings: true,
    });

    expect(plan.action).toBe("billed");
    expect(plan.fromEarnings).toBe(0.5);
    expect(plan.fromCredits).toBe(0.5);
  });

  test("pay-as-you-go ON, earnings exceed cost → only the needed amount is swept", () => {
    // Earnings = $100 but cost is $0.67. We must NOT drain all the earnings,
    // only the amount needed today. The rest stays available for cashout /
    // tomorrow's bill.
    const plan = computeContainerBillingPlan({
      dailyCost: 0.67,
      currentBalance: 0,
      ownerEarningsAvailable: 100.0,
      payAsYouGoFromEarnings: true,
    });

    expect(plan.action).toBe("billed");
    expect(plan.fromEarnings).toBe(0.67);
    expect(plan.fromCredits).toBe(0);
  });
});
