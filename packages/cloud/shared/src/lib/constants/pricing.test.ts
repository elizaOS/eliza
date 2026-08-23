/**
 * Coverage for pricing.
 */
import { describe, expect, it } from "vitest";
import { CONTAINER_PRICING, calculateDailyContainerCost } from "./pricing.js";

describe("pricing", () => {
  it("exposes pricing", () => {
    expect(CONTAINER_PRICING.DAILY_RUNNING_COST).toBeGreaterThan(0);
  });
  it("calculates daily cost", () => {
    expect(calculateDailyContainerCost()).toBe(CONTAINER_PRICING.DAILY_RUNNING_COST);
    expect(calculateDailyContainerCost({ desiredCount: 2 })).toBe(
      CONTAINER_PRICING.DAILY_RUNNING_COST * 2,
    );
  });
});
