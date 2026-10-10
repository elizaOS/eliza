import { describe, expect, test } from "bun:test";
import { fillIdleUsageDays, generateProjectionAlerts, generateProjections } from "./projections";

const day = (date: string, totalCost: number) => ({
  timestamp: new Date(`${date}T00:00:00Z`),
  totalRequests: 100,
  totalCost,
  inputTokens: 1000,
  outputTokens: 1000,
  successRate: 1,
});

describe("projections over a day series with idle days", () => {
  // $5 on three days in 30, $20 balance: $0.50/day, about 40 days of runway.
  const activeDays = [day("2026-09-12", 5), day("2026-09-26", 5), day("2026-10-10", 5)];
  const startDate = new Date("2026-09-10T12:00:00Z");
  const endDate = new Date("2026-10-10T12:00:00Z");

  test("fills each idle UTC day with zero usage", () => {
    const filled = fillIdleUsageDays(activeDays, startDate, endDate);
    expect(filled).toHaveLength(31);
    expect(filled[0]?.timestamp.toISOString()).toBe("2026-09-10T00:00:00.000Z");
    expect(filled[2]).toBe(activeDays[0]);
    expect(filled[1]?.totalCost).toBe(0);
  });

  test("projects daily points and raises no low-balance alert", () => {
    const historical = fillIdleUsageDays(activeDays, startDate, endDate);
    const projections = generateProjections(historical, 7);
    expect(
      projections
        .filter((point) => point.isProjected)
        .map((point) => point.timestamp.toISOString().slice(0, 10)),
    ).toEqual([
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
    ]);
    const alerts = generateProjectionAlerts(historical, projections, 20);
    expect(alerts.map((alert) => alert.title)).not.toContain("Low Balance");
  });
});
