import { describe, expect, it } from "vitest";
import {
  buildSleepRecapFromSchedule,
  minutesUntilLocalBedtime,
  shouldRunMorningCheckinFromSleepCycle,
  shouldRunNightCheckinFromSleepCycle,
} from "./sleep-cycle-dispatch.js";

describe("minutesUntilLocalBedtime", () => {
  const now = new Date("2026-08-25T10:00:00Z");

  it("returns minutes until today's bedtime when it is still upcoming", () => {
    expect(
      minutesUntilLocalBedtime({ now, timezone: "UTC", localBedtime: "12:30" }),
    ).toBe(150);
  });

  it("rolls to tomorrow when today's bedtime has already passed", () => {
    expect(
      minutesUntilLocalBedtime({ now, timezone: "UTC", localBedtime: "09:00" }),
    ).toBe(23 * 60);
  });

  it("is timezone-aware (Tokyo is UTC+9, 10:00Z is 19:00 local)", () => {
    expect(
      minutesUntilLocalBedtime({
        now,
        timezone: "Asia/Tokyo",
        localBedtime: "20:00",
      }),
    ).toBe(60);
  });

  it("accepts a single-digit hour with a two-digit minute", () => {
    // 10:05 UTC is 5 minutes after the 10:00Z anchor.
    expect(
      minutesUntilLocalBedtime({ now, timezone: "UTC", localBedtime: "10:05" }),
    ).toBe(5);
    // A one-digit hour still parses; a one-digit minute does not (HH:MM spec).
    expect(
      minutesUntilLocalBedtime({ now, timezone: "UTC", localBedtime: "10:5" }),
    ).toBeNull();
  });
});

describe("minutesUntilLocalBedtime rejects malformed input", () => {
  const now = new Date("2026-08-25T10:00:00Z");

  it("rejects out-of-range HH:MM values", () => {
    expect(
      minutesUntilLocalBedtime({ now, timezone: "UTC", localBedtime: "24:00" }),
    ).toBeNull();
    expect(
      minutesUntilLocalBedtime({ now, timezone: "UTC", localBedtime: "23:60" }),
    ).toBeNull();
    expect(
      minutesUntilLocalBedtime({ now, timezone: "UTC", localBedtime: "-1:00" }),
    ).toBeNull();
  });

  it("rejects non-time strings and empty values", () => {
    expect(
      minutesUntilLocalBedtime({
        now,
        timezone: "UTC",
        localBedtime: "not-a-time",
      }),
    ).toBeNull();
    expect(
      minutesUntilLocalBedtime({ now, timezone: "UTC", localBedtime: "" }),
    ).toBeNull();
    expect(
      minutesUntilLocalBedtime({
        now,
        timezone: "UTC",
        localBedtime: null,
      }),
    ).toBeNull();
  });

  it("returns null instead of throwing on an invalid IANA timezone", () => {
    // A corrupt owner timezone must not crash the scheduler tick: the
    // function's contract is "null when inputs are invalid".
    expect(() =>
      minutesUntilLocalBedtime({
        now,
        timezone: "Invalid/Zone",
        localBedtime: "23:00",
      }),
    ).not.toThrow();
    expect(
      minutesUntilLocalBedtime({
        now,
        timezone: "Invalid/Zone",
        localBedtime: "23:00",
      }),
    ).toBeNull();
  });
});

describe("shouldRunMorningCheckinFromSleepCycle", () => {
  const state = (overrides: Record<string, unknown>) => ({
    circadianState: "awake",
    wakeAt: null,
    relativeTime: { minutesUntilBedtimeTarget: null },
    ...overrides,
  });

  it("fires inside the 6-hour post-wake window, both ends inclusive", () => {
    const wakeAt = new Date("2026-08-25T06:00:00Z").toISOString();
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: state({ wakeAt }) as never,
        now: new Date("2026-08-25T06:00:00Z"),
      }),
    ).toBe(true);
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: state({ wakeAt }) as never,
        now: new Date("2026-08-25T12:00:00Z"),
      }),
    ).toBe(true);
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: state({ wakeAt }) as never,
        now: new Date("2026-08-25T12:00:01Z"),
      }),
    ).toBe(false);
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: state({ wakeAt }) as never,
        now: new Date("2026-08-25T05:59:59Z"),
      }),
    ).toBe(false);
  });

  it("never fires when the state is null, not awake, or wakeAt is invalid", () => {
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: null,
        now: new Date(),
      }),
    ).toBe(false);
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: state({ circadianState: "sleeping" }) as never,
        now: new Date(),
      }),
    ).toBe(false);
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: state({ wakeAt: null }) as never,
        now: new Date(),
      }),
    ).toBe(false);
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        state: state({ wakeAt: "not-a-date" }) as never,
        now: new Date(),
      }),
    ).toBe(false);
  });
});

