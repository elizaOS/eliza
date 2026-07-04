/**
 * Fail-closed NUMERIC boundary for app-earnings money-out (payout / withdrawal)
 * gates (#13416, cloud-shared DB-repository fallback-slop sweep).
 *
 * Postgres NUMERIC arrives as a string. Before this slice the withdrawal gates
 * read `withdrawable_balance` / `payout_threshold` through a bare `Number(...)`,
 * so a corrupt value became `NaN` and the guards FAILED OPEN:
 *
 *   - `amount < threshold`    → `amount < NaN` is always false → the minimum
 *                               payout gate was bypassed (sub-threshold payout).
 *                               This gate has NO DB-level backstop.
 *   - `withdrawable < amount` → `NaN < amount` is always false → the
 *                               insufficient-balance pre-check was bypassed.
 *
 * These tests pin the parser boundary AND the gate wiring (via a stubbed read)
 * without needing a real corrupt NUMERIC in the DB — Postgres/PGlite would
 * reject storing one, but a driver quirk / migration artifact can still surface
 * one at read time, which is exactly the failure mode this guards.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AppEarningsRepository } from "../app-earnings";
import { parseEarningsNumber } from "../app-earnings-numeric";

describe("parseEarningsNumber", () => {
  test("parses a well-formed NUMERIC string", () => {
    expect(parseEarningsNumber("25.00", "payout_threshold")).toBe(25);
    expect(parseEarningsNumber("100.500000", "withdrawable_balance")).toBe(100.5);
  });

  test("parses a numeric literal", () => {
    expect(parseEarningsNumber(0, "withdrawable_balance")).toBe(0);
    expect(parseEarningsNumber(42, "withdrawable_balance")).toBe(42);
  });

  test("allows an explicit domain zero", () => {
    expect(parseEarningsNumber("0", "withdrawable_balance")).toBe(0);
    expect(parseEarningsNumber("0.000000", "withdrawable_balance")).toBe(0);
  });

  test("throws on null / undefined instead of fabricating 0", () => {
    expect(() => parseEarningsNumber(null, "payout_threshold")).toThrow(/payout_threshold/);
    expect(() => parseEarningsNumber(undefined, "withdrawable_balance")).toThrow(
      /withdrawable_balance/,
    );
  });

  test("throws on empty / whitespace-only instead of fabricating 0", () => {
    expect(() => parseEarningsNumber("", "payout_threshold")).toThrow(/empty or missing/);
    expect(() => parseEarningsNumber("   ", "withdrawable_balance")).toThrow(/empty or missing/);
  });

  test("REGRESSION: a corrupt value throws instead of becoming NaN (fail-open guard)", () => {
    // This is the exact class the gates used to swallow: `Number("corrupt")` is
    // NaN, and every `< NaN` comparison is false — a silently-open payout gate.
    expect(Number("corrupt")).toBeNaN();
    expect(() => parseEarningsNumber("corrupt", "payout_threshold")).toThrow(/not a finite number/);
    expect(() => parseEarningsNumber("12.3.4", "withdrawable_balance")).toThrow(
      /not a finite number/,
    );
    expect(() => parseEarningsNumber("Infinity", "payout_threshold")).toThrow(
      /not a finite number/,
    );
    expect(() => parseEarningsNumber("NaN", "withdrawable_balance")).toThrow(/not a finite number/);
  });
});

describe("AppEarningsRepository.processWithdrawal fail-closed gate wiring", () => {
  const repo = new AppEarningsRepository();

  afterEach(() => {
    // bun:test restores spies via mock.restore between files; explicit for safety.
  });

  function stubEarnings(overrides: Record<string, unknown>) {
    return {
      id: "e1",
      app_id: "app-1",
      total_lifetime_earnings: "500.000000",
      total_inference_earnings: "0.000000",
      total_purchase_earnings: "500.000000",
      pending_balance: "0.000000",
      withdrawable_balance: "500.000000",
      total_withdrawn: "0.000000",
      last_withdrawal_at: null,
      payout_threshold: "25.00",
      created_at: new Date(),
      updated_at: new Date(),
      ...overrides,
    } as never;
  }

  test("healthy row: sub-threshold amount is rejected (gate holds)", async () => {
    const spy = spyOn(repo, "findByAppId").mockResolvedValue(stubEarnings({}));
    const result = await repo.processWithdrawal("app-1", 10); // below 25.00 threshold
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/at least \$25\.00/);
    spy.mockRestore();
  });

  test("corrupt payout_threshold FAILS CLOSED (throws) instead of allowing a sub-threshold payout", async () => {
    const spy = spyOn(repo, "findByAppId").mockResolvedValue(
      stubEarnings({ payout_threshold: "corrupt" }),
    );
    // Before the fix: Number("corrupt") = NaN, `10 < NaN` false, the minimum
    // payout gate is bypassed and a $10 payout below the $25 floor proceeds to
    // the DB write. Now it must throw at the read boundary.
    await expect(repo.processWithdrawal("app-1", 10)).rejects.toThrow(/payout_threshold/);
    spy.mockRestore();
  });

  test("corrupt withdrawable_balance FAILS CLOSED (throws) instead of bypassing the balance pre-check", async () => {
    const spy = spyOn(repo, "findByAppId").mockResolvedValue(
      stubEarnings({ withdrawable_balance: "corrupt", payout_threshold: "0.00" }),
    );
    // Before the fix: Number("corrupt") = NaN, `NaN < amount` false, the
    // insufficient-balance pre-check is bypassed. Now it throws first.
    await expect(repo.processWithdrawal("app-1", 1000)).rejects.toThrow(/withdrawable_balance/);
    spy.mockRestore();
  });
});
