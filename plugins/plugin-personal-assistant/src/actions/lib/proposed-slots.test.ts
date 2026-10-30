/** Proposed meeting slots are separate free options, never overlapping copies of one opening. */

import type { LifeOpsCalendarEvent } from "@elizaos/contracts";
import { describe, expect, it } from "vitest";
import type { LifeOpsMeetingPreferences } from "../../lifeops/owner-profile.js";
import { computeProposedSlots } from "./scheduling-handler.js";

const TIME_ZONE = "America/Los_Angeles";

const preferences: LifeOpsMeetingPreferences = {
  timeZone: TIME_ZONE,
  preferredStartLocal: "09:00",
  preferredEndLocal: "17:00",
  defaultDurationMinutes: 30,
  travelBufferMinutes: 0,
  blackoutWindows: [],
  updatedAt: null,
};

function event(id: string, startAt: string, endAt: string) {
  return {
    id,
    externalId: id,
    agentId: "proposed-slots-agent",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: id,
    description: "",
    location: "",
    status: "confirmed",
    startAt,
    endAt,
    isAllDay: false,
    timezone: TIME_ZONE,
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: "2026-10-30T11:35:00.000Z",
    updatedAt: "2026-10-30T11:35:00.000Z",
  } satisfies LifeOpsCalendarEvent;
}

function expectSeparateFreeSlots(
  slots: ReturnType<typeof computeProposedSlots>,
  events: readonly LifeOpsCalendarEvent[],
) {
  const intervals = slots.map((slot) => ({
    start: Date.parse(slot.startAt),
    end: Date.parse(slot.endAt),
  }));
  for (const [index, slot] of intervals.entries()) {
    expect(slot.end - slot.start).toBe(30 * 60_000);
    for (const busy of events)
      expect(
        slot.start < Date.parse(busy.endAt) &&
          slot.end > Date.parse(busy.startAt),
      ).toBe(false);
    for (const other of intervals.slice(index + 1))
      expect(slot.start < other.end && slot.end > other.start).toBe(false);
  }
}

describe("computeProposedSlots", () => {
  it("spreads 30-minute options across the free parts of an afternoon", () => {
    // "Find me a 30-minute slot tomorrow afternoon." asked on Oct 30: the
    // window is Oct 31 12:00-18:00 PDT with events 13:00-15:00 and
    // 16:00-18:00. The second pass used to offer 12:00, 12:15 and 12:30.
    const events = [
      event(
        "lunch-and-coffee",
        "2026-10-31T20:00:00.000Z",
        "2026-10-31T22:00:00.000Z",
      ),
      event(
        "coffee-and-dinner",
        "2026-10-31T23:00:00.000Z",
        "2026-11-01T01:00:00.000Z",
      ),
    ];
    const slots = computeProposedSlots({
      now: new Date("2026-10-30T11:35:00.000Z"),
      windowStart: new Date("2026-10-31T19:00:00.000Z"),
      windowEnd: new Date("2026-11-01T01:00:00.000Z"),
      durationMinutes: 30,
      slotCount: 3,
      preferences,
      events,
    });
    expect(slots.map((slot) => slot.startAt)).toEqual([
      "2026-10-31T19:00:00.000Z",
      "2026-10-31T19:30:00.000Z",
      "2026-10-31T22:00:00.000Z",
    ]);
    // Node's ICU writes "Sat, Oct 31, 12:00 PM"; Bun's writes "Sat, Oct 31
    // at 12:00 PM".
    expect(slots.map((slot) => slot.localStart)).toEqual([
      expect.stringMatching(/^Sat, Oct 31(?: at |, )12:00\sPM$/),
      expect.stringMatching(/^Sat, Oct 31(?: at |, )12:30\sPM$/),
      expect.stringMatching(/^Sat, Oct 31(?: at |, )3:00\sPM$/),
    ]);
    expectSeparateFreeSlots(slots, events);
  });

  it("keeps the spread on the day daylight saving time ends", () => {
    // Nov 1 2026 falls back to PST (UTC-8), so its afternoon starts at
    // 20:00Z, an hour later than the same local time on Oct 31.
    const events = [
      event("early", "2026-11-01T21:00:00.000Z", "2026-11-01T23:00:00.000Z"),
      event("late", "2026-11-02T00:00:00.000Z", "2026-11-02T02:00:00.000Z"),
    ];
    const slots = computeProposedSlots({
      now: new Date("2026-10-31T18:00:00.000Z"),
      windowStart: new Date("2026-11-01T20:00:00.000Z"),
      windowEnd: new Date("2026-11-02T02:00:00.000Z"),
      durationMinutes: 30,
      slotCount: 3,
      preferences,
      events,
    });
    expect(slots.map((slot) => slot.startAt)).toEqual([
      "2026-11-01T20:00:00.000Z",
      "2026-11-01T20:30:00.000Z",
      "2026-11-01T23:00:00.000Z",
    ]);
    expect(slots.map((slot) => slot.localStart)).toEqual([
      expect.stringMatching(/^Sun, Nov 1(?: at |, )12:00\sPM$/),
      expect.stringMatching(/^Sun, Nov 1(?: at |, )12:30\sPM$/),
      expect.stringMatching(/^Sun, Nov 1(?: at |, )3:00\sPM$/),
    ]);
    expectSeparateFreeSlots(slots, events);
  });

  it("offers fewer options rather than overlapping ones", () => {
    // One free 45-minute gap holds only one 30-minute option.
    const events = [
      event("morning", "2026-10-31T16:00:00.000Z", "2026-10-31T19:15:00.000Z"),
      event(
        "afternoon",
        "2026-10-31T20:00:00.000Z",
        "2026-11-01T01:00:00.000Z",
      ),
    ];
    const slots = computeProposedSlots({
      now: new Date("2026-10-30T11:35:00.000Z"),
      windowStart: new Date("2026-10-31T19:00:00.000Z"),
      windowEnd: new Date("2026-11-01T01:00:00.000Z"),
      durationMinutes: 30,
      slotCount: 3,
      preferences,
      events,
    });
    expect(slots.map((slot) => slot.startAt)).toEqual([
      "2026-10-31T19:15:00.000Z",
    ]);
  });
});
