/**
 * Unit coverage for the pure container-billing split policy: earnings-first
 * charging, the pay-as-you-go opt-out freeze, and the insufficient-warning
 * boundary. Pure function under test — no harness, deterministic.
 */

import { describe, expect, test } from "bun:test";

import { ElizaError } from "@elizaos/core";

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

  test("a negative credit balance is legitimate and fails closed as insufficient", () => {
    // Raw SQL storage debits (org-storage-mutations.ts) can leave
    // credit_balance below zero; the policy must route that to the ordinary
    // insufficiency path rather than throw.
    const plan = computeContainerBillingPlan({
      dailyCost: 1,
      currentBalance: -0.5,
      ownerEarningsAvailable: 1,
      payAsYouGoFromEarnings: true,
    });
    expect(plan.action).toBe("insufficient");
    expect(plan.totalAvailable).toBe(0.5);
    expect(plan.fromEarnings).toBe(0);
    expect(plan.fromCredits).toBe(0);
  });
});

describe("computeContainerBillingPlan — money math fails closed on garbage input", () => {
  // Pre-fix behavior: NaN inputs fell through float comparison
  // (`totalAvailable < dailyCost` is false for NaN) and returned
  // action:"billed" with NaN debit legs. The typed throw closes that vector.
  const invalidInputs: Array<[string, number, number, number]> = [
    ["dailyCost NaN", Number.NaN, 5, 1],
    ["currentBalance NaN", 1, Number.NaN, 1],
    ["ownerEarningsAvailable NaN", 1, 5, Number.NaN],
    ["dailyCost +Infinity", Number.POSITIVE_INFINITY, 5, 1],
    ["ownerEarningsAvailable +Infinity", 1, 5, Number.POSITIVE_INFINITY],
    ["negative dailyCost", -1, 5, 2],
    [
      "negative ownerEarningsAvailable (schema CHECK enforces >= 0; invalid data, not a live state)",
      1,
      5,
      -1,
    ],
  ];

  for (const [label, dailyCost, currentBalance, ownerEarningsAvailable] of invalidInputs) {
    test(`${label} throws a typed error instead of returning a plan`, () => {
      let thrown: unknown;
      try {
        computeContainerBillingPlan({
          dailyCost,
          currentBalance,
          ownerEarningsAvailable,
          payAsYouGoFromEarnings: true,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      // The stated contract is specifically ElizaError — assert the class, not
      // just an error-shaped object.
      expect(thrown).toBeInstanceOf(ElizaError);
      const err = thrown as { code?: string; message?: string };
      expect(err.code).toBe("CONTAINER_BILLING_PLAN_INPUT_INVALID");
      expect(err.message).toMatch(/must be a finite number|must be >= 0/);
    });
  }

  test("every field is validated even when the toggle makes earnings unused", () => {
    // payAsYouGoFromEarnings=false would never read ownerEarningsAvailable
    // downstream, but the input contract validates all fields regardless.
    let thrown: unknown;
    try {
      computeContainerBillingPlan({
        dailyCost: 1,
        currentBalance: 5,
        ownerEarningsAvailable: Number.NaN,
        payAsYouGoFromEarnings: false,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ElizaError);
    expect((thrown as { code?: string }).code).toBe("CONTAINER_BILLING_PLAN_INPUT_INVALID");
  });
});

describe("computeContainerBillingPlan — float residue vs the Decimal ledger path", () => {
  test("the mixed split at the DB suite's realistic 0.027917/hour rate is deliberately unrounded", () => {
    // 0.027917 * 24 === 0.670008 exactly, so the strict `<` boundary is safe
    // at this rate. The mixed split is where the pure function and the ledger
    // path visibly diverge: the pure function keeps the IEEE-754 float
    // residue (fromCredits 0.37000800000000006) while the ledger
    // (container-billing.ts:518) rounds the earnings leg to 4dp ROUND_UP in
    // Decimal. The float residue never reaches a ledger — the route forwards
    // the float legs only through deprecated compatibility fields that the
    // repository ignores, and the repository recomputes the authoritative
    // split in Decimal. Pinning the unrounded value fails if someone later
    // "fixes" the pure function by rounding it, which would silently change
    // the reference definition the repository's own comment cites.
    const plan = computeContainerBillingPlan({
      dailyCost: 0.670008,
      currentBalance: 2,
      ownerEarningsAvailable: 0.3,
      payAsYouGoFromEarnings: true,
    });
    expect(plan.action).toBe("billed");
    expect(plan.fromEarnings).toBe(0.3);
    // Exact IEEE-754 residue, not a rounded 0.370008.
    expect(plan.fromCredits).toBe(0.37000800000000006);
  });
});
