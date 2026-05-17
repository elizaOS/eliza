import { describe, expect, test } from "bun:test";
import {
  deriveCostTrendingFields,
  deriveQuotaUsage,
  toDistribution,
  toRatePercent,
  toRetentionRates,
  toSuccessRatePercent,
} from "../analytics-derived";

describe("deriveCostTrendingFields", () => {
  test("returns zero when balance is zero", () => {
    const out = deriveCostTrendingFields({ projectedMonthlyBurn: 50 }, 0);
    expect(out.monthlyBurnPercent).toBe(0);
    expect(out.monthlyBurnPercentClamped).toBe(0);
    expect(out.burnAlertThresholdExceeded).toBe(true);
  });

  test("rounds percent to one decimal place", () => {
    const out = deriveCostTrendingFields({ projectedMonthlyBurn: 1 }, 3);
    expect(out.monthlyBurnPercent).toBe(33.3);
  });

  test("clamps progress percent to 100", () => {
    const out = deriveCostTrendingFields({ projectedMonthlyBurn: 500 }, 100);
    expect(out.monthlyBurnPercent).toBe(500);
    expect(out.monthlyBurnPercentClamped).toBe(100);
  });

  test("burnAlertThresholdExceeded triggers at >80% of balance", () => {
    expect(
      deriveCostTrendingFields({ projectedMonthlyBurn: 80 }, 100).burnAlertThresholdExceeded,
    ).toBe(false);
    expect(
      deriveCostTrendingFields({ projectedMonthlyBurn: 81 }, 100).burnAlertThresholdExceeded,
    ).toBe(true);
  });
});

describe("toSuccessRatePercent", () => {
  test("converts rate to percent rounded to 1dp", () => {
    expect(toSuccessRatePercent(0.943)).toBe(94.3);
    expect(toSuccessRatePercent(0)).toBe(0);
    expect(toSuccessRatePercent(1)).toBe(100);
  });
});

describe("toRatePercent", () => {
  test("computes percent of denominator", () => {
    expect(toRatePercent(50, 100)).toBe(50);
  });

  test("returns zero when denominator is zero", () => {
    expect(toRatePercent(5, 0)).toBe(0);
  });

  test("rounds to one decimal place", () => {
    expect(toRatePercent(1, 3)).toBe(33.3);
  });
});

describe("toDistribution", () => {
  test("sorts by count desc and computes percents", () => {
    const out = toDistribution({ a: 1, b: 3, c: 6 });
    expect(out.map((e) => e.key)).toEqual(["c", "b", "a"]);
    expect(out[0]?.percent).toBe(60);
    expect(out[1]?.percent).toBe(30);
    expect(out[2]?.percent).toBe(10);
  });

  test("returns zero percent for empty input", () => {
    expect(toDistribution({})).toEqual([]);
  });
});

describe("toRetentionRates", () => {
  test("computes per-day retention percents and skips null retained", () => {
    const out = toRetentionRates([
      {
        cohort_date: "2026-01-01",
        cohort_size: 50,
        d1_retained: 25,
        d7_retained: null,
        d30_retained: 5,
      },
    ]);
    expect(out[0]?.d1).toBe(50);
    expect(out[0]?.d7).toBeNull();
    expect(out[0]?.d30).toBe(10);
  });

  test("returns null retention when cohort size is zero", () => {
    const out = toRetentionRates([
      {
        cohort_date: new Date("2026-01-01"),
        cohort_size: 0,
        d1_retained: 0,
        d7_retained: 0,
        d30_retained: 0,
      },
    ]);
    expect(out[0]?.d1).toBeNull();
    expect(out[0]?.d7).toBeNull();
    expect(out[0]?.d30).toBeNull();
  });
});

describe("deriveQuotaUsage", () => {
  test("returns null percent when no limit", () => {
    expect(deriveQuotaUsage(10, null)).toEqual({
      usedPercent: null,
      usedPercentClamped: 0,
    });
  });

  test("computes percent and clamps to 100", () => {
    expect(deriveQuotaUsage(50, 200)).toEqual({
      usedPercent: 25,
      usedPercentClamped: 25,
    });
    expect(deriveQuotaUsage(300, 200)).toEqual({
      usedPercent: 150,
      usedPercentClamped: 100,
    });
  });
});
