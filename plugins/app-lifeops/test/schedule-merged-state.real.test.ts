import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createRealTestRuntime } from "../../../test/helpers/real-runtime";
import { resolveDefaultTimeZone } from "../src/lifeops/defaults.js";
import {
  LifeOpsRepository,
  type LifeOpsScheduleMergedStateRecord,
} from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";

type Fixture = {
  runtime: AgentRuntime;
  service: LifeOpsService;
  cleanup: () => Promise<void>;
};

async function createFixture(name: string): Promise<Fixture> {
  const testRuntime = await createRealTestRuntime({ characterName: name });
  await LifeOpsRepository.bootstrapSchema(testRuntime.runtime);
  return {
    runtime: testRuntime.runtime,
    service: new LifeOpsService(testRuntime.runtime),
    cleanup: testRuntime.cleanup,
  };
}

async function seedScheduleTelemetry(service: LifeOpsService): Promise<void> {
  await service.recordScreenTimeEvent({
    source: "app",
    identifier: "com.test.evening",
    displayName: "Evening",
    startAt: "2026-04-18T18:00:00.000Z",
    endAt: "2026-04-18T23:30:00.000Z",
    durationSeconds: 5.5 * 60 * 60,
    metadata: {},
  });
  await service.recordScreenTimeEvent({
    source: "app",
    identifier: "com.test.morning",
    displayName: "Morning",
    startAt: "2026-04-19T07:30:00.000Z",
    endAt: "2026-04-19T09:00:00.000Z",
    durationSeconds: 90 * 60,
    metadata: {},
  });
  await service.recordScreenTimeEvent({
    source: "website",
    identifier: "github.com",
    displayName: "GitHub",
    startAt: "2026-04-19T09:40:00.000Z",
    endAt: "2026-04-19T12:15:00.000Z",
    durationSeconds: 155 * 60,
    metadata: {},
  });
  await service.captureActivitySignal({
    source: "mobile_device",
    platform: "mobile_app",
    state: "locked",
    observedAt: "2026-04-18T23:35:00.000Z",
    idleState: "locked",
    idleTimeSeconds: 0,
    onBattery: false,
    metadata: {},
  });
}

function buildCloudState(
  agentId: string,
  nowIso: string,
  timezone: string,
): LifeOpsScheduleMergedStateRecord {
  return {
    id: `lifeops-schedule-merged:${agentId}:cloud:${timezone}`,
    agentId,
    scope: "cloud",
    mergedAt: nowIso,
    effectiveDayKey: "2026-04-19",
    localDate: "2026-04-19",
    timezone,
    inferredAt: nowIso,
    circadianState: "winding_down",
    stateConfidence: 0.91,
    uncertaintyReason: null,
    relativeTime: {
      computedAt: nowIso,
      localNowAt: "2026-04-19T17:30:00+00:00",
      phase: "winding_down",
      isProbablySleeping: false,
      isAwake: true,
      awakeState: "awake",
      wakeAnchorAt: "2026-04-19T10:30:00.000Z",
      wakeAnchorSource: "sleep_cycle",
      minutesSinceWake: 420,
      minutesAwake: 420,
      bedtimeTargetAt: "2026-04-20T00:00:00.000Z",
      bedtimeTargetSource: "typical_sleep",
      minutesUntilBedtimeTarget: 390,
      minutesSinceBedtimeTarget: null,
      dayBoundaryStartAt: "2026-04-19T00:00:00.000Z",
      dayBoundaryEndAt: "2026-04-20T00:00:00.000Z",
      minutesSinceDayBoundaryStart: 1050,
      minutesUntilDayBoundaryEnd: 390,
      confidence: 0.91,
    },
    awakeProbability: {
      computedAt: nowIso,
      awake: 0.95,
      asleep: 0.05,
      unclear: 0,
      sampleCount: 5,
      windowMinutes: 60,
    },
    regularity: {
      sampleCount: 5,
      wakeConsistency: 0.8,
      sleepConsistency: 0.8,
      typicalWakeHour: 10.5,
      typicalSleepHour: 24,
      wakeHourStdDev: 0.5,
      sleepHourStdDev: 0.5,
    },
    baseline: null,
    circadianRuleFirings: [],
    sleepStatus: "slept",
    isProbablySleeping: false,
    sleepConfidence: 0.91,
    currentSleepStartedAt: null,
    lastSleepStartedAt: "2026-04-18T23:30:00.000Z",
    lastSleepEndedAt: "2026-04-19T10:30:00.000Z",
    lastSleepDurationMinutes: 660,
    wakeAt: "2026-04-19T10:30:00.000Z",
    firstActiveAt: "2026-04-19T10:45:00.000Z",
    lastActiveAt: "2026-04-19T12:45:00.000Z",
    meals: [],
    lastMealAt: null,
    nextMealLabel: "dinner",
    nextMealWindowStartAt: "2026-04-19T18:00:00.000Z",
    nextMealWindowEndAt: "2026-04-19T20:00:00.000Z",
    nextMealConfidence: 0.87,
    observationCount: 5,
    deviceCount: 2,
    contributingDeviceKinds: ["iphone", "mac"],
    metadata: { source: "test" },
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

describe("merged schedule state", () => {
  it("persists a local merged schedule state from local telemetry", async () => {
    const fixture = await createFixture("lifeops-local-merged-state-agent");
    try {
      await seedScheduleTelemetry(fixture.service);

      const merged = await fixture.service.refreshLocalMergedScheduleState({
        timezone: "UTC",
        now: new Date("2026-04-19T13:00:00.000Z"),
      });

      expect(merged).not.toBeNull();
      expect(merged?.scope).toBe("local");
      expect(merged?.wakeAt).toBe("2026-04-19T07:30:00.000Z");
      expect(merged?.observationCount).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("prefers a fresh cloud merged schedule state in overview and reminder reads", async () => {
    const fixture = await createFixture("lifeops-cloud-merged-state-agent");
    try {
      const now = new Date();
      const nowIso = now.toISOString();
      const timezone = resolveDefaultTimeZone();
      await seedScheduleTelemetry(fixture.service);
      await fixture.service.refreshLocalMergedScheduleState({
        timezone,
        now,
      });
      await fixture.service.repository.upsertScheduleMergedState(
        buildCloudState(String(fixture.runtime.agentId), nowIso, timezone),
      );

      const overview = await fixture.service.getOverview(now);
      const snapshot =
        await fixture.service.readReminderActivityProfileSnapshot();

      expect(overview.schedule?.circadianState).toBe("winding_down");
      expect(overview.schedule?.nextMealLabel).toBe("dinner");
      expect(snapshot?.circadianState).toBe("winding_down");
      expect(snapshot?.nextMealLabel).toBe("dinner");
      expect(snapshot?.lastSleepEndedAt).toBe("2026-04-19T10:30:00.000Z");
    } finally {
      await fixture.cleanup();
    }
  });
});
