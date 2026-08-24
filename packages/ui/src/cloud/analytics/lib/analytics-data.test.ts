/**
 * Unit tests for analytics-data: validates analytics query hook exports.
 */
import { describe, expect, it } from "vitest";
import {
  useAnalyticsBreakdown,
  useAnalyticsProjections,
} from "./analytics-data.ts";

describe("analytics-data", () => {
  it("exports useAnalyticsBreakdown query hook", () => {
    expect(typeof useAnalyticsBreakdown).toBe("function");
  });

  it("exports useAnalyticsProjections query hook", () => {
    expect(typeof useAnalyticsProjections).toBe("function");
  });
});
