/**
 * Behavior coverage for domain-pricing margin math.
 *
 * Eliza Cloud charges a margin on top of Cloudflare's at-cost registrar
 * pricing. The margin is always rounded UP to the nearest cent so the
 * platform never absorbs a half-cent; the env override must fail closed to
 * the default 3600 bps (36%) for missing, unparseable, or negative values.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { computeDomainPrice } from "./domain-pricing";

const DEFAULT_MARGIN_BPS = 3600;

afterEach(() => {
  delete process.env.ELIZA_CF_REGISTRAR_MARGIN_BPS;
});

describe("computeDomainPrice", () => {
  test("applies the default 36% margin", () => {
    // $10.99 wholesale -> 1099 * 0.36 = 395.64 -> ceil = 396 cents margin.
    const price = computeDomainPrice(1099);
    expect(price).toEqual({
      wholesaleUsdCents: 1099,
      marginUsdCents: 396,
      totalUsdCents: 1495,
      marginBps: DEFAULT_MARGIN_BPS,
    });
  });

  test("rounds the margin up to the nearest cent", () => {
    // 1 cent wholesale at 36% = 0.36 cents -> ceil = 1 cent.
    const price = computeDomainPrice(1);
    expect(price.marginUsdCents).toBe(1);
    expect(price.totalUsdCents).toBe(2);
  });

  test("honors a positive env override", () => {
    process.env.ELIZA_CF_REGISTRAR_MARGIN_BPS = "1000"; // 10%
    const price = computeDomainPrice(1000);
    expect(price.marginUsdCents).toBe(100);
    expect(price.totalUsdCents).toBe(1100);
    expect(price.marginBps).toBe(1000);
  });

  test("accepts a zero override (0 bps is a valid explicit margin)", () => {
    process.env.ELIZA_CF_REGISTRAR_MARGIN_BPS = "0";
    const price = computeDomainPrice(1000);
    expect(price.marginBps).toBe(0);
    expect(price.marginUsdCents).toBe(0);
    expect(price.totalUsdCents).toBe(1000);
  });

  test("fails closed to the default for a negative override", () => {
    process.env.ELIZA_CF_REGISTRAR_MARGIN_BPS = "-500";
    const price = computeDomainPrice(1000);
    expect(price.marginBps).toBe(DEFAULT_MARGIN_BPS);
  });

  test("fails closed to the default for a non-numeric override", () => {
    process.env.ELIZA_CF_REGISTRAR_MARGIN_BPS = "not-a-number";
    const price = computeDomainPrice(1000);
    expect(price.marginBps).toBe(DEFAULT_MARGIN_BPS);
  });

  test("parses a fractional override via parseInt (truncates at the dot)", () => {
    // Number.parseInt("12.5", 10) === 12, so a fractional override is
    // accepted as its integer part — pin the actual parseInt contract.
    process.env.ELIZA_CF_REGISTRAR_MARGIN_BPS = "12.5";
    const price = computeDomainPrice(1000);
    expect(price.marginBps).toBe(12);
  });

  test("leaves the wholesale amount untouched", () => {
    const price = computeDomainPrice(4242);
    expect(price.wholesaleUsdCents).toBe(4242);
    // 4242 * 0.36 = 1527.12 -> ceil 1528
    expect(price.marginUsdCents).toBe(1528);
    expect(price.totalUsdCents).toBe(5770);
  });
});
