/**
 * Deterministic unit tests for the trigger-schedule humanizers: cron
 * recurrence phrasing, one-shot sender-local times, and interval descriptions.
 * Absolute instants and explicit IANA zones keep the assertions independent
 * of the test runner's host timezone.
 */
import { describe, expect, it } from "vitest";

import {
  describeCronSchedule,
  describeIntervalMs,
  describeOnceAt,
} from "./humanize.ts";

describe("describeCronSchedule", () => {
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
});
