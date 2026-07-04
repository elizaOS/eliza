/**
 * Exercises the fail-closed numeric boundary for redeemable-earnings rows and
 * pins the money-out fail-open regression it closes.
 */
import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import {
  CorruptRedeemableEarningsNumberError,
  parseRedeemableEarningsNumber,
} from "./redeemable-earnings-numeric";

describe("parseRedeemableEarningsNumber", () => {
  test("parses a well-formed NUMERIC string", () => {
    expect(parseRedeemableEarningsNumber("10.5000", "available_balance")).toBe(10.5);
  });

  test("parses a numeric value", () => {
    expect(parseRedeemableEarningsNumber(42, "total_earned")).toBe(42);
  });

  test("parses a zero string (explicit domain zero is allowed)", () => {
    expect(parseRedeemableEarningsNumber("0.0000", "available_balance")).toBe(0);
    expect(parseRedeemableEarningsNumber(0, "available_balance")).toBe(0);
  });

  test("throws on the 'NaN' string a corrupt Postgres NUMERIC reads back as", () => {
    // `'NaN'::numeric` is a valid Postgres NUMERIC and the driver returns "NaN".
    expect(() => parseRedeemableEarningsNumber("NaN", "available_balance")).toThrow(
      /Unable to read redeemable earnings available_balance/,
    );
  });

  test("throws on a non-numeric corrupt string instead of returning NaN", () => {
    expect(() => parseRedeemableEarningsNumber("corrupt", "available_balance")).toThrow(
      /available_balance/,
    );
  });

  test("throws on NaN input rather than fabricating a permissive value", () => {
    expect(() => parseRedeemableEarningsNumber(Number.NaN, "available_balance")).toThrow(
      /not a finite number/,
    );
  });

  test("throws on Infinity", () => {
    expect(() =>
      parseRedeemableEarningsNumber(Number.POSITIVE_INFINITY, "available_balance"),
    ).toThrow(/not a finite number/);
    expect(() =>
      parseRedeemableEarningsNumber(Number.NEGATIVE_INFINITY, "available_balance"),
    ).toThrow(/not a finite number/);
  });

  test("throws on null / undefined / empty / whitespace (missing value)", () => {
    expect(() => parseRedeemableEarningsNumber(null, "available_balance")).toThrow(
      /empty or missing/,
    );
    expect(() => parseRedeemableEarningsNumber(undefined, "available_balance")).toThrow(
      /empty or missing/,
    );
    expect(() => parseRedeemableEarningsNumber("", "available_balance")).toThrow(
      /empty or missing/,
    );
    expect(() => parseRedeemableEarningsNumber("   ", "available_balance")).toThrow(
      /empty or missing/,
    );
  });

  test("names the field in the error so corrupt columns are identifiable", () => {
    expect(() => parseRedeemableEarningsNumber("x", "total_redeemed")).toThrow(/total_redeemed/);
    expect(() => parseRedeemableEarningsNumber("x", "total_pending")).toThrow(/total_pending/);
  });

  test("throws a typed CorruptRedeemableEarningsNumberError carrying field + raw value", () => {
    try {
      parseRedeemableEarningsNumber("NaN", "available_balance");
      throw new Error("expected parse to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CorruptRedeemableEarningsNumberError);
      const typed = err as CorruptRedeemableEarningsNumberError;
      expect(typed.fieldName).toBe("available_balance");
      expect(typed.rawValue).toBe("NaN");
    }
  });
});

describe("money-out fail-open regression (secure token-redemption insufficient-balance gate)", () => {
  // Reproduces token-redemption-secure.ts createRedemption():
  //   const availableBalance = new Decimal(earningsBalance.availableBalance);
  //   if (availableBalance.lt(deductionAmount)) return { insufficient }
  // where earningsBalance.availableBalance came from getBalance()'s NUMERIC read.
  const deductionAmount = 50;

  test("a bare Number('NaN') balance makes the Decimal insufficient-check FAIL OPEN", () => {
    const fabricatedBalance = Number("NaN"); // what getBalance used to return
    const availableBalance = new Decimal(fabricatedBalance);
    // Decimal(NaN).lt(50) === false -> the insufficient-balance branch is skipped
    // -> the redemption is authorized against a corrupt (unbacked) balance.
    expect(availableBalance.lt(deductionAmount)).toBe(false);
  });

  test("the fail-closed reader throws on that same corrupt balance so the gate never fabricates funds", () => {
    // getBalance now routes available_balance through the reader, so a corrupt
    // row throws before any Decimal comparison -> the route catch denies (500).
    expect(() => parseRedeemableEarningsNumber("NaN", "available_balance")).toThrow();
  });

  test("a healthy balance still parses and the Decimal gate behaves normally", () => {
    const healthy = parseRedeemableEarningsNumber("10.0000", "available_balance");
    const availableBalance = new Decimal(healthy);
    expect(availableBalance.lt(deductionAmount)).toBe(true); // $10 < $50 -> insufficient, correctly denied
    expect(availableBalance.lt(5)).toBe(false); // $10 >= $5 -> sufficient, correctly allowed
  });

  test("the same parser protects the other redeemable-earnings debit gates", () => {
    const corruptAvailableBalance = Number("NaN");

    // These mirror lockForRedemption(), convertToCredits(), and
    // reduceEarnings({ requireSufficientBalance: true }) before they parse the
    // locked available_balance. A bare Decimal(NaN) comparison reports
    // "not less than", so the insufficient-balance branch would be skipped.
    expect(new Decimal(corruptAvailableBalance).lt(5)).toBe(false);
    expect(new Decimal(corruptAvailableBalance).lessThan(5)).toBe(false);

    expect(() => parseRedeemableEarningsNumber("NaN", "available_balance")).toThrow(
      CorruptRedeemableEarningsNumberError,
    );
  });
});
