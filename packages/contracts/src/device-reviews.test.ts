import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calendarAvailability,
  calendarEventOverlapsRange,
} from "./device-reviews.ts";

// Asia/Beirut springs forward at local midnight: on 2026-03-29 the clocks
// jump 00:00 -> 01:00, so that civil day's first instant is
// 2026-03-28T22:00:00.000Z and the previous civil day ends at that instant.
const BEIRUT = "Asia/Beirut";
const operation = (timeZone: string, startUtc: number) => ({
  type: "calendar_availability" as const,
  start: new Date(startUtc - 2 * 86_400_000).toISOString(),
  end: new Date(startUtc + 3 * 86_400_000).toISOString(),
  timeZone,
});
const allDay = (startUtc: number) => ({
  start: new Date(startUtc).toISOString(),
  end: new Date(startUtc + 86_400_000).toISOString(),
  allDay: true,
  availability: "busy" as const,
});

test("an all-day event on the day before a midnight spring forward ends at the jump", () => {
  const result = calendarAvailability(
    operation(BEIRUT, Date.UTC(2026, 2, 28)),
    1,
    [allDay(Date.UTC(2026, 2, 28))],
  );
  assert.equal(result.busy[0]?.end, "2026-03-28T22:00:00.000Z");
});

test("an all-day event on a midnight spring-forward day starts at its first instant", () => {
  const result = calendarAvailability(
    operation(BEIRUT, Date.UTC(2026, 2, 29)),
    1,
    [allDay(Date.UTC(2026, 2, 29))],
  );
  assert.equal(result.busy[0]?.start, "2026-03-28T22:00:00.000Z");
});

test("a spring-forward day all-day event does not overlap the previous evening", () => {
  assert.equal(
    calendarEventOverlapsRange(
      {
        start: "2026-03-28T21:30:00.000Z", // 23:30 local on Mar 28
        end: "2026-03-28T21:45:00.000Z",
        timeZone: BEIRUT,
      },
      {
        start: "2026-03-29T00:00:00.000Z",
        end: "2026-03-30T00:00:00.000Z",
        allDay: true,
      },
    ),
    false,
  );
});

test("all-day bounds in a zone whose transition is not at midnight are unchanged", () => {
  // America/New_York springs forward at 02:00; 2026-03-08 local midnight is
  // 05:00Z (EST) and the next midnight is 04:00Z (EDT).
  const result = calendarAvailability(
    operation("America/New_York", Date.UTC(2026, 2, 8)),
    1,
    [allDay(Date.UTC(2026, 2, 8))],
  );
  assert.equal(result.busy[0]?.start, "2026-03-08T05:00:00.000Z");
  assert.equal(result.busy[0]?.end, "2026-03-09T04:00:00.000Z");
});
