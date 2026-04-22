import { describe, expect, it } from "vitest";
import { deriveSleepWakeEvents } from "../src/lifeops/sleep-wake-events.js";
import type { LifeOpsScheduleMergedStateRecord } from "../src/lifeops/repository.js";

function buildState(
  overrides: Partial<LifeOpsScheduleMergedStateRecord>,
): LifeOpsScheduleMergedStateRecord {
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
      sri: 82,
      bedtimeStddevMin: 28,
      wakeStddevMin: 25,
      midSleepStddevMin: 19,
      regularityClass: "regular",
      sampleCount: 10,
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
    nextMealLabel: "breakfast",
    nextMealWindowStartAt: "2026-04-20T08:00:00.000Z",
    nextMealWindowEndAt: "2026-04-20T10:00:00.000Z",
    nextMealConfidence: 0.6,
    observationCount: 1,
    deviceCount: 1,
    contributingDeviceKinds: ["mac"],
    metadata: {},
    createdAt: "2026-04-20T08:00:00.000Z",
    updatedAt: "2026-04-20T08:00:00.000Z",
    ...overrides,
  };
}

describe("sleep wake events", () => {
  it("emits wake events for an awake schedule state", () => {
    const events = deriveSleepWakeEvents({
      previous: buildState({
        awakeProbability: {
          pAwake: 0.1,
          pAsleep: 0.8,
          pUnknown: 0.1,
          contributingSources: [],
          computedAt: "2026-04-20T07:20:00.000Z",
        },
      }),
      current: buildState({}),
      now: new Date("2026-04-20T08:00:00.000Z"),
    });

    expect(events.map((event) => event.kind)).toContain("lifeops.wake.detected");
    expect(events.map((event) => event.kind)).toContain("lifeops.wake.confirmed");
  });

  it("emits bedtime imminent when the target is within 30 minutes", () => {
    const events = deriveSleepWakeEvents({
      previous: buildState({
        relativeTime: {
          ...buildState({}).relativeTime,
          minutesUntilBedtimeTarget: 45,
        },
      }),
      current: buildState({
        relativeTime: {
          ...buildState({}).relativeTime,
          bedtimeTargetAt: "2026-04-20T23:30:00.000Z",
          minutesUntilBedtimeTarget: 20,
        },
      }),
      now: new Date("2026-04-20T23:10:00.000Z"),
    });

    expect(events.map((event) => event.kind)).toContain(
      "lifeops.bedtime.imminent",
    );
  });
});
