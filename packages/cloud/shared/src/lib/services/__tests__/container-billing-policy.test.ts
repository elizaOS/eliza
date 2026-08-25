/**
 * Unit coverage for the pure container-billing split policy: earnings-first
 * charging, the pay-as-you-go opt-out freeze, and the insufficient-warning
 * boundary. Pure function under test — no harness, deterministic.
 */

import { describe, expect, test } from "bun:test";

import { computeContainerBillingPlan } from "../container-billing-policy";

describe("computeContainerBillingPlan", () => {
  test("earnings absorb the bill first; credits cover only the remainder", () => {
    const plan = computeContainerBillingPlan({
      dailyCost: 2.5,
      currentBalance: 5,
      ownerEarningsAvailable: 1,
      payAsYouGoFromEarnings: true,
    });
    expect(plan).toEqual({
      action: "billed",
      fromEarnings: 1,
      fromCredits: 1.5,
      totalAvailable: 6,
      earningsEligible: 1,
    });
  });

  test("a single fully-funded charge debits credits for exactly the cost", () => {
    const plan = computeContainerBillingPlan({
      dailyCost: 0.75,
      currentBalance: 0.75,
      ownerEarningsAvailable: 0,
      payAsYouGoFromEarnings: true,
    });
    expect(plan.action).toBe("billed");
    expect(plan.fromEarnings).toBe(0);
    expect(plan.fromCredits).toBe(0.75);
  });

  test("earnings alone can carry the full daily cost (survival economics)", () => {
    const plan = computeContainerBillingPlan({
      dailyCost: 1,
      currentBalance: 0,
      ownerEarningsAvailable: 3,
      payAsYouGoFromEarnings: true,
    });
    expect(plan.action).toBe("billed");
    expect(plan.fromEarnings).toBe(1);
    expect(plan.fromCredits).toBe(0);
  });

  test("opting out freezes earnings entirely — credits pay the whole bill", () => {
    const plan = computeContainerBillingPlan({
      dailyCost: 2,
      currentBalance: 4,
      ownerEarningsAvailable: 10,
      payAsYouGoFromEarnings: false,
    });
    expect(plan).toEqual({
      action: "billed",
      fromEarnings: 0,
      fromCredits: 2,
      totalAvailable: 4,
      earningsEligible: 0,
    });
  });

  test("opting out also excludes earnings from the insufficiency check", () => {
    // 1 credit + 10 earnings with the toggle off is still insufficient for a
    // 2 charge: earnings never count when the org opted out.
    const plan = computeContainerBillingPlan({
      dailyCost: 2,
      currentBalance: 1,
      ownerEarningsAvailable: 10,
      payAsYouGoFromEarnings: false,
    });
    expect(plan).toEqual({
      action: "insufficient",
      fromEarnings: 0,
      fromCredits: 0,
      totalAvailable: 1,
      earningsEligible: 0,
    });
  });

  test("insufficient when earnings plus credits cannot cover the cost", () => {
    const plan = computeContainerBillingPlan({
      dailyCost: 3,
      currentBalance: 1,
      ownerEarningsAvailable: 1,
      payAsYouGoFromEarnings: true,
    });
    expect(plan).toEqual({
      action: "insufficient",
      fromEarnings: 0,
      fromCredits: 0,
      totalAvailable: 2,
      earningsEligible: 1,
    });
  });

  test("the exact-availability boundary still bills (strict insufficiency)", () => {
    const plan = computeContainerBillingPlan({
      dailyCost: 3,
      currentBalance: 2,
      ownerEarningsAvailable: 1,
      payAsYouGoFromEarnings: true,
    });
    expect(plan.action).toBe("billed");
    expect(plan.fromEarnings).toBe(1);
    expect(plan.fromCredits).toBe(2);
  });

  test("a zero-cost day is a no-op bill, not insufficiency", () => {
    const plan = computeContainerBillingPlan({
      dailyCost: 0,
      currentBalance: 0,
      ownerEarningsAvailable: 0,
      payAsYouGoFromEarnings: true,
    });
    expect(plan.action).toBe("billed");
    expect(plan.fromEarnings).toBe(0);
    expect(plan.fromCredits).toBe(0);
  });
});
