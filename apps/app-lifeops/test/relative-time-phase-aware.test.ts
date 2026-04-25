import type {
  LifeOpsAwakeProbability,
  LifeOpsPersonalBaseline,
  LifeOpsScheduleRegularity,
} from "@elizaos/shared/contracts/lifeops";
import { describe, expect, it } from "vitest";
import { resolveLifeOpsRelativeTime } from "../src/lifeops/relative-time.js";

const defaultAwakeProbability: LifeOpsAwakeProbability = {
  pAwake: 0,
  pAsleep: 0,
  pUnknown: 1,
  contributingSources: [],
  computedAt: "2026-04-20T12:00:00.000Z",
};

const regularBaseline: LifeOpsPersonalBaseline = {
  medianWakeLocalHour: 7.5,
  medianBedtimeLocalHour: 23.5,
  medianSleepDurationMin: 480,
  bedtimeStddevMin: 30,
  wakeStddevMin: 25,
  sampleCount: 10,
  windowDays: 28,
};

const regularRegularity: LifeOpsScheduleRegularity = {
  sri: 80,
  bedtimeStddevMin: 30,
  wakeStddevMin: 25,
  midSleepStddevMin: 20,
  regularityClass: "regular",
  sampleCount: 10,
  windowDays: 28,
};

describe("resolveLifeOpsRelativeTime phase-aware", () => {
  it("returns a projected bedtime anchor when state is awake and regularity is regular", () => {
    const result = resolveLifeOpsRelativeTime({
      nowMs: Date.parse("2026-04-20T12:00:00.000Z"),
      timezone: "UTC",
      schedule: {
        circadianState: "awake",
        stateConfidence: 0.9,
        uncertaintyReason: null,
        awakeProbability: defaultAwakeProbability,
        regularity: regularRegularity,
        baseline: regularBaseline,
        sleepConfidence: 0.6,
        currentSleepStartedAt: null,
        lastSleepStartedAt: null,
        lastSleepEndedAt: "2026-04-20T07:30:00.000Z",
        wakeAt: "2026-04-20T07:30:00.000Z",
        firstActiveAt: "2026-04-20T07:35:00.000Z",
      },
    });
    expect(result.circadianState).toBe("awake");
    expect(result.wakeAnchorAt).not.toBeNull();
    expect(result.bedtimeTargetAt).not.toBeNull();
    expect(result.uncertaintyReason).toBeNull();
  });

  it("returns null wakeAnchor + null bedtime when state is unclear", () => {
    const result = resolveLifeOpsRelativeTime({
      nowMs: Date.parse("2026-04-20T12:00:00.000Z"),
      timezone: "UTC",
      schedule: {
        circadianState: "unclear",
        stateConfidence: 0,
        uncertaintyReason: "no_signals",
        awakeProbability: defaultAwakeProbability,
        regularity: regularRegularity,
        baseline: regularBaseline,
        sleepConfidence: 0,
        currentSleepStartedAt: null,
        lastSleepStartedAt: "2026-04-19T23:30:00.000Z",
        lastSleepEndedAt: "2026-04-20T07:30:00.000Z",
        wakeAt: "2026-04-20T07:30:00.000Z",
        firstActiveAt: "2026-04-20T07:35:00.000Z",
      },
    });
    expect(result.circadianState).toBe("unclear");
    expect(result.wakeAnchorAt).toBeNull();
    expect(result.wakeAnchorSource).toBeNull();
    expect(result.bedtimeTargetAt).toBeNull();
    expect(result.uncertaintyReason).toBe("no_signals");
  });

  it("returns null projected bedtime when regularity is irregular", () => {
    const irregular: LifeOpsScheduleRegularity = {
      ...regularRegularity,
      regularityClass: "irregular",
    };
    const result = resolveLifeOpsRelativeTime({
      nowMs: Date.parse("2026-04-20T12:00:00.000Z"),
      timezone: "UTC",
      schedule: {
        circadianState: "awake",
        stateConfidence: 0.7,
        uncertaintyReason: null,
        awakeProbability: defaultAwakeProbability,
        regularity: irregular,
        baseline: regularBaseline,
        sleepConfidence: 0,
        currentSleepStartedAt: null,
        lastSleepStartedAt: null,
        lastSleepEndedAt: null,
        wakeAt: null,
        firstActiveAt: null,
      },
    });
    expect(result.bedtimeTargetAt).toBeNull();
  });
});
