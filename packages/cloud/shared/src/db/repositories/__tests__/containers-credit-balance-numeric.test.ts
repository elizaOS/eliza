/**
 * Pins the fail-closed NUMERIC boundary used by container quota and debit
 * reads. Deterministic parser cases cover corrupt driver values, while source
 * guards ensure every repository admission path delegates to the same parser;
 * healthy persistence remains covered by the PGlite container suites.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

describe("ContainersRepository wires every credit_balance read through the fail-closed parser", () => {
  test("source pins all three read sites to parseOrganizationCreditBalance (no bare Number(org.credit_balance) survives)", () => {
    // Grep-guard against a regression that reintroduces a bare
    // `Number(org.credit_balance)` on the deploy / quota paths. Reads the actual
    // source (not a transpiled Function.toString(), which can rename/reorder).
    const repoPath = fileURLToPath(new URL("../containers.ts", import.meta.url));
    const src = readFileSync(repoPath, "utf8");

    // The module imports the shared fail-closed boundary.
    expect(src).toContain(
      'import { parseOrganizationCreditBalance } from "./organizations-credit-balance-numeric"',
    );

    // Quota reads share one canonical DB-source resolver; the money-out debit
    // keeps its independent parser call inside its transaction.
    const delegations = src.match(/parseOrganizationCreditBalance\(\s*org\.credit_balance/g) ?? [];
    expect(delegations.length).toBe(1);
    expect(src).toContain(
      'parsedBalance = parseOrganizationCreditBalance(creditBalance, "credit_balance")',
    );

    // Both checkQuota and createWithQuotaCheck use that same source resolver
    // (plus its declaration), so their missing/corrupt behavior cannot drift.
    const quotaResolutions = src.match(/resolveContainerLimitFromDatabaseSources\(/g) ?? [];
    expect(quotaResolutions.length).toBe(3);

    // A quota reached result stays authoritative; only source failures carry
    // the explicit unavailable state consumed by the account-limits snapshot.
    expect(src).toContain('availability: "ready"');
    expect(src).toContain('availability: "unavailable"');

    // No bare Number(...) read of the corrupt-prone NUMERIC field survives.
    // `\bNumber\(` anchors on the global Number constructor, NOT the tail of a
    // helper name.
    expect(src).not.toMatch(/\bNumber\(\s*org\.credit_balance/);
  });
});
