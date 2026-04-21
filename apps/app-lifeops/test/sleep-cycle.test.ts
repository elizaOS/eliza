import { describe, expect, it } from "vitest";
import type { LifeOpsActivitySignal } from "@elizaos/shared/contracts/lifeops";
import {
  resolveLifeOpsDayBoundary,
  resolveLifeOpsSleepCycle,
  type LifeOpsActivityWindow,
} from "../src/lifeops/sleep-cycle.js";

function activitySignal(overrides: Partial<LifeOpsActivitySignal>): LifeOpsActivitySignal {
  return {
    id: "signal-1",
    agentId: "agent-1",
    source: "mobile_device",
    platform: "mobile_app",
    state: "locked",
    observedAt: "2026-04-19T12:05:00.000Z",
    idleState: "locked",
    idleTimeSeconds: 0,
    onBattery: false,
    health: null,
    metadata: {},
    createdAt: "2026-04-19T12:05:00.000Z",
    ...overrides,
  };
}

describe("lifeops sleep cycle resolver", () => {
  it("normalizes HealthKit intervals using duration when awakeAt is missing", () => {
    const resolution = resolveLifeOpsSleepCycle({
      nowMs: Date.parse("2026-04-19T12:00:00.000Z"),
      timezone: "UTC",
      windows: [],
      signals: [
        activitySignal({
          id: "health-1",
          source: "mobile_health",
          observedAt: "2026-04-19T08:45:00.000Z",
          state: "sleeping",
          health: {
            source: "healthkit",
            permissions: { sleep: true, biometrics: false },
            sleep: {
              available: true,
              isSleeping: false,
              asleepAt: "2026-04-19T01:15:00.000Z",
              awakeAt: null,
              durationMinutes: 450,
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
        }),
      ],
    });

    expect(resolution.sleepCycle.cycleType).toBe("overnight");
    expect(resolution.sleepCycle.sleepStatus).toBe("slept");
    expect(resolution.sleepCycle.lastSleepDurationMinutes).toBe(450);
    expect(resolution.sleepCycle.evidence[0]?.endAt).toBe(
      "2026-04-19T08:45:00.000Z",
    );
  });

  it("falls back to activity gaps when no health interval exists", () => {
    const windows: LifeOpsActivityWindow[] = [
      {
        startMs: Date.parse("2026-04-18T18:00:00.000Z"),
        endMs: Date.parse("2026-04-18T23:30:00.000Z"),
        source: "app",
      },
      {
        startMs: Date.parse("2026-04-19T07:30:00.000Z"),
        endMs: Date.parse("2026-04-19T09:00:00.000Z"),
        source: "app",
      },
    ];
    const resolution = resolveLifeOpsSleepCycle({
      nowMs: Date.parse("2026-04-19T10:00:00.000Z"),
      timezone: "UTC",
      windows,
      signals: [activitySignal({ observedAt: "2026-04-18T23:35:00.000Z" })],
    });

    expect(resolution.sleepCycle.isProbablySleeping).toBe(false);
    expect(resolution.sleepCycle.sleepStatus).toBe("slept");
    expect(resolution.sleepCycle.cycleType).toBe("overnight");
    expect(resolution.sleepCycle.sleepConfidence).toBeGreaterThan(0.5);
    expect(resolution.sleepCycle.evidence.some((item) => item.source === "activity_gap")).toBe(
      true,
    );
  });

  it("distinguishes nap gaps from overnight sleep and resolves day boundaries", () => {
    const windows: LifeOpsActivityWindow[] = [
      {
        startMs: Date.parse("2026-04-19T10:00:00.000Z"),
        endMs: Date.parse("2026-04-19T12:00:00.000Z"),
        source: "app",
      },
    ];
    const resolution = resolveLifeOpsSleepCycle({
      nowMs: Date.parse("2026-04-19T15:30:00.000Z"),
      timezone: "UTC",
      windows,
      signals: [
        activitySignal({
          observedAt: "2026-04-19T12:05:00.000Z",
          state: "locked",
          onBattery: false,
        }),
      ],
    });
    const boundary = resolveLifeOpsDayBoundary({
      nowMs: Date.parse("2026-04-19T15:30:00.000Z"),
      timezone: "UTC",
      sleepCycle: resolution.sleepCycle,
    });

    expect(resolution.sleepCycle.sleepStatus).toBe("sleeping_now");
    expect(resolution.sleepCycle.cycleType).toBe("nap");
    expect(boundary.anchor).toBe("start_of_day");
    expect(boundary.beforeSleepAt).toBe("2026-04-19T12:00:00.000Z");
    expect(boundary.startOfDayAt).toBe("2026-04-19T00:00:00.000Z");
    expect(boundary.endOfDayAt).toBe("2026-04-20T00:00:00.000Z");
  });
});
