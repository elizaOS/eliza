import { describe, expect, it } from "vitest";
import { resolveNextRelativeScheduleInstant } from "../src/lifeops/relative-schedule-resolver.js";
import type { LifeOpsScheduleMergedStateRecord } from "../src/lifeops/repository.js";

function buildState(): LifeOpsScheduleMergedStateRecord {
  return {
    id: "state-1",
    agentId: "agent-1",
    scope: "local",
    mergedAt: "2026-04-20T08:00:00.000Z",
    effectiveDayKey: "2026-04-20",
    localDate: "2026-04-20",
    timezone: "UTC",
    inferredAt: "2026-04-20T08:00:00.000Z",
    phase: "morning",
    relativeTime: {
      computedAt: "2026-04-20T08:00:00.000Z",
      localNowAt: "2026-04-20T08:00:00Z",
      phase: "morning",
      awakeProbability: {
        pAwake: 0.9,
        pAsleep: 0.05,
        pUnknown: 0.05,
        contributingSources: [],
        computedAt: "2026-04-20T08:00:00.000Z",
      },
      isProbablySleeping: false,
      isAwake: true,
      awakeState: "awake",
      wakeAnchorAt: "2026-04-20T07:30:00.000Z",
      wakeAnchorSource: "sleep_cycle",
      minutesSinceWake: 30,
      minutesAwake: 30,
      bedtimeTargetAt: "2026-04-20T23:30:00.000Z",
      bedtimeTargetSource: "typical_sleep",
      minutesUntilBedtimeTarget: 930,
      minutesSinceBedtimeTarget: null,
      dayBoundaryStartAt: "2026-04-20T00:00:00.000Z",
      dayBoundaryEndAt: "2026-04-21T00:00:00.000Z",
      minutesSinceDayBoundaryStart: 480,
      minutesUntilDayBoundaryEnd: 960,
      confidence: 0.9,
    },
    awakeProbability: {
      pAwake: 0.9,
      pAsleep: 0.05,
      pUnknown: 0.05,
      contributingSources: [],
      computedAt: "2026-04-20T08:00:00.000Z",
    },
    regularity: {
      sri: 80,
      bedtimeStddevMin: 30,
      wakeStddevMin: 25,
      midSleepStddevMin: 22,
      regularityClass: "regular",
      sampleCount: 8,
      windowDays: 28,
    },
    sleepStatus: "slept",
    isProbablySleeping: false,
    sleepConfidence: 0.8,
    currentSleepStartedAt: null,
    lastSleepStartedAt: "2026-04-19T23:30:00.000Z",
    lastSleepEndedAt: "2026-04-20T07:30:00.000Z",
    lastSleepDurationMinutes: 480,
    typicalWakeHour: 7.5,
    typicalSleepHour: 23.5,
    wakeAt: "2026-04-20T07:30:00.000Z",
    firstActiveAt: "2026-04-20T07:35:00.000Z",
    lastActiveAt: "2026-04-20T08:00:00.000Z",
    meals: [],
    lastMealAt: null,
    nextMealLabel: null,
    nextMealWindowStartAt: null,
    nextMealWindowEndAt: null,
    nextMealConfidence: 0,
    observationCount: 1,
    deviceCount: 1,
    contributingDeviceKinds: ["mac"],
    metadata: {},
    createdAt: "2026-04-20T08:00:00.000Z",
    updatedAt: "2026-04-20T08:00:00.000Z",
  };
}

describe("relative schedule resolver", () => {
  it("uses the observed wake anchor when it is still in the future relative to the cursor", () => {
    const nextRunAt = resolveNextRelativeScheduleInstant({
      schedule: {
        kind: "relative_to_wake",
        offsetMinutes: 30,
        timezone: "UTC",
      },
      state: buildState(),
      cursorIso: "2026-04-20T07:20:00.000Z",
      nowMs: Date.parse("2026-04-20T08:00:00.000Z"),
    });

    expect(nextRunAt).toBe("2026-04-20T08:00:00.000Z");
  });

  it("returns null when regularity does not satisfy the schedule requirement", () => {
    const state = buildState();
    state.regularity = {
      ...state.regularity,
      regularityClass: "irregular",
    };
    const nextRunAt = resolveNextRelativeScheduleInstant({
      schedule: {
        kind: "relative_to_bedtime",
        offsetMinutes: -30,
        timezone: "UTC",
        requireRegularityAtLeast: "regular",
      },
      state,
      nowMs: Date.parse("2026-04-20T12:00:00.000Z"),
    });

    expect(nextRunAt).toBeNull();
  });
});
