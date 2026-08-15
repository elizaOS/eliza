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

  // #19948: COUNT aggregates are integer-only; impossible shapes must fail
  // closed to manual review instead of Number-coercing into a plausible count.
  test.each(["0.5", "1.9", "1e2", "0x10", "+1", " 1", "1 ", "9007199254740992"])(
    "REGRESSION: impossible recent-earnings COUNT shape %p fails closed to review",
    async (count) => {
      executeResults = [{ rows: [{ count, total: "100.00" }] }];
      const result = await callCheckFraudPatterns("app-1", 500);
      expect(result).toMatchObject({ flagged: true, requiresReview: true });
      expect(result.warning).toContain("corrupt");
    },
  );

  test.each(["0.5", "1.9", "1e2", "0x10", "+1", " 2", "9007199254740992"])(
    "REGRESSION: impossible shared-address user_count shape %p fails closed to review",
    async (userCount) => {
      executeResults = [{ rows: [{ user_count: userCount }] }];
      const result = await callCheckFraudPatterns(undefined, 500, "0xshared");
      expect(result).toMatchObject({ flagged: true, requiresReview: true });
      expect(result.warning).toContain("corrupt");
    },
  );

  test("REGRESSION: fractional COUNT '0.5' with healthy total flags instead of passing the fast-redemption gate", async () => {
    // Old behavior: Number("0.5") === 0.5 coerced an impossible count into a
    // usable one and evaluated the heuristic on fabricated data (#19948).
    executeResults = [{ rows: [{ count: "0.5", total: "100.00" }] }];
    const result = await callCheckFraudPatterns("app-1", 500);
    expect(result).toMatchObject({ flagged: true, requiresReview: true });
    expect(result.warning).toContain("corrupt");
  });

  test("numeric (non-string) canonical integer COUNT stays accepted", async () => {
    executeResults = [{ rows: [{ count: 5, total: "100.00" }] }];
    const result = await callCheckFraudPatterns("app-1", 500);
    expect(result.flagged).toBe(true);
    expect(result.requiresReview).toBe(true);
    expect(result.warning).toContain("within last hour");
  });

  test("numeric zero shared-address user_count stays accepted (no flag)", async () => {
    executeResults = [{ rows: [{ user_count: 0 }] }];
    const result = await callCheckFraudPatterns(undefined, 500, "0xshared");
    expect(result.flagged).toBe(false);
  });

  // #19948 (review): numeric driver values must hit the same fail-closed
  // contract on both COUNT decision paths — the parser cannot trust the
  // runtime type any more than the wire format.
  test.each([1.9, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, -3])(
    "REGRESSION: impossible numeric recent-earnings COUNT %p fails closed to review",
    async (count) => {
      executeResults = [{ rows: [{ count, total: "100.00" }] }];
      const result = await callCheckFraudPatterns("app-1", 500);
      expect(result).toMatchObject({ flagged: true, requiresReview: true });
      expect(result.warning).toContain("corrupt");
    },
  );

  test.each([
    1.9,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    -1,
    null,
    undefined,
  ])(
    "REGRESSION: impossible numeric shared-address user_count %p fails closed to review",
    async (userCount) => {
      executeResults = [{ rows: [{ user_count: userCount }] }];
      const result = await callCheckFraudPatterns(undefined, 500, "0xshared");
      expect(result).toMatchObject({ flagged: true, requiresReview: true });
      expect(result.warning).toContain("corrupt");
    },
  );

  // #19948 (review): SUM parsing stays compatible with canonical PostgreSQL
  // NUMERIC text output (plain integer or fixed-point decimal, no sign/
  // exponent/hex/whitespace/leading-zero/leading-dot coercion-only shapes)
  // and corrupt shapes fail closed on the full path.
  test.each(["1e2", "0x10", "+1", " 100.00", "100.00 ", ".5", "01.0", "1.", "0.5.5"])(
    "REGRESSION: non-canonical recent-earnings SUM %p fails closed to review",
    async (total) => {
      executeResults = [{ rows: [{ count: "3", total }] }];
      const result = await callCheckFraudPatterns("app-1", 500);
      expect(result).toMatchObject({ flagged: true, requiresReview: true });
      expect(result.warning).toContain("corrupt");
    },
  );

  test("canonical PostgreSQL NUMERIC SUM strings stay accepted on the full path", async () => {
    // Fixed-point decimal and plain-integer shapes are exactly what the
    // Postgres driver returns for NUMERIC/COALESCE aggregates.
    executeResults = [
      { rows: [{ count: "0", total: "100.50" }] },
      { rows: [{ total: "100" }] },
      { rows: [{ total: "0.00" }] },
    ];
    const result = await callCheckFraudPatterns("app-1", 500);
    // Healthy data: no fast-earn flag, ratio check runs on real values.
    expect(result.flagged).toBe(false);
  });

  test("numeric (non-string) finite non-negative SUM values stay accepted", async () => {
    executeResults = [
      { rows: [{ count: "0", total: 100.5 }] },
      { rows: [{ total: 10 }] },
      { rows: [{ total: 9.5 }] },
    ];
    const result = await callCheckFraudPatterns("app-1", 500);
    expect(result.flagged).toBe(true);
    expect(result.warning).toContain("redemption ratio");
  });
});
