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

const days = (from: string, to: string, keep: (date: Date) => boolean, totalCost: number) => {
  const out: ReturnType<typeof day>[] = [];
  for (
    let date = new Date(`${from}T00:00:00Z`);
    date <= new Date(`${to}T00:00:00Z`);
    date = new Date(date.getTime() + 86_400_000)
  ) {
    if (keep(date)) out.push(day(date.toISOString().slice(0, 10), totalCost));
  }
  return out;
};

const alertTitles = (activeDays: ReturnType<typeof day>[], creditBalance: number) =>
  generateProjectionAlerts(activeDays, generateProjections(activeDays, 7), creditBalance).map(
    (alert) => alert.title,
  );

describe("projections over usage with idle days", () => {
  // $5 on three days across 29 calendar days: about $0.52/day and 39 days of runway.
  const activeDays = [day("2026-09-12", 5), day("2026-09-26", 5), day("2026-10-10", 5)];

  test("fills idle UTC days between usage days and none after the last one", () => {
    const filled = fillIdleUsageDays(activeDays);
    expect(filled).toHaveLength(29);
    expect(filled[0]).toBe(activeDays[0]);
    expect(filled[1]?.totalCost).toBe(0);
    expect(filled.at(-1)).toBe(activeDays[2]);
    expect(fillIdleUsageDays([])).toEqual([]);
  });

  test("projects the chart one day at a time", () => {
    const projections = generateProjections(fillIdleUsageDays(activeDays), 7);
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
  });

  test("computes the low-balance runway per calendar day", () => {
    expect(alertTitles(activeDays, 20)).not.toContain("Low Balance");
    const recentDays = [day("2026-10-08", 10), day("2026-10-09", 10), day("2026-10-10", 10)];
    const alerts = generateProjectionAlerts(recentDays, generateProjections(recentDays, 7), 25);
    expect(alerts).toContainEqual(
      expect.objectContaining({
        title: "Low Balance",
        message: expect.stringContaining("approximately 2 days"),
      }),
    );
  });

  test("raises no trend alert for steady weekday-only or daily usage", () => {
    const weekday = (date: Date) => date.getUTCDay() !== 0 && date.getUTCDay() !== 6;
    expect(alertTitles(days("2026-09-14", "2026-10-09", weekday, 10), 1000)).toEqual([]);
    expect(alertTitles(days("2026-09-14", "2026-10-12", weekday, 10), 1000)).toEqual([]);
    expect(
      alertTitles(
        days("2026-09-14", "2026-10-13", () => true, 10),
        1000,
      ),
    ).toEqual([]);
  });
});
