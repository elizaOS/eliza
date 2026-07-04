// Exercises app credit math behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  type AppMonetizationConfig,
  computeInferenceCharge,
  computePurchaseSplit,
  computeReconciliation,
  isAppMonetizationActive,
} from "./app-credit-math";

/**
 * Money math behind app credits (issue #9145: the processPurchase /
 * deductCredits / reconcileCredits arithmetic was untested). The invariant that
 * matters: markup + creator share apply ONLY when the app has monetization
 * enabled — with it off, the buyer/spender pays exactly base cost and the
 * creator earns nothing. The buyer always receives the full purchase as credits.
 */

const enabled: AppMonetizationConfig = {
  monetizationEnabled: true,
  platformOffsetAmount: 100,
  purchaseSharePercentage: 70, // creator keeps 70% after the platform fee
  inferenceMarkupPercentage: 20,
};
const disabled: AppMonetizationConfig = { ...enabled, monetizationEnabled: false };

describe("computePurchaseSplit", () => {
  test("applies platform fee then creator share when monetized", () => {
    // $1000 purchase, $100 platform fee, 70% of the remaining $900 = $630 creator.
    const split = computePurchaseSplit(1000, enabled);
    expect(split.platformOffset).toBe(100);
    expect(split.amountAfterOffset).toBe(900);
    expect(split.creatorEarnings).toBe(630);
    expect(split.creditsToAdd).toBe(1000); // buyer always gets the full purchase
  });

  test("platform fee never exceeds the purchase", () => {
    const split = computePurchaseSplit(50, enabled); // fee 100 > purchase 50
    expect(split.platformOffset).toBe(50);
    expect(split.amountAfterOffset).toBe(0);
    expect(split.creatorEarnings).toBe(0);
  });

  test("monetization off → no fee, no creator earnings, full credits", () => {
    const split = computePurchaseSplit(1000, disabled);
    expect(split).toEqual({
      platformOffset: 0,
      amountAfterOffset: 1000,
      creatorEarnings: 0,
      creditsToAdd: 1000,
    });
  });
});

describe("computeInferenceCharge", () => {
  test("adds creator markup to base cost when monetized", () => {
    const charge = computeInferenceCharge(500, enabled); // 20% markup
    expect(charge.markupPercentage).toBe(20);
    expect(charge.creatorMarkup).toBe(100);
    expect(charge.totalCost).toBe(600);
  });

  test("monetization off → user pays base cost only, creator earns nothing", () => {
    expect(computeInferenceCharge(500, disabled)).toEqual({
      markupPercentage: 0,
      creatorMarkup: 0,
      totalCost: 500,
    });
  });
});

describe("computeReconciliation", () => {
  test("scales an estimate→actual delta by the markup multiplier", () => {
    // actual cost 50 over estimate → +50 base, ×1.20 = +60 total, +10 creator.
    const recon = computeReconciliation(50, enabled);
    expect(recon.totalCostDifference).toBe(60);
    expect(recon.creatorMarkupDifference).toBe(10);
  });

  test("a negative delta (over-charged) yields a signed refund", () => {
    const recon = computeReconciliation(-50, enabled);
    expect(recon.totalCostDifference).toBe(-60); // refund
    expect(recon.creatorMarkupDifference).toBe(-10); // reverse creator earnings
  });

  test("monetization off → delta is base-cost only", () => {
    const recon = computeReconciliation(50, disabled);
    expect(recon.markupPercentage).toBe(0);
    expect(recon.totalCostDifference).toBe(50);
    expect(recon.creatorMarkupDifference).toBe(0);
  });
});

describe("isAppMonetizationActive", () => {
  test("true for enabled + approved", () => {
    expect(isAppMonetizationActive({ monetization_enabled: true, review_status: "approved" })).toBe(
      true,
    );
  });

  test("a review REJECTION revokes earnings even while the flag is still true", () => {
    // Rows persisted rejected+enabled before runAppReview started flipping the
    // flag off must earn nothing — this predicate is the earnings-path gate.
    expect(isAppMonetizationActive({ monetization_enabled: true, review_status: "rejected" })).toBe(
      false,
    );
  });

  test("draft re-gate (re-review pending) deliberately keeps accruing", () => {
    // Explicit product DECISION at api/v1/apps/[id]/route.ts: a metadata edit
    // must not freeze a creator's live revenue; only a rejection cuts it off.
    expect(isAppMonetizationActive({ monetization_enabled: true, review_status: "draft" })).toBe(
      true,
    );
  });

  test("flag off → inactive regardless of review status", () => {
    expect(
      isAppMonetizationActive({ monetization_enabled: false, review_status: "approved" }),
    ).toBe(false);
  });

  test("absent review_status (synthetic accounting apps) falls back to the flag", () => {
    expect(isAppMonetizationActive({ monetization_enabled: true })).toBe(true);
    expect(isAppMonetizationActive({ monetization_enabled: true, review_status: null })).toBe(true);
  });
});
