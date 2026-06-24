import { describe, expect, it } from "bun:test";
import {
  generateWindowIds,
  getWindowIdForTimestamp,
} from "../../agents/src/training/window-utils";

/**
 * RL training time-window bucketing. A timestamp floors to its hour-window id,
 * and a time range enumerates each covered window. These derive from UTC
 * (toISOString), so they're timezone-stable — a wrong window mislabels training
 * samples.
 */

describe("getWindowIdForTimestamp", () => {
  it("floors a timestamp to its hourly window id (UTC)", () => {
    expect(getWindowIdForTimestamp(new Date("2026-06-23T14:37:00.000Z"))).toBe(
      "2026-06-23T14:00",
    );
    expect(getWindowIdForTimestamp(new Date("2026-06-23T14:00:00.000Z"))).toBe(
      "2026-06-23T14:00",
    );
    expect(getWindowIdForTimestamp(new Date("2026-06-23T23:59:59.000Z"))).toBe(
      "2026-06-23T23:00",
    );
  });
});

describe("generateWindowIds", () => {
  it("enumerates each hourly window covering the range", () => {
    const ids = generateWindowIds(
      new Date("2026-06-23T14:00:00.000Z"),
      new Date("2026-06-23T16:30:00.000Z"),
    );
    expect(ids).toEqual([
      "2026-06-23T14:00",
      "2026-06-23T15:00",
      "2026-06-23T16:00",
    ]);
  });

  it("yields a single window when start and end share one hour", () => {
    const ids = generateWindowIds(
      new Date("2026-06-23T14:05:00.000Z"),
      new Date("2026-06-23T14:55:00.000Z"),
    );
    expect(ids).toEqual(["2026-06-23T14:00"]);
  });
});
