/**
 * `minutesUntilLocalBedtime` rolls a passed bedtime to the next local
 * calendar day. Day 31 + 1 is not a valid day number, so the next civil
 * date must be normalized before the timezone resolver runs.
 */
import { describe, expect, it } from "vitest";
import { minutesUntilLocalBedtime } from "./sleep-cycle-dispatch.js";

describe("minutesUntilLocalBedtime", () => {
  it("uses tomorrow when today's bedtime has already passed", () => {
    expect(
      minutesUntilLocalBedtime({
        now: new Date("2026-01-15T23:30:00.000Z"),
        timezone: "UTC",
        localBedtime: "22:00",
      }),
    ).toBe(22 * 60 + 30);
  });

  it("keeps today's bedtime when it is still ahead on the last day of a month", () => {
    expect(
      minutesUntilLocalBedtime({
        now: new Date("2026-01-31T21:00:00.000Z"),
        timezone: "UTC",
        localBedtime: "22:00",
      }),
    ).toBe(60);
  });

  it("resolves the next calendar day after bedtime on a month end", () => {
    expect(
      minutesUntilLocalBedtime({
        now: new Date("2026-01-31T23:30:00.000Z"),
        timezone: "UTC",
        localBedtime: "22:00",
      }),
    ).toBe(22 * 60 + 30);
    expect(
      minutesUntilLocalBedtime({
        now: new Date("2026-12-31T23:30:00.000Z"),
        timezone: "UTC",
        localBedtime: "22:00",
      }),
    ).toBe(22 * 60 + 30);
    expect(
      minutesUntilLocalBedtime({
        now: new Date("2027-02-28T23:30:00.000Z"),
        timezone: "UTC",
        localBedtime: "22:00",
      }),
    ).toBe(22 * 60 + 30);
    expect(
      minutesUntilLocalBedtime({
        now: new Date("2026-02-01T04:30:00.000Z"),
        timezone: "America/New_York",
        localBedtime: "22:00",
      }),
    ).toBe(22 * 60 + 30);
  });

  it("returns null for a bedtime that is not HH:MM", () => {
    expect(
      minutesUntilLocalBedtime({
        now: new Date("2026-01-31T23:30:00.000Z"),
        timezone: "UTC",
        localBedtime: "25:00",
      }),
    ).toBeNull();
  });
});
