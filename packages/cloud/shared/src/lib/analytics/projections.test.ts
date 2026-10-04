/**
 * Usage cost is USD with sub-dollar precision; projected daily cost must keep
 * that precision so flat sub-dollar usage neither projects to $0 nor raises a
 * cost-increase alert.
 */
import { describe, expect, test } from "bun:test";
import type { TimeSeriesDataPoint } from "../../db/repositories/usage-records";
import { generateProjectionAlerts, generateProjections } from "./projections";

const DAY_MS = 24 * 60 * 60 * 1000;

function flatDailyUsage(dailyCost: number, days = 30): TimeSeriesDataPoint[] {
  const start = Date.UTC(2026, 8, 1);
  return Array.from({ length: days }, (_, i) => ({
    timestamp: new Date(start + i * DAY_MS),
    totalRequests: 20,
    totalCost: dailyCost,
    inputTokens: 1000,
    outputTokens: 500,
    successRate: 1,
  }));
}

describe("generateProjections", () => {
  for (const dailyCost of [0.4, 0.6]) {
    test(`projects flat $${dailyCost}/day usage near $${dailyCost}/day`, () => {
      const history = flatDailyUsage(dailyCost);

      const projected = generateProjections(history, 7).filter((point) => point.isProjected);

      expect(projected).toHaveLength(7);
      for (const point of projected) {
        expect(point.totalCost).toBeGreaterThan(dailyCost * 0.9);
        expect(point.totalCost).toBeLessThan(dailyCost * 1.1);
      }
      expect(
        generateProjectionAlerts(history, generateProjections(history, 7), 1000).map(
          (alert) => alert.title,
        ),
      ).toEqual([]);
    });
  }
});
