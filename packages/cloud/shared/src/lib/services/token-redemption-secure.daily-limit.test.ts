// Fail-closed daily-limit gate for the secure token-redemption money-out path.
//
// Regression coverage for #13415: `checkDailyLimitsUTC` read the
// `redemption_limits.daily_usd_total` (numeric(12,2)) and `redemption_count`
// (numeric(5,0)) columns via bare `Number(...)`. The Postgres driver returns
// NUMERIC as strings and `'NaN'::numeric` is a valid stored value that reads
// back as the string "NaN": `Number("NaN") === NaN`, and every `NaN`
// comparison is `false`, so a corrupt limits row made BOTH anti-sybil gates
// (`count >= MAX`, `total + usd > DAILY_LIMIT_USD`) fail OPEN — authorizing
// unbounded redemptions. The fix parses through a fail-closed boundary and
// DENIES on a corrupt row.

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// db/client mock — control the single redemptionLimits.findFirst read that
// checkDailyLimitsUTC performs. Nothing else in this method touches the DB.
// ---------------------------------------------------------------------------
let nextLimitsRow: Record<string, unknown> | undefined;

mock.module("../../db/client", () => ({
  dbRead: {
    query: {
      redemptionLimits: {
        findFirst: async () => nextLimitsRow,
      },
    },
  },
  dbWrite: {},
}));

const { SecureTokenRedemptionService, parseRedemptionLimitNumber, CorruptRedemptionLimitError } =
  await import("./token-redemption-secure");

// checkDailyLimitsUTC is private in TS but present at runtime; exercise the seam
// directly with a controlled limits row.
type DailyLimitCheck = (
  userId: string,
  pointsAmount: number,
) => Promise<{ valid: boolean; error?: string }>;

function callCheckDailyLimits(pointsAmount: number): Promise<{ valid: boolean; error?: string }> {
  const service = new SecureTokenRedemptionService() as unknown as {
    checkDailyLimitsUTC: DailyLimitCheck;
  };
  return service.checkDailyLimitsUTC("user-1", pointsAmount);
}

beforeEach(() => {
  nextLimitsRow = undefined;
});

describe("parseRedemptionLimitNumber (fail-closed boundary)", () => {
  test("parses a well-formed NUMERIC driver string", () => {
    expect(parseRedemptionLimitNumber("1234.56", "daily_usd_total")).toBe(1234.56);
    expect(parseRedemptionLimitNumber("7", "redemption_count")).toBe(7);
  });

  test("allows an explicit domain zero (fresh/zeroed row is legitimate)", () => {
    expect(parseRedemptionLimitNumber("0", "daily_usd_total")).toBe(0);
    expect(parseRedemptionLimitNumber("0.00", "daily_usd_total")).toBe(0);
    expect(parseRedemptionLimitNumber(0, "redemption_count")).toBe(0);
  });

  test("accepts a plain finite number", () => {
    expect(parseRedemptionLimitNumber(42.5, "daily_usd_total")).toBe(42.5);
  });

  test.each([
    ["NaN"], // <- the exact fail-open value ('NaN'::numeric reads back as "NaN")
    [""],
    ["   "],
    ["not-a-number"],
    ["Infinity"],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [null],
    [undefined],
  ])("throws CorruptRedemptionLimitError on non-finite/absent value %p", (bad) => {
    expect(() => parseRedemptionLimitNumber(bad as unknown, "daily_usd_total")).toThrow(
      CorruptRedemptionLimitError,
    );
  });
});

describe("checkDailyLimitsUTC (money-out anti-sybil gate)", () => {
  test("healthy row under limits authorizes", async () => {
    nextLimitsRow = { daily_usd_total: "10.00", redemption_count: "2" };
    const result = await callCheckDailyLimits(500); // $5
    expect(result.valid).toBe(true);
  });

  test("no limits row today authorizes (nothing spent yet)", async () => {
    nextLimitsRow = undefined;
    const result = await callCheckDailyLimits(500);
    expect(result.valid).toBe(true);
  });

  test("healthy row over the USD daily limit denies", async () => {
    // DAILY_LIMIT_USD = 5000; already spent 4999.99, +$5 pushes over.
    nextLimitsRow = { daily_usd_total: "4999.99", redemption_count: "1" };
    const result = await callCheckDailyLimits(500);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Daily limit exceeded");
  });

  test("healthy row at the redemption-count cap denies", async () => {
    // MAX_DAILY_REDEMPTIONS = 10
    nextLimitsRow = { daily_usd_total: "50.00", redemption_count: "10" };
    const result = await callCheckDailyLimits(500);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Daily limit reached");
  });

  test("REGRESSION: corrupt daily_usd_total ('NaN') DENIES instead of failing open", async () => {
    // Old behavior: Number("NaN") + 5 > 5000 === false -> gate authorized.
    nextLimitsRow = { daily_usd_total: "NaN", redemption_count: "1" };
    const result = await callCheckDailyLimits(500);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unable to verify your daily redemption limit");
  });

  test("REGRESSION: corrupt redemption_count ('NaN') DENIES instead of failing open", async () => {
    // Old behavior: NaN >= 10 === false -> count cap bypassed.
    nextLimitsRow = { daily_usd_total: "10.00", redemption_count: "NaN" };
    const result = await callCheckDailyLimits(500);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unable to verify your daily redemption limit");
  });

  test("REGRESSION: empty-string NUMERIC read DENIES", async () => {
    nextLimitsRow = { daily_usd_total: "", redemption_count: "1" };
    const result = await callCheckDailyLimits(500);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unable to verify your daily redemption limit");
  });
});
