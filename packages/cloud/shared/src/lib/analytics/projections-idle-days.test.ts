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
  // $5 on three days across 29 observed days: about $0.52/day and 39 days of runway.
  const activeDays = [day("2026-09-12", 5), day("2026-09-26", 5), day("2026-10-10", 5)];
  const endDate = new Date("2026-10-10T12:00:00Z");

  test("fills idle UTC days only after usage starts", () => {
    const filled = fillIdleUsageDays(activeDays, endDate);
    expect(filled).toHaveLength(29);
    expect(filled[0]).toBe(activeDays[0]);
    expect(filled[1]?.totalCost).toBe(0);
  });

  test("projects daily points and raises no low-balance alert", () => {
    const historical = fillIdleUsageDays(activeDays, endDate);
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

  test("keeps a low-balance alert for an organization with three days of usage", () => {
    const recentDays = [day("2026-10-08", 10), day("2026-10-09", 10), day("2026-10-10", 10)];
    const historical = fillIdleUsageDays(recentDays, endDate);
    const alerts = generateProjectionAlerts(historical, generateProjections(historical, 7), 25);
    expect(alerts).toContainEqual(
      expect.objectContaining({
        title: "Low Balance",
        message: expect.stringContaining("approximately 2 days"),
      }),
    );
  });

  test("keeps an empty series empty and preserves rows after the requested end", () => {
    expect(fillIdleUsageDays([], endDate)).toEqual([]);
    const later = day("2026-10-12", 5);
    const filled = fillIdleUsageDays([activeDays[0], later], endDate);
    expect(filled.at(-1)).toBe(later);
    expect(filled).toHaveLength(31);
  });
});
