/**
 * Unit tests for the sleep-cycle check-in scheduling predicates: the morning
 * wake window, the night lead window (including the winding_down trigger and
 * the irregular-owner local-bedtime fallback), and the sleep-recap projection.
 * Pure functions, no runtime.
 */
import { describe, expect, it } from "vitest";
import {
  buildSleepRecapFromSchedule,
  type CheckinSleepCycleState,
  DEFAULT_IRREGULAR_BEDTIME_LOCAL,
  MORNING_CHECKIN_WINDOW_MINUTES,
  minutesUntilLocalBedtime,
  NIGHT_CHECKIN_LEAD_MINUTES,
  shouldRunMorningCheckinFromSleepCycle,
  shouldRunNightCheckinFromSleepCycle,
} from "./sleep-cycle-dispatch.js";

const NOW = new Date("2026-08-25T12:00:00Z");

function state(
  overrides: Partial<CheckinSleepCycleState> = {},
): CheckinSleepCycleState {
  return {
    circadianState: "awake",
    wakeAt: null,
    relativeTime: { minutesUntilBedtimeTarget: null },
    ...overrides,
  };
}

describe("shouldRunMorningCheckinFromSleepCycle", () => {
  it("fires only inside the 6h window after a parsed wake time", () => {
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: state({
          circadianState: "awake",
          wakeAt: "2026-08-25T09:30:00Z",
        }),
        now: NOW,
      }),
    ).toBe(true);
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: state({
          circadianState: "awake",
          wakeAt: "2026-08-25T05:00:00Z", // 7h before now — outside
        }),
        now: NOW,
      }),
    ).toBe(false);
  });

  it("never fires before the wake time (negative elapsed)", () => {
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: state({
          circadianState: "awake",
          wakeAt: "2026-08-25T12:30:00Z", // still in the future
        }),
        now: NOW,
      }),
    ).toBe(false);
  });

  it("requires awake state and a wake time", () => {
    expect(
      shouldRunMorningCheckinFromSleepCycle({ state: null, now: NOW }),
    ).toBe(false);
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: state({
          circadianState: "sleeping",
          wakeAt: "2026-08-25T09:30:00Z",
        }),
        now: NOW,
      }),
    ).toBe(false);
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: state({ circadianState: "awake", wakeAt: null }),
        now: NOW,
      }),
    ).toBe(false);
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: state({ circadianState: "awake", wakeAt: "not-a-date" }),
        now: NOW,
      }),
    ).toBe(false);
  });

  it("fires at exactly zero minutes since wake (boundary) and not one minute before", () => {
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: state({ circadianState: "awake", wakeAt: NOW.toISOString() }),
        now: NOW,
      }),
    ).toBe(true);
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: state({
          circadianState: "awake",
          wakeAt: new Date(NOW.getTime() + 60_000).toISOString(),
        }),
        now: NOW,
      }),
    ).toBe(false);
  });

  it("pins the documented window constant", () => {
    expect(MORNING_CHECKIN_WINDOW_MINUTES).toBe(360);
    // Boundary: exactly 6h after wake still fires.
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: state({
          circadianState: "awake",
          wakeAt: "2026-08-25T06:00:00Z",
        }),
        now: NOW,
      }),
    ).toBe(true);
  });
});

