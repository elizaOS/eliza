import { describe, expect, test } from "bun:test";
import { coerceNonNegativeIntegerCount, parseReferralMeResponse } from "@/lib/types/referral-me";

describe("coerceNonNegativeIntegerCount", () => {
  test("accepts non-negative integers and digit-only strings", () => {
    expect(coerceNonNegativeIntegerCount(0)).toBe(0);
    expect(coerceNonNegativeIntegerCount(42)).toBe(42);
    expect(coerceNonNegativeIntegerCount(" 7 ")).toBe(7);
    expect(coerceNonNegativeIntegerCount(0n)).toBe(0);
    expect(coerceNonNegativeIntegerCount(9007199254740991n)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("rejects null, boolean, float, empty string, decimal string, unsafe bigint", () => {
    expect(coerceNonNegativeIntegerCount(null)).toBeNull();
    expect(coerceNonNegativeIntegerCount(undefined)).toBeNull();
    expect(coerceNonNegativeIntegerCount(true)).toBeNull();
    expect(coerceNonNegativeIntegerCount(1.5)).toBeNull();
    expect(coerceNonNegativeIntegerCount("")).toBeNull();
    expect(coerceNonNegativeIntegerCount("01")).toBeNull();
    expect(coerceNonNegativeIntegerCount("1.5")).toBeNull();
    expect(coerceNonNegativeIntegerCount(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBeNull();
  });
});

describe("parseReferralMeResponse", () => {
  test("parses valid payload", () => {
    expect(
      parseReferralMeResponse({
        code: "ABC12",
        total_referrals: 3,
        is_active: true,
      }),
    ).toEqual({
      code: "ABC12",
      total_referrals: 3,
      is_active: true,
    });
  });

  test("accepts inactive codes and string total_referrals", () => {
    expect(
      parseReferralMeResponse({
        code: "XYZ99",
        total_referrals: "0",
        is_active: false,
      }),
    ).toEqual({
      code: "XYZ99",
      total_referrals: 0,
      is_active: false,
    });
  });

  test("rejects malformed total_referrals", () => {
    expect(
      parseReferralMeResponse({
        code: "ABC",
        total_referrals: Number.NaN,
        is_active: true,
      }),
    ).toBeNull();
  });
});
