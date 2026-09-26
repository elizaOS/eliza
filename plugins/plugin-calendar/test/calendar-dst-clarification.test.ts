/**
 * DST disambiguation coverage for the calendar mutation boundary (#32600).
 *
 * Missing/repeated local hours must surface as typed clarification — never a
 * silently resolved instant — before any event is written:
 *   - nonexistent local time (spring-forward gap) rejects with
 *     CALENDAR_LOCAL_TIME_NONEXISTENT and no possible instants.
 *   - repeated local time (fall-back) rejects with CALENDAR_LOCAL_TIME_AMBIGUOUS
 *     and exactly the two possible instants.
 *   - clarification resolution: re-submitting with an explicit offset
 *     normalizes to that exact instant and the create completes.
 *   - unambiguous local times keep working unchanged.
 *
 * Uses the production normalizeCalendarDateTimeInTimeZone / resolveCalendarEventRange
 * against the real DST transitions of America/Los_Angeles (2026-03-08, 2026-11-01).
 */
import { describe, expect, it } from "vitest";
import {
  normalizeCalendarDateTimeInTimeZone,
  resolveCalendarEventRange,
} from "../src/internal/calendar-normalize.js";
import { CalendarLocalTimeError } from "../src/internal/time.js";

const ZONE = "America/Los_Angeles";
/** 2026-03-08 02:30 local does not exist (clocks jump 02:00 → 03:00). */
const NONEXISTENT_LOCAL = "2026-03-08T02:30:00";
/** 2026-11-01 01:30 local occurs twice (clocks fall back 02:00 → 01:00). */
const AMBIGUOUS_LOCAL = "2026-11-01T01:30:00";

function expectClarification(input: string, code: string, choices: number) {
  try {
    normalizeCalendarDateTimeInTimeZone(input, "startAt", ZONE, "reject");
    throw new Error(`expected ${input} to require clarification`);
  } catch (error) {
    // The typed contract: a CalendarLocalTimeError carrying the zone, the
    // offending local time, and the concrete instants the user can pick.
    expect(error).toBeInstanceOf(CalendarLocalTimeError);
    const local = error as CalendarLocalTimeError;
    expect((local as { code?: string }).code).toBe(code);
    const context = (local as { context?: Record<string, unknown> }).context ?? {};
    expect(context.timeZone).toBe(ZONE);
    const localTime = context.localTime as { hour: number; minute: number };
    expect(localTime.hour).toBe(input.includes("02:30") ? 2 : 1);
    expect(localTime.minute).toBe(30);
    const instants = context.possibleInstants as string[];
    expect(instants).toHaveLength(choices);
    return instants;
  }
}

describe("calendar mutation boundary disambiguates DST local times", () => {
  it("rejects a nonexistent spring-forward local time before any write", () => {
    expectClarification(NONEXISTENT_LOCAL, "CALENDAR_LOCAL_TIME_NONEXISTENT", 0);
  });

  it("rejects a repeated fall-back local time and reports both occurrences", () => {
    const instants = expectClarification(AMBIGUOUS_LOCAL, "CALENDAR_LOCAL_TIME_AMBIGUOUS", 2);
    // The two candidates are the PDT (−07:00) and PST (−08:00) occurrences.
    expect(instants).toEqual(
      expect.arrayContaining([
        "2026-11-01T08:30:00.000Z",
        "2026-11-01T09:30:00.000Z",
      ]),
    );
  });

  it("resolves the clarification when the user re-submits an explicit offset", () => {
    // Picking the earlier (PDT) occurrence by naming the instant explicitly.
    const earlier = normalizeCalendarDateTimeInTimeZone(
      "2026-11-01T01:30:00-07:00",
      "startAt",
      ZONE,
      "reject",
    );
    expect(earlier).toBe("2026-11-01T08:30:00.000Z");
    const later = normalizeCalendarDateTimeInTimeZone(
      "2026-11-01T01:30:00-08:00",
      "startAt",
      ZONE,
      "reject",
    );
    expect(later).toBe("2026-11-01T09:30:00.000Z");
  });

  it("keeps unambiguous local times working in reject mode", () => {
    const unambiguous = normalizeCalendarDateTimeInTimeZone(
      "2026-03-08T09:30:00",
      "startAt",
      ZONE,
      "reject",
    );
    expect(unambiguous).toBe("2026-03-08T16:30:00.000Z");
  });

  it("resolveCalendarEventRange blocks a create whose start falls in the DST gap", () => {
    const PINNED_NOW = new Date("2026-03-01T18:00:00.000Z");
    expect(() =>
      resolveCalendarEventRange(
        {
          title: "Gym session",
          timeZone: ZONE,
          startAt: NONEXISTENT_LOCAL,
          durationMinutes: 60,
        },
        PINNED_NOW,
      ),
    ).toThrow(CalendarLocalTimeError);
  });

  it("resolveCalendarEventRange blocks a create whose repeated start is ambiguous", () => {
    const PINNED_NOW = new Date("2026-10-25T18:00:00.000Z");
    expect(() =>
      resolveCalendarEventRange(
        {
          title: "Gym session",
          timeZone: ZONE,
          startAt: AMBIGUOUS_LOCAL,
          durationMinutes: 60,
        },
        PINNED_NOW,
      ),
    ).toThrow(CalendarLocalTimeError);
  });

  it("resolveCalendarEventRange completes once the ambiguity is resolved explicitly", () => {
    const PINNED_NOW = new Date("2026-10-25T18:00:00.000Z");
    const range = resolveCalendarEventRange(
      {
        title: "Gym session",
        timeZone: ZONE,
        startAt: "2026-11-01T01:30:00-08:00",
        durationMinutes: 60,
      },
      PINNED_NOW,
    );
    expect(range.startAt).toBe("2026-11-01T09:30:00.000Z");
    expect(range.endAt).toBe("2026-11-01T10:30:00.000Z");
  });

  it("still honors compatible mode for arithmetic callers outside mutations", () => {
    // Non-mutation callers (window derivation, ICS import) keep the documented
    // compatible behavior: the earlier instant for repeats, gap-advance for
    // nonexistent times.
    const repeated = normalizeCalendarDateTimeInTimeZone(AMBIGUOUS_LOCAL, "timeMin", ZONE);
    expect(repeated).toBe("2026-11-01T08:30:00.000Z");
    const gap = normalizeCalendarDateTimeInTimeZone(NONEXISTENT_LOCAL, "timeMin", ZONE);
    expect(gap).toBe("2026-03-08T10:30:00.000Z");
  });
});
