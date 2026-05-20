import { describe, expect, it } from "bun:test";
import { FEED_POINTS_SYMBOL } from "@feed/shared";

import {
  calculateSharePercentages,
  formatPrice,
  formatVolume,
  getDaysLeft,
} from "../../../../apps/web/src/lib/market-formatters";

describe("formatPrice", () => {
  it("formats with currency symbol and 2 decimals", () => {
    expect(formatPrice(123.456)).toBe(`${FEED_POINTS_SYMBOL}123.46`);
    expect(formatPrice(100)).toBe(`${FEED_POINTS_SYMBOL}100.00`);
    expect(formatPrice(0)).toBe(`${FEED_POINTS_SYMBOL}0.00`);
    expect(formatPrice(-100)).toBe(`${FEED_POINTS_SYMBOL}-100.00`);
  });

  it("handles edge values", () => {
    expect(formatPrice(0.001)).toBe(`${FEED_POINTS_SYMBOL}0.00`);
    expect(formatPrice(0.01)).toBe(`${FEED_POINTS_SYMBOL}0.01`);
    expect(formatPrice(999999)).toBe(`${FEED_POINTS_SYMBOL}999999.00`);
  });
});

describe("formatVolume", () => {
  it("formats under 1K without suffix", () => {
    expect(formatVolume(0)).toBe(`${FEED_POINTS_SYMBOL}0.00`);
    expect(formatVolume(500)).toBe(`${FEED_POINTS_SYMBOL}500.00`);
    expect(formatVolume(999)).toBe(`${FEED_POINTS_SYMBOL}999.00`);
  });

  it("adds K/M/B suffix for larger values", () => {
    expect(formatVolume(1000)).toBe(`${FEED_POINTS_SYMBOL}1.00K`);
    expect(formatVolume(1500)).toBe(`${FEED_POINTS_SYMBOL}1.50K`);
    expect(formatVolume(1000000)).toBe(`${FEED_POINTS_SYMBOL}1.00M`);
    expect(formatVolume(1000000000)).toBe(`${FEED_POINTS_SYMBOL}1.00B`);
  });
});

describe("getDaysLeft", () => {
  it("returns null for missing date", () => {
    expect(getDaysLeft(undefined)).toBeNull();
    expect(getDaysLeft("")).toBeNull();
  });

  it("calculates days for future dates", () => {
    const future = new Date();
    future.setDate(future.getDate() + 5);
    const result = getDaysLeft(future.toISOString());
    expect(result).toBeGreaterThanOrEqual(4);
    expect(result).toBeLessThanOrEqual(6);
  });

  it("clamps past dates to 0", () => {
    const past = new Date();
    past.setDate(past.getDate() - 5);
    expect(getDaysLeft(past.toISOString())).toBe(0);
  });
});

describe("calculateSharePercentages", () => {
  it("defaults to 50/50 when no shares", () => {
    const result = calculateSharePercentages(undefined, undefined);
    expect(result.totalShares).toBe(0);
    expect(result.yesPercent).toBe(50);
    expect(result.noPercent).toBe(50);
  });

  it("returns 50/50 when shares are equal", () => {
    const result = calculateSharePercentages(10, 10);
    expect(result.totalShares).toBe(20);
    expect(result.yesPercent).toBe(50);
    expect(result.noPercent).toBe(50);
  });

  it("is symmetric when swapping sides", () => {
    const a = calculateSharePercentages(90, 10);
    const b = calculateSharePercentages(10, 90);

    expect(a.totalShares).toBe(100);
    expect(b.totalShares).toBe(100);

    expect(a.yesPercent + a.noPercent).toBeCloseTo(100, 6);
    expect(b.yesPercent + b.noPercent).toBeCloseTo(100, 6);

    expect(a.yesPercent).toBeCloseTo(b.noPercent, 6);
    expect(a.noPercent).toBeCloseTo(b.yesPercent, 6);
  });
});
