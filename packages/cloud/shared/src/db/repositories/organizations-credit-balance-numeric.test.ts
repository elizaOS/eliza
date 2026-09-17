/**
 * Exercises organization balance parsing across valid and malformed driver values.
 * The credit-balance PGlite suite owns mutation rejection and ledger readback.
 */

import { describe, expect, test } from "bun:test";
import { parseOrganizationCreditBalance } from "./organizations-credit-balance-numeric";

describe("parseOrganizationCreditBalance", () => {
  test("parses a well-formed NUMERIC string", () => {
    expect(parseOrganizationCreditBalance("10.50", "credit_balance")).toBe(10.5);
    expect(parseOrganizationCreditBalance("1234.567890", "credit_balance")).toBe(1234.56789);
  });

  test("parses a NUMERIC string with surrounding whitespace", () => {
    expect(parseOrganizationCreditBalance(" 10.50 ", "credit_balance")).toBe(10.5);
  });

  test("parses a numeric value", () => {
    expect(parseOrganizationCreditBalance(42, "credit_balance")).toBe(42);
  });

  test("parses an explicit domain zero (a genuinely $0 balance is allowed)", () => {
    expect(parseOrganizationCreditBalance("0.00", "credit_balance")).toBe(0);
    expect(parseOrganizationCreditBalance(0, "credit_balance")).toBe(0);
  });

  test("parses a negative balance (an overdrawn balance is a real value)", () => {
    expect(parseOrganizationCreditBalance("-5.00", "credit_balance")).toBe(-5);
  });

  test("throws on a non-numeric corrupt string instead of returning NaN", () => {
    expect(() => parseOrganizationCreditBalance("corrupt", "credit_balance")).toThrow(
      /Unable to read organization credit_balance/,
    );
  });

  test("throws on the literal string 'NaN' (a valid Postgres NUMERIC value)", () => {
    expect(() => parseOrganizationCreditBalance("NaN", "credit_balance")).toThrow(/credit_balance/);
  });

  test("throws on a partially numeric corrupt string", () => {
    expect(() => parseOrganizationCreditBalance("12.5oops", "credit_balance")).toThrow(
      /credit_balance/,
    );
  });

  test("throws on JS-only numeric strings Number() would otherwise coerce", () => {
    expect(() => parseOrganizationCreditBalance("1e3", "credit_balance")).toThrow(/credit_balance/);
    expect(() => parseOrganizationCreditBalance("0x10", "credit_balance")).toThrow(
      /credit_balance/,
    );
    expect(() => parseOrganizationCreditBalance("Infinity", "credit_balance")).toThrow(
      /credit_balance/,
    );
  });

  test("throws on NaN / Infinity numeric input rather than fabricating a value", () => {
    expect(() => parseOrganizationCreditBalance(Number.NaN, "credit_balance")).toThrow(
      /not a finite number/,
    );
    expect(() =>
      parseOrganizationCreditBalance(Number.POSITIVE_INFINITY, "credit_balance"),
    ).toThrow(/not a finite number/);
  });

  test("throws on null / undefined / empty / whitespace (missing value)", () => {
    expect(() => parseOrganizationCreditBalance(null, "credit_balance")).toThrow(
      /empty or missing/,
    );
    expect(() => parseOrganizationCreditBalance(undefined, "credit_balance")).toThrow(
      /empty or missing/,
    );
    expect(() => parseOrganizationCreditBalance("", "credit_balance")).toThrow(/empty or missing/);
    expect(() => parseOrganizationCreditBalance("   ", "credit_balance")).toThrow(
      /empty or missing/,
    );
  });
});
