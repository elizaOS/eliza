// Exercises redemption security behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  ADMIN_CONTROLS,
  ARBITRAGE_PROTECTION,
  calculateEffectiveTokens,
  isLargeRedemption,
  isPriceSane,
  requiresAdminApproval,
  SUPPLY_SHOCK_PROTECTION,
  VOLATILITY_BREAKERS,
} from "./redemption-security";

/**
 * Token-redemption security gates. These protect the payout system: the
 * effective-token math applies a safety spread (user gets slightly less), and
 * the large-redemption / admin-approval / price-sanity thresholds must trip at
 * exactly their configured bounds. Asserted against the live config constants.
 */

describe("calculateEffectiveTokens", () => {
  test("applies the safety spread so the user receives below par", () => {
    const tokens = calculateEffectiveTokens(100, 2);
    expect(tokens).toBeCloseTo((100 * (1 - ARBITRAGE_PROTECTION.SAFETY_SPREAD)) / 2);
    // strictly less than the no-spread amount (100 / 2 = 50).
    expect(tokens).toBeLessThan(50);
  });
});

describe("threshold gates", () => {
  test("isLargeRedemption trips at the configured threshold", () => {
    const t = SUPPLY_SHOCK_PROTECTION.LARGE_REDEMPTION_THRESHOLD_USD;
    expect(isLargeRedemption(t)).toBe(true);
    expect(isLargeRedemption(t - 0.01)).toBe(false);
  });

  test("requiresAdminApproval trips at the configured threshold", () => {
    const t = ADMIN_CONTROLS.ADMIN_APPROVAL_THRESHOLD_USD;
    expect(requiresAdminApproval(t)).toBe(true);
    expect(requiresAdminApproval(t - 0.01)).toBe(false);
  });
});

describe("isPriceSane", () => {
  test("accepts prices within [MIN, MAX], rejects outside", () => {
    const { MIN_SANE_PRICE_USD: min, MAX_SANE_PRICE_USD: max } = VOLATILITY_BREAKERS;
    expect(isPriceSane(min)).toBe(true);
    expect(isPriceSane(max)).toBe(true);
    expect(isPriceSane(min / 2)).toBe(false);
    expect(isPriceSane(max * 2)).toBe(false);
  });
});
