/**
 * Unit tests for analytics time-range resolution and projection horizon mapping.
 * Exercises query parameter normalization, default fallback, and period calculations.
 */
import { describe, expect, it } from "vitest";
import {
  ANALYTICS_TIME_RANGES,
  DEFAULT_ANALYTICS_TIME_RANGE,
  projectionPeriodsForRange,
  resolveTimeRangeParam,
} from "./time-range.ts";

describe("time-range", () => {
  describe("constants", () => {
    it("defines expected analytics time ranges", () => {
      expect(ANALYTICS_TIME_RANGES).toEqual(["daily", "weekly", "monthly"]);
      expect(DEFAULT_ANALYTICS_TIME_RANGE).toBe("weekly");
    });
  });

  describe("resolveTimeRangeParam", () => {
    it("preserves valid time-range buckets", () => {
      expect(resolveTimeRangeParam("daily")).toBe("daily");
      expect(resolveTimeRangeParam("weekly")).toBe("weekly");
      expect(resolveTimeRangeParam("monthly")).toBe("monthly");
    });

    it("falls back to default weekly for invalid or missing values", () => {
      expect(resolveTimeRangeParam(null)).toBe("weekly");
      expect(resolveTimeRangeParam(undefined)).toBe("weekly");
      expect(resolveTimeRangeParam("")).toBe("weekly");
      expect(resolveTimeRangeParam("yearly")).toBe("weekly");
      expect(resolveTimeRangeParam("hourly")).toBe("weekly");
    });
  });

  describe("projectionPeriodsForRange", () => {
    it("returns correct projection horizon days for each bucket", () => {
      expect(projectionPeriodsForRange("daily")).toBe(1);
      expect(projectionPeriodsForRange("weekly")).toBe(7);
      expect(projectionPeriodsForRange("monthly")).toBe(30);
    });
  });
});
