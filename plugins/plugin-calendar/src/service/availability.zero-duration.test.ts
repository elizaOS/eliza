/**
 * Zero-duration (instantaneous) availability events: Google's
 * endTimeUnspecified caches end == start, and one such event must neither fail
 * the whole scan nor fabricate a conflict — while reversed intervals stay
 * rejected as corrupt provider data.
 */

import { describe, expect, it } from "vitest";
import {
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
  return { id, title: id, startISO, endISO, ...overrides };
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

describe("zero-duration availability events", () => {
  it("accepts an instantaneous timed event without failing the scan", () => {
    const evaluation = evaluateCalendarAvailability({
      range: UTC_DAY,
      timeZone: "UTC",
      sources: [
        source([
          event(
            "instant",
            "2026-05-11T10:30:00.000Z",
            "2026-05-11T10:30:00.000Z",
          ),
          event(
            "meeting",
            "2026-05-11T14:00:00.000Z",
            "2026-05-11T15:00:00.000Z",
          ),
        ]),
      ],
    });
    expect(evaluation.conflicts).toEqual([]);
    expect(evaluation.definitive).toBe(true);
    expect(evaluation.checkedEvents).toBe(1);
    expect(evaluation.ignoredEvents).toBe(1);
  });

  it("does not report a proposal conflict for an instantaneous event inside the window", () => {
    const evaluation = evaluateCalendarAvailability({
      range: UTC_DAY,
      timeZone: "UTC",
      sources: [
        source([
          event(
            "instant",
            "2026-05-11T10:30:00.000Z",
            "2026-05-11T10:30:00.000Z",
          ),
        ]),
      ],
      proposal: {
        startISO: "2026-05-11T10:00:00.000Z",
        endISO: "2026-05-11T11:00:00.000Z",
      },
    });
    expect(evaluation.conflicts).toEqual([]);
    expect(evaluation.summary).toBe("No conflicts detected.");
  });

  it("still detects real overlaps alongside an instantaneous sibling", () => {
    const evaluation = evaluateCalendarAvailability({
      range: UTC_DAY,
      timeZone: "UTC",
      sources: [
        source([
          event(
            "instant",
            "2026-05-11T09:15:00.000Z",
            "2026-05-11T09:15:00.000Z",
          ),
          event(
            "busy-a",
            "2026-05-11T09:00:00.000Z",
            "2026-05-11T10:00:00.000Z",
          ),
          event(
            "busy-b",
            "2026-05-11T09:30:00.000Z",
            "2026-05-11T10:30:00.000Z",
          ),
        ]),
      ],
    });
    expect(evaluation.conflicts).toHaveLength(1);
    expect(evaluation.conflicts[0]?.eventA.id).toBe("busy-a");
    expect(evaluation.conflicts[0]?.eventB.id).toBe("busy-b");
  });

  it("accepts a zero-duration all-day event as instantaneous", () => {
    const evaluation = evaluateCalendarAvailability({
      range: UTC_DAY,
      timeZone: "UTC",
      sources: [
        source([
          {
            id: "all-day-instant",
            title: "all-day-instant",
            startDate: "2026-05-11",
            endDate: "2026-05-11",
            isAllDay: true,
          },
        ]),
      ],
      proposal: {
        startISO: "2026-05-11T10:00:00.000Z",
        endISO: "2026-05-11T11:00:00.000Z",
      },
    });
    expect(evaluation.conflicts).toEqual([]);
  });

  it("keeps rejecting reversed timed intervals as invalid input", () => {
    expect(() =>
      evaluateCalendarAvailability({
        range: UTC_DAY,
        timeZone: "UTC",
        sources: [
          source([
            event(
              "reversed",
              "2026-05-11T11:00:00.000Z",
              "2026-05-11T10:00:00.000Z",
            ),
          ]),
        ],
      }),
    ).toThrowError(/must not precede/);
  });

  it("keeps rejecting reversed all-day intervals as invalid input", () => {
    expect(() =>
      evaluateCalendarAvailability({
        range: UTC_DAY,
        timeZone: "UTC",
        sources: [
          source([
            {
              id: "reversed-all-day",
              title: "reversed-all-day",
              startDate: "2026-05-11",
              endDate: "2026-05-10",
              isAllDay: true,
            },
          ]),
        ],
      }),
    ).toThrowError(/must not precede/);
  });

  it("keeps rejecting a zero-length proposal window", () => {
    expect(() =>
      evaluateCalendarAvailability({
        range: UTC_DAY,
        timeZone: "UTC",
        sources: [source([])],
        proposal: {
          startISO: "2026-05-11T10:00:00.000Z",
          endISO: "2026-05-11T10:00:00.000Z",
        },
      }),
    ).toThrowError(/endISO must be after startISO/);
  });
});