describe("shouldRunNightCheckinFromSleepCycle", () => {
  it("fires immediately on winding_down regardless of other fields", () => {
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: state({
          circadianState: "winding_down",
          relativeTime: { minutesUntilBedtimeTarget: null },
        }),
        now: NOW,
      }),
    ).toBe(true);
  });

  it("fires inside the 3h lead window for awake/waking owners", () => {
    for (const circadianState of ["awake", "waking"] as const) {
      expect(
        shouldRunNightCheckinFromSleepCycle({
          state: state({
            circadianState,
            relativeTime: { minutesUntilBedtimeTarget: 150 },
          }),
          now: NOW,
        }),
      ).toBe(true);
    }
    // Boundary: exactly 0 min fires, 181 does not.
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: state({ relativeTime: { minutesUntilBedtimeTarget: 0 } }),
        now: NOW,
      }),
    ).toBe(true);
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: state({ relativeTime: { minutesUntilBedtimeTarget: 180 } }),
        now: NOW,
      }),
    ).toBe(true);
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: state({ relativeTime: { minutesUntilBedtimeTarget: 181 } }),
        now: NOW,
      }),
    ).toBe(false);
    // Negative (past bedtime projection) does not fire via this trigger.
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: state({ relativeTime: { minutesUntilBedtimeTarget: -5 } }),
        now: NOW,
      }),
    ).toBe(false);
  });

  it("ignores non-finite minutesUntilBedtimeTarget", () => {
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: state({
          relativeTime: { minutesUntilBedtimeTarget: Number.NaN },
        }),
        now: NOW,
      }),
    ).toBe(false);
  });

  it("does not fire for sleeping owners regardless of lead", () => {
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: state({
          circadianState: "sleeping",
          relativeTime: { minutesUntilBedtimeTarget: 10 },
        }),
        now: NOW,
      }),
    ).toBe(false);
  });

  it("irregular-owner fallback: fires inside the lead before configured bedtime", () => {
    // 22:00 New York on Aug 25 2026; now is 12:00Z = 08:00 EDT — 14h away, no fire.
    const morning = new Date("2026-08-25T12:00:00Z");
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: state({
          circadianState: "awake",
          regularity: { regularityClass: "irregular" },
          timezone: "America/New_York",
          relativeTime: { minutesUntilBedtimeTarget: null },
        }),
        now: morning,
        nightFallbackBedtimeLocal: "22:00",
      }),
    ).toBe(false);
    // 19:30Z = 15:30 EDT, bedtime 18:00 EDT — 2.5h away, fires.
    const afternoon = new Date("2026-08-25T19:30:00Z");
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: state({
          circadianState: "awake",
          regularity: { regularityClass: "very_irregular" },
          timezone: "America/New_York",
          relativeTime: { minutesUntilBedtimeTarget: null },
        }),
        now: afternoon,
        nightFallbackBedtimeLocal: "18:00",
      }),
    ).toBe(true);
  });

  it("irregular-owner fallback defaults to 23:00 when no bedtime configured", () => {
    // 20:30Z = 16:30 EDT; default 23:00 EDT is 6.5h away — no fire.
    const now = new Date("2026-08-25T20:30:00Z");
    expect(DEFAULT_IRREGULAR_BEDTIME_LOCAL).toBe("23:00");
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: state({
          regularity: { regularityClass: "irregular" },
          timezone: "America/New_York",
          relativeTime: { minutesUntilBedtimeTarget: null },
        }),
        now,
        nightFallbackBedtimeLocal: null,
      }),
    ).toBe(false);
    // 20:15Z = 16:15 EDT, exactly within 3h of... no: 23:00 EDT = 03:00Z Aug 26,
    // which is 6.75h after 20:15Z. Use a closer now: 00:30Z Aug 26 = 20:30 EDT
    // Aug 25 — 2.5h before 23:00 EDT, fires.
    const evening = new Date("2026-08-26T00:30:00Z");
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: state({
          regularity: { regularityClass: "irregular" },
          timezone: "America/New_York",
          relativeTime: { minutesUntilBedtimeTarget: null },
        }),
        now: evening,
      }),
    ).toBe(true);
  });

  it("skips the fallback for regular owners even near their configured bedtime", () => {
    const evening = new Date("2026-08-26T00:30:00Z"); // 20:30 EDT
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: state({
          regularity: { regularityClass: "regular" },
          timezone: "America/New_York",
          relativeTime: { minutesUntilBedtimeTarget: null },
        }),
        now: evening,
        nightFallbackBedtimeLocal: "23:00",
      }),
    ).toBe(false);
  });

  it("requires timezone and now for the fallback path", () => {
    const evening = new Date("2026-08-26T00:30:00Z");
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: state({
          regularity: { regularityClass: "irregular" },
          timezone: undefined,
          relativeTime: { minutesUntilBedtimeTarget: null },
        }),
        now: evening,
      }),
    ).toBe(false);
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: state({
          regularity: { regularityClass: "irregular" },
          timezone: "America/New_York",
          relativeTime: { minutesUntilBedtimeTarget: null },
        }),
      }),
    ).toBe(false);
  });

  it("fallback fires for irregular owners near local bedtime even when projected minutes are non-null but outside the lead window (execution-verified actual behavior; the JSDoc claims null-only)", () => {
    const evening = new Date("2026-08-26T00:30:00Z"); // 20:30 EDT; 23:00 EDT fallback = 2.5h away
    for (const minutes of [181, -5, Number.NaN]) {
      expect(
        shouldRunNightCheckinFromSleepCycle({
          state: state({
            circadianState: "awake",
            regularity: { regularityClass: "irregular" },
            timezone: "America/New_York",
            relativeTime: { minutesUntilBedtimeTarget: minutes },
          }),
          now: evening,
          nightFallbackBedtimeLocal: "23:00",
        }),
      ).toBe(true);
    }
  });

  it("requires a state object at all", () => {
    expect(shouldRunNightCheckinFromSleepCycle({ state: null })).toBe(false);
  });
});

