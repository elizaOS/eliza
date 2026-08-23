/**
 * Static contract tests for the EventKit bridge boundary that cannot run in
 * Vitest: authorization-level routing, add-only isolation, required creation
 * fields, readback-free receipts, and hostile payload guards.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// A pure reformat of the Swift source must not break the contract, so every
// assertion runs against whitespace-collapsed text: tokens and semantic
// content, never indentation or line breaks.
function collapse(value: string): string {
  return value.replace(/\s+/g, " ");
}

const currentDir = new URL(".", import.meta.url).pathname;
const swiftSource = collapse(
  readFileSync(
    resolve(currentDir, "../ios/Sources/CalendarPlugin/CalendarPlugin.swift"),
    "utf8",
  ),
);
const definitionsSource = collapse(
  readFileSync(resolve(currentDir, "./definitions.ts"), "utf8"),
);

// Omitting `end` slices to end-of-file, for members that close out the class.
function sourceBetween(start: string, end?: string): string {
  const startIndex = swiftSource.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  if (end === undefined) return swiftSource.slice(startIndex);
  const endIndex = swiftSource.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return swiftSource.slice(startIndex, endIndex);
}

describe("Apple Calendar Swift bridge contract", () => {
  it("preserves full/legacy access while exposing write-only distinctly", () => {
    expect(swiftSource).toContain('case "full_access": return .fullAccess');
    expect(swiftSource).toContain('case "write_only": return .writeOnly');
    expect(swiftSource).toContain("requestFullAccessToEvents");
    expect(swiftSource).toContain("requestWriteOnlyAccessToEvents");
    expect(swiftSource).toContain("requestAccess(to: .event)");
    expect(swiftSource).toContain(
      'call.reject("Calendar access must be either full_access or write_only.")',
    );
    expect(swiftSource).toContain('return "write_only"');
    expect(swiftSource).toContain(
      'permission == "prompt" || permission == "write_only"',
    );
  });

  it.each([
    ["listCalendars", "list calendars", "@objc func listEvents"],
    ["listEvents", "read events", "@objc func createEvent"],
    ["updateEvent", "update events", "@objc func deleteEvent"],
    ["deleteEvent", "delete events", "private func permissionResult"],
  ])(
    "requires full access before %s and identifies write-only failures",
    (method, operation, nextMethod) => {
      const body = sourceBetween(`@objc func ${method}`, nextMethod);
      expect(body).toContain("guard hasFullAccess()");
      expect(body).toContain(`fullAccessError(operation: "${operation}")`);
    },
  );

  it("allows write-only creation only through the default calendar", () => {
    const createBody = sourceBetween(
      "@objc func createEvent",
      "@objc func updateEvent",
    );
    expect(createBody).toContain("let writeOnly = hasWriteOnlyAccess()");
    expect(createBody).toContain("guard hasFullAccess() || writeOnly");
    expect(createBody).toContain("writeOnly: writeOnly");

    const applyBody = sourceBetween("private func applyEventPayload");
    expect(applyBody).toContain(
      'requestedCalendarId == "primary" || requestedCalendarId == "default"',
    );
    expect(applyBody).toContain("writeOnlyDefaultCalendarError()");
    expect(applyBody).toContain(
      'nativeError("Calendar event calendarId must be a string.")',
    );
    expect(applyBody).toContain("eventStore.defaultCalendarForNewEvents");
    expect(applyBody).toContain(
      'nativeError("No default Apple Calendar is available.")',
    );

    for (const writeOnlyBranch of applyBody.matchAll(
      /if writeOnly \{(.*?)\} else \{/g,
    )) {
      expect(writeOnlyBranch[1]).not.toContain("eventStore.calendars(for:");
      expect(writeOnlyBranch[1]).not.toContain("calendar(withIdentifier:");
    }
  });

  it("resolves both public default-calendar aliases before touching EventKit", () => {
    expect(swiftSource).toContain(
      'identifier == "primary" || identifier == "default"',
    );
  });

  it("returns a write-only receipt without claiming event readback", () => {
    const createBody = sourceBetween(
      "@objc func createEvent",
      "@objc func updateEvent",
    );
    const receiptBody = createBody.slice(
      createBody.indexOf("if writeOnly {"),
      createBody.indexOf(
        '"event": eventJson(event)',
        createBody.indexOf("if writeOnly {"),
      ),
    );
    expect(receiptBody).toContain('"accessLevel": "write_only"');
    expect(receiptBody).toContain('"destination": "default_calendar"');
    expect(receiptBody).toContain('"eventId": NSNull()');
    expect(receiptBody).toContain('"readBackAvailable": false');
    expect(receiptBody).not.toContain("eventJson(event)");
    expect(receiptBody).not.toContain("calendarItemIdentifier");
  });

  it("requires every direct-creation field in Swift and TypeScript", () => {
    expect(swiftSource).toContain("requireTitle: true");
    expect(swiftSource).toContain(
      'nativeError("Calendar event title is required.")',
    );
    expect(swiftSource).toContain(
      'nativeError("Calendar event startAt and endAt are required.")',
    );
    // `[^}]*` keeps the match inside the interface body (its scalar members
    // precede any nested object type), so each field is a required direct
    // member, not a hit in some later declaration.
    expect(definitionsSource).toMatch(
      /interface AppleCalendarEventInput \{[^}]* title: string;/,
    );
    expect(definitionsSource).toMatch(
      /interface AppleCalendarEventInput \{[^}]* startAt: string;/,
    );
    expect(definitionsSource).toMatch(
      /interface AppleCalendarEventInput \{[^}]* endAt: string;/,
    );
  });

  it("keeps old status payloads and default full-access requests compatible", () => {
    expect(definitionsSource).toContain('| "granted"');
    expect(definitionsSource).toContain('| "denied"');
    expect(definitionsSource).toContain('| "prompt"');
    expect(definitionsSource).toContain('| "restricted"');
    expect(definitionsSource).toContain(
      "access?: AppleCalendarRequestedAccess",
    );
    expect(swiftSource).toContain(
      'let value = (call.getString("access") ?? "full_access")',
    );
  });

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
      '"error": "unsupported_feature", "message": "Apple Calendar recurrence editing is not supported by this bridge."',
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

  it("serializes EventKit availability for deterministic transparency rules", () => {
    expect(swiftSource).toContain(
      "private func eventAvailability(_ availability: EKEventAvailability)",
    );
    expect(swiftSource).toContain('case .free: return "free"');
    expect(swiftSource).toContain(
      '"availability": eventAvailability(event.availability)',
    );
  });

  it("emits portable identity, recurrence, reminder, and source provenance", () => {
    for (const token of [
      "calendarItemExternalIdentifier",
      "occurrenceDate",
      "lastModifiedDate",
      "recurrenceRules",
      "event.alarms",
      "sourceIdentifier",
      "sourceType",
    ]) {
      expect(swiftSource).toContain(token);
    }
  });

  it("publishes EventKit store-change observations for cache invalidation", () => {
    expect(swiftSource).toContain("name: .EKEventStoreChanged");
    expect(swiftSource).toContain('notifyListeners( "calendarStoreChanged"');
    expect(definitionsSource).toContain('eventName: "calendarStoreChanged"');
  });
});
