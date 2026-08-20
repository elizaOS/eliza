/** Pure denomination and compatibility tests for organization cloud credits. */

import { describe, expect, test } from "vitest";
import {
  LEGACY_MCP_POINTS_PER_DOLLAR,
  legacyMcpPointsToOrganizationCredits,
  ORGANIZATION_CREDIT_PRICING,
  organizationCreditsToLegacyMcpPoints,
} from "./organization-credits";

describe("organization credit unit", () => {
  test("defines one USD-denominated credit per dollar", () => {
    expect(ORGANIZATION_CREDIT_PRICING).toEqual({
      creditUnit: "USD",
      creditsPerDollar: 1,
      usdPerCredit: 1,
    });
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

  test("rejects negative and non-finite amounts", () => {
    for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => legacyMcpPointsToOrganizationCredits(amount)).toThrow(RangeError);
      expect(() => organizationCreditsToLegacyMcpPoints(amount)).toThrow(RangeError);
    }
  });
});
