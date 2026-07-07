/**
 * Static contract test that greps `CalendarPlugin.swift` source text for the
 * guard clauses TS callers depend on — event-window/timezone validation,
 * blocked recurrence/attendee edits, string-length bounds — since this suite
 * cannot execute Swift/EventKit directly.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const currentDir = new URL(".", import.meta.url).pathname;
const swiftSource = readFileSync(
  resolve(currentDir, "../ios/Sources/CalendarPlugin/CalendarPlugin.swift"),
  "utf8",
);

describe("Apple Calendar Swift bridge contract", () => {
  it("rejects malformed event windows before querying EventKit", () => {
    expect(swiftSource).toContain('parseDate(call.getString("timeMin") ?? "")');
    expect(swiftSource).toContain('parseDate(call.getString("timeMax") ?? "")');
    expect(swiftSource).toContain("timeMax > timeMin");
  });

  it("rejects invalid or blank event time zones instead of silently ignoring them", () => {
    expect(swiftSource).toContain('call.options.keys.contains("timeZone")');
    expect(swiftSource).toContain(
      'nativeError("Calendar event timeZone is invalid.")',
    );
    expect(swiftSource).toContain("TimeZone(identifier: timeZoneName)");
  });

  it("keeps unsupported recurrence and attendee edits out of EventKit writes", () => {
    for (const key of [
      "recurrence",
      "recurrenceRule",
      "recurrenceRules",
      "rrule",
    ]) {
      expect(swiftSource).toContain(`"${key}"`);
    }

    expect(swiftSource).toContain(
      '"error": "unsupported_feature",\n                "message": "Apple Calendar recurrence editing is not supported by this bridge."',
    );
    expect(swiftSource).toContain(
      'nativeError("Calendar event attendees must be an array.")',
    );
    expect(swiftSource).toContain(
      "Apple Calendar does not allow this app to create or edit event invitees through EventKit.",
    );
  });

  it("bounds string fields that can be supplied by hostile event payloads", () => {
    expect(swiftSource).toContain("private let maxTitleLength = 512");
    expect(swiftSource).toContain("private let maxDescriptionLength = 20000");
    expect(swiftSource).toContain("private let maxLocationLength = 1024");
    expect(swiftSource).toContain("Calendar event \\(key) must be a string.");
    expect(swiftSource).toContain("Calendar event \\(key) is too long.");
  });
});
