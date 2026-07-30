/**
 * Windows TZID ingestion: Outlook/Exchange feeds label timed VEVENTs with
 * Windows display zone names, which must resolve through the CLDR mapping to
 * real IANA zones; unmapped zones quarantine only the affected event.
 */

import { describe, expect, it } from "vitest";
import { parseIcsCalendar } from "./parser.js";
import { resolveIcsTimeZoneId } from "./windows-timezones.js";

function calendar(...body: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//elizaOS//ICS test//EN",
    ...body,
    "END:VCALENDAR",
  ].join("\r\n");
}

describe("resolveIcsTimeZoneId", () => {
  it("passes valid IANA zones through unchanged", () => {
    expect(resolveIcsTimeZoneId("America/Chicago")).toBe("America/Chicago");
    expect(resolveIcsTimeZoneId(" Europe/Paris ")).toBe("Europe/Paris");
  });

  it("maps CLDR Windows zone names case-insensitively", () => {
    expect(resolveIcsTimeZoneId("Eastern Standard Time")).toBe(
      "America/New_York",
    );
    expect(resolveIcsTimeZoneId("pacific standard time")).toBe(
      "America/Los_Angeles",
    );
    expect(resolveIcsTimeZoneId("W. Europe Standard Time")).toBe(
      "Europe/Berlin",
    );
  });

  it("returns null for unknown zones and empty input", () => {
    expect(resolveIcsTimeZoneId("Middle of Nowhere Standard Time")).toBeNull();
    expect(resolveIcsTimeZoneId("")).toBeNull();
    expect(resolveIcsTimeZoneId("   ")).toBeNull();
  });
});

describe("parseIcsCalendar with Windows timezone names", () => {
  it("ingests an Outlook-style feed whose TZID is a Windows zone name", () => {
    const parsed = parseIcsCalendar(
      calendar(
        "BEGIN:VEVENT",
        "UID:school-conference@example.test",
        "DTSTAMP:20261101T120000Z",
        "DTSTART;TZID=Eastern Standard Time:20261105T090000",
        "DTEND;TZID=Eastern Standard Time:20261105T100000",
        "SUMMARY:Parent conference",
        "END:VEVENT",
      ),
    );
    expect(parsed.state).toBe("complete");
    expect(parsed.issues).toEqual([]);
    expect(parsed.events).toHaveLength(1);
    // November 5 is after the DST fall-back: America/New_York is UTC-5.
    expect(parsed.events[0]).toMatchObject({
      startAt: "2026-11-05T14:00:00.000Z",
      endAt: "2026-11-05T15:00:00.000Z",
      timezone: "America/New_York",
      isAllDay: false,
    });
  });

  it("resolves DST-aware offsets through the mapped IANA zone", () => {
    const parsed = parseIcsCalendar(
      calendar(
        "BEGIN:VEVENT",
        "UID:summer@example.test",
        "DTSTAMP:20260601T120000Z",
        "DTSTART;TZID=Eastern Standard Time:20260710T090000",
        "DTEND;TZID=Eastern Standard Time:20260710T100000",
        "SUMMARY:Summer practice",
        "END:VEVENT",
      ),
    );
    // Outlook writes the standard-time name year-round; July resolves in
    // daylight time (UTC-4) because the mapping is a zone, not a fixed offset.
    expect(parsed.events[0]?.startAt).toBe("2026-07-10T13:00:00.000Z");
  });

  it("applies a Windows X-WR-TIMEZONE to floating and all-day values", () => {
    const parsed = parseIcsCalendar(
      calendar(
        "X-WR-TIMEZONE:Central Standard Time",
        "BEGIN:VEVENT",
        "UID:floating@example.test",
        "DTSTAMP:20261101T120000Z",
        "DTSTART:20261201T080000",
        "DTEND:20261201T090000",
        "SUMMARY:Floating morning block",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:all-day@example.test",
        "DTSTAMP:20261101T120000Z",
        "DTSTART;VALUE=DATE:20261202",
        "SUMMARY:All day",
        "END:VEVENT",
      ),
    );
    expect(parsed.state).toBe("complete");
    expect(parsed.events[0]).toMatchObject({
      startAt: "2026-12-01T14:00:00.000Z",
      timezone: "America/Chicago",
    });
    expect(parsed.events[1]).toMatchObject({
      isAllDay: true,
      timezone: "America/Chicago",
    });
  });

  it("quarantines only the event with an unmapped zone", () => {
    const parsed = parseIcsCalendar(
      calendar(
        "BEGIN:VEVENT",
        "UID:bad-zone@example.test",
        "DTSTAMP:20261101T120000Z",
        "DTSTART;TZID=Middle of Nowhere Standard Time:20261105T090000",
        "DTEND;TZID=Middle of Nowhere Standard Time:20261105T100000",
        "SUMMARY:Unmappable",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:good@example.test",
        "DTSTAMP:20261101T120000Z",
        "DTSTART;TZID=Eastern Standard Time:20261106T090000",
        "DTEND;TZID=Eastern Standard Time:20261106T100000",
        "SUMMARY:Good sibling",
        "END:VEVENT",
      ),
    );
    expect(parsed.state).toBe("partial");
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.uid).toBe("good@example.test");
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]).toMatchObject({
      uid: "bad-zone@example.test",
    });
    expect(parsed.issues[0]?.message).toContain(
      "Middle of Nowhere Standard Time",
    );
  });
});
