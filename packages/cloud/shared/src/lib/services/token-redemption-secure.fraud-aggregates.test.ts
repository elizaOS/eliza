// Fail-closed fraud-heuristic aggregates for the secure token-redemption path.
//
// Regression coverage for #13415: `checkFraudPatterns` read its SQL aggregates
// (COUNT/SUM over the `app_earnings_transactions.amount` and
// `token_redemptions.usd_value` NUMERIC columns) via bare `Number(... || 0)`.
// The Postgres driver returns NUMERIC as strings and `'NaN'::numeric` is a
// valid stored value, so `SUM(...)` over a corrupt row reads back as the
// string "NaN": `"NaN" || 0` keeps the truthy string, `Number("NaN")` is NaN,
// and every NaN comparison is `false` — silently disabling ALL THREE fraud
// heuristics (fast earn-to-redeem, high redemption ratio, shared payout
// address). The fix parses each aggregate through a fail-closed boundary and
// FLAGS the redemption for manual review on corrupt data instead of skipping
// the checks.
//
// Harness: bun:test with a mocked db client (the only DB touch points in
// checkFraudPatterns are dbRead.execute calls, controlled per-test).

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// db/client mock — checkFraudPatterns performs up to three dbRead.execute
// calls in order: recent earnings, total earned, total redeemed, plus one for
// the shared-address check. Queue rows per call.
// ---------------------------------------------------------------------------
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
