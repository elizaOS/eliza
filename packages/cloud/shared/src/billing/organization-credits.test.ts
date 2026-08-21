/** Pure denomination and compatibility tests for organization cloud credits. */

import { describe, expect, test } from "vitest";
import {
  formatOrganizationCreditUsd,
  LEGACY_MCP_POINTS_PER_DOLLAR,
  legacyMcpPointsToOrganizationCredits,
  ORGANIZATION_CREDIT_PRICING,
  organizationCreditsToLegacyMcpPoints,
  RETRIEVE_MEMORIES_PRICE_USD,
  SAVE_MEMORY_PRICE_USD,
} from "./organization-credits";

describe("organization credit unit", () => {
  test("defines one USD-denominated credit per dollar", () => {
    expect(ORGANIZATION_CREDIT_PRICING).toEqual({
      creditUnit: "USD",
      creditsPerDollar: 1,
      usdPerCredit: 1,
    });
  });

  test("publishes the memory prices used by execution and discovery", () => {
    expect(SAVE_MEMORY_PRICE_USD).toBe(1);
    expect(RETRIEVE_MEMORIES_PRICE_USD).toBe(0);
  });

  test("keeps legacy MCP point prices value-equivalent", () => {
    expect(LEGACY_MCP_POINTS_PER_DOLLAR).toBe(100);
    expect(legacyMcpPointsToOrganizationCredits(1)).toBe(0.01);
    expect(legacyMcpPointsToOrganizationCredits(12.5)).toBe(0.125);
    expect(organizationCreditsToLegacyMcpPoints(1)).toBe(100);
    expect(organizationCreditsToLegacyMcpPoints(0.0125)).toBe(1.25);
  });

  test("round-trips fractional prices without changing their value", () => {
    for (const amount of [0, 0.0001, 0.01, 1, 9.8765]) {
      expect(
        legacyMcpPointsToOrganizationCredits(organizationCreditsToLegacyMcpPoints(amount)),
      ).toBeCloseTo(amount, 12);
    }
  });

  test("quantizes the float remainder a fractional point price would otherwise leak", () => {
    // 1.1 / 100 is 0.011000000000000001 in binary floating point.
    expect(legacyMcpPointsToOrganizationCredits(1.1)).toBe(0.011);
    expect(formatOrganizationCreditUsd(1.1 / 100)).toBe("0.011");
    // 0.011 * 100 is 1.1000000000000001 before quantization.
    expect(organizationCreditsToLegacyMcpPoints(0.011)).toBe(1.1);
  });

  test("formats canonical amounts without trailing zeros or lost micro-prices", () => {
    expect(formatOrganizationCreditUsd(1)).toBe("1");
    expect(formatOrganizationCreditUsd(0)).toBe("0");
    expect(formatOrganizationCreditUsd(0.0125)).toBe("0.0125");
    expect(formatOrganizationCreditUsd(0.000001)).toBe("0.000001");
    expect(formatOrganizationCreditUsd(100)).toBe("100");
  });

  test("rejects negative and non-finite amounts", () => {
    for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => legacyMcpPointsToOrganizationCredits(amount)).toThrow(RangeError);
      expect(() => organizationCreditsToLegacyMcpPoints(amount)).toThrow(RangeError);
    }
  });
});
