/**
 * Exercises the fail-closed numeric boundary for usage-quota rows.
 */
import { describe, expect, test } from "bun:test";
import { parseUsageQuotaNumber } from "./usage-quotas-numeric";

describe("parseUsageQuotaNumber", () => {
  test("parses a well-formed NUMERIC string", () => {
    expect(parseUsageQuotaNumber("10.50", "credits_limit")).toBe(10.5);
  });

  test("parses a numeric value", () => {
    expect(parseUsageQuotaNumber(42, "current_usage")).toBe(42);
  });

  test("parses a zero string (explicit domain zero is allowed)", () => {
    expect(parseUsageQuotaNumber("0.00", "current_usage")).toBe(0);
    expect(parseUsageQuotaNumber(0, "current_usage")).toBe(0);
  });

  test("throws on a non-numeric corrupt string instead of returning NaN", () => {
    expect(() => parseUsageQuotaNumber("corrupt", "credits_limit")).toThrow(
      /Unable to read extra usage credits_limit/,
    );
  });

  test("throws on NaN input rather than fabricating a permissive value", () => {
    expect(() => parseUsageQuotaNumber(Number.NaN, "credits_limit")).toThrow(/not a finite number/);
  });

  test("throws on Infinity", () => {
    expect(() => parseUsageQuotaNumber(Number.POSITIVE_INFINITY, "credits_limit")).toThrow(
      /not a finite number/,
    );
  });

  test("throws on null / undefined / empty / whitespace (missing value)", () => {
    expect(() => parseUsageQuotaNumber(null, "current_usage")).toThrow(/empty or missing/);
    expect(() => parseUsageQuotaNumber(undefined, "current_usage")).toThrow(/empty or missing/);
    expect(() => parseUsageQuotaNumber("", "current_usage")).toThrow(/empty or missing/);
    expect(() => parseUsageQuotaNumber("   ", "current_usage")).toThrow(/empty or missing/);
  });

  test("names the field in the error so corrupt columns are identifiable", () => {
    expect(() => parseUsageQuotaNumber("x", "credits_limit")).toThrow(/credits_limit/);
    expect(() => parseUsageQuotaNumber("x", "current_usage")).toThrow(/current_usage/);
  });
});

describe("spend-gate fail-open regression (corrupt limit)", () => {
  test("bare Number(...) comparison would silently fail OPEN on a corrupt limit", () => {
    const corruptLimit = Number("corrupt");
    const usage = Number("999999");
    expect(usage >= corruptLimit).toBe(false);
    expect(usage + 100 > corruptLimit).toBe(false);
  });

  test("the fail-closed reader throws on that same corrupt limit", () => {
    expect(() => parseUsageQuotaNumber("corrupt", "credits_limit")).toThrow();
  });
});
