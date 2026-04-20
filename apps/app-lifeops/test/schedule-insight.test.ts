import { describe, expect, it } from "vitest";
import type { LifeOpsActivitySignal } from "@elizaos/shared/contracts/lifeops";
import { inferLifeOpsScheduleInsight } from "../src/lifeops/schedule-insight.js";

describe("lifeops schedule insight inference", () => {
  it("detects a completed overnight sleep interval from activity gaps", () => {
    const timezone = "UTC";
    const nowMs = Date.parse("2026-04-19T13:00:00.000Z");
    const insight = inferLifeOpsScheduleInsight({
      nowMs,
      timezone,
      windows: [
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
        {
          startMs: Date.parse("2026-04-19T09:40:00.000Z"),
          endMs: Date.parse("2026-04-19T12:15:00.000Z"),
          source: "website",
        },
      ],
      signals: [
        {
          id: "signal-1",
          agentId: "agent-1",
          source: "mobile_device",
          platform: "mobile_app",
          state: "locked",
          observedAt: "2026-04-18T23:35:00.000Z",
          idleState: "locked",
          idleTimeSeconds: 0,
          onBattery: false,
          health: null,
          metadata: {},
          createdAt: "2026-04-18T23:35:00.000Z",
        } satisfies LifeOpsActivitySignal,
      ],
    });

    expect(insight.sleepStatus).toBe("slept");
    expect(insight.isProbablySleeping).toBe(false);
    expect(insight.lastSleepDurationMinutes).toBeGreaterThanOrEqual(450);
    expect(insight.wakeAt).toBe("2026-04-19T07:30:00.000Z");
    expect(insight.nextMealLabel).toBe("lunch");
  });

  it("prefers HealthKit current sleep when it is available", () => {
    const timezone = "UTC";
    const nowMs = Date.parse("2026-04-19T05:00:00.000Z");
    const insight = inferLifeOpsScheduleInsight({
      nowMs,
      timezone,
      windows: [
        {
          startMs: Date.parse("2026-04-18T18:00:00.000Z"),
          endMs: Date.parse("2026-04-18T23:00:00.000Z"),
          source: "app",
        },
      ],
      signals: [
        {
          id: "health-1",
          agentId: "agent-1",
          source: "mobile_health",
          platform: "mobile_app",
          state: "sleeping",
          observedAt: "2026-04-19T04:30:00.000Z",
          idleState: "locked",
          idleTimeSeconds: null,
          onBattery: false,
          health: {
            source: "healthkit",
            permissions: { sleep: true, biometrics: false },
            sleep: {
              available: true,
              isSleeping: true,
              asleepAt: "2026-04-19T02:15:00.000Z",
              awakeAt: null,
              durationMinutes: 135,
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
          createdAt: "2026-04-19T04:30:00.000Z",
        } satisfies LifeOpsActivitySignal,
      ],
    });

    expect(insight.sleepStatus).toBe("sleeping_now");
    expect(insight.isProbablySleeping).toBe(true);
    expect(insight.currentSleepStartedAt).toBe("2026-04-19T02:15:00.000Z");
    expect(insight.sleepConfidence).toBeGreaterThanOrEqual(0.9);
    expect(insight.phase).toBe("sleeping");
  });
});