describe("shouldRunNightCheckinFromSleepCycle", () => {
  const state = (overrides: Record<string, unknown>) => ({
    circadianState: "awake",
    wakeAt: null,
    relativeTime: { minutesUntilBedtimeTarget: null },
    ...overrides,
  });

  it("immediately triggers on winding_down", () => {
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: state({ circadianState: "winding_down" }) as never,
      }),
    ).toBe(true);
  });

  it("triggers when the bedtime target is inside the 3-hour lead window", () => {
    const inside = state({ relativeTime: { minutesUntilBedtimeTarget: 180 } });
    expect(
      shouldRunNightCheckinFromSleepCycle({ state: inside as never }),
    ).toBe(true);
    const boundary = state({ relativeTime: { minutesUntilBedtimeTarget: 0 } });
    expect(
      shouldRunNightCheckinFromSleepCycle({ state: boundary as never }),
    ).toBe(true);
    const outside = state({ relativeTime: { minutesUntilBedtimeTarget: 181 } });
    expect(
      shouldRunNightCheckinFromSleepCycle({ state: outside as never }),
    ).toBe(false);
    const past = state({ relativeTime: { minutesUntilBedtimeTarget: -1 } });
    expect(shouldRunNightCheckinFromSleepCycle({ state: past as never })).toBe(
      false,
    );
  });

  it("ignores non-finite relative minutes", () => {
    const nanState = state({
      relativeTime: { minutesUntilBedtimeTarget: Number.NaN },
    });
    expect(
      shouldRunNightCheckinFromSleepCycle({ state: nanState as never }),
    ).toBe(false);
  });

  it("uses the irregular-owner bedtime fallback only inside the lead window", () => {
    const now = new Date("2026-08-25T10:00:00Z");
    // 23:00 is 13h away -> outside the 3h lead -> no night check-in
    const far = state({
      timezone: "UTC",
      regularity: { regularityClass: "irregular" },
    });
    expect(
      shouldRunNightCheckinFromSleepCycle({ state: far as never, now }),
    ).toBe(false);
    // 12:00 is 2h away -> inside the lead -> fires
    const close = state({
      timezone: "UTC",
      regularity: { regularityClass: "very_irregular" },
    });
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: close as never,
        now,
        nightFallbackBedtimeLocal: "12:00",
      }),
    ).toBe(true);
  });

  it("never uses the bedtime fallback for regular owners", () => {
    const now = new Date("2026-08-25T10:00:00Z");
    const regular = state({
      timezone: "UTC",
      regularity: { regularityClass: "regular" },
    });
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: regular as never,
        now,
        nightFallbackBedtimeLocal: "12:00",
      }),
    ).toBe(false);
  });

  it("does not throw on an invalid owner timezone (fallback treated as unavailable)", () => {
    const now = new Date("2026-08-25T10:00:00Z");
    const bad = state({
      timezone: "Invalid/Zone",
      regularity: { regularityClass: "irregular" },
    });
    expect(() =>
      shouldRunNightCheckinFromSleepCycle({
        state: bad as never,
        now,
        nightFallbackBedtimeLocal: "12:00",
      }),
    ).not.toThrow();
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: bad as never,
        now,
        nightFallbackBedtimeLocal: "12:00",
      }),
    ).toBe(false);
  });

  it("requires timezone and now for the fallback path", () => {
    const noTz = state({ regularity: { regularityClass: "irregular" } });
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: noTz as never,
        now: new Date(),
      }),
    ).toBe(false);
    const noNow = state({
      timezone: "UTC",
      regularity: { regularityClass: "irregular" },
    });
    expect(shouldRunNightCheckinFromSleepCycle({ state: noNow as never })).toBe(
      false,
    );
  });
});

describe("buildSleepRecapFromSchedule", () => {
  it("returns null for an empty schedule", () => {
    expect(buildSleepRecapFromSchedule(null)).toBeNull();
  });

  it("projects baseline and regularity fields", () => {
    const recap = buildSleepRecapFromSchedule({
      baseline: { medianBedtimeLocalHour: 23.5, medianSleepDurationMin: 420 },
      regularity: { sri: 42, regularityClass: "moderate" },
    });
    expect(recap).toEqual({
      medianBedtimeLocalHour: 23.5,
      medianSleepDurationMin: 420,
      sri: 42,
      regularityClass: "moderate",
    });
  });

  it("keeps null baseline fields when the baseline is missing", () => {
    const recap = buildSleepRecapFromSchedule({
      baseline: null,
      regularity: { sri: 0, regularityClass: "insufficient_data" },
    });
    expect(recap).toEqual({
      medianBedtimeLocalHour: null,
      medianSleepDurationMin: null,
      sri: 0,
      regularityClass: "insufficient_data",
    });
  });
});
