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
  });

  it("rejects non-object or null", () => {
    expect(isAffiliateBillingAttribution(null)).toBe(false);
    expect(isAffiliateBillingAttribution("str")).toBe(false);
    expect(isAffiliateBillingAttribution([])).toBe(false);
  });

  it("rejects invalid uuids or empty code", () => {
    expect(isAffiliateBillingAttribution({ ...valid, affiliateCodeId: "bad" })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, affiliateUserId: "bad" })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, affiliateCode: "   " })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, affiliateCode: "" })).toBe(false);
  });

  it("rejects markup out of range or non-finite", () => {
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: 0 })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: 11 })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: NaN })).toBe(false);
    expect(isAffiliateBillingAttribution({ ...valid, markupPercent: Infinity })).toBe(false);
  });
});
