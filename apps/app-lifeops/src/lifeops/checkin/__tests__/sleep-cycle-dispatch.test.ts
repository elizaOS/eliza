import { describe, expect, it } from "vitest";
import {
  buildSleepRecapFromSchedule,
  DEFAULT_IRREGULAR_BEDTIME_LOCAL,
  minutesUntilLocalBedtime,
  NIGHT_CHECKIN_LEAD_MINUTES,
  shouldRunMorningCheckinFromSleepCycle,
  shouldRunNightCheckinFromSleepCycle,
} from "../sleep-cycle-dispatch.js";

describe("sleep-cycle check-in dispatch", () => {
  it("runs the morning check-in after confirmed awake state within the wake window", () => {
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        now: new Date("2026-04-22T15:30:00.000Z"),
        state: {
          circadianState: "awake",
          wakeAt: "2026-04-22T14:00:00.000Z",
          relativeTime: { minutesUntilBedtimeTarget: 720 },
        },
      }),
    ).toBe(true);
  });

  it("does not run the morning check-in while still waking or long after wake", () => {
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        now: new Date("2026-04-22T15:30:00.000Z"),
        state: {
          circadianState: "waking",
          wakeAt: "2026-04-22T14:00:00.000Z",
          relativeTime: { minutesUntilBedtimeTarget: 720 },
        },
      }),
    ).toBe(false);
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        now: new Date("2026-04-22T23:30:00.000Z"),
        state: {
          circadianState: "awake",
          wakeAt: "2026-04-22T14:00:00.000Z",
          relativeTime: { minutesUntilBedtimeTarget: 120 },
        },
      }),
    ).toBe(false);
  });

  it("runs the night check-in inside the three-hour predicted bedtime lead", () => {
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: {
          circadianState: "awake",
          wakeAt: "2026-04-22T14:00:00.000Z",
          relativeTime: {
            minutesUntilBedtimeTarget: NIGHT_CHECKIN_LEAD_MINUTES,
          },
        },
      }),
    ).toBe(true);
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: {
          circadianState: "awake",
          wakeAt: "2026-04-22T14:00:00.000Z",
          relativeTime: {
            minutesUntilBedtimeTarget: NIGHT_CHECKIN_LEAD_MINUTES + 1,
          },
        },
      }),
    ).toBe(false);
  });

  it("runs the night check-in immediately on circadianState=winding_down even when the bedtime window is hours out", () => {
    // bedtime is 8h away (480 min) — well outside NIGHT_CHECKIN_LEAD_MINUTES
    // (180 min) — but HID-idle/desktop-lock signals already classify the user
    // as winding_down, so the night summary should fire on the early signal.
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: {
          circadianState: "winding_down",
          wakeAt: "2026-04-22T14:00:00.000Z",
          relativeTime: {
            minutesUntilBedtimeTarget: 480,
          },
        },
      }),
    ).toBe(true);
  });

  it("runs the night check-in on winding_down even when no bedtime target is known (irregular owner)", () => {
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: {
          circadianState: "winding_down",
          wakeAt: null,
          relativeTime: {
            minutesUntilBedtimeTarget: null,
          },
        },
      }),
    ).toBe(true);
  });

  describe("irregular-schedule bedtime fallback", () => {
    it("fires the night check-in inside the lead window using nightCheckinTime when bedtime projection is null", () => {
      // 2026-04-22T19:30 America/Los_Angeles = 2026-04-23T02:30Z.
      // The owner's nightCheckinTime is 22:00 local, so the next bedtime is
      // 2.5h away — inside the 3h lead window.
      expect(
        shouldRunNightCheckinFromSleepCycle({
          now: new Date("2026-04-23T02:30:00.000Z"),
          nightFallbackBedtimeLocal: "22:00",
          state: {
            circadianState: "awake",
            wakeAt: "2026-04-22T15:00:00.000Z",
            timezone: "America/Los_Angeles",
            regularity: { regularityClass: "irregular" },
            relativeTime: { minutesUntilBedtimeTarget: null },
          },
        }),
      ).toBe(true);
    });

    it("falls back to the 23:00 default bedtime when nightCheckinTime is unset", () => {
      // 2026-04-22T20:30 America/Los_Angeles = 2026-04-23T03:30Z.
      // Default bedtime 23:00 local is 2.5h away.
      expect(
        shouldRunNightCheckinFromSleepCycle({
          now: new Date("2026-04-23T03:30:00.000Z"),
          nightFallbackBedtimeLocal: null,
          state: {
            circadianState: "awake",
            wakeAt: "2026-04-22T15:00:00.000Z",
            timezone: "America/Los_Angeles",
            regularity: { regularityClass: "very_irregular" },
            relativeTime: { minutesUntilBedtimeTarget: null },
          },
        }),
      ).toBe(true);
    });

    it("does not fire the fallback for a regular-schedule owner missing a bedtime projection", () => {
      // Regular-schedule owner with no bedtime projection: do NOT use the
      // fallback. The relative-time resolver is the source of truth for them
      // and a missing projection should be diagnosed elsewhere.
      expect(
        shouldRunNightCheckinFromSleepCycle({
          now: new Date("2026-04-23T03:30:00.000Z"),
          nightFallbackBedtimeLocal: "22:00",
          state: {
            circadianState: "awake",
            wakeAt: "2026-04-22T15:00:00.000Z",
            timezone: "America/Los_Angeles",
            regularity: { regularityClass: "regular" },
            relativeTime: { minutesUntilBedtimeTarget: null },
          },
        }),
      ).toBe(false);
    });

    it("does not fire the fallback when irregular owner is hours outside the lead window", () => {
      // 2026-04-22T15:00 America/Los_Angeles = 2026-04-22T22:00Z.
      // Default bedtime 23:00 local is 8h away — outside the 3h lead.
      expect(
        shouldRunNightCheckinFromSleepCycle({
          now: new Date("2026-04-22T22:00:00.000Z"),
          state: {
            circadianState: "awake",
            wakeAt: "2026-04-22T15:00:00.000Z",
            timezone: "America/Los_Angeles",
            regularity: { regularityClass: "irregular" },
            relativeTime: { minutesUntilBedtimeTarget: null },
          },
        }),
      ).toBe(false);
    });
  });

  describe("minutesUntilLocalBedtime helper", () => {
    it("returns minutes to today's bedtime when still upcoming", () => {
      // 19:00 PT, bedtime 22:00 PT → 180 min.
      expect(
        minutesUntilLocalBedtime({
          now: new Date("2026-04-23T02:00:00.000Z"),
          timezone: "America/Los_Angeles",
          localBedtime: "22:00",
        }),
      ).toBe(180);
    });

    it("rolls to tomorrow when today's bedtime has already passed", () => {
      // 23:30 PT, bedtime 22:00 PT → 22:00 the next local day.
      // 23:30 PT today → 22:00 PT tomorrow is +22h30m = 1350 min.
      expect(
        minutesUntilLocalBedtime({
          now: new Date("2026-04-23T06:30:00.000Z"),
          timezone: "America/Los_Angeles",
          localBedtime: "22:00",
        }),
      ).toBe(22 * 60 + 30);
    });

    it("returns null on malformed HH:MM input", () => {
      expect(
        minutesUntilLocalBedtime({
          now: new Date("2026-04-23T02:00:00.000Z"),
          timezone: "America/Los_Angeles",
          localBedtime: "not-a-time",
        }),
      ).toBeNull();
    });

    it("exposes a sensible default bedtime constant", () => {
      expect(DEFAULT_IRREGULAR_BEDTIME_LOCAL).toBe("23:00");
    });
  });

  describe("buildSleepRecapFromSchedule", () => {
    it("returns null when the schedule itself is null", () => {
      expect(buildSleepRecapFromSchedule(null)).toBeNull();
    });

    it("projects baseline + regularity into a SleepRecap", () => {
      const recap = buildSleepRecapFromSchedule({
        baseline: {
          medianBedtimeLocalHour: 23.5,
          medianSleepDurationMin: 420,
          medianWakeLocalHour: 6.5,
          bedtimeStddevMin: 30,
          wakeStddevMin: 25,
          sampleCount: 14,
          windowDays: 28,
        },
        regularity: {
          sri: 82,
          bedtimeStddevMin: 30,
          wakeStddevMin: 25,
          midSleepStddevMin: 27,
          regularityClass: "regular",
          sampleCount: 14,
          windowDays: 28,
        },
      });
      expect(recap).toEqual({
        medianBedtimeLocalHour: 23.5,
        medianSleepDurationMin: 420,
        sri: 82,
        regularityClass: "regular",
      });
    });

    it("returns nulls for the baseline-derived fields when baseline is null but still surfaces regularity", () => {
      const recap = buildSleepRecapFromSchedule({
        baseline: null,
        regularity: {
          sri: 0,
          bedtimeStddevMin: 0,
          wakeStddevMin: 0,
          midSleepStddevMin: 0,
          regularityClass: "insufficient_data",
          sampleCount: 0,
          windowDays: 28,
        },
      });
      expect(recap).toEqual({
        medianBedtimeLocalHour: null,
        medianSleepDurationMin: null,
        sri: 0,
        regularityClass: "insufficient_data",
      });
    });
  });
});
