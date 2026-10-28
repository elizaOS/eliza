import { describe, expect, it } from "vitest";
import type { IcsCalendarSourceRecord } from "../service/CalendarRepository.js";
import {
  endAtFromIcsDuration,
  parseIcsCalendar,
  startAtBeforeIcsDurationEnd,
} from "./parser.js";
import {
  expandIcsCalendarEvents,
  lifeOpsCalendarEventFromIcs,
} from "./source.js";

function feedWithSummary(summary: string): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//t//t//EN",
    "BEGIN:VEVENT",
    "UID:esc1",
    "DTSTAMP:20260101T000000Z",
    "DTSTART:20260102T100000Z",
    "DTEND:20260102T110000Z",
    `SUMMARY:${summary}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

describe("decodeIcsText unknown escapes", () => {
  it("keeps the backslash of undefined escapes", () => {
    const raw = String.raw`keep \q and 100\% done`;
    const cal = parseIcsCalendar(feedWithSummary(raw));
    expect(cal.events[0]?.title).toBe(raw);
  });
  it("still decodes the defined escapes", () => {
    // ICS value: a\,b\;c\\d\ne  ->  a,b;c\<newline>e
    const raw = "a\\,b\\;c\\\\d\\ne";
    const cal = parseIcsCalendar(feedWithSummary(raw));
    expect(cal.events[0]?.title).toBe("a,b;c\\d\ne");
  });
});

describe("startAtBeforeIcsDurationEnd", () => {
  it("steps back across a DST gap so overlapping starts stay in range", () => {
    // 02:30 EDT on 2026-03-09; one nominal day earlier is 02:30 on 03-08,
    // inside the New York spring-forward gap.
    const boundary = startAtBeforeIcsDurationEnd({
      endAt: "2026-03-09T06:30:00.000Z",
      timezone: "America/New_York",
      isAllDay: false,
      duration: "P1D",
    });
    const overlappingStart = "2026-03-08T07:00:00.000Z";
    expect(Date.parse(boundary)).toBeLessThan(Date.parse(overlappingStart));
    expect(
      Date.parse(
        endAtFromIcsDuration({
          startAt: overlappingStart,
          timezone: "America/New_York",
          isAllDay: false,
          duration: "P1D",
        }),
      ),
    ).toBeGreaterThan(Date.parse("2026-03-09T06:30:00.000Z"));
    expect(boundary).toBe("2026-03-08T06:30:00.000Z");
  });

  it("returns the exact nominal inverse outside a gap", () => {
    expect(
      startAtBeforeIcsDurationEnd({
        endAt: "2026-03-10T14:00:00.000Z",
        timezone: "America/New_York",
        isAllDay: false,
        duration: "P1D",
      }),
    ).toBe("2026-03-09T14:00:00.000Z");
  });

  it("keeps a start whose end is pushed past a gap on the end date", () => {
    // 2026-03-07 02:32 EST + P1D is 02:32 on 03-08, inside the New York gap,
    // so the end resolves forward to 03:32 EDT (07:32Z), after endAt.
    const args = {
      timezone: "America/New_York",
      isAllDay: false,
      duration: "P1D",
    };
    const endAt = "2026-03-08T07:30:00.000Z";
    const start = "2026-03-07T07:32:00.000Z";
    expect(
      Date.parse(endAtFromIcsDuration({ ...args, startAt: start })),
    ).toBeGreaterThan(Date.parse(endAt));
    const boundary = startAtBeforeIcsDurationEnd({ ...args, endAt });
    expect(Date.parse(boundary)).toBeLessThan(Date.parse(start));
  });

  it("stays below every overlapping start around DST transitions", () => {
    const MINUTE = 60_000;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;
    // America/Santiago springs forward at local midnight; Lord Howe by 30m.
    const transitions: Array<[string, string]> = [
      ["America/New_York", "2026-03-08T07:00:00.000Z"],
      ["America/New_York", "2026-11-01T06:00:00.000Z"],
      ["Europe/Berlin", "2026-03-29T01:00:00.000Z"],
      ["Australia/Lord_Howe", "2026-10-03T15:30:00.000Z"],
      ["America/Santiago", "2026-09-06T04:00:00.000Z"],
    ];
    const missed: string[] = [];
    for (const [timezone, transition] of transitions) {
      const args = { timezone, isAllDay: false, duration: "P1D" };
      const transitionMs = Date.parse(transition);
      for (
        let endMs = transitionMs - 2 * HOUR;
        endMs <= transitionMs + 3 * HOUR;
        endMs += 30 * MINUTE
      ) {
        const endAt = new Date(endMs).toISOString();
        const boundaryMs = Date.parse(
          startAtBeforeIcsDurationEnd({ ...args, endAt }),
        );
        for (
          let startMs = endMs - DAY - 3 * HOUR;
          startMs <= endMs - DAY + 3 * HOUR;
          startMs += 10 * MINUTE
        ) {
          const startAt = new Date(startMs).toISOString();
          const occurrenceEndMs = Date.parse(
            endAtFromIcsDuration({ ...args, startAt }),
          );
          // Callers search starts strictly after the boundary.
          if (occurrenceEndMs > endMs && boundaryMs >= startMs) {
            missed.push(`${timezone} end=${endAt} start=${startAt}`);
          }
        }
      }
    }
    expect(missed).toEqual([]);
  });
});

describe("expandIcsCalendarEvents across a DST gap", () => {
  it("returns an occurrence whose DURATION end is pushed past the gap", () => {
    const calendar = parseIcsCalendar(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//t//t//EN",
        "BEGIN:VEVENT",
        "UID:daily-dst",
        "DTSTAMP:20260101T000000Z",
        "DTSTART;TZID=America/New_York:20260301T023200",
        "DURATION:P1D",
        "RRULE:FREQ=DAILY;COUNT=10",
        "SUMMARY:Daily",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    const source: IcsCalendarSourceRecord = {
      id: "source-1",
      agentId: "agent-1",
      provider: "ics",
      side: "owner",
      name: "Feed",
      enabled: true,
      secretRef: "secret-1",
      urlFingerprint: "fingerprint-1",
      origin: "https://calendar.example.test",
      etag: null,
      lastModified: null,
      contentHash: null,
      syncStatus: "fresh",
      error: null,
      lastSyncedAt: null,
      lastAttemptedAt: null,
      syncGeneration: 1,
      leaseToken: null,
      leaseExpiresAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const events = calendar.events.map((event) =>
      lifeOpsCalendarEventFromIcs({
        event,
        source,
        syncedAt: "2026-03-01T00:00:00.000Z",
      }),
    );
    // The 2026-03-07 02:32 EST occurrence ends at 03:32 EDT (07:32Z) because
    // 02:32 on 03-08 does not exist, so it overlaps a window from 07:30Z.
    const window = {
      timeMin: "2026-03-08T07:30:00.000Z",
      timeMax: "2026-03-08T07:31:00.000Z",
    };
    const result = expandIcsCalendarEvents({
      events,
      ...window,
      allDayTimeMin: window.timeMin,
      allDayTimeMax: window.timeMax,
    });
    expect(result.events.map((event) => [event.startAt, event.endAt])).toEqual([
      ["2026-03-07T07:32:00.000Z", "2026-03-08T07:32:00.000Z"],
    ]);
    expect(result.complete).toBe(true);
  });
});
