/** Unit coverage for deterministic redemption-balance eligibility limits. */

import { describe, expect, test } from "bun:test";
import {
  calculateDailyLimitRemaining,
  evaluateRedemptionEligibility,
} from "./eligibility";

const eligibleInput = {
  availableBalance: 100,
  minimumRedemptionUsd: 1,
  isInCooldown: false,
  cooldownEndsAt: null,
  dailyLimitRemaining: 10,
};

describe("evaluateRedemptionEligibility", () => {
  test("allows a balance and daily remainder that both cover the minimum", () => {
    expect(evaluateRedemptionEligibility(eligibleInput)).toEqual({
      canRedeem: true,
    });
  });

  test("rejects a positive daily remainder below the minimum", () => {
    expect(
      evaluateRedemptionEligibility({
        ...eligibleInput,
        dailyLimitRemaining: 0.5,
      }),
    ).toEqual({
      canRedeem: false,
      reason:
        "Daily limit remaining ($0.50) is below the $1.00 minimum redemption. Resets at midnight UTC.",
    });
  });

  test("reports an exhausted daily limit separately", () => {
    expect(
      evaluateRedemptionEligibility({
        ...eligibleInput,
        dailyLimitRemaining: 0,
      }),
    ).toEqual({
      canRedeem: false,
      reason: "Daily limit reached. Resets at midnight UTC.",
    });
  });

  test("keeps balance and cooldown failures ahead of the daily remainder", () => {
    expect(
      evaluateRedemptionEligibility({
        ...eligibleInput,
        availableBalance: 0.5,
        dailyLimitRemaining: 0.5,
      }).reason,
    ).toContain("Minimum redemption");

    const cooldownEndsAt = new Date("2026-08-21T00:00:00.000Z");
    expect(
      evaluateRedemptionEligibility({
        ...eligibleInput,
        isInCooldown: true,
        cooldownEndsAt,
        dailyLimitRemaining: 0.5,
      }).reason,
    ).toContain(cooldownEndsAt.toISOString());
  });
});

describe("calculateDailyLimitRemaining", () => {
  test("preserves an exact 1.15 remainder from a SQL decimal string", () => {
    expect(calculateDailyLimitRemaining(5_000, "4998.85")).toBe(1.15);
  });

  test("rounds sub-cent consumption against the spendable remainder", () => {
    expect(calculateDailyLimitRemaining(5_000, "4998.8501")).toBe(1.14);
  });

  test("fails closed on an invalid SQL numeric value", () => {
    expect(() => calculateDailyLimitRemaining(5_000, "NaN")).toThrow(
      "Invalid non-negative USD amount",
    );
  });
});
