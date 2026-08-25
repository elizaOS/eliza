/**
 * Deterministic coverage for calendar availability rules, source health,
 * timezone boundaries, and private free/busy redaction.
 */

import { describe, expect, it } from "vitest";
import {
  buildZonedCalendarRange,
  type CalendarAvailabilityEvent,
  type CalendarAvailabilitySource,
  evaluateCalendarAvailability,
} from "./availability.js";

const UTC_DAY = {
  start: "2026-05-11T00:00:00.000Z",
  end: "2026-05-12T00:00:00.000Z",
};

function event(
  id: string,
  startISO: string,
  endISO: string,
  overrides: Partial<CalendarAvailabilityEvent> = {},
): CalendarAvailabilityEvent {
  return {
    id,
    title: id,
    startISO,
    endISO,
    ...overrides,
  };
}

function source(
  events: readonly CalendarAvailabilityEvent[],
  overrides: Partial<CalendarAvailabilitySource> = {},
): CalendarAvailabilitySource {
  return {
    id: "owner",
    status: "fresh",
    visibility: "details",
    events,
    ...overrides,
  };
}

describe("evaluateCalendarAvailability", () => {
  it("ignores cancelled, owner-declined, and transparent events", () => {
    const activeA = event(
      "active-a",
      "2026-05-11T09:00:00.000Z",
      "2026-05-11T10:00:00.000Z",
    );
    const activeB = event(
      "active-b",
      "2026-05-11T09:30:00.000Z",
      "2026-05-11T10:30:00.000Z",
    );
    const evaluation = evaluateCalendarAvailability({
      range: UTC_DAY,
      timeZone: "UTC",
      sources: [
        source([
          activeA,
          activeB,
          event(
            "cancelled",
            "2026-05-11T09:15:00.000Z",
            "2026-05-11T09:45:00.000Z",
            { status: "cancelled" },
          ),
          event(
            "declined",
            "2026-05-11T09:15:00.000Z",
            "2026-05-11T09:45:00.000Z",
            {
              attendees: [
                {
                  email: "owner@example.com",
                  self: true,
                  responseStatus: "declined",
                },
              ],
            },
          ),
          event(
            "transparent",
            "2026-05-11T09:15:00.000Z",
            "2026-05-11T09:45:00.000Z",
            { transparency: "transparent" },
          ),
        ]),
      ],
    });

    expect(evaluation.checkedEvents).toBe(2);
    expect(evaluation.ignoredEvents).toBe(3);
    expect(evaluation.conflicts).toHaveLength(1);
    expect([
      evaluation.conflicts[0]?.eventA.id,
      evaluation.conflicts[0]?.eventB.id,
    ]).toEqual(["active-a", "active-b"]);
    expect(evaluation.conflicts[0]?.severity).toBe("hard");
  });

  it("blocks tentative events as warnings by default and can explicitly ignore them", () => {
    const tentative = event(
      "tentative",
      "2026-05-11T09:00:00.000Z",
      "2026-05-11T10:00:00.000Z",
      { status: "tentative" },
    );
    const base = {
      range: UTC_DAY,
      timeZone: "UTC",
      sources: [source([tentative])],
      proposal: {
        startISO: "2026-05-11T09:15:00.000Z",
        endISO: "2026-05-11T09:45:00.000Z",
      },
    } as const;

    const blocked = evaluateCalendarAvailability(base);
    expect(blocked.conflicts).toHaveLength(1);
    expect(blocked.conflicts[0]).toMatchObject({
      severity: "warning",
      reasons: ["time_overlap", "tentative"],
    });

    const ignored = evaluateCalendarAvailability({
      ...base,
      policy: { tentative: "ignore" },
    });
    expect(ignored.conflicts).toHaveLength(0);
    expect(ignored.checkedEvents).toBe(0);
    expect(ignored.ignoredEvents).toBe(1);
  });

  it("always blocks provider busy-only intervals regardless of retained event metadata or owner policy", () => {
    const evaluation = evaluateCalendarAvailability({
      range: UTC_DAY,
      timeZone: "UTC",
      sources: [
        source([]),
        source(
          [
            event(
              "provider-busy",
              "2026-05-11T09:00:00.000Z",
              "2026-05-11T10:00:00.000Z",
              {
                status: "cancelled",
                transparency: "transparent",
                attendees: [
                  {
                    email: "private-guest@example.com",
                    self: true,
                    responseStatus: "declined",
                  },
                ],
              },
            ),
          ],
          { id: "private-guest", visibility: "busy_only" },
        ),
      ],
      proposal: {
        startISO: "2026-05-11T09:15:00.000Z",
        endISO: "2026-05-11T09:45:00.000Z",
      },
      policy: { tentative: "ignore", allDay: "ignore" },
    });

    expect(evaluation).toMatchObject({
      checkedEvents: 1,
      ignoredEvents: 0,
      conflicts: [
        {
          severity: "hard",
          reasons: ["time_overlap", "guest_busy"],
          eventB: {
            id: "private-busy-1",
            title: "Busy",
            status: "busy",
            attendees: [],
          },
        },
      ],
    });
    expect(JSON.stringify(evaluation.conflicts)).not.toContain(
      "private-guest@example.com",
    );
  });

  it("reserves opaque all-day local dates across a 23-hour DST day", () => {
    const evaluation = evaluateCalendarAvailability({
      range: {
        start: "2026-03-08T05:00:00.000Z",
        end: "2026-03-09T04:00:00.000Z",
      },
      timeZone: "America/New_York",
      sources: [
        source([
          {
            id: "school-closed",
            title: "School closed",
            isAllDay: true,
            startDate: "2026-03-08",
            endDate: "2026-03-09",
            timeZone: "America/New_York",
          },
        ]),
      ],
      proposal: {
        startISO: "2026-03-08T15:00:00.000Z",
        endISO: "2026-03-08T16:00:00.000Z",
      },
    });

    expect(evaluation.conflicts).toHaveLength(1);
    expect(evaluation.conflicts[0]).toMatchObject({
      severity: "warning",
      reasons: ["time_overlap", "all_day"],
      eventB: {
        id: "school-closed",
        startISO: "2026-03-08T05:00:00.000Z",
        endISO: "2026-03-09T04:00:00.000Z",
        isAllDay: true,
      },
    });
  });

  it("starts an all-day event after a skipped local midnight", () => {
    const input = {
      range: {
        start: "2026-09-06T03:00:00.000Z",
        end: "2026-09-07T03:00:00.000Z",
      },
      timeZone: "America/Santiago",
      sources: [
        source([
          {
            id: "midnight-transition",
            title: "Local all-day event",
            isAllDay: true,
            startDate: "2026-09-06",
            endDate: "2026-09-07",
            timeZone: "America/Santiago",
          },
        ]),
      ],
    } as const;
    const beforeGap = evaluateCalendarAvailability({
      ...input,
      proposal: {
        startISO: "2026-09-06T03:15:00.000Z",
        endISO: "2026-09-06T03:45:00.000Z",
      },
    });

    expect(beforeGap.conflicts).toHaveLength(0);

    const afterGap = evaluateCalendarAvailability({
      ...input,
      proposal: {
        startISO: "2026-09-06T04:15:00.000Z",
        endISO: "2026-09-06T04:45:00.000Z",
      },
    });
    expect(afterGap.conflicts).toHaveLength(1);
    expect(afterGap.conflicts[0]).toMatchObject({
      eventB: {
        id: "midnight-transition",
        startISO: "2026-09-06T04:00:00.000Z",
        endISO: "2026-09-07T03:00:00.000Z",
        isAllDay: true,
      },
    });
  });

  it("normalizes an all-day event across Apia's skipped local date", () => {
    const input = {
      range: {
        start: "2011-12-29T10:00:00.000Z",
        end: "2011-12-31T10:00:00.000Z",
      },
      timeZone: "Pacific/Apia",
      sources: [
        source([
          {
            id: "date-line-transition",
            title: "Local all-day event",
            isAllDay: true,
            startDate: "2011-12-30",
            endDate: "2012-01-01",
            timeZone: "Pacific/Apia",
          },
        ]),
      ],
    } as const;
    const beforeSkip = evaluateCalendarAvailability({
      ...input,
      proposal: {
        startISO: "2011-12-29T10:15:00.000Z",
        endISO: "2011-12-29T10:45:00.000Z",
      },
    });

    expect(beforeSkip.conflicts).toHaveLength(0);

    const afterSkip = evaluateCalendarAvailability({
      ...input,
      proposal: {
        startISO: "2011-12-30T10:15:00.000Z",
        endISO: "2011-12-30T10:45:00.000Z",
      },
    });
    expect(afterSkip.conflicts[0]).toMatchObject({
      eventB: {
        id: "date-line-transition",
        startISO: "2011-12-30T10:00:00.000Z",
        endISO: "2011-12-31T10:00:00.000Z",
        isAllDay: true,
      },
    });
  });

  it("does not block on a transparent all-day annotation", () => {
    const evaluation = evaluateCalendarAvailability({
      range: UTC_DAY,
      timeZone: "UTC",
      sources: [
        source([
          {
            id: "birthday",
            title: "Birthday",
            isAllDay: true,
            startDate: "2026-05-11",
            endDate: "2026-05-12",
            timeZone: "UTC",
            transparency: "transparent",
          },
        ]),
      ],
      proposal: {
        startISO: "2026-05-11T12:00:00.000Z",
        endISO: "2026-05-11T13:00:00.000Z",
      },
    });

    expect(evaluation.checkedEvents).toBe(0);
    expect(evaluation.ignoredEvents).toBe(1);
    expect(evaluation.conflicts).toHaveLength(0);
  });

  it("detects cross-midnight overlap and keeps repeated DST hours distinct", () => {
    const crossMidnight = evaluateCalendarAvailability({
      range: {
        start: "2026-05-11T00:00:00.000Z",
        end: "2026-05-13T00:00:00.000Z",
      },
      timeZone: "UTC",
      sources: [
        source([
          event(
            "late-flight",
            "2026-05-11T23:30:00.000Z",
            "2026-05-12T00:30:00.000Z",
          ),
          event(
            "midnight-call",
            "2026-05-12T00:00:00.000Z",
            "2026-05-12T01:00:00.000Z",
          ),
        ]),
      ],
    });
    expect(crossMidnight.conflicts).toHaveLength(1);

    const repeatedHour = evaluateCalendarAvailability({
      range: {
        start: "2026-11-01T04:00:00.000Z",
        end: "2026-11-01T08:00:00.000Z",
      },
      timeZone: "America/New_York",
      sources: [
        source([
          event(
            "first-0130",
            "2026-11-01T01:15:00-04:00",
            "2026-11-01T01:45:00-04:00",
          ),
          event(
            "second-0130",
            "2026-11-01T01:15:00-05:00",
            "2026-11-01T01:45:00-05:00",
          ),
        ]),
      ],
    });
    expect(repeatedHour.checkedEvents).toBe(2);
    expect(repeatedHour.conflicts).toHaveLength(0);
  });

  it("accepts RFC 3339 lowercase time separators and offsets", () => {
    const evaluation = evaluateCalendarAvailability({
      range: UTC_DAY,
      timeZone: "UTC",
      sources: [
        source([
          event("lower-z", "2026-05-11t09:00:00z", "2026-05-11t10:00:00z"),
          event(
            "lower-offset",
            "2026-05-11t14:30:00+05:30",
            "2026-05-11t15:30:00+05:30",
          ),
        ]),
      ],
    });
    // Both events resolve to 09:00-10:00 UTC, so parsing both yields one
    // overlap conflict instead of an "explicit offset" rejection.
    expect(evaluation.checkedEvents).toBe(2);
    expect(evaluation.conflicts).toHaveLength(1);
  });

  it("rejects an offset-less local timestamp instead of guessing through a DST fold", () => {
    expect(() =>
      evaluateCalendarAvailability({
        range: {
          start: "2026-11-01T04:00:00.000Z",
          end: "2026-11-01T08:00:00.000Z",
        },
        timeZone: "America/New_York",
        sources: [
          source([
            event("ambiguous", "2026-11-01T01:30:00", "2026-11-01T02:00:00"),
          ]),
        ],
      }),
    ).toThrow(/explicit offset/i);
  });

  it("rejects a proposal outside the evaluated range", () => {
    expect(() =>
      evaluateCalendarAvailability({
        range: UTC_DAY,
        timeZone: "UTC",
        sources: [source([])],
        proposal: {
          startISO: "2026-05-12T09:00:00.000Z",
          endISO: "2026-05-12T10:00:00.000Z",
        },
      }),
    ).toThrow(/entirely inside the availability range/i);
  });

  it("reports stale or failed source coverage without claiming the window is free", () => {
    const partial = evaluateCalendarAvailability({
      range: UTC_DAY,
      timeZone: "UTC",
      sources: [
        source([], { id: "work", status: "fresh" }),
        source([], { id: "school", status: "stale" }),
        source([], {
          id: "co-parent",
          status: "error",
          error: "provider 503",
        }),
      ],
    });
    expect(partial).toMatchObject({
      completeness: "partial",
      definitive: false,
      conflicts: [],
    });
    expect(partial.summary).toMatch(/availability is incomplete/i);
    expect(partial.summary).not.toBe("No conflicts detected.");

    const unavailable = evaluateCalendarAvailability({
      range: UTC_DAY,
      timeZone: "UTC",
      sources: [
        source([], { status: "error", error: "provider 503" }),
        source([], { id: "guest", status: "disconnected" }),
      ],
    });
    expect(unavailable).toMatchObject({
      completeness: "unavailable",
      definitive: false,
    });
    expect(unavailable.summary).toMatch(/unavailable/i);
  });

  it("reports conflicts found in stale data while keeping the result partial", () => {
    const evaluation = evaluateCalendarAvailability({
      range: UTC_DAY,
      timeZone: "UTC",
      sources: [
        source(
          [
            event(
              "stale-a",
              "2026-05-11T09:00:00.000Z",
              "2026-05-11T10:00:00.000Z",
            ),
            event(
              "stale-b",
              "2026-05-11T09:30:00.000Z",
              "2026-05-11T10:30:00.000Z",
            ),
          ],
          { status: "stale" },
        ),
      ],
    });
    expect(evaluation.conflicts).toHaveLength(1);
    expect(evaluation.completeness).toBe("partial");
    expect(evaluation.summary).toMatch(/recheck stale or unavailable/i);
  });

  it("redacts guest-private busy details, identifiers, and attendee identities", () => {
    const evaluation = evaluateCalendarAvailability({
      range: UTC_DAY,
      timeZone: "UTC",
      sources: [
        source([]),
        source(
          [
            event(
              "alice-secret-therapy",
              "2026-05-11T09:15:00.000Z",
              "2026-05-11T09:45:00.000Z",
              {
                title: "Alice private therapy",
                attendees: ["alice@example.com"],
              },
            ),
          ],
          {
            id: "alice@example.com",
            visibility: "busy_only",
            error:
              "freebusy request for secretguest@example.com failed at /calendar/freebusy",
          },
        ),
      ],
      proposal: {
        startISO: "2026-05-11T09:00:00.000Z",
        endISO: "2026-05-11T10:00:00.000Z",
        attendees: ["alice@example.com"],
      },
    });

    expect(evaluation.conflicts).toHaveLength(1);
    expect(evaluation.conflicts[0]).toMatchObject({
      severity: "hard",
      reasons: ["time_overlap", "guest_busy"],
      eventB: {
        id: "private-busy-1",
        title: "Busy",
        attendees: [],
      },
    });
    const exposedPrivateBlock = JSON.stringify(evaluation.conflicts[0]?.eventB);
    expect(exposedPrivateBlock).not.toContain("alice-secret-therapy");
    expect(exposedPrivateBlock).not.toContain("Alice private therapy");
    expect(exposedPrivateBlock).not.toContain("alice@example.com");
    expect(evaluation.sources[1]?.error).toBe(
      "Private availability source unavailable.",
    );
    expect(JSON.stringify(evaluation.sources)).not.toContain(
      "secretguest@example.com",
    );
  });

  it("produces stable pair ordering regardless of provider input order", () => {
    const events = [
      event("a", "2026-05-11T09:00:00.000Z", "2026-05-11T10:00:00.000Z"),
      event("b", "2026-05-11T09:15:00.000Z", "2026-05-11T10:15:00.000Z"),
      event("c", "2026-05-11T09:30:00.000Z", "2026-05-11T09:45:00.000Z"),
    ];
    const forward = evaluateCalendarAvailability({
      range: UTC_DAY,
      timeZone: "UTC",
      sources: [source(events)],
    });
    const reversed = evaluateCalendarAvailability({
      range: UTC_DAY,
      timeZone: "UTC",
      sources: [source([...events].reverse())],
    });

    expect(reversed.conflicts).toEqual(forward.conflicts);
  });
});

describe("buildZonedCalendarRange", () => {
  it("uses 23-hour and 25-hour local-day boundaries at DST transitions", () => {
    const spring = buildZonedCalendarRange({
      now: new Date("2026-03-08T12:00:00.000Z"),
      timeZone: "America/New_York",
      days: 1,
    });
    expect(spring).toEqual({
      start: "2026-03-08T05:00:00.000Z",
      end: "2026-03-09T04:00:00.000Z",
    });
    expect(Date.parse(spring.end) - Date.parse(spring.start)).toBe(
      23 * 60 * 60 * 1000,
    );

    const fall = buildZonedCalendarRange({
      now: new Date("2026-11-01T12:00:00.000Z"),
      timeZone: "America/New_York",
      days: 1,
    });
    expect(fall).toEqual({
      start: "2026-11-01T04:00:00.000Z",
      end: "2026-11-02T05:00:00.000Z",
    });
    expect(Date.parse(fall.end) - Date.parse(fall.start)).toBe(
      25 * 60 * 60 * 1000,
    );
  });
});
