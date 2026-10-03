/**
 * The bridge's trend window walks local calendar days in the configured zone,
 * never UTC days. Clock pinned; fixture backend; no CLI or network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRecentSummaries } from "./health-bridge.js";

describe("health bridge local calendar day", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends the trend window on the zone's local today", async () => {
    // 22:30Z on Sep 13 is already Sep 14 in Tokyo.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-13T22:30:00.000Z"));
    const summaries = await getRecentSummaries(3, {
      preferredBackend: "fixture",
      timeZone: "Asia/Tokyo",
    });
    expect(summaries.map((summary) => summary.date)).toEqual([
      "2026-09-12",
      "2026-09-13",
      "2026-09-14",
    ]);
  });
});
