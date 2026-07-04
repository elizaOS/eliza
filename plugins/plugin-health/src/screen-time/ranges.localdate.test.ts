/**
 * Regression test: `enumerateScreenTimeHistoryDays` must key each history
 * bucket by the LOCAL calendar date. In any UTC+ timezone, local midnight maps
 * to the previous UTC date, so a `toISOString()`-derived key labels every day
 * with the day before (Tokyo local 2026-06-01T00:00 is 2026-05-31T15:00Z).
 * Pure, deterministic; overrides the suite's pinned TZ per-test and restores it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { enumerateScreenTimeHistoryDays } from "./ranges.js";

const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("enumerateScreenTimeHistoryDays local date key", () => {
  it("keys days by the local calendar date in a UTC+ timezone (Tokyo)", () => {
    process.env.TZ = "Asia/Tokyo";
    const days = enumerateScreenTimeHistoryDays({
      since: "2026-06-01T01:30:00.000Z", // 10:30 JST June 1
      until: "2026-06-02T06:45:00.000Z", // 15:45 JST June 2
    });

    expect(days.map((day) => day.date)).toEqual(["2026-06-01", "2026-06-02"]);
    // The day key must agree with the local (label) day, not the UTC day of
    // the bucket's start instant.
    expect(days[0]?.since).toBe("2026-05-31T15:00:00.000Z");
  });

  it("keys days by the local calendar date in a UTC- timezone (Los Angeles)", () => {
    process.env.TZ = "America/Los_Angeles";
    const days = enumerateScreenTimeHistoryDays({
      since: "2026-06-01T10:30:00.000Z", // 03:30 PDT June 1
      until: "2026-06-02T15:45:00.000Z", // 08:45 PDT June 2
    });

    expect(days.map((day) => day.date)).toEqual(["2026-06-01", "2026-06-02"]);
  });
});
