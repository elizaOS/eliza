/**
 * Fail-closed coverage for app credit balance numeric reads (#12788).
 */

import { describe, expect, test } from "bun:test";
import { parseAppCreditBalanceNumber } from "./app-credit-balances-numeric";

describe("parseAppCreditBalanceNumber", () => {
  test("parses valid Drizzle numeric strings", () => {
    expect(parseAppCreditBalanceNumber("12.50", "credit_balance")).toBe(12.5);
  });

  test("parses valid decimal strings with surrounding whitespace", () => {
    expect(parseAppCreditBalanceNumber(" 12.50 ", "credit_balance")).toBe(12.5);
  });

  test("parses valid numeric aggregate values", () => {
    expect(parseAppCreditBalanceNumber(3, "userCount")).toBe(3);
  });

  test("throws on null instead of fabricating zero", () => {
    expect(() => parseAppCreditBalanceNumber(null, "totalBalance")).toThrow(/totalBalance/);
  });

  test("throws on undefined instead of fabricating zero", () => {
    expect(() => parseAppCreditBalanceNumber(undefined, "totalSpent")).toThrow(/totalSpent/);
  });

  test("throws on non-numeric strings instead of returning NaN", () => {
    expect(() => parseAppCreditBalanceNumber("not-a-number", "credit_balance")).toThrow(
      /credit_balance/,
    );
  });

  test("throws on partially numeric corrupt strings", () => {
    expect(() => parseAppCreditBalanceNumber("12.5oops", "totalPurchased")).toThrow(
      /totalPurchased/,
    );
  });

  test("throws on JavaScript-only numeric strings", () => {
    expect(() => parseAppCreditBalanceNumber("0x10", "credit_balance")).toThrow(/credit_balance/);
    expect(() => parseAppCreditBalanceNumber("1e3", "credit_balance")).toThrow(/credit_balance/);
  });
});
