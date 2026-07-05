/**
 * Fail-closed NUMERIC boundary regression tests for the TWAP redemption-security
 * oracle (#13415 cloud-shared service-layer fallback-slop sweep).
 *
 * The oracle is a money-out surface fed by Postgres NUMERIC values for price
 * samples and redemption aggregates. These tests prove corrupt read-back values
 * deny the TWAP, payout-price, and supply-shock seams instead of poisoning their
 * comparisons with NaN.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// db/client mock. getTWAP does a single `dbRead.select(...).from(...).where(...)
// .orderBy(...)` chain resolving to the sample rows; getSystemHealth does three
// `dbRead.execute(sql...)` calls resolving to { rows: [...] }.
// ---------------------------------------------------------------------------
let nextSampleRows: Array<{ price: unknown; timestamp: Date; source: string }> = [];
let nextExecuteRows: Array<{ rows: Array<Record<string, unknown>> }> = [];
const insertedPriceSamples: Array<Record<string, unknown>> = [];
let executeCallIndex = 0;

mock.module("../../db/client", () => ({
  dbRead: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => nextSampleRows,
        }),
      }),
    }),
    execute: async () => {
      const result = nextExecuteRows[executeCallIndex] ?? { rows: [] };
      executeCallIndex += 1;
      return result;
    },
  },
  dbWrite: {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        insertedPriceSamples.push(row);
      },
    }),
  },
}));

const { TWAPPriceOracle, parseTwapNumeric, CorruptTwapNumericError } = await import(
  "./twap-price-oracle"
);

function sample(price: unknown) {
  return { price, timestamp: new Date(), source: "test" };
}

beforeEach(() => {
  nextSampleRows = [];
  nextExecuteRows = [];
  insertedPriceSamples.length = 0;
  executeCallIndex = 0;
});

describe("parseTwapNumeric (fail-closed boundary)", () => {
  test("parses a well-formed NUMERIC driver string", () => {
    expect(parseTwapNumeric("price_usd", "0.0125")).toBe(0.0125);
    expect(parseTwapNumeric("usd_value", "1234.56")).toBe(1234.56);
  });

  test("parses a finite number input", () => {
    expect(parseTwapNumeric("price_usd", 0.02)).toBe(0.02);
  });

  test("allows an explicit domain zero (empty aggregate is a legit 0)", () => {
    expect(parseTwapNumeric("usd_value", "0")).toBe(0);
    expect(parseTwapNumeric("usd_value", 0)).toBe(0);
  });

  test("throws on negative money values", () => {
    expect(() => parseTwapNumeric("usd_value", "-1")).toThrow(CorruptTwapNumericError);
    expect(() => parseTwapNumeric("usd_value", -1)).toThrow(CorruptTwapNumericError);
  });

  test("throws on zero when the caller requires a positive price", () => {
    expect(() => parseTwapNumeric("price_usd", "0", { allowZero: false })).toThrow(
      CorruptTwapNumericError,
    );
  });

  test("throws on fractional values when the caller requires an integer count", () => {
    expect(() =>
      parseTwapNumeric("recent_redemption_count", "1.5", { requireInteger: true }),
    ).toThrow(CorruptTwapNumericError);
  });

  test("REGRESSION: 'NaN'::numeric read-back throws instead of returning NaN", () => {
    expect(() => parseTwapNumeric("price_usd", "NaN")).toThrow(CorruptTwapNumericError);
  });

  test("throws on empty / whitespace-only string", () => {
    expect(() => parseTwapNumeric("price_usd", "")).toThrow(CorruptTwapNumericError);
    expect(() => parseTwapNumeric("price_usd", "   ")).toThrow(CorruptTwapNumericError);
  });

  test("throws on null / undefined (never returns NaN)", () => {
    expect(() => parseTwapNumeric("usd_value", null)).toThrow(CorruptTwapNumericError);
    expect(() => parseTwapNumeric("usd_value", undefined)).toThrow(CorruptTwapNumericError);
  });

  test("throws on non-numeric string and on Infinity", () => {
    expect(() => parseTwapNumeric("price_usd", "not-a-number")).toThrow(CorruptTwapNumericError);
    expect(() => parseTwapNumeric("price_usd", "1e3")).toThrow(CorruptTwapNumericError);
    expect(() => parseTwapNumeric("price_usd", "0x10")).toThrow(CorruptTwapNumericError);
    expect(() => parseTwapNumeric("price_usd", Number.POSITIVE_INFINITY)).toThrow(
      CorruptTwapNumericError,
    );
  });

  test("names the offending field and value in the error", () => {
    try {
      parseTwapNumeric("usd_value", "oops");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CorruptTwapNumericError);
      const err = e as InstanceType<typeof CorruptTwapNumericError>;
      expect(err.field).toBe("usd_value");
      expect(err.rawValue).toBe("oops");
      expect(err.code).toBe("CORRUPT_TWAP_NUMERIC");
      expect(err.context).toEqual({ field: "usd_value", rawValue: "oops" });
      expect(err.severity).toBe("fatal");
      expect(err.message).toContain("usd_value");
    }
  });
});

describe("recordPriceSample fail-closed write boundary", () => {
  test("records a healthy positive sample", async () => {
    const oracle = new TWAPPriceOracle();

    await oracle.recordPriceSample("base", 0.0125, "test-source");

    expect(insertedPriceSamples).toHaveLength(1);
    expect(insertedPriceSamples[0].price_usd).toBe("0.0125");
  });

  test("REGRESSION: invalid sample prices throw before any DB write", async () => {
    const oracle = new TWAPPriceOracle();

    for (const price of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      insertedPriceSamples.length = 0;
      await expect(oracle.recordPriceSample("base", price, "bad-source")).rejects.toBeInstanceOf(
        CorruptTwapNumericError,
      );
      expect(insertedPriceSamples).toHaveLength(0);
    }
  });
});

describe("getTWAP fail-closed seam", () => {
  test("computes a normal TWAP from healthy samples", async () => {
    const oracle = new TWAPPriceOracle();
    nextSampleRows = [sample("0.010"), sample("0.011"), sample("0.012")];
    const twap = await oracle.getTWAP("base");
    expect(twap).not.toBeNull();
    expect(twap?.twapPrice).toBeCloseTo(0.011, 6);
    // spot is the most recent (first) sample
    expect(twap?.spotPrice).toBe(0.01);
    expect(Number.isFinite(twap?.volatility ?? NaN)).toBe(true);
  });

  test("returns null (not a throw) when there are no samples", async () => {
    const oracle = new TWAPPriceOracle();
    nextSampleRows = [];
    expect(await oracle.getTWAP("base")).toBeNull();
  });

  test("REGRESSION: a corrupt 'NaN' price sample throws instead of fabricating a stable quote", async () => {
    const oracle = new TWAPPriceOracle();
    nextSampleRows = [sample("0.010"), sample("NaN"), sample("0.012")];
    // Old behavior: Number("NaN") -> NaN -> twapPrice/spotPrice NaN, isStable
    // and slippage checks (NaN comparisons) all pass -> a fabricated quote.
    await expect(oracle.getTWAP("base")).rejects.toBeInstanceOf(CorruptTwapNumericError);
  });

  test("REGRESSION: a zero price sample throws instead of dividing by an invalid quote price", async () => {
    const oracle = new TWAPPriceOracle();
    nextSampleRows = [sample("0.010"), sample("0"), sample("0.012")];
    await expect(oracle.getTWAP("base")).rejects.toBeInstanceOf(CorruptTwapNumericError);
  });
});

describe("getSystemHealth fail-closed seam (supply-shock rate limits)", () => {
  test("computes healthy volumes from well-formed aggregates and permits redemptions", async () => {
    const oracle = new TWAPPriceOracle();
    // order: hourly SUM, daily SUM, velocity COUNT
    nextExecuteRows = [
      { rows: [{ total: "100.00" }] },
      { rows: [{ total: "500.00" }] },
      { rows: [{ count: "2" }] },
    ];
    const health = await oracle.getSystemHealth();
    expect(health.hourlyVolumeUsd).toBe(100);
    expect(health.dailyVolumeUsd).toBe(500);
    expect(health.recentRedemptionCount).toBe(2);
    expect(health.canProcessRedemptions).toBe(true);
  });

  test("treats a genuinely-empty aggregate result as zero (COALESCE semantics)", async () => {
    const oracle = new TWAPPriceOracle();
    nextExecuteRows = [
      { rows: [{ total: "0" }] },
      { rows: [{ total: "0" }] },
      { rows: [{ count: "0" }] },
    ];
    const health = await oracle.getSystemHealth();
    expect(health.hourlyVolumeUsd).toBe(0);
    expect(health.dailyVolumeUsd).toBe(0);
    expect(health.recentRedemptionCount).toBe(0);
    expect(health.canProcessRedemptions).toBe(true);
  });

  test("REGRESSION: a corrupt 'NaN' hourly aggregate throws instead of failing the rate limit OPEN", async () => {
    const oracle = new TWAPPriceOracle();
    // Old behavior: Number("NaN") -> NaN, `NaN >= MAX_HOURLY` false, so the cap
    // was silently bypassed and canProcessRedemptions stayed true.
    nextExecuteRows = [
      { rows: [{ total: "NaN" }] },
      { rows: [{ total: "500.00" }] },
      { rows: [{ count: "2" }] },
    ];
    await expect(oracle.getSystemHealth()).rejects.toBeInstanceOf(CorruptTwapNumericError);
  });

  test("REGRESSION: a corrupt velocity COUNT throws instead of bypassing the coordinated-attack guard", async () => {
    const oracle = new TWAPPriceOracle();
    nextExecuteRows = [
      { rows: [{ total: "100.00" }] },
      { rows: [{ total: "500.00" }] },
      { rows: [{ count: "NaN" }] },
    ];
    await expect(oracle.getSystemHealth()).rejects.toBeInstanceOf(CorruptTwapNumericError);
  });

  test("REGRESSION: a missing aggregate row throws instead of reading as a healthy zero", async () => {
    const oracle = new TWAPPriceOracle();
    nextExecuteRows = [{ rows: [] }, { rows: [{ total: "500.00" }] }, { rows: [{ count: "2" }] }];
    await expect(oracle.getSystemHealth()).rejects.toBeInstanceOf(CorruptTwapNumericError);
  });

  test("REGRESSION: a negative aggregate throws instead of increasing available redemption capacity", async () => {
    const oracle = new TWAPPriceOracle();
    nextExecuteRows = [
      { rows: [{ total: "-100.00" }] },
      { rows: [{ total: "500.00" }] },
      { rows: [{ count: "2" }] },
    ];
    await expect(oracle.getSystemHealth()).rejects.toBeInstanceOf(CorruptTwapNumericError);
  });
});

describe("validatePayoutPrice fail-closed seam (money-out price re-check)", () => {
  test("validates a payout when the current TWAP matches the quoted price", async () => {
    const oracle = new TWAPPriceOracle();
    nextSampleRows = [sample("0.010"), sample("0.010"), sample("0.010")];
    const result = await oracle.validatePayoutPrice("base", 0.01, 100);
    expect(result.valid).toBe(true);
  });

  test("REGRESSION: a corrupt current-TWAP sample throws instead of returning valid:true", async () => {
    const oracle = new TWAPPriceOracle();
    // Old behavior: Number("NaN") -> twap.twapPrice NaN -> priceDrift NaN ->
    // `NaN > threshold` false -> the payout was VALIDATED against corrupt data.
    nextSampleRows = [sample("0.010"), sample("NaN"), sample("0.010")];
    await expect(oracle.validatePayoutPrice("base", 0.01, 100)).rejects.toBeInstanceOf(
      CorruptTwapNumericError,
    );
  });

  test("REGRESSION: a corrupt quoted price throws instead of returning valid:true", async () => {
    const oracle = new TWAPPriceOracle();
    nextSampleRows = [sample("0.010"), sample("0.010"), sample("0.010")];
    await expect(oracle.validatePayoutPrice("base", Number.NaN, 100)).rejects.toBeInstanceOf(
      CorruptTwapNumericError,
    );
  });

  test("still fails a payout (valid:false) when there is no recent data", async () => {
    const oracle = new TWAPPriceOracle();
    nextSampleRows = [];
    const result = await oracle.validatePayoutPrice("base", 0.01, 100);
    expect(result.valid).toBe(false);
  });
});
