/**
 * Tests for app analytics getAppUsageSummary division and NaN bounds.
 */

import { describe, expect, it } from "vitest";

function computeUsageAverages(
  totalRequests: number,
  totalCreditsUsed: string | null | undefined,
  days?: number,
) {
  const effectiveDays = Math.max(
    1,
    Math.floor(Number.isFinite(days as number) ? (days as number) : 30),
  );
  const avgRequestsPerDay = Math.round(totalRequests / effectiveDays);
  const totalCostNum = parseFloat(totalCreditsUsed ?? "0.00");
  const safeCost = Number.isFinite(totalCostNum) ? totalCostNum : 0;
  const avgCostPerDay = (safeCost / effectiveDays).toFixed(2);

  return { avgRequestsPerDay, avgCostPerDay };
}

describe("app-analytics usage calculation bounds", () => {
  it("computes standard averages correctly", () => {
    const res = computeUsageAverages(300, "15.00", 30);
    expect(res.avgRequestsPerDay).toBe(10);
    expect(res.avgCostPerDay).toBe("0.50");
  });

  it("handles days <= 0 or 0 gracefully without producing Infinity", () => {
    const resZero = computeUsageAverages(100, "5.00", 0);
    expect(Number.isFinite(resZero.avgRequestsPerDay)).toBe(true);
    expect(resZero.avgRequestsPerDay).toBe(100);
    expect(resZero.avgCostPerDay).toBe("5.00");

    const resNeg = computeUsageAverages(100, "5.00", -5);
    expect(Number.isFinite(resNeg.avgRequestsPerDay)).toBe(true);
    expect(resNeg.avgRequestsPerDay).toBe(100);
    expect(resNeg.avgCostPerDay).toBe("5.00");
  });

  it("handles NaN or malformed credit string safely", () => {
    const res = computeUsageAverages(50, "invalid-credits", 10);
    expect(res.avgCostPerDay).toBe("0.00");
    expect(res.avgRequestsPerDay).toBe(5);
  });
});
