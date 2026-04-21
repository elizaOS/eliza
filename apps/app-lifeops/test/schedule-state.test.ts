import type { LifeOpsScheduleInsight } from "@elizaos/shared/contracts/lifeops";
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
  phase: "afternoon",
  relativeTime: {
    localNowAt: "2026-04-19T13:00:00+00:00",
    phase: "afternoon",
    isProbablySleeping: false,
    wakeAnchorAt: "2026-04-19T07:17:00.000Z",
    wakeAnchorSource: "sleep_cycle",
    minutesSinceWake: 343,
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
  sleepStatus: "slept",
  isProbablySleeping: false,
  sleepConfidence: 0.81,
  currentSleepStartedAt: null,
  lastSleepStartedAt: "2026-04-18T23:12:00.000Z",
  lastSleepEndedAt: "2026-04-19T07:17:00.000Z",
  lastSleepDurationMinutes: 485,
  typicalWakeHour: 7.25,
  typicalSleepHour: 23.5,
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
    state: "active_recently",
    phase: "afternoon",
    mealLabel: null,
    confidence: 0.6,
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
          state: "probably_awake",
          windowStartAt: "2026-04-19T07:30:00.000Z",
          windowEndAt: "2026-04-19T13:00:00.000Z",
        }),
        expect.objectContaining({
          state: "meal_window_likely",
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
          state: "woke_recently",
          confidence: 0.82,
          windowStartAt: "2026-04-19T11:30:00.000Z",
          phase: "waking",
        }),
        observation({
          id: "active",
          deviceId: "macbook-1",
          deviceKind: "mac",
          state: "active_recently",
          confidence: 0.73,
          windowStartAt: "2026-04-19T12:30:00.000Z",
          phase: "afternoon",
        }),
        observation({
          id: "meal",
          deviceId: "iphone-1",
          deviceKind: "iphone",
          state: "meal_window_likely",
          confidence: 0.66,
          mealLabel: "lunch",
          windowStartAt: "2026-04-19T13:00:00.000Z",
          windowEndAt: "2026-04-19T15:00:00.000Z",
          phase: "afternoon",
        }),
      ],
    });

    expect(merged).not.toBeNull();
    expect(merged?.scope).toBe("cloud");
    expect(merged?.phase).toBe("waking");
    expect(merged?.wakeAt).toBe("2026-04-19T11:30:00.000Z");
    expect(merged?.nextMealLabel).toBe("lunch");
    expect(merged?.deviceCount).toBe(2);
    expect(merged?.contributingDeviceKinds).toEqual(["iphone", "mac"]);
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
        phase: "sleeping",
        relativeTime: {
          localNowAt: "2026-04-19T02:00:00+00:00",
          phase: "sleeping",
          isProbablySleeping: true,
          wakeAnchorAt: null,
          wakeAnchorSource: null,
          minutesSinceWake: null,
          bedtimeTargetAt: "2026-04-18T23:30:00.000Z",
          bedtimeTargetSource: "sleep_cycle",
          minutesUntilBedtimeTarget: 0,
          minutesSinceBedtimeTarget: 150,
          dayBoundaryStartAt: "2026-04-19T00:00:00.000Z",
          dayBoundaryEndAt: "2026-04-20T00:00:00.000Z",
          minutesSinceDayBoundaryStart: 120,
          minutesUntilDayBoundaryEnd: 1320,
          confidence: 0.81,
        },
        sleepStatus: "sleeping_now",
        isProbablySleeping: true,
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

    expect(merged?.phase).toBe("sleeping");
    expect(merged?.effectiveDayKey).toBe("2026-04-18");
    expect(merged?.localDate).toBe("2026-04-19");
  });
});
