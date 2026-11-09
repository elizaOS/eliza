/**
 * Regression tests for the sleep-status bands in `resolveLifeOpsSleepCycle`:
 * a completed sleep that ended 20-30 hours ago means the owner was awake
 * through the last night, so the status must be `likely_missed`, not `slept`.
 */
import type { LifeOpsActivitySignal } from "@elizaos/contracts";
import { describe, expect, it } from "vitest";
import { resolveLifeOpsSleepCycle } from "./sleep-cycle.js";

const HOUR_MS = 60 * 60 * 1000;
// Monday 2026-11-09 08:00 UTC (midnight America/Los_Angeles).
const NOW_MS = Date.parse("2026-11-09T08:00:00.000Z");
const TIMEZONE = "America/Los_Angeles";

function completedSleepSignal(wakeAgoHours: number): LifeOpsActivitySignal {
  const awakeAtMs = NOW_MS - wakeAgoHours * HOUR_MS;
  const asleepAtMs = awakeAtMs - 8 * HOUR_MS;
  return {
    id: "signal-1",
    agentId: "agent-1",
    source: "healthkit",
    platform: "ios",
    state: "idle",
    observedAt: new Date(awakeAtMs).toISOString(),
    idleState: "idle",
    idleTimeSeconds: null,
    onBattery: null,
    health: {
      source: "healthkit",
      permissions: { sleep: true, biometrics: false },
      sleep: {
        available: true,
        isSleeping: false,
        asleepAt: new Date(asleepAtMs).toISOString(),
        awakeAt: new Date(awakeAtMs).toISOString(),
        durationMinutes: 480,
        stage: null,
      },
      biometrics: {
        sampleAt: null,
        heartRateBpm: null,
        restingHeartRateBpm: null,
        heartRateVariabilityMs: null,
        respiratoryRate: null,
        bloodOxygenPercent: null,
      },
      warnings: [],
    },
    metadata: {},
    createdAt: new Date(awakeAtMs).toISOString(),
  };
}

function sleepStatus(wakeAgoHours: number | null): string {
  const { sleepCycle } = resolveLifeOpsSleepCycle({
    nowMs: NOW_MS,
    timezone: TIMEZONE,
    windows: [],
    signals: wakeAgoHours === null ? [] : [completedSleepSignal(wakeAgoHours)],
  });
  return sleepCycle.sleepStatus;
}

describe("resolveLifeOpsSleepCycle sleepStatus", () => {
  it("reports slept when the last sleep ended 15 hours ago", () => {
    expect(sleepStatus(15)).toBe("slept");
  });

  it("reports likely_missed when the last sleep ended 25 hours ago", () => {
    // The owner woke 25 hours ago and has been awake through the last
    // night, so the completed sleep is not last night's sleep.
    expect(sleepStatus(25)).toBe("likely_missed");
  });

  it("reports likely_missed when the last sleep ended 35 hours ago", () => {
    expect(sleepStatus(35)).toBe("likely_missed");
  });

  it("reports unknown with no completed sleep", () => {
    expect(sleepStatus(null)).toBe("unknown");
  });
});
