import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { X402BudgetTracker } from "./budget";

describe("X402BudgetTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows payments within default (unbounded) limits", () => {
    const tracker = new X402BudgetTracker();
    expect(tracker.checkBudget("svc", 100n)).toEqual({ allowed: true });
    expect(tracker.checkBudget("svc", 10_000_000n)).toEqual({ allowed: true });
  });

  it("rejects amounts above the global per-request max", () => {
    const tracker = new X402BudgetTracker({ globalPerRequestMax: 1000n });
    expect(tracker.checkBudget("svc", 1001n)).toMatchObject({ allowed: false });
    expect(tracker.checkBudget("svc", 1001n).reason).toContain(
      "per-request max",
    );
    expect(tracker.checkBudget("svc", 1000n)).toEqual({ allowed: true });
  });

  it("rejects amounts that would exceed the global daily limit", () => {
    const tracker = new X402BudgetTracker({ globalDailyLimit: 5000n });
    expect(tracker.checkBudget("svc", 4000n)).toEqual({ allowed: true });
    tracker.recordPayment({
      service: "svc",
      amount: 4000n,
      success: true,
      timestamp: 1,
    });
    expect(tracker.checkBudget("svc", 2000n)).toMatchObject({ allowed: false });
    expect(tracker.checkBudget("svc", 2000n).reason).toContain("daily limit");
  });

  it("enforces per-service per-request caps", () => {
    const tracker = new X402BudgetTracker({
      serviceBudgets: [
        { service: "llm", maxPerRequest: 50n, dailyLimit: 10_000n },
      ],
    });
    expect(tracker.checkBudget("llm", 50n)).toEqual({ allowed: true });
    expect(tracker.checkBudget("llm", 51n)).toMatchObject({ allowed: false });
    expect(tracker.checkBudget("llm", 51n).reason).toContain("per-request max");
  });

  it("enforces per-service daily limits", () => {
    const tracker = new X402BudgetTracker({
      serviceBudgets: [
        { service: "llm", maxPerRequest: 1000n, dailyLimit: 300n },
      ],
    });
    expect(tracker.checkBudget("llm", 200n)).toEqual({ allowed: true });
    tracker.recordPayment({
      service: "llm",
      amount: 200n,
      success: true,
      timestamp: 1,
    });
    expect(tracker.checkBudget("llm", 200n)).toMatchObject({ allowed: false });
    expect(tracker.checkBudget("llm", 200n).reason).toContain("daily limit");
  });

  it("applies a wildcard service budget as a fallback", () => {
    const tracker = new X402BudgetTracker({
      serviceBudgets: [{ service: "*", maxPerRequest: 10n, dailyLimit: 100n }],
    });
    expect(tracker.checkBudget("anything", 10n)).toEqual({ allowed: true });
    expect(tracker.checkBudget("anything", 11n)).toMatchObject({
      allowed: false,
    });
  });

  it("accumulates successful payments and skips failed ones", () => {
    const tracker = new X402BudgetTracker({
      serviceBudgets: [
        { service: "llm", maxPerRequest: 1000n, dailyLimit: 500n },
      ],
    });
    tracker.recordPayment({
      service: "llm",
      amount: 200n,
      success: true,
      timestamp: 1,
    });
    tracker.recordPayment({
      service: "llm",
      amount: 200n,
      success: true,
      timestamp: 2,
    });
    tracker.recordPayment({
      service: "llm",
      amount: 200n,
      success: false,
      timestamp: 3,
    });
    // 400 spent; a 100 payment fits, a 101 payment does not.
    expect(tracker.checkBudget("llm", 100n)).toEqual({ allowed: true });
    expect(tracker.checkBudget("llm", 101n)).toMatchObject({ allowed: false });
    expect(tracker.getDailySpendSummary().global).toBe(400n);
    expect(tracker.getDailySpendSummary().byService).toEqual({ llm: 400n });
  });

  it("resets daily spend once the UTC day rolls over", () => {
    const tracker = new X402BudgetTracker({
      serviceBudgets: [
        { service: "llm", maxPerRequest: 1000n, dailyLimit: 500n },
      ],
    });
    tracker.recordPayment({
      service: "llm",
      amount: 400n,
      success: true,
      timestamp: 1,
    });
    expect(tracker.checkBudget("llm", 200n)).toMatchObject({ allowed: false });

    vi.setSystemTime(new Date("2026-08-26T00:00:01.000Z"));
    expect(tracker.checkBudget("llm", 200n)).toEqual({ allowed: true });
    expect(tracker.getDailySpendSummary().global).toBe(0n);
  });

  it("filters the transaction log by service and timestamp", () => {
    const tracker = new X402BudgetTracker();
    tracker.recordPayment({
      service: "a",
      amount: 1n,
      success: true,
      timestamp: 100,
    });
    tracker.recordPayment({
      service: "b",
      amount: 2n,
      success: true,
      timestamp: 200,
    });
    tracker.recordPayment({
      service: "a",
      amount: 3n,
      success: true,
      timestamp: 300,
    });

    expect(tracker.getTransactionLog({ service: "a" })).toHaveLength(2);
    expect(tracker.getTransactionLog({ since: 250 })).toHaveLength(1);
    expect(
      tracker.getTransactionLog({ service: "a", since: 150 }),
    ).toHaveLength(1);
    expect(tracker.getTransactionLog()).toHaveLength(3);
  });

  it("adds service budgets at runtime", () => {
    const tracker = new X402BudgetTracker();
    tracker.setServiceBudget({
      service: "new",
      maxPerRequest: 5n,
      dailyLimit: 20n,
    });
    expect(tracker.checkBudget("new", 5n)).toEqual({ allowed: true });
    expect(tracker.checkBudget("new", 6n)).toMatchObject({ allowed: false });
  });
});
