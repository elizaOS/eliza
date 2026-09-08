/**
 * Exercises the fail-closed NUMERIC parser used by container billing. Real
 * persisted corruption and admission are covered by the project-intent PGlite suite.
 */

import { describe, expect, test } from "bun:test";
import { parseOrganizationCreditBalance } from "../organizations-credit-balance-numeric";

describe("parseOrganizationCreditBalance fails closed on the container deploy money-out class", () => {
  test("parses a well-formed NUMERIC balance", () => {
    expect(parseOrganizationCreditBalance("10.50", "credit_balance")).toBe(10.5);
    expect(parseOrganizationCreditBalance("1234.567890", "credit_balance")).toBe(1234.56789);
  });

  test("allows an explicit domain zero (a genuinely $0 balance still gates deploys)", () => {
    expect(parseOrganizationCreditBalance("0.00", "credit_balance")).toBe(0);
    expect(parseOrganizationCreditBalance(0, "credit_balance")).toBe(0);
  });

  test("allows a negative overdrawn balance (a real value, not corruption)", () => {
    expect(parseOrganizationCreditBalance("-5.00", "credit_balance")).toBe(-5);
  });

  test("throws on the literal 'NaN' instead of returning NaN (the fail-open trigger)", () => {
    // This is the exact value that made `NaN < deploymentCost` FALSE and
    // bypassed the insufficient-balance spend gate.
    expect(() => parseOrganizationCreditBalance("NaN", "credit_balance")).toThrow(/credit_balance/);
  });

  test("regression: the old bare Number('NaN') fail-open path is provably wrong", () => {
    // Demonstrates the defect this slice closes: with a bare Number(...) a
    // corrupt balance silently authorizes the deploy AND poisons the column.
    const corrupt = "NaN";
    const deploymentCost = 5;
    const fabricated = Number(corrupt); // old code path
    expect(Number.isNaN(fabricated)).toBe(true);
    expect(fabricated < deploymentCost).toBe(false); // guard bypassed
    expect(String(fabricated - deploymentCost)).toBe("NaN"); // poisoned write
    // The fix routes this same value through the fail-closed parser, which
    // throws instead of authorizing / poisoning.
    expect(() => parseOrganizationCreditBalance(corrupt, "credit_balance")).toThrow();
  });

  test("throws on Infinity / non-finite JS coercions", () => {
    expect(() => parseOrganizationCreditBalance("Infinity", "credit_balance")).toThrow();
    expect(() => parseOrganizationCreditBalance("1e3", "credit_balance")).toThrow();
    expect(() => parseOrganizationCreditBalance("0x10", "credit_balance")).toThrow();
  });

  test("throws on null / undefined / empty instead of fabricating 0", () => {
    expect(() => parseOrganizationCreditBalance(null, "credit_balance")).toThrow(
      /empty or missing/,
    );
    expect(() => parseOrganizationCreditBalance(undefined, "credit_balance")).toThrow(
      /empty or missing/,
    );
    expect(() => parseOrganizationCreditBalance("   ", "credit_balance")).toThrow(
      /empty or missing/,
    );
  });
});
