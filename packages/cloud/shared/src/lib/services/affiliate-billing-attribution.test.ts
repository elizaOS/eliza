/**
 * Deterministic unit tests for affiliate billing attribution runtime validation.
 *
 * Exercises the isAffiliateBillingAttribution type guard across structural shape,
 * UUID invariants, non-empty codes, missing fields, non-number inputs, and exact
 * economic boundaries (0 < markupPercent <= 10) before database ingestion.
 */

import { describe, expect, it } from "vitest";
import { isAffiliateBillingAttribution } from "./affiliate-billing-attribution.js";

describe("isAffiliateBillingAttribution", () => {
  const valid = {
    affiliateCodeId: "123e4567-e89b-12d3-a456-426614174000",
    affiliateUserId: "123e4567-e89b-12d3-a456-426614174001",
    affiliateCode: "CODE123",
    markupPercent: 0.2,
  };

  it("accepts valid snapshot", () => {
    expect(isAffiliateBillingAttribution(valid)).toBe(true);
    expect(
      isAffiliateBillingAttribution({
        ...valid,
        affiliateCodeId: "123E4567-E89B-12D3-A456-426614174000",
        affiliateUserId: "ABCDEF01-2345-6789-ABCD-EF0123456789",
      }),
    ).toBe(true);
  });

  it("rejects non-object, null, or array inputs", () => {
    expect(isAffiliateBillingAttribution(null)).toBe(false);
    expect(isAffiliateBillingAttribution(undefined)).toBe(false);
    expect(isAffiliateBillingAttribution("str")).toBe(false);
    expect(isAffiliateBillingAttribution(123)).toBe(false);
    expect(isAffiliateBillingAttribution(true)).toBe(false);
    expect(isAffiliateBillingAttribution([])).toBe(false);
    expect(isAffiliateBillingAttribution([valid])).toBe(false);
  });

  it("rejects missing fields", () => {
    expect(isAffiliateBillingAttribution({})).toBe(false);
    const { affiliateCodeId: _id, ...missingCodeId } = valid;
    expect(isAffiliateBillingAttribution(missingCodeId)).toBe(false);

    const { affiliateUserId: _user, ...missingUserId } = valid;
    expect(isAffiliateBillingAttribution(missingUserId)).toBe(false);

    const { affiliateCode: _code, ...missingCode } = valid;
    expect(isAffiliateBillingAttribution(missingCode)).toBe(false);

    const { markupPercent: _markup, ...missingMarkup } = valid;
    expect(isAffiliateBillingAttribution(missingMarkup)).toBe(false);
  });

  it("rejects non-string or non-number field types", () => {
    expect(isAffiliateBillingAttribution({ ...valid, affiliateCodeId: 12345 })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, affiliateCodeId: null })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, affiliateUserId: true })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, affiliateUserId: {} })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, affiliateCode: 123 })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, affiliateCode: null })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: "0.2" })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: "10" })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: true })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: null })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: {} })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: [] })).toBe(false);
  });

  it("rejects invalid uuids or empty code", () => {
    expect(isAffiliateBillingAttribution({ ...valid, affiliateCodeId: "bad" })).toBe(false);
    expect(
      isAffiliateBillingAttribution({
        ...valid,
        affiliateCodeId: "123e4567-e89b-12d3-a456-42661417400",
      }),
    ).toBe(false);
    expect(
      isAffiliateBillingAttribution({
        ...valid,
        affiliateCodeId: "123e4567-e89b-12d3-a456-4266141740000",
      }),
    ).toBe(false);
    expect(
      isAffiliateBillingAttribution({
        ...valid,
        affiliateCodeId: "g23e4567-e89b-12d3-a456-426614174000",
      }),
    ).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, affiliateUserId: "bad" })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, affiliateCode: "   " })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, affiliateCode: "" })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, affiliateCode: "\t\n" })).toBe(false);
  });

  it("enforces exact economic boundaries on markupPercent", () => {
    // Exact upper bound (10 = 1000% markup) is accepted
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: 10 })).toBe(true);

    // Smallest representable IEEE 754 float64 value above 10 is rejected
    const smallestAboveTen = 10 + Number.EPSILON * 8;
    expect(smallestAboveTen > 10).toBe(true);
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: smallestAboveTen })).toBe(
      false,
    );
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: 10.000000000000002 })).toBe(
      false,
    );
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: 10.01 })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: 11 })).toBe(false);

    // Lower bound: strictly positive (> 0)
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: 0 })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: -0.01 })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: -1 })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: Number.MIN_VALUE })).toBe(true);

    // Non-finite values rejected
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: Number.NaN })).toBe(false);
    expect(
      isAffiliateBillingAttribution({ ...valid, markupPercent: Number.POSITIVE_INFINITY }),
    ).toBe(false);
    expect(
      isAffiliateBillingAttribution({ ...valid, markupPercent: Number.NEGATIVE_INFINITY }),
    ).toBe(false);
  });
});
