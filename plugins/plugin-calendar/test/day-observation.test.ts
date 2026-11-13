import { expect, it } from "vitest";
import { calendarDayObservation as observe } from "../src/client/day-observation.ts";

const ready = {
  mode: "day" as const,
  selection: "none" as const,
  source: "canonical" as const,
  status: "ready",
  mutating: false,
  ownerKey: "owner",
};
const host = { visible: true, ownerCurrent: true, currentOwnerKey: "owner" };
const calendarDayObservation = (
  dayOffset: unknown,
  timeZone: string,
  now?: number,
) => observe({ ...ready, dayOffset }, host, timeZone, now);
it("projects civil days across daylight saving instead of adding 24 hours", () => {
  const zone = "America/Los_Angeles";
  expect(
    calendarDayObservation(1, zone, Date.parse("2026-03-08T07:30:00Z")),
  ).toEqual({ date: "2026-03-08", timeZone: zone });
  expect(
    calendarDayObservation(2, zone, Date.parse("2026-03-08T07:30:00Z")),
  ).toEqual({ date: "2026-03-09", timeZone: zone });
  expect(
    calendarDayObservation(
      -1,
      "Pacific/Kiritimati",
      Date.parse("2026-01-01T12:00:00Z"),
    ),
  ).toEqual({ date: "2026-01-01", timeZone: "Pacific/Kiritimati" });
});
it("refuses draft/noninteger offsets and invalid civil time input", () => {
  for (const offset of [1.5, "1", NaN, Infinity])
    expect(calendarDayObservation(offset, "UTC")).toBeUndefined();
  expect(calendarDayObservation(0, "Not/AZone")).toBeUndefined();
  expect(calendarDayObservation(0, "UTC", NaN)).toBeUndefined();
});

it("refuses non-day, draft, stale-owner and unavailable Calendar snapshots", () => {
  for (const patch of [
    { mode: "month" as const },
    { selection: "event" as const },
    { selection: "editor" as const },
    { source: "other" as const },
    { status: "loading" },
    { mutating: true },
    { ownerKey: "old-owner" },
  ])
    expect(
      observe({ ...ready, dayOffset: 0, ...patch }, host, "UTC"),
    ).toBeUndefined();
  for (const patch of [
    { visible: false },
    { ownerCurrent: false },
    { currentOwnerKey: null },
  ])
    expect(
      observe({ ...ready, dayOffset: 0 }, { ...host, ...patch }, "UTC"),
    ).toBeUndefined();
});
