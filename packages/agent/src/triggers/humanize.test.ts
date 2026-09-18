/**
 * Deterministic unit tests for the trigger-schedule humanizers: cron
 * recurrence phrasing, one-shot sender-local times, and interval descriptions.
 * Absolute instants and explicit IANA zones keep the assertions independent
 * of the test runner's host timezone. The cron cases additionally drive the
 * real scheduler (`computeNextCronRunAtMs`) so a claimed cadence is checked
 * against the fire times it produces, not against a list of literal strings.
 */
import { describe, expect, it } from "vitest";

import {
  describeCronSchedule,
  describeIntervalMs,
  describeOnceAt,
} from "./humanize.ts";
import { computeNextCronRunAtMs } from "./scheduling.ts";

/**
 * Walk the real scheduler forward and return the gaps between consecutive
 * fires, in minutes. The base is 23:00Z so the window crosses an hour
 * boundary (and a day boundary) — that is where a minute-field step restarts
 * and a literal "every N minutes" phrase stops being true.
 */
function measuredGapMinutes(expression: string, fires: number): number[] {
  let cursor = Date.parse("2026-01-01T23:00:00Z");
  const gaps: number[] = [];
  for (let i = 0; i < fires; i++) {
    const next = computeNextCronRunAtMs(expression, cursor, "UTC");
    if (next === null) throw new Error(`no next run for ${expression}`);
    gaps.push((next - cursor) / 60_000);
    cursor = next;
  }
  return gaps;
}

describe("describeCronSchedule", () => {
  it("only claims an every-N-minutes cadence when N divides 60", () => {
    // A minute-field step restarts each hour, so the literal phrasing is only
    // true for divisors of 60. The measured gaps behind each case are pinned
    // by the next-run test below.
    expect(describeCronSchedule("*/5 * * * *")).toBe("every 5 minutes");
    expect(describeCronSchedule("*/15 * * * *")).toBe("every 15 minutes");
    expect(describeCronSchedule("*/30 * * * *")).toBe("every 30 minutes");
    expect(describeCronSchedule("*/1 * * * *")).toBe("every minute");

    expect(describeCronSchedule("*/7 * * * *")).toBeNull();
    expect(describeCronSchedule("*/25 * * * *")).toBeNull();
    expect(describeCronSchedule("*/45 * * * *")).toBeNull();
    expect(describeCronSchedule("*/59 * * * *")).toBeNull();
    expect(describeCronSchedule("*/90 * * * *")).toBeNull();
  });

  it("matches the gaps computeNextCronRunAtMs actually produces", () => {
    // The phrase is checked against the scheduler, not against a list of
    // literal strings: a cadence may be claimed only when the measured gaps
    // across the hour boundary are uniformly N minutes.
    for (const n of [1, 5, 15, 30, 60, 7, 25, 45, 59, 61, 90]) {
      const expression = `*/${n} * * * *`;
      const gaps = measuredGapMinutes(expression, 12);
      const uniform = gaps.every((gap) => gap === n);
      const description = describeCronSchedule(expression);
      if (uniform) {
        expect(description).toBe(
          n === 1 ? "every minute" : `every ${n} minutes`,
        );
      } else {
        expect(description).toBeNull();
      }
    }

    // The specific sequences, so a parser change that moves them fails here
    // rather than silently re-validating the phrase against new behaviour.
    // `*/59` expands to minutes 0 and 59 — it alternates 59 and 1, it is not
    // hourly. Only steps above 59 collapse to minute 0 and fire hourly.
    expect(measuredGapMinutes("*/59 * * * *", 6)).toEqual([
      59, 1, 59, 1, 59, 1,
    ]);
    expect(measuredGapMinutes("*/45 * * * *", 4)).toEqual([45, 15, 45, 15]);
    expect(measuredGapMinutes("*/25 * * * *", 6)).toEqual([
      25, 25, 10, 25, 25, 10,
    ]);
    expect(measuredGapMinutes("*/7 * * * *", 9)).toEqual([
      7, 7, 7, 7, 7, 7, 7, 7, 4,
    ]);
    expect(measuredGapMinutes("*/90 * * * *", 3)).toEqual([60, 60, 60]);
    expect(measuredGapMinutes("*/30 * * * *", 4)).toEqual([30, 30, 30, 30]);
  });

  it("maps daily crons onto time-of-day nouns", () => {
    expect(describeCronSchedule("0 8 * * *")).toBe("every morning at 8am");
    expect(describeCronSchedule("30 14 * * *")).toBe(
      "every afternoon at 2:30pm",
    );
    expect(describeCronSchedule("0 19 * * *")).toBe("every evening at 7pm");
    // Small hours have no natural noun; plain daily phrasing instead.
    expect(describeCronSchedule("0 2 * * *")).toBe("every day at 2am");
    expect(describeCronSchedule("0 0 * * *")).toBe("every day at 12am");
  });

  it("describes weekday, weekend, and single-day recurrences", () => {
    expect(describeCronSchedule("0 9 * * 1-5")).toBe("every weekday at 9am");
    expect(describeCronSchedule("0 10 * * 0,6")).toBe("every weekend at 10am");
    expect(describeCronSchedule("0 9 * * 1")).toBe("every Monday at 9am");
    // POSIX Sunday alias.
    expect(describeCronSchedule("0 9 * * 7")).toBe("every Sunday at 9am");
  });

  it("describes minute/hour and day-of-month shapes", () => {
    expect(describeCronSchedule("*/15 * * * *")).toBe("every 15 minutes");
    expect(describeCronSchedule("*/1 * * * *")).toBe("every minute");
    expect(describeCronSchedule("0 * * * *")).toBe("every hour");
    expect(describeCronSchedule("0 9 1 * *")).toBe(
      "on the 1st of every month at 9am",
    );
    expect(describeCronSchedule("0 9 22 * *")).toBe(
      "on the 22nd of every month at 9am",
    );
  });

  it("returns null for shapes outside the reminder vocabulary", () => {
    // Ranges/lists in minute or hour would misread as a single fire time.
    expect(describeCronSchedule("0 9-17 * * *")).toBeNull();
    expect(describeCronSchedule("0,30 9 * * *")).toBeNull();
    // Restricted month, malformed, out-of-range.
    expect(describeCronSchedule("0 9 * 1 *")).toBeNull();
    expect(describeCronSchedule("not a cron")).toBeNull();
    expect(describeCronSchedule("0 25 * * *")).toBeNull();
    expect(describeCronSchedule("0 9 32 * *")).toBeNull();
  });
});

