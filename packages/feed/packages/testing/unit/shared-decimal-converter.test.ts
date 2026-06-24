import { describe, expect, it } from "bun:test";
import {
  convertBalanceToStrings,
  toSafeNumber,
  toSafeString,
} from "../../shared/src/utils/decimal-converter";

/**
 * Safe Decimal/serialized-value conversion. Balance values arrive as Decimal
 * objects, strings (from Redis cache), or numbers; conversion must be lossless
 * and fall back on null/NaN rather than emitting NaN/"undefined" into financial
 * display or storage.
 */

// A Decimal-like object (has toString).
const decimalLike = (s: string) => ({ toString: () => s });

describe("toSafeString", () => {
  it("handles Decimal/string/number + null fallback", () => {
    expect(toSafeString(decimalLike("1000.50"))).toBe("1000.50");
    expect(toSafeString("42.5")).toBe("42.5");
    expect(toSafeString(7)).toBe("7");
    expect(toSafeString(null)).toBe("0");
    expect(toSafeString(undefined, "n/a")).toBe("n/a");
  });
});

describe("toSafeNumber", () => {
  it("parses Decimal/string/number, falls back on NaN/null", () => {
    expect(toSafeNumber(decimalLike("1000.50"))).toBe(1000.5);
    expect(toSafeNumber("42.5")).toBe(42.5);
    expect(toSafeNumber(7)).toBe(7);
    expect(toSafeNumber(null)).toBe(0);
    expect(toSafeNumber("not-a-number")).toBe(0);
    expect(toSafeNumber(undefined, 100)).toBe(100);
  });
});

describe("convertBalanceToStrings", () => {
  it("stringifies every balance field with a zero default", () => {
    expect(
      convertBalanceToStrings({
        virtualBalance: decimalLike("1000.50"),
        totalDeposited: 5000,
        // totalWithdrawn + lifetimePnL absent → "0"
      }),
    ).toEqual({
      virtualBalance: "1000.50",
      totalDeposited: "5000",
      totalWithdrawn: "0",
      lifetimePnL: "0",
    });
  });
});
