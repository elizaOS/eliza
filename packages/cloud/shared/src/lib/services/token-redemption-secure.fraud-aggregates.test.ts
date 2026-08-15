/**
 * Exercises fail-closed fraud aggregates in the secure token-redemption path.
 * The deterministic harness controls each database aggregate returned to the
 * private fraud check and verifies corrupt values require manual review.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Results are consumed in the same order as the fraud check's aggregate queries.
let executeResults: Array<{ rows: Array<Record<string, unknown>> }> = [];

mock.module("../../db/client", () => ({
  dbRead: {
    execute: async () => {
      const next = executeResults.shift();
      if (!next) throw new Error("test: unexpected extra dbRead.execute call");
      return next;
    },
    query: {},
  },
  dbWrite: {},
}));

const { SecureTokenRedemptionService } = await import("./token-redemption-secure");

type FraudCheck = (
  userId: string,
  appId: string | undefined,
  pointsAmount: number,
  payoutAddress?: string,
) => Promise<{ flagged: boolean; warning?: string; requiresReview?: boolean }>;

function callCheckFraudPatterns(
  appId: string | undefined,
  pointsAmount: number,
  payoutAddress?: string,
): Promise<{ flagged: boolean; warning?: string; requiresReview?: boolean }> {
  const service = new SecureTokenRedemptionService() as unknown as {
    checkFraudPatterns: FraudCheck;
  };
  return service.checkFraudPatterns("user-1", appId, pointsAmount, payoutAddress);
}

beforeEach(() => {
  executeResults = [];
});

describe("checkFraudPatterns fail-closed aggregates", () => {
  test("healthy aggregates below thresholds do not flag", async () => {
    executeResults = [
      { rows: [{ count: "0", total: "0" }] }, // recent earnings
      { rows: [{ total: "100.00" }] }, // total earned
      { rows: [{ total: "1.00" }] }, // total redeemed
      { rows: [{ user_count: "0" }] }, // shared address
    ];
    const result = await callCheckFraudPatterns("app-1", 500, "0xabc");
    expect(result.flagged).toBe(false);
  });

  test("healthy fast earn-to-redeem pattern still flags", async () => {
    executeResults = [
      // 5 earnings in the last hour totalling $100 vs a $5 redemption
      { rows: [{ count: "5", total: "100.00" }] },
    ];
    const result = await callCheckFraudPatterns("app-1", 500);
    expect(result.flagged).toBe(true);
    expect(result.requiresReview).toBe(true);
    expect(result.warning).toContain("within last hour");
  });

  test("REGRESSION: corrupt recent-earnings SUM ('NaN') flags for review instead of failing open", async () => {
    // Old behavior: Number("NaN" || 0) === NaN; NaN > x === false -> heuristic
    // silently skipped and the redemption sailed through unflagged.
    executeResults = [{ rows: [{ count: "3", total: "NaN" }] }];
    const result = await callCheckFraudPatterns("app-1", 500);
    expect(result.flagged).toBe(true);
    expect(result.requiresReview).toBe(true);
    expect(result.warning).toContain("corrupt");
  });

  test("REGRESSION: corrupt lifetime earned SUM ('NaN') flags instead of skipping the ratio check", async () => {
    executeResults = [
      { rows: [{ count: "0", total: "0" }] },
      { rows: [{ total: "NaN" }] }, // corrupt total earned
      { rows: [{ total: "5.00" }] },
    ];
    const result = await callCheckFraudPatterns("app-1", 500);
    expect(result.flagged).toBe(true);
    expect(result.requiresReview).toBe(true);
    expect(result.warning).toContain("corrupt");
  });

  test("REGRESSION: corrupt redeemed SUM ('NaN') flags instead of skipping the ratio check", async () => {
    executeResults = [
      { rows: [{ count: "0", total: "0" }] },
      { rows: [{ total: "100.00" }] },
      { rows: [{ total: "NaN" }] }, // corrupt total redeemed
    ];
    const result = await callCheckFraudPatterns("app-1", 500);
    expect(result.flagged).toBe(true);
    expect(result.requiresReview).toBe(true);
    expect(result.warning).toContain("corrupt");
  });

  test("REGRESSION: corrupt shared-address user_count flags instead of skipping the sybil check", async () => {
    executeResults = [{ rows: [{ user_count: "garbage" }] }];
    const result = await callCheckFraudPatterns(undefined, 500, "0xshared");
    expect(result.flagged).toBe(true);
    expect(result.requiresReview).toBe(true);
    expect(result.warning).toContain("corrupt");
  });

  test("missing aggregate row (undefined fields) flags for review, not treated as zero", async () => {
    executeResults = [{ rows: [] }];
    const result = await callCheckFraudPatterns("app-1", 500);
    expect(result.flagged).toBe(true);
    expect(result.requiresReview).toBe(true);
  });

  test.each([[""], ["   "], ["Infinity"], ["-1"], [null], [undefined]])(
    "invalid recent-earnings COUNT %p flags for review",
    async (count) => {
      executeResults = [{ rows: [{ count, total: "0" }] }];
      const result = await callCheckFraudPatterns("app-1", 500);
      expect(result).toMatchObject({ flagged: true, requiresReview: true });
      expect(result.warning).toContain("corrupt");
    },
  );

  test("high redemption ratio on healthy data still flags", async () => {
    executeResults = [
      { rows: [{ count: "0", total: "0" }] },
      { rows: [{ total: "10.00" }] }, // earned $10
      { rows: [{ total: "9.50" }] }, // redeemed $9.50, requesting $5 more
    ];
    const result = await callCheckFraudPatterns("app-1", 500);
    expect(result.flagged).toBe(true);
    expect(result.warning).toContain("redemption ratio");
  });

  test("explicit zero aggregates are legitimate domain values (no flag)", async () => {
    executeResults = [
      { rows: [{ count: "0", total: "0" }] },
      { rows: [{ total: "0" }] },
      { rows: [{ total: "0" }] },
    ];
    const result = await callCheckFraudPatterns("app-1", 500);
    expect(result.flagged).toBe(false);
  });
});
