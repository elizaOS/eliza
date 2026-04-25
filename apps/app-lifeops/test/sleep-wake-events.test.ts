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
    circadianState: "awake",
    stateConfidence: 0.9,
    uncertaintyReason: null,
    relativeTime: {
      computedAt: "2026-04-20T08:00:00.000Z",
      localNowAt: "2026-04-20T08:00:00Z",
      circadianState: "awake",
      stateConfidence: 0.9,
      uncertaintyReason: null,
      awakeProbability: {
        pAwake: 0.9,
        pAsleep: 0.05,
        pUnknown: 0.05,
        contributingSources: [],
        computedAt: "2026-04-20T08:00:00.000Z",
      },
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
    baseline: {
      medianWakeLocalHour: 7.5,
      medianBedtimeLocalHour: 23.5,
      medianSleepDurationMin: 480,
      bedtimeStddevMin: 28,
      wakeStddevMin: 25,
      sampleCount: 10,
      windowDays: 28,
    },
    sleepStatus: "slept",
    sleepConfidence: 0.8,
    currentSleepStartedAt: null,
    lastSleepStartedAt: "2026-04-19T23:30:00.000Z",
    lastSleepEndedAt: "2026-04-20T07:30:00.000Z",
    lastSleepDurationMinutes: 480,
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
  it("emits wake.observed on sleeping -> waking transition", () => {
    const events = deriveSleepWakeEvents({
      previous: buildState({ circadianState: "sleeping" }),
      current: buildState({ circadianState: "waking" }),
      now: new Date("2026-04-20T08:00:00.000Z"),
    });
    expect(events.map((event) => event.kind)).toContain(
      "lifeops.wake.observed",
    );
  });

  it("emits wake.confirmed + sleep.ended on waking -> awake transition", () => {
    const events = deriveSleepWakeEvents({
      previous: buildState({ circadianState: "waking" }),
      current: buildState({ circadianState: "awake" }),
      now: new Date("2026-04-20T08:00:00.000Z"),
    });
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("lifeops.wake.confirmed");
    expect(kinds).toContain("lifeops.sleep.ended");
  });

  it("emits sleep.onset_candidate + sleep.detected on awake -> sleeping transition", () => {
    const events = deriveSleepWakeEvents({
      previous: buildState({ circadianState: "awake" }),
      current: buildState({
        circadianState: "sleeping",
        currentSleepStartedAt: "2026-04-20T23:30:00.000Z",
      }),
      now: new Date("2026-04-20T23:35:00.000Z"),
    });
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("lifeops.sleep.onset_candidate");
    expect(kinds).toContain("lifeops.sleep.detected");
  });

  it("does not re-emit on stable state (edge-triggered only)", () => {
    const state = buildState({ circadianState: "awake" });
    const events = deriveSleepWakeEvents({
      previous: state,
      current: state,
      now: new Date("2026-04-20T08:00:00.000Z"),
    });
    // No state transition -> no circadian events should fire
    expect(
      events.filter((event) => event.kind.startsWith("lifeops.sleep")),
    ).toHaveLength(0);
    expect(
      events.filter((event) => event.kind.startsWith("lifeops.wake")),
    ).toHaveLength(0);
  });

  it("emits bedtime imminent when the target is within 30 minutes (edge)", () => {
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

  it("emits regularity.changed on regularityClass transition", () => {
    const events = deriveSleepWakeEvents({
      previous: buildState({
        regularity: {
          ...buildState({}).regularity,
          regularityClass: "irregular",
        },
      }),
      current: buildState({
        regularity: { ...buildState({}).regularity, regularityClass: "regular" },
      }),
      now: new Date("2026-04-20T08:00:00.000Z"),
    });
    expect(events.map((event) => event.kind)).toContain(
      "lifeops.regularity.changed",
    );
  });
});
