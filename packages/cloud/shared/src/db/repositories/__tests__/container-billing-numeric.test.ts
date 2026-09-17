/**
 * Exercises container-billing numeric parsing with deterministic input classes.
 * Source checks below inspect wiring only; they do not prove transaction behavior.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as numericModule from "../container-billing-numeric";
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

describe("recordSuccessfulDailyBilling wires every NUMERIC read through fail-closed boundaries", () => {
  test("source pins balance reads to exact parsing (no bare Number(...) survives)", () => {
    // Grep-guard against a regression that reintroduces a bare `Number(<row
    // field>)` read on the billing write path. Reads the actual source (not a
    // transpiled Function.toString(), which can rename/reorder).
    const repoPath = fileURLToPath(new URL("../container-billing.ts", import.meta.url));
    const src = readFileSync(repoPath, "utf8");
    expect(src).toContain('exactBillingDecimal(lockedOrg.credit_balance, "credit_balance")');
    expect(src).toContain(
      'exactBillingDecimal(earningsRow.available_balance, "available_balance")',
    );
    expect(src).toContain('parseContainerBillingNumber(org.credit_balance, "credit_balance")');
    expect(src).toContain(
      'parseContainerBillingNumber(updatedOrg.credit_balance, "credit_balance")',
    );
    // No bare Number(...) read of a corrupt-prone NUMERIC row field survives.
    // `\bNumber\(` anchors on the global Number constructor, NOT the tail of
    // the helper name `parseContainerBillingNumber(` (which contains "Number(").
    expect(src).not.toMatch(/\bNumber\(\s*lockedOrg\.credit_balance/);
    expect(src).not.toMatch(/\bNumber\(\s*earningsRow\.available_balance/);
    expect(src).not.toMatch(/\bNumber\(\s*org\.credit_balance/);
    expect(src).not.toMatch(/\bNumber\(\s*updatedOrg\.credit_balance/);
    // exported parser is the module's fail-closed boundary
    expect(typeof numericModule.parseContainerBillingNumber).toBe("function");
  });
});
