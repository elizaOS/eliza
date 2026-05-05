import type { LifeOpsScheduleInsight } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  deriveLocalScheduleObservations,
  mergeScheduleObservations,
} from "../src/lifeops/schedule-state.js";
import type { LifeOpsScheduleObservation } from "../src/lifeops/schedule-sync-contracts.js";

const BASE_INSIGHT: LifeOpsScheduleInsight = {
  effectiveDayKey: "2026-04-19",
  localDate: "2026-04-19",
  timezone: "UTC",
  inferredAt: "2026-04-19T13:00:00.000Z",
  circadianState: "awake",
  stateConfidence: 0.81,
  uncertaintyReason: null,
  relativeTime: {
    computedAt: "2026-04-19T13:00:00.000Z",
    localNowAt: "2026-04-19T13:00:00+00:00",
    circadianState: "awake",
    stateConfidence: 0.81,
    uncertaintyReason: null,
    awakeProbability: {
      pAwake: 0.78,
      pAsleep: 0.07,
      pUnknown: 0.15,
      contributingSources: [],
      computedAt: "2026-04-19T13:00:00.000Z",
    },
    wakeAnchorAt: "2026-04-19T07:17:00.000Z",
    wakeAnchorSource: "sleep_cycle",
    minutesSinceWake: 343,
    minutesAwake: 343,
    bedtimeTargetAt: "2026-04-19T23:30:00.000Z",
    bedtimeTargetSource: "typical_sleep",
    minutesUntilBedtimeTarget: 630,
    minutesSinceBedtimeTarget: null,
    dayBoundaryStartAt: "2026-04-19T00:00:00.000Z",
    dayBoundaryEndAt: "2026-04-20T00:00:00.000Z",
    minutesSinceDayBoundaryStart: 780,
    minutesUntilDayBoundaryEnd: 660,
    confidence: 0.81,
  },
  awakeProbability: {
    pAwake: 0.78,
    pAsleep: 0.07,
    pUnknown: 0.15,
    contributingSources: [],
    computedAt: "2026-04-19T13:00:00.000Z",
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
    medianWakeLocalHour: 7.25,
    medianBedtimeLocalHour: 23.5,
    medianSleepDurationMin: 480,
    bedtimeStddevMin: 28,
    wakeStddevMin: 25,
    sampleCount: 10,
    windowDays: 28,
  },
  sleepStatus: "slept",
  sleepConfidence: 0.81,
  currentSleepStartedAt: null,
  lastSleepStartedAt: "2026-04-18T23:12:00.000Z",
  lastSleepEndedAt: "2026-04-19T07:17:00.000Z",
  lastSleepDurationMinutes: 485,
  wakeAt: "2026-04-19T07:17:00.000Z",
  firstActiveAt: "2026-04-19T07:23:00.000Z",
  lastActiveAt: "2026-04-19T12:52:00.000Z",
  meals: [],
  lastMealAt: null,
  nextMealLabel: "lunch",
  nextMealWindowStartAt: "2026-04-19T13:05:00.000Z",
  nextMealWindowEndAt: "2026-04-19T14:40:00.000Z",
  nextMealConfidence: 0.62,
};

function observation(
  overrides: Partial<LifeOpsScheduleObservation>,
): LifeOpsScheduleObservation {
  return {
    id: "observation-1",
    agentId: "agent-1",
    origin: "local_inference",
    deviceId: "device-1",
    deviceKind: "mac",
    timezone: "UTC",
    observedAt: "2026-04-19T13:00:00.000Z",
    windowStartAt: "2026-04-19T12:30:00.000Z",
    windowEndAt: "2026-04-19T13:00:00.000Z",
    circadianState: "awake",
    stateConfidence: 0.6,
    uncertaintyReason: null,
    mealLabel: null,
    metadata: {},
    createdAt: "2026-04-19T13:00:00.000Z",
    updatedAt: "2026-04-19T13:00:00.000Z",
    ...overrides,
  };
}

