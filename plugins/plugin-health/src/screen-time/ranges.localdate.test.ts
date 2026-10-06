/**
 * Regression test: `enumerateScreenTimeHistoryDays` must key each history
 * bucket by the LOCAL calendar date. In any UTC+ timezone, local midnight maps
 * to the previous UTC date, so a `toISOString()`-derived key labels every day
 * with the day before (Tokyo local 2026-06-01T00:00 is 2026-05-31T15:00Z).
 * Pure, deterministic; overrides the suite's pinned TZ per-test and restores it.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  computeScreenTimeRange,
  enumerateScreenTimeHistoryDays,
} from "./ranges.js";

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

describe("screen-time ranges in an explicit owner time zone", () => {
  // A UTC host (cloud) reporting for an owner in Los Angeles.
  it("starts today and this week at the owner's midnight, not the host's", () => {
    process.env.TZ = "UTC";
    const now = new Date("2026-10-06T23:00:00.000Z"); // 16:00 PDT Tue Oct 6

    expect(computeScreenTimeRange("today", now, "America/Los_Angeles")).toEqual(
      {
        since: "2026-10-06T07:00:00.000Z",
        until: "2026-10-06T23:00:00.000Z",
      },
    );
    // Sunday Oct 4 00:00 PDT.
    expect(
      computeScreenTimeRange("this-week", now, "America/Los_Angeles").since,
    ).toBe("2026-10-04T07:00:00.000Z");
  });

  it("buckets history by the owner's days across the DST change", () => {
    process.env.TZ = "UTC";
    const days = enumerateScreenTimeHistoryDays(
      {
        since: "2026-10-31T07:00:00.000Z", // 00:00 PDT Oct 31
        until: "2026-11-02T08:00:00.000Z", // 00:00 PST Nov 2
      },
      "America/Los_Angeles",
    );

    expect(days.map(({ date, since }) => [date, since])).toEqual([
      ["2026-10-31", "2026-10-31T07:00:00.000Z"],
      ["2026-11-01", "2026-11-01T07:00:00.000Z"],
      ["2026-11-02", "2026-11-02T08:00:00.000Z"],
    ]);
  });
});
