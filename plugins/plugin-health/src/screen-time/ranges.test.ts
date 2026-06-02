import { describe, expect, it } from "vitest";
import {
  computePriorScreenTimeRange,
  computeScreenTimeRange,
  enumerateScreenTimeHistoryDays,
  screenTimeRangeLabel,
} from "./ranges.js";

describe("screen-time ranges", () => {
  it("computes rolling ranges from the local start of day", () => {
    const now = new Date("2026-06-02T15:45:00.000Z");

    expect(computeScreenTimeRange("today", now)).toEqual({
      since: "2026-06-02T07:00:00.000Z",
      until: "2026-06-02T15:45:00.000Z",
    });
    expect(computeScreenTimeRange("7d", now)).toEqual({
      since: "2026-05-27T07:00:00.000Z",
      until: "2026-06-02T15:45:00.000Z",
    });
  });

  it("computes prior windows and labels", () => {
    const current = {
      since: "2026-05-27T07:00:00.000Z",
      until: "2026-06-02T15:45:00.000Z",
    };

    expect(computePriorScreenTimeRange("today", current)).toBeNull();
    expect(computePriorScreenTimeRange("7d", current)).toEqual({
      since: "2026-05-20T23:15:00.000Z",
      until: "2026-05-27T07:00:00.000Z",
    });
    expect(screenTimeRangeLabel("30d")).toBe("Last 30d");
  });

  it("enumerates history days clipped to the range end", () => {
    const days = enumerateScreenTimeHistoryDays({
      since: "2026-06-01T10:30:00.000Z",
      until: "2026-06-02T15:45:00.000Z",
    });

    expect(days.map((day) => [day.date, day.since, day.until])).toEqual([
      [
        "2026-06-01",
        "2026-06-01T07:00:00.000Z",
        "2026-06-02T07:00:00.000Z",
      ],
      [
        "2026-06-02",
        "2026-06-02T07:00:00.000Z",
        "2026-06-02T15:45:00.000Z",
      ],
    ]);
  });
});
