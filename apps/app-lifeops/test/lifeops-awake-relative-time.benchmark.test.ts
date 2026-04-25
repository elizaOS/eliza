import type { LifeOpsActivitySignal } from "@elizaos/shared/contracts/lifeops";
import { describe, expect, it } from "vitest";
import { inferLifeOpsScheduleInsight } from "../src/lifeops/schedule-insight.js";
import type { LifeOpsActivityWindow } from "../src/lifeops/sleep-cycle.js";

type BenchmarkCase = {
  name: string;
  nowAt: string;
  windows: LifeOpsActivityWindow[];
  signals: LifeOpsActivitySignal[];
  expectedWakeAt: string;
  expectedBedtimeAt: string;
};

function mobileSignal(
  overrides: Partial<LifeOpsActivitySignal>,
): LifeOpsActivitySignal {
  return {
    id: overrides.id ?? "signal-1",
    agentId: "agent-1",
    source: "mobile_device",
    platform: "mobile_app",
    state: "locked",
    observedAt: overrides.observedAt ?? "2026-04-19T12:00:00.000Z",
    idleState: "locked",
    idleTimeSeconds: 0,
    onBattery: false,
    health: null,
    metadata: {},
    createdAt: overrides.observedAt ?? "2026-04-19T12:00:00.000Z",
    ...overrides,
  };
}

function healthSleepSignal(args: {
  id: string;
  observedAt: string;
  asleepAt: string;
  awakeAt: string | null;
  durationMinutes: number;
  isSleeping?: boolean;
}): LifeOpsActivitySignal {
  return mobileSignal({
    id: args.id,
    source: "mobile_health",
    platform: "mobile_app",
    state: args.isSleeping ? "sleeping" : "active",
    observedAt: args.observedAt,
    health: {
      source: "healthkit",
      permissions: { sleep: true, biometrics: true },
      sleep: {
        available: true,
        isSleeping: args.isSleeping === true,
        asleepAt: args.asleepAt,
        awakeAt: args.awakeAt,
        durationMinutes: args.durationMinutes,
        stage: null,
      },
      biometrics: {
        sampleAt: args.observedAt,
        heartRateBpm: 58,
        restingHeartRateBpm: 55,
        heartRateVariabilityMs: 72,
        respiratoryRate: null,
        bloodOxygenPercent: null,
      },
      warnings: [],
    },
  });
}

function minutesError(actual: string | null, expected: string): number {
  expect(actual).not.toBeNull();
  return Math.abs(Date.parse(actual as string) - Date.parse(expected)) / 60_000;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

describe("LifeOps awake-relative time benchmark", () => {
  it("keeps wake and bedtime anchors accurate across PMData-style signal mixes", () => {
    const cases: BenchmarkCase[] = [
      {
        name: "wearable sleep interval with ordinary day",
        nowAt: "2026-04-19T13:00:00.000Z",
        windows: [
          {
            startMs: Date.parse("2026-04-19T07:45:00.000Z"),
            endMs: Date.parse("2026-04-19T12:30:00.000Z"),
            source: "app",
          },
        ],
        signals: [
          healthSleepSignal({
            id: "health-ordinary",
            observedAt: "2026-04-19T07:30:00.000Z",
            asleepAt: "2026-04-18T23:10:00.000Z",
            awakeAt: "2026-04-19T07:30:00.000Z",
            durationMinutes: 500,
          }),
        ],
        expectedWakeAt: "2026-04-19T07:30:00.000Z",
        expectedBedtimeAt: "2026-04-19T23:10:00.000Z",
      },
      {
        name: "wearable sleep interval with delayed wake",
        nowAt: "2026-04-21T15:00:00.000Z",
        windows: [
          {
            startMs: Date.parse("2026-04-21T12:20:00.000Z"),
            endMs: Date.parse("2026-04-21T14:30:00.000Z"),
            source: "website",
          },
        ],
        signals: [
          healthSleepSignal({
            id: "health-delayed",
            observedAt: "2026-04-21T12:10:00.000Z",
            asleepAt: "2026-04-21T04:15:00.000Z",
            awakeAt: "2026-04-21T12:10:00.000Z",
            durationMinutes: 475,
          }),
        ],
        expectedWakeAt: "2026-04-21T12:10:00.000Z",
        expectedBedtimeAt: "2026-04-22T04:15:00.000Z",
      },
      {
        name: "desktop activity gap without wearable sleep",
        nowAt: "2026-04-23T16:00:00.000Z",
        windows: [
          {
            startMs: Date.parse("2026-04-22T21:00:00.000Z"),
            endMs: Date.parse("2026-04-23T00:45:00.000Z"),
            source: "app",
          },
          {
            startMs: Date.parse("2026-04-23T10:40:00.000Z"),
            endMs: Date.parse("2026-04-23T15:00:00.000Z"),
            source: "app",
          },
        ],
        signals: [
          mobileSignal({
            id: "locked-before-sleep",
            observedAt: "2026-04-23T00:48:00.000Z",
          }),
        ],
        expectedWakeAt: "2026-04-23T10:40:00.000Z",
        expectedBedtimeAt: "2026-04-24T00:45:00.000Z",
      },
    ];

    const wakeErrors: number[] = [];
    const bedtimeErrors: number[] = [];

    for (const item of cases) {
      const insight = inferLifeOpsScheduleInsight({
        nowMs: Date.parse(item.nowAt),
        timezone: "UTC",
        windows: item.windows,
        signals: item.signals,
      });

      wakeErrors.push(minutesError(insight.wakeAt, item.expectedWakeAt));
      bedtimeErrors.push(
        minutesError(
          insight.relativeTime.bedtimeTargetAt,
          item.expectedBedtimeAt,
        ),
      );
      expect(insight.relativeTime.computedAt, item.name).toBe(item.nowAt);
      expect(insight.relativeTime.circadianState, item.name).toBe("awake");
      expect(insight.relativeTime.minutesAwake, item.name).toBe(
        insight.relativeTime.minutesSinceWake,
      );
    }

    expect(mean(wakeErrors)).toBeLessThanOrEqual(5);
    expect(Math.max(...wakeErrors)).toBeLessThanOrEqual(15);
    expect(mean(bedtimeErrors)).toBeLessThanOrEqual(5);
    expect(Math.max(...bedtimeErrors)).toBeLessThanOrEqual(15);
  });

  it("reports probably sleeping without inventing awake duration", () => {
    const nowAt = "2026-04-20T03:30:00.000Z";
    const insight = inferLifeOpsScheduleInsight({
      nowMs: Date.parse(nowAt),
      timezone: "UTC",
      windows: [
        {
          startMs: Date.parse("2026-04-19T20:00:00.000Z"),
          endMs: Date.parse("2026-04-20T01:20:00.000Z"),
          source: "app",
        },
      ],
      signals: [
        healthSleepSignal({
          id: "health-current",
          observedAt: "2026-04-20T03:25:00.000Z",
          asleepAt: "2026-04-20T01:30:00.000Z",
          awakeAt: null,
          durationMinutes: 115,
          isSleeping: true,
        }),
      ],
    });

    expect(insight.circadianState).toBe("sleeping");
    expect(insight.relativeTime.computedAt).toBe(nowAt);
    expect(insight.relativeTime.circadianState).toBe("sleeping");
    expect(insight.relativeTime.minutesAwake).toBeNull();
    expect(insight.relativeTime.minutesSinceBedtimeTarget).toBe(120);
  });
});