describe("schedule-state", () => {
  it("buckets local schedule observations into coarse half-hour windows", () => {
    const observations = deriveLocalScheduleObservations({
      agentId: "agent-1",
      deviceId: "macbook-1",
      deviceKind: "mac",
      timezone: "UTC",
      observedAt: "2026-04-19T13:00:00.000Z",
      insight: BASE_INSIGHT,
    });

    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          circadianState: "awake",
          windowStartAt: "2026-04-19T07:30:00.000Z",
          windowEndAt: "2026-04-19T13:00:00.000Z",
        }),
        expect.objectContaining({
          mealLabel: "lunch",
          windowStartAt: "2026-04-19T13:00:00.000Z",
          windowEndAt: "2026-04-19T15:00:00.000Z",
        }),
      ]),
    );
  });

  it("merges coarse observations into a cross-device schedule state", () => {
    const merged = mergeScheduleObservations({
      agentId: "agent-1",
      scope: "cloud",
      timezone: "UTC",
      now: new Date("2026-04-19T13:00:00.000Z"),
      observations: [
        observation({
          id: "wake",
          deviceId: "iphone-1",
          deviceKind: "iphone",
          circadianState: "waking",
          stateConfidence: 0.82,
          windowStartAt: "2026-04-19T11:30:00.000Z",
        }),
        observation({
          id: "active",
          deviceId: "macbook-1",
          deviceKind: "mac",
          circadianState: "awake",
          stateConfidence: 0.73,
          windowStartAt: "2026-04-19T12:30:00.000Z",
        }),
        observation({
          id: "meal",
          deviceId: "iphone-1",
          deviceKind: "iphone",
          circadianState: "awake",
          stateConfidence: 0.66,
          mealLabel: "lunch",
          windowStartAt: "2026-04-19T13:00:00.000Z",
          windowEndAt: "2026-04-19T15:00:00.000Z",
        }),
      ],
    });

    expect(merged).not.toBeNull();
    expect(merged?.scope).toBe("cloud");
    // `waking` outranks `awake` when both fire in the merge.
    expect(merged?.circadianState).toBe("waking");
    expect(merged?.wakeAt).toBe("2026-04-19T11:30:00.000Z");
    expect(merged?.relativeTime.minutesSinceWake).toBe(90);
    expect(merged?.nextMealLabel).toBe("lunch");
    expect(merged?.deviceCount).toBe(2);
    expect(merged?.contributingDeviceKinds).toEqual(["iphone", "mac"]);
  });

  it("drops stale meal window observations whose window has already passed", () => {
    const merged = mergeScheduleObservations({
      agentId: "agent-1",
      scope: "local",
      timezone: "America/Los_Angeles",
      // After midnight the next day: any dinner window from last night is stale.
      now: new Date("2026-04-21T08:00:00.000Z"),
      observations: [
        observation({
          id: "active-late",
          deviceId: "macbook-1",
          deviceKind: "mac",
          circadianState: "winding_down",
          stateConfidence: 0.7,
          observedAt: "2026-04-21T07:55:00.000Z",
          windowStartAt: "2026-04-21T07:30:00.000Z",
          windowEndAt: "2026-04-21T08:00:00.000Z",
        }),
        observation({
          id: "stale-dinner",
          deviceId: "macbook-1",
          deviceKind: "mac",
          circadianState: "awake",
          stateConfidence: 0.52,
          mealLabel: "dinner",
          // Dinner window from 9:30 PM Apr 20 to 12:30 AM Apr 21 local —
          // entire window is now in the past.
          observedAt: "2026-04-21T04:30:00.000Z",
          windowStartAt: "2026-04-21T04:30:00.000Z",
          windowEndAt: "2026-04-21T07:30:00.000Z",
          metadata: {
            source: "schedule_insight",
            snapshot: {
              nextMealLabel: "dinner",
              nextMealWindowStartAt: "2026-04-21T04:30:00.000Z",
              nextMealWindowEndAt: "2026-04-21T07:30:00.000Z",
              nextMealConfidence: 0.52,
            },
          },
        }),
      ],
    });

    expect(merged).not.toBeNull();
    expect(merged?.nextMealLabel).toBeNull();
    expect(merged?.nextMealWindowStartAt).toBeNull();
    expect(merged?.nextMealWindowEndAt).toBeNull();
    expect(merged?.nextMealConfidence).toBe(0);
  });

  it("keeps a future meal window observation untouched", () => {
    const merged = mergeScheduleObservations({
      agentId: "agent-1",
      scope: "local",
      timezone: "UTC",
      now: new Date("2026-04-19T11:30:00.000Z"),
      observations: [
        observation({
          id: "upcoming-lunch",
          deviceId: "macbook-1",
          deviceKind: "mac",
          circadianState: "awake",
          stateConfidence: 0.6,
          mealLabel: "lunch",
          observedAt: "2026-04-19T11:25:00.000Z",
          windowStartAt: "2026-04-19T12:00:00.000Z",
          windowEndAt: "2026-04-19T14:00:00.000Z",
        }),
      ],
    });

    expect(merged?.nextMealLabel).toBe("lunch");
    expect(merged?.nextMealWindowStartAt).toBe("2026-04-19T12:00:00.000Z");
    expect(merged?.nextMealWindowEndAt).toBe("2026-04-19T14:00:00.000Z");
  });

  it("preserves the inferred effective day key from schedule snapshots", () => {
    const observations = deriveLocalScheduleObservations({
      agentId: "agent-1",
      deviceId: "iphone-1",
      deviceKind: "iphone",
      timezone: "UTC",
      observedAt: "2026-04-19T02:00:00.000Z",
      insight: {
        ...BASE_INSIGHT,
        effectiveDayKey: "2026-04-18",
        localDate: "2026-04-19",
        inferredAt: "2026-04-19T02:00:00.000Z",
        circadianState: "sleeping",
        stateConfidence: 0.9,
        relativeTime: {
          ...BASE_INSIGHT.relativeTime,
          computedAt: "2026-04-19T02:00:00.000Z",
          localNowAt: "2026-04-19T02:00:00+00:00",
          circadianState: "sleeping",
          stateConfidence: 0.9,
          wakeAnchorAt: null,
          wakeAnchorSource: null,
          minutesSinceWake: null,
          minutesAwake: null,
          bedtimeTargetAt: "2026-04-18T23:30:00.000Z",
          bedtimeTargetSource: "sleep_cycle",
          minutesUntilBedtimeTarget: null,
          minutesSinceBedtimeTarget: 150,
          dayBoundaryStartAt: "2026-04-19T00:00:00.000Z",
          dayBoundaryEndAt: "2026-04-20T00:00:00.000Z",
          minutesSinceDayBoundaryStart: 120,
          minutesUntilDayBoundaryEnd: 1320,
          confidence: 0.9,
        },
        sleepStatus: "sleeping_now",
        currentSleepStartedAt: "2026-04-18T23:30:00.000Z",
        lastSleepStartedAt: "2026-04-18T23:30:00.000Z",
        lastSleepEndedAt: null,
        wakeAt: null,
        firstActiveAt: null,
        lastActiveAt: "2026-04-18T23:20:00.000Z",
      },
    });

    const merged = mergeScheduleObservations({
      agentId: "agent-1",
      scope: "cloud",
      timezone: "UTC",
      now: new Date("2026-04-19T02:00:00.000Z"),
      observations,
    });

    expect(merged?.circadianState).toBe("sleeping");
    expect(merged?.effectiveDayKey).toBe("2026-04-18");
    expect(merged?.localDate).toBe("2026-04-19");
    expect(merged?.relativeTime.minutesUntilBedtimeTarget).toBeNull();
    expect(merged?.relativeTime.minutesSinceBedtimeTarget).toBe(150);
  });
});