describe("minutesUntilLocalBedtime", () => {
  it("computes minutes until today's bedtime when still upcoming", () => {
    // 12:00Z = 08:00 EDT; bedtime 09:00 EDT = 13:00Z — 60 minutes.
    expect(
      minutesUntilLocalBedtime({
        now: new Date("2026-08-25T12:00:00Z"),
        timezone: "America/New_York",
        localBedtime: "09:00",
      }),
    ).toBe(60);
  });

  it("rolls to tomorrow when bedtime already passed today", () => {
    // 14:00Z = 10:00 EDT; bedtime 09:00 EDT passed 1h ago → tomorrow 09:00 = 23h.
    expect(
      minutesUntilLocalBedtime({
        now: new Date("2026-08-25T14:00:00Z"),
        timezone: "America/New_York",
        localBedtime: "09:00",
      }),
    ).toBe(23 * 60);
  });

  it("returns null on malformed or out-of-range HH:MM", () => {
    for (const bad of [
      "24:00",
      "12:60",
      "abc",
      "9",
      "",
      "  ",
      null,
      undefined,
    ]) {
      expect(
        minutesUntilLocalBedtime({
          now: NOW,
          timezone: "America/New_York",
          localBedtime: bad as string,
        }),
      ).toBeNull();
    }
  });

  it("accepts boundary values 00:00 and 23:59, trims whitespace, and rounds fractional minutes to nearest", () => {
    // 08:00 EDT == 12:00Z exactly → 0 minutes (also proves whitespace trim).
    expect(
      minutesUntilLocalBedtime({
        now: new Date("2026-08-25T12:00:00Z"),
        timezone: "America/New_York",
        localBedtime: " 08:00 ",
      }),
    ).toBe(0);
    // 00:00 is a valid bedtime: 08:00 EDT now → midnight next EDT = 16h.
    expect(
      minutesUntilLocalBedtime({
        now: new Date("2026-08-25T12:00:00Z"),
        timezone: "America/New_York",
        localBedtime: "00:00",
      }),
    ).toBe(16 * 60);
    // 23:59 EDT from 12:00Z (08:00 EDT) = 15h59m later exactly.
    expect(
      minutesUntilLocalBedtime({
        now: new Date("2026-08-25T12:00:00Z"),
        timezone: "America/New_York",
        localBedtime: "23:59",
      }),
    ).toBe(15 * 60 + 59);
    // Fractional-minute difference rounds to nearest: 30s → 1 (Math.round, not floor).
    expect(
      minutesUntilLocalBedtime({
        now: new Date("2026-08-25T12:00:30Z"),
        timezone: "America/New_York",
        localBedtime: "08:01",
      }),
    ).toBe(1);
    expect(
      minutesUntilLocalBedtime({
        now: new Date("2026-08-25T12:00:31Z"),
        timezone: "America/New_York",
        localBedtime: "08:01",
      }),
    ).toBe(0);
  });

  it("handles a timezone east of UTC across day boundaries", () => {
    // 18:00Z Aug 25 = 03:00 Aug 26 Tokyo; bedtime 09:00 Tokyo = 00:00Z Aug 26 → 360 min.
    expect(
      minutesUntilLocalBedtime({
        now: new Date("2026-08-25T18:00:00Z"),
        timezone: "Asia/Tokyo",
        localBedtime: "09:00",
      }),
    ).toBe(360);
  });
});

describe("buildSleepRecapFromSchedule", () => {
  it("returns null when schedule is null", () => {
    expect(buildSleepRecapFromSchedule(null)).toBeNull();
  });

  it("projects baseline fields with null-safe defaults when baseline is null", () => {
    expect(
      buildSleepRecapFromSchedule({
        baseline: null,
        regularity: {
          sri: 0,
          regularityClass: "insufficient_data",
          bedtimeStddevMin: 0,
          wakeStddevMin: 0,
          midSleepStddevMin: 0,
          sampleCount: 0,
          windowDays: 14,
        },
      }),
    ).toEqual({
      medianBedtimeLocalHour: null,
      medianSleepDurationMin: null,
      sri: 0,
      regularityClass: "insufficient_data",
    });
  });

  it("projects a full baseline record verbatim", () => {
    expect(
      buildSleepRecapFromSchedule({
        baseline: {
          medianBedtimeLocalHour: 23,
          medianWakeLocalHour: 7,
          medianSleepDurationMin: 450,
          bedtimeStddevMin: 30,
          wakeStddevMin: 25,
          sampleCount: 12,
          windowDays: 14,
        },
        regularity: {
          sri: 72,
          regularityClass: "regular",
          bedtimeStddevMin: 30,
          wakeStddevMin: 25,
          midSleepStddevMin: 20,
          sampleCount: 12,
          windowDays: 14,
        },
      }),
    ).toEqual({
      medianBedtimeLocalHour: 23,
      medianSleepDurationMin: 450,
      sri: 72,
      regularityClass: "regular",
    });
  });
});

describe("constants", () => {
  it("pins the documented lead/window constants", () => {
    expect(NIGHT_CHECKIN_LEAD_MINUTES).toBe(180);
    expect(MORNING_CHECKIN_WINDOW_MINUTES).toBe(360);
  });
});
