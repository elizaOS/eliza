/**
 * mergeAggregatedCalendarFeedEvents gives each event an own accountEmail
 * property, undefined for a source without an email such as the built-in
 * Eliza calendar. Live tj-783cb093c72b2b: that key made the read projection
 * decline, so the full 6.6k-char event list went to the evaluator and the
 * post-turn evaluator.
 */
import { describe, expect, it } from "vitest";
import { calendarReadPromptProjection } from "../src/calendar-read-result.js";

const PREFIX =
  "58061aa5-4439-0a79-8e33-181a443b15b7:eliza:owner:grant:eliza-calendar:calendar:primary:";

function stored(externalId: string, title: string, hour: number) {
  const at = (h: number) =>
    `2026-10-30T${String(h).padStart(2, "0")}:00:00.000Z`;
  return {
    id: `${PREFIX}${externalId}`,
    externalId,
    agentId: "58061aa5-4439-0a79-8e33-181a443b15b7",
    provider: "eliza",
    side: "owner",
    calendarId: "primary",
    connectorAccountId: "eliza-calendar",
    title,
    description: "",
    location: "",
    status: "confirmed",
    startAt: at(hour),
    endAt: at(hour + 1),
    isAllDay: false,
    timezone: "America/Los_Angeles",
    htmlLink: null,
    conferenceLink: null,
    organizer: { self: true, displayName: "You" },
    attendees: [],
    metadata: { managedBy: "eliza", version: 1, etag: '"eliza-1"' },
    recurrence: null,
    recurringEventId: null,
    syncedAt: "2026-10-30T04:29:27.775Z",
    updatedAt: "2026-10-30T04:29:27.775Z",
    grantId: "eliza-calendar",
  };
}

/** The merged shape: stored fields, then accountEmail and calendarSummary. */
function feedData() {
  const events = [
    stored("event-breakfast", "breakfast", 18),
    stored("event-lunch", "lunch with Sam", 19),
    stored("event-dinner", "dinner", 20),
  ].map((event) => ({
    ...event,
    accountEmail: undefined,
    calendarSummary: "Eliza Calendar",
  }));
  return { calendarId: "primary", events, source: "synced" };
}

function decode(events: {
  keys: string[];
  shared: Record<string, unknown>;
  columns: string[];
  prefixes: Record<string, string>;
  rows: unknown[][];
}) {
  return events.rows.map((row) =>
    Object.fromEntries(
      events.keys.map((key) => {
        if (Object.hasOwn(events.shared, key)) return [key, events.shared[key]];
        const cell = row[events.columns.indexOf(key)];
        return [key, (events.prefixes[key] ?? "") + (cell as string)];
      }),
    ),
  );
}

describe("calendar read projection", () => {
  it("encodes an aggregated feed whose events carry an undefined accountEmail", () => {
    const data = feedData();
    expect(Object.hasOwn(data.events[0], "accountEmail")).toBe(true);
    const projected = calendarReadPromptProjection(data);
    expect(projected.promptDataMode).toBe("replace-data");
    const encoded = projected.promptData?.events as Parameters<
      typeof decode
    >[0];
    expect(JSON.stringify(decode(encoded))).toBe(JSON.stringify(data.events));
    expect(JSON.stringify(projected.promptData).length).toBeLessThan(
      JSON.stringify(data).length,
    );
  });

  it("declines events whose fields differ", () => {
    const data = feedData();
    const [first, ...rest] = data.events;
    const { location: _location, ...withoutLocation } = first;
    expect(
      calendarReadPromptProjection({
        ...data,
        events: [withoutLocation, ...rest],
      }),
    ).toEqual({});
  });
});
