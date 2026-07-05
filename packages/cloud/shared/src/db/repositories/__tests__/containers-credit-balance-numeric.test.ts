/**
 * Fail-closed NUMERIC boundary for the container deploy/quota `credit_balance`
 * reads in `ContainersRepository` (#13415, cloud-shared DB-repository
 * fallback-slop sweep).
 *
 * `organizations.credit_balance` is a Postgres NUMERIC column, so the driver
 * hands it back as a string. Before this slice three reads in
 * `ContainersRepository` coerced it with a bare `Number(...)`, which fails OPEN
 * on a corrupt value (`'NaN'::numeric` is a valid Postgres NUMERIC and a
 * migration artifact / manual DB edit can produce a non-parseable string):
 *
 *   - `createContainerWithCreditDeduction` (money-out spend gate): the
 *     insufficient-balance guard `Number(credit_balance) < deploymentCost` is
 *     FALSE for `NaN`, so the deploy+debit is AUTHORIZED against a corrupt
 *     balance, the container is created FREE, and `String(NaN - cost)` = `"NaN"`
 *     is written back into the balance column — permanently poisoning it. A
 *     money-out gate failing open is the worst class of this bug.
 *   - `createWithQuotaCheck` and `checkQuota` (container-quota tier): a `NaN`
 *     feeds `getMaxContainersForOrg`, which silently drops the org into the
 *     FREE quota tier, mis-labelling a paying org's container allowance.
 *
 * All three now delegate to the merged, exported fail-closed boundary
 * `parseOrganizationCreditBalance` (#13416) — the same helper the two
 * `OrganizationsRepository` mutation paths already use for this exact column —
 * so a corrupt read throws a field-named error INSIDE the mutation transaction
 * (money path) / denies the pre-flight check (read-only path) instead of
 * bypassing the guard or fabricating a free-tier max.
 *
 * A real corrupt NUMERIC cannot be stored in PGlite/Postgres (they reject it),
 * so the healthy-path regression coverage lives in the PGlite-backed container
 * suites. These tests pin the reused PARSER boundary against the money-out
 * class and grep-guard that each wired read site delegates to it — the exact
 * seam a read-time driver quirk / migration artifact would hit.
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

    // Exactly three call sites delegate to the parser (checkQuota,
    // createWithQuotaCheck, createContainerWithCreditDeduction).
    const delegations = src.match(/parseOrganizationCreditBalance\(\s*org\.credit_balance/g) ?? [];
    expect(delegations.length).toBe(3);

    // No bare Number(...) read of the corrupt-prone NUMERIC field survives.
    // `\bNumber\(` anchors on the global Number constructor, NOT the tail of a
    // helper name.
    expect(src).not.toMatch(/\bNumber\(\s*org\.credit_balance/);
  });
});
