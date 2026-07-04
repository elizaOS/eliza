/**
 * Fail-closed NUMERIC boundary for the container daily-billing transaction
 * (#13416, cloud-shared DB-repository fallback-slop sweep).
 *
 * Postgres NUMERIC arrives as a string. Before this slice
 * `recordSuccessfulDailyBilling` read `containers.total_billed` and
 * `organizations.credit_balance` through a bare `Number(...)`, so a corrupt
 * value became `NaN` and poisoned the billing write path:
 *
 *   - `total_billed`  → `String(Number(total_billed) + dailyCost)` = `"NaN"`,
 *                       written back into the NUMERIC column. That either
 *                       rolls back the whole billing transaction with a cryptic
 *                       driver cast error (container never billed, cron retries
 *                       forever = silent free hosting) or persists a corrupt
 *                       running total.
 *   - `credit_balance` → the returned `newBalance` becomes `NaN` and is shown
 *                        verbatim: the low-balance email renders `$NaN`, and
 *                        `lowerOrgBalanceHint`/logs record a garbage figure.
 *
 * A real corrupt NUMERIC cannot be stored in PGlite/Postgres (they reject it),
 * so the healthy-path regression coverage lives in the PGlite-backed
 * container-billing-idempotency suite (it asserts a finite `newBalance` and a
 * correctly-accumulated `total_billed`). These tests pin the PARSER boundary
 * exhaustively and prove each wired read site delegates to it — which is the
 * exact seam a read-time driver quirk / migration artifact would hit.
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
    expect(Number("corrupt")).toBeNaN();
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

describe("recordSuccessfulDailyBilling wires every NUMERIC read through the fail-closed parser", () => {
  test("source pins all three read sites to parseContainerBillingNumber (no bare Number(...) survives)", () => {
    // Grep-guard against a regression that reintroduces a bare `Number(<row
    // field>)` read on the billing write path. Reads the actual source (not a
    // transpiled Function.toString(), which can rename/reorder).
    const repoPath = fileURLToPath(new URL("../container-billing.ts", import.meta.url));
    const src = readFileSync(repoPath, "utf8");
    expect(src).toContain("parseContainerBillingNumber(input.currentTotalBilled");
    expect(src).toContain('parseContainerBillingNumber(org.credit_balance, "credit_balance")');
    expect(src).toContain(
      'parseContainerBillingNumber(updatedOrg.credit_balance, "credit_balance")',
    );
    // No bare Number(...) read of a corrupt-prone NUMERIC row field survives.
    // `\bNumber\(` anchors on the global Number constructor, NOT the tail of
    // the helper name `parseContainerBillingNumber(` (which contains "Number(").
    expect(src).not.toMatch(/\bNumber\(\s*input\.currentTotalBilled/);
    expect(src).not.toMatch(/\bNumber\(\s*org\.credit_balance/);
    expect(src).not.toMatch(/\bNumber\(\s*updatedOrg\.credit_balance/);
    // exported parser is the module's fail-closed boundary
    expect(typeof numericModule.parseContainerBillingNumber).toBe("function");
  });
});
