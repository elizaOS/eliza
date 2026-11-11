import { describe, expect, it } from "vitest";
import type { IcsCalendarSourceRecord } from "../service/CalendarRepository.js";
import { parseIcsCalendar } from "./parser.js";
import {
  expandIcsCalendarEvents,
  lifeOpsCalendarEventFromIcs,
} from "./source.js";

function feedSource(): IcsCalendarSourceRecord {
  return {
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
}

describe("expandIcsCalendarEvents with EXRULE", () => {
  it("drops the occurrences named by a legacy EXRULE line", () => {
    const calendar = parseIcsCalendar(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//t//t//EN",
        "BEGIN:VEVENT",
        "UID:daily-exrule",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260105T100000Z",
        "DTEND:20260105T110000Z",
        "RRULE:FREQ=DAILY;COUNT=7",
        "EXRULE:FREQ=WEEKLY;BYDAY=SU",
        "SUMMARY:Daily except Sundays",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    // 2026-01-05 is a Monday, so the daily series runs Mon 01-05 .. Sun
    // 01-11 and the weekly EXRULE removes the Sunday occurrence.
    expect(calendar.events[0]?.recurrence).toContain(
      "EXRULE:FREQ=WEEKLY;BYDAY=SU",
    );
    const source = feedSource();
    const events = calendar.events.map((event) =>
      lifeOpsCalendarEventFromIcs({
        event,
        source,
        syncedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const result = expandIcsCalendarEvents({
      events,
      timeMin: "2026-01-05T00:00:00.000Z",
      timeMax: "2026-01-12T00:00:00.000Z",
      allDayTimeMin: "2026-01-05T00:00:00.000Z",
      allDayTimeMax: "2026-01-12T00:00:00.000Z",
    });
    expect(result.events.map((event) => event.startAt)).toEqual([
      "2026-01-05T10:00:00.000Z",
      "2026-01-06T10:00:00.000Z",
      "2026-01-07T10:00:00.000Z",
      "2026-01-08T10:00:00.000Z",
      "2026-01-09T10:00:00.000Z",
      "2026-01-10T10:00:00.000Z",
    ]);
    expect(result.complete).toBe(true);
  });

  it("drops DTSTART itself when the EXRULE pattern matches it", () => {
    const calendar = parseIcsCalendar(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//t//t//EN",
        "BEGIN:VEVENT",
        "UID:daily-exrule-first",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260105T100000Z",
        "DTEND:20260105T110000Z",
        "RRULE:FREQ=DAILY;COUNT=7",
        "EXRULE:FREQ=DAILY;COUNT=1",
        "SUMMARY:Daily except the first day",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    const source = feedSource();
    const events = calendar.events.map((event) =>
      lifeOpsCalendarEventFromIcs({
        event,
        source,
        syncedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const result = expandIcsCalendarEvents({
      events,
      timeMin: "2026-01-05T00:00:00.000Z",
      timeMax: "2026-01-12T00:00:00.000Z",
      allDayTimeMin: "2026-01-05T00:00:00.000Z",
      allDayTimeMax: "2026-01-12T00:00:00.000Z",
    });
    expect(result.events.map((event) => event.startAt)).toEqual([
      "2026-01-06T10:00:00.000Z",
      "2026-01-07T10:00:00.000Z",
      "2026-01-08T10:00:00.000Z",
      "2026-01-09T10:00:00.000Z",
      "2026-01-10T10:00:00.000Z",
      "2026-01-11T10:00:00.000Z",
    ]);
    expect(result.complete).toBe(true);
  });
});
