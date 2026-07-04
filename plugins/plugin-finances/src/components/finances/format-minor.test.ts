/**
 * Currency formatting tests pin the finance view boundary that converts stored
 * minor units into user-facing Intl currency strings.
 */

import { describe, expect, it } from "vitest";
import { formatMinor } from "./FinancesView.tsx";

describe("formatMinor", () => {
  it("converts USD minor units to a grouped major-unit currency string", () => {
    expect(formatMinor(123456, "USD")).toBe("$1,234.56");
    expect(formatMinor(0, "USD")).toBe("$0.00");
    expect(formatMinor(1234567, "USD")).toBe("$12,345.67");
  });

  it("renders negative minor amounts (outflows) with a leading minus", () => {
    expect(formatMinor(-4599, "USD")).toBe("-$45.99");
  });

  it("formats a non-USD valid ISO code with its own symbol and grouping", () => {
    // EUR keeps 2 fraction digits; JPY has 0 fraction digits in ICU.
    expect(formatMinor(99900, "EUR")).toBe("€999.00");
    expect(formatMinor(150000, "JPY")).toBe("¥1,500");
    expect(formatMinor(7500, "GBP")).toBe("£75.00");
  });

  it("falls back to '<value.toFixed(2)> <currency>' for an invalid ISO code", () => {
    // "XX" / "ZZ" are not valid ISO 4217 currency codes, so Intl.NumberFormat
    // throws and the catch branch produces the plain fallback. (Note: "ZZZ" IS
    // a valid ISO test code, so it does NOT hit the fallback — use a length-2
    // or otherwise-invalid code to exercise the catch.)
    expect(formatMinor(123456, "XX")).toBe("1234.56 XX");
    expect(formatMinor(-50, "ZZ")).toBe("-0.50 ZZ");
  });
});