describe("describeOnceAt", () => {
  const TIME_ZONE = "America/New_York";
  const NOW_MS = Date.parse("2026-08-08T16:00:00.000Z");

  it("renders near-term fires as a countdown", () => {
    expect(
      describeOnceAt(
        new Date(NOW_MS + 30_000).toISOString(),
        NOW_MS,
        TIME_ZONE,
      ),
    ).toBe("in under a minute");
    expect(
      describeOnceAt(
        new Date(NOW_MS + 90_000).toISOString(),
        NOW_MS,
        TIME_ZONE,
      ),
    ).toBe("in 2 minutes");
    expect(
      describeOnceAt(
        new Date(NOW_MS + 5 * 60_000).toISOString(),
        NOW_MS,
        TIME_ZONE,
      ),
    ).toBe("in 5 minutes");
  });

  it("renders same-day, next-day, and same-week fires in the supplied timezone", () => {
    expect(describeOnceAt("2026-08-08T19:30:00.000Z", NOW_MS, TIME_ZONE)).toBe(
      "today at 3:30pm",
    );
    expect(describeOnceAt("2026-08-09T12:00:00.000Z", NOW_MS, TIME_ZONE)).toBe(
      "tomorrow at 8am",
    );
    // 2026-08-12 is a Wednesday.
    expect(describeOnceAt("2026-08-12T12:00:00.000Z", NOW_MS, TIME_ZONE)).toBe(
      "on Wednesday at 8am",
    );
  });

  it("uses the supplied timezone for calendar-day boundaries", () => {
    expect(
      describeOnceAt(
        "2026-08-09T01:00:00.000Z",
        Date.parse("2026-08-08T23:30:00.000Z"),
        TIME_ZONE,
      ),
    ).toBe("today at 9pm");
  });

  it("renders far-out fires as dates, with the year only when it differs", () => {
    expect(describeOnceAt("2026-08-20T12:00:00.000Z", NOW_MS, TIME_ZONE)).toBe(
      "on Aug 20 at 8am",
    );
    expect(describeOnceAt("2027-01-02T14:00:00.000Z", NOW_MS, TIME_ZONE)).toBe(
      "on Jan 2, 2027 at 9am",
    );
  });

  it("returns null for an unparseable timestamp", () => {
    expect(describeOnceAt("not a timestamp", NOW_MS, TIME_ZONE)).toBeNull();
  });
});

describe("describeIntervalMs", () => {
  it("picks the largest evenly-dividing unit", () => {
    expect(describeIntervalMs(24 * 60 * 60 * 1000)).toBe("every day");
    expect(describeIntervalMs(2 * 24 * 60 * 60 * 1000)).toBe("every 2 days");
    expect(describeIntervalMs(12 * 60 * 60 * 1000)).toBe("every 12 hours");
    expect(describeIntervalMs(60 * 60 * 1000)).toBe("every hour");
    expect(describeIntervalMs(90 * 60 * 1000)).toBe("every 90 minutes");
    expect(describeIntervalMs(60 * 1000)).toBe("every minute");
    expect(describeIntervalMs(45 * 1000)).toBe("every 45 seconds");
  });

  it("never emits raw milliseconds", () => {
    expect(describeIntervalMs(1500)).toBe("every 2 seconds");
    expect(describeIntervalMs(10)).toBe("every second");
  });

  it("fails closed on non-finite and non-positive intervals", () => {
    expect(describeIntervalMs(Number.NaN)).toBeNull();
    expect(describeIntervalMs(Number.POSITIVE_INFINITY)).toBeNull();
    expect(describeIntervalMs(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(describeIntervalMs(0)).toBeNull();
    expect(describeIntervalMs(-1000)).toBeNull();
  });
});
