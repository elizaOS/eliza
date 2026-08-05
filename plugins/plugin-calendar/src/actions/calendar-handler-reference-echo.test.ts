/**
 * Regression coverage for the external-content security envelope leak in the
 * CALENDAR handler's reference echoes: titleHint and search queries come from
 * model extraction over a message hardenIncomingUserMessage may have wrapped
 * in a ~2KB "SECURITY NOTICE … <<<EXTERNAL_UNTRUSTED_CONTENT>>>" envelope, so
 * a blob-shaped value quoted verbatim re-broadcast the whole envelope to chat
 * (live leak 2026-08-02, tj-2dc95f75456876). Deterministic — exercises the
 * exported fallback builders directly with real core envelope fixtures.
 */

import { userReferenceLogView, wrapExternalContent } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  buildCalendarEventDisambiguationFallback,
  buildCalendarEventNotFoundFallback,
  formatCalendarSearchResults,
} from "./calendar-handler.js";

/** The exact multi-line envelope core wraps around untrusted content.text. */
const ENVELOPE_BLOB = wrapExternalContent("dentist appointment tomorrow", {
  source: "api",
  includeWarning: true,
});

function event(title: string): LifeOpsCalendarEvent {
  return {
    id: `id-${title}`,
    calendarId: "primary",
    title,
    startAt: "2026-08-03T15:00:00.000Z",
    endAt: "2026-08-03T16:00:00.000Z",
    timezone: "UTC",
    isAllDay: false,
  } as LifeOpsCalendarEvent;
}

function expectNoEnvelope(text: string) {
  expect(text).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
  expect(text).not.toContain("SECURITY NOTICE");
}

describe("calendar reference echoes never re-broadcast the security envelope", () => {
  it("precondition: the fixture is the real multi-line envelope, warning first", () => {
    expect(ENVELOPE_BLOB.startsWith("SECURITY NOTICE")).toBe(true);
    expect(ENVELOPE_BLOB).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
    expect(ENVELOPE_BLOB).toContain("dentist appointment tomorrow");
  });

  it("disambiguation intro quotes a name-shaped titleHint and neutralizes a blob", () => {
    const candidates = [event("Dentist"), event("Dentist follow-up")];

    const named = buildCalendarEventDisambiguationFallback({
      action: "update",
      candidates,
      titleHint: "dentist",
    });
    expect(named).toContain('I found multiple events matching "dentist".');

    const blobbed = buildCalendarEventDisambiguationFallback({
      action: "delete",
      candidates,
      titleHint: ENVELOPE_BLOB,
    });
    expectNoEnvelope(blobbed);
    expect(blobbed).toContain("I found multiple events matching that event.");
  });

  it("not-found fallback neutralizes a blob-shaped titleHint and keeps the no-hint wording", () => {
    const named = buildCalendarEventNotFoundFallback("update", "dentist");
    expect(named).toBe(
      'i couldn\'t find an event matching "dentist" in that window.',
    );

    const blobbed = buildCalendarEventNotFoundFallback("delete", ENVELOPE_BLOB);
    expectNoEnvelope(blobbed);
    expect(blobbed).toBe(
      "i couldn't find an event matching that event in that window.",
    );

    expect(buildCalendarEventNotFoundFallback("delete", undefined)).toBe(
      "i couldn't find any events to delete in that window. give me a title or a date.",
    );
  });

  it("search results echo the query only when name-shaped, in every branch", () => {
    const none = formatCalendarSearchResults([], ENVELOPE_BLOB, "this week");
    expectNoEnvelope(none);
    expect(none).toBe("No calendar events matched that request this week.");

    const named = formatCalendarSearchResults([], "dentist", "this week");
    expect(named).toBe('No calendar events matched "dentist" this week.');

    const many = formatCalendarSearchResults(
      [event("Dentist"), event("Dentist follow-up")],
      ENVELOPE_BLOB,
      "this week",
    );
    expectNoEnvelope(many);
    expect(many).toContain(
      "Found 2 calendar events for that request this week:",
    );
    expect(many).toContain("**Dentist**");
  });

  it("machine-facing renders of a blob stay single-line and length-bounded", () => {
    const view = userReferenceLogView(ENVELOPE_BLOB);
    expect(view).not.toContain("\n");
    expect(view.length).toBeLessThanOrEqual(121);
  });
});
