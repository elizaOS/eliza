/**
 * Pins the container pricing contract after #22957 removed the ghost
 * catalogue charges. Every advertised rate must have an audited settlement
 * caller: only the daily running rate (cron settlement + active-billing
 * snapshot) and the shutdown-warning window survive. One-time deployment and
 * image-upload rates, per-GB storage/bandwidth rates, per-extra-instance
 * rates, the static monthly reference, the low-credit warning threshold, and
 * the uncalled calculateDeploymentCost helper were advertised but never
 * metered, so this suite fails if any of them reappear in the catalogue.
 */

import { describe, expect, test } from "bun:test";
import { CONTAINER_PRICING, calculateDailyContainerCost } from "./pricing";

describe("CONTAINER_PRICING catalogue contract (#22957 ghost-charge removal)", () => {
  test("exposes exactly the audited active charges", () => {
    expect(Object.keys(CONTAINER_PRICING).sort()).toEqual(
      ["DAILY_RUNNING_COST", "SHUTDOWN_WARNING_HOURS"].sort(),
    );
  });

  test("ghost rates stay removed from the catalogue", () => {
    const catalogue = CONTAINER_PRICING as Record<string, unknown>;
    const ghostKeys = [
      "DEPLOYMENT",
      "IMAGE_UPLOAD",
      "MONTHLY_BASE_COST",
      "COST_PER_GB_STORAGE",
      "COST_PER_GB_BANDWIDTH",
      "COST_PER_ADDITIONAL_INSTANCE",
      "LOW_CREDITS_WARNING_THRESHOLD",
    ];
    for (const key of ghostKeys) {
      expect(catalogue[key]).toBeUndefined();
    }
  });

  test("retained daily running rate is the marked-up $0.67", () => {
    expect(CONTAINER_PRICING.DAILY_RUNNING_COST).toBe(0.67);
  });

  test("shutdown warning window is 48 hours", () => {
    expect(CONTAINER_PRICING.SHUTDOWN_WARNING_HOURS).toBe(48);
  });
});

describe("calculateDailyContainerCost (audited active charge)", () => {
  test("base single-instance day rounds to $0.67", () => {
    expect(calculateDailyContainerCost()).toBe(0.67);
    expect(calculateDailyContainerCost({})).toBe(0.67);
  });

  test("each additional desired instance adds the same daily rate", () => {
    expect(calculateDailyContainerCost({ desiredCount: 2 })).toBe(1.34);
    expect(calculateDailyContainerCost({ desiredCount: 3 })).toBe(2.01);
  });

  test("CPU above 1 vCPU scales linearly", () => {
    expect(calculateDailyContainerCost({ cpu: 2048 })).toBe(1.34);
  });

  test("memory above 2GB scales sub-linearly", () => {
    // sqrt(8GB/2GB) = 2x
    expect(calculateDailyContainerCost({ memory: 8192 })).toBe(1.34);
  });

  test("combined scaling multiplies", () => {
    // 2 instances x 2 vCPU = 4 x 0.67 = 2.68
    expect(calculateDailyContainerCost({ desiredCount: 2, cpu: 2048 })).toBe(2.68);
  });

  test("at-or-below-baseline resources do not scale", () => {
    expect(calculateDailyContainerCost({ desiredCount: 1, cpu: 1024, memory: 2048 })).toBe(0.67);
    expect(calculateDailyContainerCost({ cpu: 256, memory: 512 })).toBe(0.67);
  });
});
