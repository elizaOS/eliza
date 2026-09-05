/**
 * Verifies the Health-owned screen-time service and HTTP dispatcher against
 * injected host rows without replacing their aggregation logic.
 */
import { describe, expect, it, vi } from "vitest";
import { handleScreenTimeReadRoute, ScreenTimeRouteError } from "./routes.js";
import {
  createScreenTimeAggregationService,
  type ScreenTimeAggregationService,
} from "./service.js";

describe("Health screen-time ownership boundary", () => {
  it("builds summaries and weekly averages from injected host rows", async () => {
    const collectRows = vi.fn(async () => [
      {
        source: "app" as const,
        identifier: "com.example.editor",
        displayName: "Editor",
        totalSeconds: 700,
        sessionCount: 4,
      },
    ]);
    const service = createScreenTimeAggregationService({
      collectRows,
      getSocialSummary: vi.fn(),
    });
    await expect(
      service.getScreenTimeSummary({
        since: "2026-08-01T00:00:00.000Z",
        until: "2026-08-08T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ totalSeconds: 700 });
    await expect(
      service.getScreenTimeWeeklyAverageByApp({
        since: "2026-08-01T00:00:00.000Z",
        until: "2026-08-08T00:00:00.000Z",
        daysInWindow: 7,
      }),
    ).resolves.toMatchObject({
      totalSeconds: 700,
      daysInWindow: 7,
      items: [{ averageSecondsPerDay: 100 }],
    });
  });

  it("owns query parsing while preserving the mounted route paths", async () => {
    const getScreenTimeSummary = vi.fn(async () => ({
      items: [],
      totalSeconds: 0,
    }));
    const service = {
      getScreenTimeSummary,
    } as unknown as ScreenTimeAggregationService;
    const result = await handleScreenTimeReadRoute({
      method: "GET",
      pathname: "/api/lifeops/screen-time/summary",
      url: new URL(
        "http://localhost/api/lifeops/screen-time/summary?since=2026-08-01T00:00:00.000Z&until=2026-08-02T00:00:00.000Z&source=app&topN=5",
      ),
      service,
    });
    expect(result).toEqual({
      handled: true,
      body: { items: [], totalSeconds: 0 },
    });
    expect(getScreenTimeSummary).toHaveBeenCalledWith({
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-02T00:00:00.000Z",
      source: "app",
      identifier: undefined,
      topN: 5,
    });
  });

  it("rejects invalid Health route query values", async () => {
    await expect(
      handleScreenTimeReadRoute({
        method: "GET",
        pathname: "/api/lifeops/screen-time/summary",
        url: new URL(
          "http://localhost/api/lifeops/screen-time/summary?since=no&until=also-no",
        ),
        service: {} as ScreenTimeAggregationService,
      }),
    ).rejects.toBeInstanceOf(ScreenTimeRouteError);
  });
});
