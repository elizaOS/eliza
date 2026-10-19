import { expect, it } from "vitest";
import { resolveLifeOpsSleepCycle } from "../src/sleep/sleep-cycle.js";

// Phone health snapshots as the iOS/Android signal plugins shape them: while
// asleep `isSleeping: true` with no `awakeAt`; after the wake `isSleeping:
// false` with `awakeAt` set. Their state is never "active".
function snapshot(
  observedAt: string,
  state: "sleeping" | "idle",
  sleep: Record<string, unknown>,
) {
  return {
    id: observedAt,
    agentId: "agent",
    source: "mobile_health",
    platform: "ios",
    state,
    observedAt,
    idleState: null,
    idleTimeSeconds: null,
    onBattery: null,
    health: {
      source: "healthkit",
      permissions: { sleep: true, biometrics: false },
      sleep: { available: true, durationMinutes: null, stage: null, ...sleep },
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
    createdAt: observedAt,
  };
}

it("ends the current sleep when a later snapshot of the same sleep reports the wake", () => {
  const signals = [
    snapshot("2026-10-19T06:00:00.000Z", "sleeping", {
      isSleeping: true,
      asleepAt: "2026-10-18T23:00:00.000Z",
      awakeAt: null,
      stage: "core",
    }),
    snapshot("2026-10-19T06:40:00.000Z", "idle", {
      isSleeping: false,
      asleepAt: "2026-10-18T23:00:00.000Z",
      awakeAt: "2026-10-19T06:30:00.000Z",
      stage: "awake",
    }),
  ];

  const { sleepCycle } = resolveLifeOpsSleepCycle({
    nowMs: Date.parse("2026-10-19T07:00:00.000Z"),
    timezone: "UTC",
    windows: [],
    signals: signals as never,
  });

  expect(sleepCycle).toMatchObject({
    isProbablySleeping: false,
    currentSleepStartedAt: null,
    lastSleepEndedAt: "2026-10-19T06:30:00.000Z",
  });
});

it("keeps a current sleep that no later snapshot has ended", () => {
  const signals = [
    snapshot("2026-10-19T06:00:00.000Z", "sleeping", {
      isSleeping: true,
      asleepAt: "2026-10-18T23:00:00.000Z",
      awakeAt: null,
      stage: "core",
    }),
  ];

  const { sleepCycle } = resolveLifeOpsSleepCycle({
    nowMs: Date.parse("2026-10-19T06:10:00.000Z"),
    timezone: "UTC",
    windows: [],
    signals: signals as never,
  });

  expect(sleepCycle).toMatchObject({
    isProbablySleeping: true,
    currentSleepStartedAt: "2026-10-18T23:00:00.000Z",
  });
});
