/**
 * Tests for Redis enforcement middleware.
 *
 * These tests verify the rate-limit and spend-tracking extraction
 * and enforcement logic WITHOUT requiring a live Redis connection.
 * Redis helpers degrade gracefully when unavailable.
 */

import { describe, expect, it } from "bun:test";
import type { PolicyRule } from "@stwd/shared";
import {
  enforceRateLimit,
  extractRateLimitPolicy,
  extractSpendLimitPolicy,
  recordVaultSpend,
} from "../middleware/redis-enforcement";

// ─── Policy extraction tests ─────────────────────────────────────────────────

describe("extractRateLimitPolicy", () => {
  it("returns null when no rate-limit policy exists", () => {
    const policies: PolicyRule[] = [
      {
        id: "p1",
        type: "spending-limit",
        enabled: true,
        config: {
          maxPerDay: "1000000",
          maxPerWeek: "5000000",
          maxPerTx: "100000",
        },
      },
    ];
    expect(extractRateLimitPolicy(policies)).toBeNull();
  });

  it("returns null when rate-limit policy is disabled", () => {
    const policies: PolicyRule[] = [
      {
        id: "p1",
        type: "rate-limit",
        enabled: false,
        config: { maxTxPerHour: 10, maxTxPerDay: 100 },
      },
    ];
    expect(extractRateLimitPolicy(policies)).toBeNull();
  });

  it("extracts rate-limit config from enabled policy", () => {
    const policies: PolicyRule[] = [
      {
        id: "p1",
        type: "rate-limit",
        enabled: true,
        config: { maxTxPerHour: 25, maxTxPerDay: 200 },
      },
    ];
    const result = extractRateLimitPolicy(policies);
    expect(result).toEqual({ maxTxPerHour: 25, maxTxPerDay: 200 });
  });

  it("uses defaults for missing config fields", () => {
    const policies: PolicyRule[] = [
      {
        id: "p1",
        type: "rate-limit",
        enabled: true,
        config: {},
      },
    ];
    const result = extractRateLimitPolicy(policies);
    expect(result).toEqual({ maxTxPerHour: 100, maxTxPerDay: 1000 });
  });
});

describe("extractSpendLimitPolicy", () => {
  it("returns null when no spending-limit policy exists", () => {
    const policies: PolicyRule[] = [
      {
        id: "p1",
        type: "rate-limit",
        enabled: true,
        config: { maxTxPerHour: 10, maxTxPerDay: 100 },
      },
    ];
    expect(extractSpendLimitPolicy(policies)).toBeNull();
  });

  it("extracts canonical format spend limits", () => {
    const policies: PolicyRule[] = [
      {
        id: "p1",
        type: "spending-limit",
        enabled: true,
        config: {
          maxPerDay: "1000000",
          maxPerWeek: "5000000",
          maxPerTx: "100000",
        },
      },
    ];
    const result = extractSpendLimitPolicy(policies);
    expect(result).toEqual({ maxPerDay: "1000000", maxPerWeek: "5000000" });
  });

  it("handles simplified period format (day)", () => {
    const policies: PolicyRule[] = [
      {
        id: "p1",
        type: "spending-limit",
        enabled: true,
        config: { maxAmount: "500000", period: "day" },
      },
    ];
    const result = extractSpendLimitPolicy(policies);
    expect(result).not.toBeNull();
    if (!result) throw new Error("Expected spend-limit policy");
    expect(result.maxPerDay).toBe("500000");
  });

  it("handles simplified period format (week)", () => {
    const policies: PolicyRule[] = [
      {
        id: "p1",
        type: "spending-limit",
        enabled: true,
        config: { maxAmount: "2000000", period: "week" },
      },
    ];
    const result = extractSpendLimitPolicy(policies);
    expect(result).not.toBeNull();
    if (!result) throw new Error("Expected spend-limit policy");
    expect(result.maxPerWeek).toBe("2000000");
  });
});

// ─── Graceful degradation tests (no Redis) ───────────────────────────────────

describe("enforceRateLimit (no Redis)", () => {
  it("allows requests when Redis is not available", async () => {
    const policies: PolicyRule[] = [
      {
        id: "p1",
        type: "rate-limit",
        enabled: true,
        config: { maxTxPerHour: 1, maxTxPerDay: 1 },
      },
    ];

    const result = await enforceRateLimit("test-agent", policies);
    expect(result.allowed).toBe(true);
  });

  it("allows requests when no rate-limit policy exists", async () => {
    const policies: PolicyRule[] = [];
    const result = await enforceRateLimit("test-agent", policies);
    expect(result.allowed).toBe(true);
  });
});

describe("recordVaultSpend (no Redis)", () => {
  it("does not throw when Redis is not available", async () => {
    // Should silently succeed (no-op)
    await recordVaultSpend("test-agent", "test-tenant", "1000000000000000000", 8453);
  });

  it("does not throw for zero value", async () => {
    await recordVaultSpend("test-agent", "test-tenant", "0", 8453);
  });
});
