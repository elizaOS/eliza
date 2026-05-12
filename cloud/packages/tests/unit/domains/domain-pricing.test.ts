/**
 * Unit tests for domain-pricing margin policy.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { computeDomainPrice } from "@/lib/services/domain-pricing";

const ENV_KEY = "ELIZA_CF_REGISTRAR_MARGIN_BPS";

describe("computeDomainPrice", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  test("default 36% margin on $10.99 wholesale → $14.95 total (rounds up)", () => {
    const p = computeDomainPrice(1099);
    expect(p.wholesaleUsdCents).toBe(1099);
    expect(p.marginBps).toBe(3600);
    // 1099 * 3600 / 10000 = 395.64 → ceil to 396
    expect(p.marginUsdCents).toBe(396);
    expect(p.totalUsdCents).toBe(1495);
  });

  test("zero wholesale produces zero margin and zero total", () => {
    const p = computeDomainPrice(0);
    expect(p.wholesaleUsdCents).toBe(0);
    expect(p.marginUsdCents).toBe(0);
    expect(p.totalUsdCents).toBe(0);
  });

  test("env override changes margin", () => {
    process.env[ENV_KEY] = "1000";
    const p = computeDomainPrice(1099);
    expect(p.marginBps).toBe(1000);
    // 1099 * 1000 / 10000 = 109.9 → ceil to 110
    expect(p.marginUsdCents).toBe(110);
    expect(p.totalUsdCents).toBe(1209);
  });

  test("invalid env value falls back to default", () => {
    process.env[ENV_KEY] = "not-a-number";
    const p = computeDomainPrice(1099);
    expect(p.marginBps).toBe(3600);
  });

  test("negative env value falls back to default", () => {
    process.env[ENV_KEY] = "-100";
    const p = computeDomainPrice(1099);
    expect(p.marginBps).toBe(3600);
  });

  test("zero margin env is respected (0% markup, all pure passthrough)", () => {
    process.env[ENV_KEY] = "0";
    const p = computeDomainPrice(1099);
    expect(p.marginBps).toBe(0);
    expect(p.marginUsdCents).toBe(0);
    expect(p.totalUsdCents).toBe(1099);
  });

  test("margin always rounds UP (never absorbs partial cents)", () => {
    // 100c * 3600bps = 360_000 / 10000 = 36 exact, no rounding
    expect(computeDomainPrice(100).marginUsdCents).toBe(36);
    // 101c * 3600bps = 363_600 / 10000 = 36.36 → ceil to 37
    expect(computeDomainPrice(101).marginUsdCents).toBe(37);
    // 99c * 3600bps = 356_400 / 10000 = 35.64 → ceil to 36
    expect(computeDomainPrice(99).marginUsdCents).toBe(36);
  });
});
