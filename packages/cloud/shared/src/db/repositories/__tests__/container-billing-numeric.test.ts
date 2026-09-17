/**
 * Exercises container-billing numeric parsing with deterministic input classes.
 * The existing billing idempotency suite owns actual rejection and rollback.
 */

import { describe, expect, test } from "bun:test";
import { parseContainerBillingNumber } from "../container-billing-numeric";

describe("parseContainerBillingNumber", () => {
  test("parses a well-formed NUMERIC string", () => {
    expect(parseContainerBillingNumber("50.00", "total_billed")).toBe(50);
    expect(parseContainerBillingNumber("1234.567890", "credit_balance")).toBe(1234.56789);
  });

  test("parses a numeric literal", () => {
    expect(parseContainerBillingNumber(0, "credit_balance")).toBe(0);
    expect(parseContainerBillingNumber(42, "total_billed")).toBe(42);
  });

  test("allows an explicit domain zero (a brand-new container / zeroed balance)", () => {
    expect(parseContainerBillingNumber("0", "total_billed")).toBe(0);
    expect(parseContainerBillingNumber("0.00", "total_billed")).toBe(0);
    expect(parseContainerBillingNumber("0.000000", "credit_balance")).toBe(0);
  });

  test("throws on null / undefined instead of fabricating 0", () => {
    expect(() => parseContainerBillingNumber(null, "total_billed")).toThrow(/total_billed/);
    expect(() => parseContainerBillingNumber(undefined, "credit_balance")).toThrow(
      /credit_balance/,
    );
    expect(() => parseContainerBillingNumber(null, "total_billed")).toThrow(/empty or missing/);
  });

  test("throws on empty / whitespace-only instead of fabricating 0", () => {
    expect(() => parseContainerBillingNumber("", "total_billed")).toThrow(/empty or missing/);
    expect(() => parseContainerBillingNumber("   ", "credit_balance")).toThrow(/empty or missing/);
  });

  test("REGRESSION: a corrupt value throws instead of becoming NaN (fail-open guard)", () => {
    // The exact class the write path used to swallow: Number("corrupt") is NaN,
    // NaN + dailyCost is NaN, and String(NaN) = "NaN" poisons the NUMERIC write.
    expect(() => parseContainerBillingNumber("corrupt", "total_billed")).toThrow(
      /not a finite number/,
    );
    expect(() => parseContainerBillingNumber("12.3.4", "total_billed")).toThrow(
      /not a finite number/,
    );
    expect(() => parseContainerBillingNumber("NaN", "credit_balance")).toThrow(
      /not a finite number/,
    );
    expect(() => parseContainerBillingNumber("Infinity", "credit_balance")).toThrow(
      /not a finite number/,
    );
    expect(() => parseContainerBillingNumber("-Infinity", "total_billed")).toThrow(
      /not a finite number/,
    );
  });

  test("error names the field so a corrupt column is diagnosable", () => {
    expect(() => parseContainerBillingNumber("corrupt", "total_billed")).toThrow(
      /container billing total_billed/,
    );
    expect(() => parseContainerBillingNumber("corrupt", "credit_balance")).toThrow(
      /container billing credit_balance/,
    );
  });
});
