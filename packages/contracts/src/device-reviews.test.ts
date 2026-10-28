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

test("an all-day event on a repeated-midnight day starts at the first midnight", () => {
  // Asia/Amman fell back 01:00 -> 00:00 on 2021-10-29, so that civil date
  // first exists at 2021-10-28T21:00:00.000Z (00:00 at +03:00); the second
  // midnight is 2021-10-28T22:00:00.000Z (00:00 at +02:00).
  const result = calendarAvailability(
    operation("Asia/Amman", Date.UTC(2021, 9, 29)),
    1,
    [allDay(Date.UTC(2021, 9, 29))],
  );
  assert.equal(result.busy[0]?.start, "2021-10-28T21:00:00.000Z");
});

test("a repeated-midnight all-day event overlaps the first hour of its day", () => {
  assert.equal(
    calendarEventOverlapsRange(
      {
        start: "2021-10-28T21:00:00.000Z",
        end: "2021-10-28T22:00:00.000Z",
        timeZone: "Asia/Amman",
      },
      {
        start: "2021-10-29T00:00:00.000Z",
        end: "2021-10-30T00:00:00.000Z",
        allDay: true,
      },
    ),
    true,
  );
});

test("an all-day event starts exactly at a sub-thirty-minute skipped midnight", () => {
  // Asia/Kathmandu sprang forward 15 minutes at midnight on 1986-01-01, so
  // that day's first instant is 00:15 local = 1985-12-31T18:30:00.000Z.
  const result = calendarAvailability(
    operation("Asia/Kathmandu", Date.UTC(1986, 0, 1)),
    1,
    [allDay(Date.UTC(1986, 0, 1))],
  );
  assert.equal(result.busy[0]?.start, "1985-12-31T18:30:00.000Z");
});

test("an all-day event on a date split into two runs starts at the first run", () => {
  // Antarctica/Casey on 2010-03-05: the date first exists at
  // 2010-03-04T13:00:00.000Z (00:00 at +11); the offset drops to +08 at
  // 15:00Z, the clock falls back into Mar 4, and Mar 5 starts again at
  // 2010-03-04T16:00:00.000Z.
  const result = calendarAvailability(
    operation("Antarctica/Casey", Date.UTC(2010, 2, 5)),
    1,
    [allDay(Date.UTC(2010, 2, 5))],
  );
  assert.equal(result.busy[0]?.start, "2010-03-04T13:00:00.000Z");
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
