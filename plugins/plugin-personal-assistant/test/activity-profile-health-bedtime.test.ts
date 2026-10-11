import { describe, expect, it } from "vitest";
import { analyzeMessages } from "../src/activity-profile/analyzer";

const timezone = "America/New_York";
const now = new Date("2026-10-10T16:00:00Z");
const healthSleep = (asleepAt: string) => {
  const awakeAt = new Date(Date.parse(asleepAt) + 7.5 * 3600e3).toISOString();
  return {
    source: "mobile_health",
    platform: "ios",
    state: "sleeping",
    observedAt: Date.parse(awakeAt),
    idleState: null,
    idleTimeSeconds: null,
    onBattery: null,
    health: {
      source: "healthkit",
      sleep: { isSleeping: false, asleepAt, awakeAt, durationMinutes: 450 },
    },
    metadata: {},
  };
};

describe("activity profile bedtime from health sleep", () => {
  it("keeps a bedtime that crosses midnight near midnight, not noon", () => {
    // Onsets 23:30, 00:30, 23:30, 00:30 local.
    const signals = [
      "2026-10-06T03:30:00Z",
      "2026-10-07T04:30:00Z",
      "2026-10-08T03:30:00Z",
      "2026-10-09T04:30:00Z",
    ].map(healthSleep);
    const profile = analyzeMessages(
      [],
      new Map(),
      "owner",
      timezone,
      14,
      now,
      signals as never,
    );
    expect(profile.sleepHours).toEqual([23, 23, 24, 24]);
    expect(profile.typicalSleepHour).toBe(24);
  });
});
