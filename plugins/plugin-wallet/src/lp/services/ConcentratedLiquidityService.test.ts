/**
 * Behavioral contract for ConcentratedLiquidityService (plugin-wallet).
 *
 * The range/utilization math is the only live logic in this service today.
 * Two defect classes are pinned here (fix + test):
 *
 * 1. A non-positive rangeWidthPercent produced an inverted or zero-width
 *    range (priceLower >= priceUpper) instead of failing loud.
 * 2. A zero-width range made calculateUtilization divide by zero; the
 *    resulting Infinity was silently clamped to 100 — a fabricated "fully
 *    utilized" answer for a range with no width.
 *
 * The unimplemented position/rebalance operations must also keep failing
 * loud ("coming soon") rather than silently returning empty results.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { IRangeParams } from "../types";
import { ConcentratedLiquidityService } from "./ConcentratedLiquidityService";

describe("ConcentratedLiquidityService — range math bounds and fail-loud contract", () => {
  it("computes a symmetric range around the current price", () => {
    const svc = new ConcentratedLiquidityService();
    const wide = svc.calculateOptimalRange(100, 20);
    expect(wide.priceLower).toBeCloseTo(90, 10);
    expect(wide.priceUpper).toBeCloseTo(110, 10);
    const narrow = svc.calculateOptimalRange(100, 0.5);
    expect(narrow.priceLower).toBeCloseTo(99.75, 10);
    expect(narrow.priceUpper).toBeCloseTo(100.25, 10);
  });

  it("throws RangeError on a non-positive range width instead of producing an inverted range", () => {
    const svc = new ConcentratedLiquidityService();
    expect(() => svc.calculateOptimalRange(100, 0)).toThrow(RangeError);
    expect(() => svc.calculateOptimalRange(100, -20)).toThrow(RangeError);
  });

  it("throws RangeError on non-finite inputs instead of returning NaN bounds", () => {
    const svc = new ConcentratedLiquidityService();
    expect(() => svc.calculateOptimalRange(Number.NaN, 20)).toThrow(RangeError);
    expect(() => svc.calculateOptimalRange(100, Number.NaN)).toThrow(
      RangeError,
    );
    expect(() =>
      svc.calculateOptimalRange(100, Number.POSITIVE_INFINITY),
    ).toThrow(RangeError);
  });

  it("returns 100% utilization at the center of the range", () => {
    const svc = new ConcentratedLiquidityService();
    expect(svc.calculateUtilization(100, 90, 110)).toBe(100);
  });

  it("returns 0% utilization at the range bounds and outside the range", () => {
    const svc = new ConcentratedLiquidityService();
    expect(svc.calculateUtilization(90, 90, 110)).toBe(0);
    expect(svc.calculateUtilization(110, 90, 110)).toBe(0);
    expect(svc.calculateUtilization(50, 90, 110)).toBe(0);
    expect(svc.calculateUtilization(150, 90, 110)).toBe(0);
  });

  it("returns the intermediate utilization between bound and center", () => {
    const svc = new ConcentratedLiquidityService();
    // Distance from lower bound = 5 of a half-range of 10 -> 50%
    expect(svc.calculateUtilization(95, 90, 110)).toBe(50);
  });

  it("throws RangeError on a zero-width range instead of dividing by zero into a silent 100%", () => {
    const svc = new ConcentratedLiquidityService();
    // Previously: priceRange = 0 -> Infinity -> Math.min(Infinity, 100) = 100.
    expect(() => svc.calculateUtilization(100, 100, 100)).toThrow(RangeError);
  });

  it("throws RangeError on an inverted range instead of reporting 0% utilization", () => {
    const svc = new ConcentratedLiquidityService();
    expect(() => svc.calculateUtilization(100, 110, 90)).toThrow(RangeError);
  });

  it("keeps the unimplemented position operations failing loud", async () => {
    const svc = new ConcentratedLiquidityService();
    await expect(
      svc.createConcentratedPosition("u", {} as IRangeParams),
    ).rejects.toThrow(/coming soon/);
    await expect(svc.rebalanceConcentratedPosition("u", "p")).rejects.toThrow(
      /coming soon/,
    );
    await expect(svc.getConcentratedPositions("u")).resolves.toEqual([]);
  });

  it("exposes the service type and starts/stops without side effects", async () => {
    expect(ConcentratedLiquidityService.serviceType).toBe(
      "concentrated-liquidity",
    );
    const started = await ConcentratedLiquidityService.start(
      {} as IAgentRuntime,
    );
    expect(started).toBeInstanceOf(ConcentratedLiquidityService);
    await started.stop();
    await ConcentratedLiquidityService.stop({} as IAgentRuntime);
  });
});
