/**
 * Fail-closed coverage for residual NUMERIC reads in the secure
 * token-redemption service. The IP-cap and refund paths must deny or roll back
 * on corrupt aggregates instead of treating `NaN`, empty, or negative money
 * values as healthy zeroes.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// db/client mock — checkIPRateLimits performs two dbRead.execute calls
// (hourly count, then daily count+sum); rejectRedemption runs a single
// dbWrite.transaction whose tx does a select-for-update then writes.
// ---------------------------------------------------------------------------
let executeResults: Array<{ rows: Array<Record<string, unknown>> }> = [];
let txRedemptionRow: Record<string, unknown> | undefined;
let txWriteCalls = 0;

function makeTx() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          for: async () => (txRedemptionRow ? [txRedemptionRow] : []),
        }),
      }),
    }),
    update: () => {
      txWriteCalls += 1;
      return {
        set: () => ({
          where: async () => undefined,
        }),
      };
    },
    insert: () => {
      txWriteCalls += 1;
      return {
        values: async () => undefined,
      };
    },
  };
}

mock.module("../../db/client", () => ({
  dbRead: {
    execute: async () => {
      const next = executeResults.shift();
      if (!next) throw new Error("unexpected dbRead.execute call");
      return next;
    },
    query: {
      redemptionLimits: {
        findFirst: async () => undefined,
      },
    },
  },
  dbWrite: {
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      // Real drizzle transactions roll back when the callback throws; the
      // mock just propagates, which is the observable contract we assert.
      await fn(makeTx());
    },
  },
}));

const { SecureTokenRedemptionService, CorruptRedemptionLimitError } = await import(
  "./token-redemption-secure"
);

type IPRateCheck = (
  ipAddress: string,
  pointsAmount: number,
) => Promise<{ valid: boolean; error?: string }>;

function callCheckIPRateLimits(pointsAmount: number): Promise<{ valid: boolean; error?: string }> {
  const service = new SecureTokenRedemptionService() as unknown as {
    checkIPRateLimits: IPRateCheck;
  };
  return service.checkIPRateLimits("203.0.113.7", pointsAmount);
}

beforeEach(() => {
  executeResults = [];
  txRedemptionRow = undefined;
  txWriteCalls = 0;
});

describe("checkIPRateLimits — per-IP daily USD cap (fail-closed)", () => {
  test("REGRESSION: corrupt 'NaN' SUM no longer bypasses the per-IP daily USD cap", async () => {
    executeResults = [
      { rows: [{ count: "1" }] }, // hourly count: under limit
      { rows: [{ count: "2", total_usd: "NaN" }] }, // 'NaN'::numeric poisoned SUM
    ];
    const result = await callCheckIPRateLimits(1000);
    // Old behavior: Number("NaN") = NaN -> both daily gates false -> valid:true.
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unable to verify");
  });

  test("empty-string aggregate is treated as corrupt, not $0", async () => {
    executeResults = [{ rows: [{ count: "0" }] }, { rows: [{ count: "0", total_usd: "" }] }];
    const result = await callCheckIPRateLimits(1000);
    expect(result.valid).toBe(false);
  });

  test("negative aggregate is treated as corrupt, not a cap offset", async () => {
    executeResults = [{ rows: [{ count: "0" }] }, { rows: [{ count: "0", total_usd: "-25" }] }];
    const result = await callCheckIPRateLimits(1000);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unable to verify");
  });

  test("missing daily aggregate row is corrupt, not an implicit $0", async () => {
    executeResults = [{ rows: [{ count: "0" }] }, { rows: [] }];
    const result = await callCheckIPRateLimits(1000);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unable to verify");
  });

  test("corrupt hourly count denies instead of becoming zero", async () => {
    executeResults = [{ rows: [{ count: "NaN" }] }];
    const result = await callCheckIPRateLimits(1000);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unable to verify");
  });

  test("corrupt daily count denies instead of becoming zero", async () => {
    executeResults = [{ rows: [{ count: "0" }] }, { rows: [{ count: "NaN", total_usd: "0" }] }];
    const result = await callCheckIPRateLimits(1000);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unable to verify");
  });

  test("healthy aggregate under the cap still passes", async () => {
    executeResults = [{ rows: [{ count: "1" }] }, { rows: [{ count: "2", total_usd: "50.25" }] }];
    const result = await callCheckIPRateLimits(1000); // +$10
    expect(result.valid).toBe(true);
  });

  test("healthy aggregate over the cap still denies with the limit message", async () => {
    executeResults = [{ rows: [{ count: "1" }] }, { rows: [{ count: "2", total_usd: "99999" }] }];
    const result = await callCheckIPRateLimits(1000);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Daily redemption value limit");
  });

  test("COALESCE zero (no prior redemptions) stays a legitimate $0", async () => {
    executeResults = [{ rows: [{ count: "0" }] }, { rows: [{ count: "0", total_usd: "0" }] }];
    const result = await callCheckIPRateLimits(1000);
    expect(result.valid).toBe(true);
  });
});

describe("rejectRedemption — refund amount (fail-closed)", () => {
  test("REGRESSION: corrupt usd_value throws before any balance write (no NaN poisoning)", async () => {
    txRedemptionRow = {
      id: "red-1",
      user_id: "user-1",
      usd_value: "NaN", // 'NaN'::numeric reads back as the string "NaN"
      status: "pending",
    };
    const service = new SecureTokenRedemptionService();
    await expect(service.rejectRedemption("red-1", "admin-1", "fraud review")).rejects.toThrow(
      CorruptRedemptionLimitError,
    );
    // The parse throws BEFORE tx.update/tx.insert run: the transaction rolls
    // back with zero writes instead of interpolating NaN into balance SQL.
    expect(txWriteCalls).toBe(0);
  });

  test("REGRESSION: negative usd_value throws before any balance write", async () => {
    txRedemptionRow = {
      id: "red-negative",
      user_id: "user-1",
      usd_value: "-12.3400",
      status: "pending",
    };
    const service = new SecureTokenRedemptionService();
    await expect(
      service.rejectRedemption("red-negative", "admin-1", "fraud review"),
    ).rejects.toThrow(CorruptRedemptionLimitError);
    expect(txWriteCalls).toBe(0);
  });

  test("healthy usd_value refunds normally", async () => {
    txRedemptionRow = {
      id: "red-2",
      user_id: "user-2",
      usd_value: "12.3400",
      status: "pending",
    };
    const service = new SecureTokenRedemptionService();
    const result = await service.rejectRedemption("red-2", "admin-1", "user request");
    expect(result.success).toBe(true);
    expect(txWriteCalls).toBeGreaterThan(0);
  });
});
