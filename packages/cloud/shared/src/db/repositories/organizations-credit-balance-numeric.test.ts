/**
 * Fail-closed coverage for `organizations.credit_balance` mutation reads (#13416).
 *
 * Guards the two balance-mutation paths in OrganizationsRepository
 * (updateCreditBalance negative-balance guard, deductCreditsWithTransaction
 * insufficient-balance spend gate) against a corrupt NUMERIC read silently
 * failing OPEN via a bare `Number(...)`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseOrganizationCreditBalance } from "./organizations-credit-balance-numeric";

describe("parseOrganizationCreditBalance", () => {
  test("parses a well-formed NUMERIC string", () => {
    expect(parseOrganizationCreditBalance("10.50", "credit_balance")).toBe(10.5);
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

  test("names the field in the error so a corrupt column is identifiable", () => {
    expect(() => parseOrganizationCreditBalance("x", "credit_balance")).toThrow(/credit_balance/);
  });
});

describe("spend-gate / negative-guard fail-open regression (corrupt credit_balance)", () => {
  test("bare Number(...) makes both money gates silently fail OPEN on a corrupt balance", () => {
    // Reproduces the pre-fix behavior at both mutation sites.
    const corruptBalance = Number("corrupt"); // NaN
    const amount = 100;

    // updateCreditBalance negative-balance guard: NaN + amount = NaN, NaN < 0 is false.
    const newBalance = corruptBalance + amount;
    expect(Number.isNaN(newBalance)).toBe(true);
    expect(newBalance < 0).toBe(false); // guard bypassed -> "NaN" written back

    // deductCreditsWithTransaction spend gate: NaN < amount is false.
    expect(corruptBalance < amount).toBe(false); // debit authorized against corrupt balance
  });

  test("the fail-closed reader throws on that same corrupt balance instead", () => {
    expect(() => parseOrganizationCreditBalance("corrupt", "credit_balance")).toThrow();
  });
});

describe("OrganizationsRepository wires both balance-mutation reads through the parser", () => {
  // A real corrupt NUMERIC cannot be stored in Postgres/PGlite (they reject it),
  // so healthy-path behavior is covered by the existing credit-balance service
  // suites. These grep-guards pin the two mutation read sites to the fail-closed
  // parser and prove no bare Number(<row field>) survives on the write path.
  const repoPath = fileURLToPath(new URL("./organizations.ts", import.meta.url));
  const src = readFileSync(repoPath, "utf8");

  test("updateCreditBalance + deductCreditsWithTransaction both delegate to parseOrganizationCreditBalance", () => {
    const wiredReads =
      src.match(/parseOrganizationCreditBalance\(org\.credit_balance, "credit_balance"\)/g) ?? [];
    // Exactly the two balance-mutation sites route through the parser.
    expect(wiredReads.length).toBe(2);
  });

  test("no bare Number(<row field>) read of credit_balance survives on the write path", () => {
    // \bNumber\( anchors on the global Number constructor, not a helper tail.
    expect(/\bNumber\(\s*org\.credit_balance/.test(src)).toBe(false);
    expect(src).not.toContain("Number(org.credit_balance)");
  });
});
