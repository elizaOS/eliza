/**
 * Real-runtime coverage of merged schedule state: persisting a local merged state from
 * telemetry and preferring a fresh cloud merged state in overview and reminder reads.
 * DB-backed runtime.
 */
import type { AgentRuntime } from "@elizaos/core";
import { createLifeOpsSleepEpisode } from "@elizaos/plugin-health";
import { describe, expect, it } from "vitest";
import { createRealTestRuntime } from "../../../packages/app/test/helpers/real-runtime.ts";
import { resolveDefaultTimeZone } from "../src/lifeops/defaults.js";
import { resolveOwnerFactStore } from "../src/lifeops/owner/fact-store.js";
import { resolveNextRelativeScheduleInstant } from "../src/lifeops/relative-schedule-resolver.js";
import { resolveLifeOpsRelativeTime } from "../src/lifeops/relative-time.js";
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

// One observed night (23:30 -> 07:30 UTC) and a day of activity up to 22:50
// put tonight's bedtime target at 23:30 on the wake's sleep-day.
async function seedBedtimeEveningTelemetry(fixture: Fixture): Promise<void> {
  await resolveOwnerFactStore(fixture.runtime).update(
    { timezone: "UTC" },
    { source: "profile_save", recordedAt: new Date().toISOString() },
  );
  await fixture.service.recordScreenTimeEvent({
    source: "app",
    identifier: "com.test.evening",
    displayName: "Evening",
    startAt: "2026-04-18T18:00:00.000Z",
    endAt: "2026-04-18T23:30:00.000Z",
    durationSeconds: 5.5 * 60 * 60,
    metadata: {},
  });
  await fixture.service.captureActivitySignal({
    source: "mobile_device",
    platform: "mobile_app",
    state: "locked",
    observedAt: "2026-04-18T23:35:00.000Z",
    idleState: "locked",
    idleTimeSeconds: 0,
    onBattery: false,
    metadata: {},
  });
  await fixture.service.recordScreenTimeEvent({
    source: "app",
    identifier: "com.test.day",
    displayName: "Day",
    startAt: "2026-04-19T07:30:00.000Z",
    endAt: "2026-04-19T22:50:00.000Z",
    durationSeconds: (15 * 60 + 20) * 60,
    metadata: {},
  });
}

// Runs the scheduler tick 35 and then 25 minutes before that target and
// returns the `occurredAt` of every bedtime.imminent the runtime emitted.
async function collectBedtimeImminentAcrossTicks(
  fixture: Fixture,
): Promise<unknown[]> {
  const occurredAt: unknown[] = [];
  fixture.runtime.registerEvent("lifeops.bedtime.imminent", async (payload) => {
    occurredAt.push((payload as { occurredAt?: unknown }).occurredAt);
  });
  await fixture.service.processScheduledWork({
    now: "2026-04-19T22:55:00.000Z",
  });
  expect(occurredAt).toEqual([]);
  await fixture.service.processScheduledWork({
    now: "2026-04-19T23:05:00.000Z",
  });
  return occurredAt;
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

      // Drive projected bedtime selection through persisted owner state and
      // the workflow scheduler, including the hours after local midnight.
      for (const [cursor, onDays, offsetMinutes, expected] of [
        ["2026-10-09T12:00:00.000Z", [5], -120, "2026-10-10T00:00:00.000Z"],
        ["2026-10-10T00:30:00.000Z", [5], 0, "2026-10-10T02:00:00.000Z"],
        ["2026-10-10T00:30:00.000Z", undefined, 0, "2026-10-10T02:00:00.000Z"],
        ["2026-10-10T02:00:00.000Z", [5], 0, "2026-10-17T02:00:00.000Z"],
      ] as const) {
        const projected = buildCloudState(
          String(fixture.runtime.agentId),
          cursor,
          "UTC",
        );
        projected.relativeTime.bedtimeTargetAt = null;
        projected.baseline = {
          medianWakeLocalHour: 8,
          medianBedtimeLocalHour: 26,
          medianSleepDurationMin: 360,
          bedtimeStddevMin: 15,
          wakeStddevMin: 15,
          sampleCount: 10,
          windowDays: 28,
        };
        await fixture.service.repository.upsertScheduleMergedState(projected);
        const workflow = await fixture.service.createWorkflow({
          title: "Projected bedtime schedule",
          triggerType: "schedule",
          schedule: {
            kind: "relative_to_bedtime",
            timezone: "UTC",
            offsetMinutes,
            ...(onDays ? { onDays: [...onDays] } : {}),
          },
          actionPlan: {
            steps: [{ kind: "summarize", prompt: "Bedtime reminder" }],
          },
        });
        expect(
          await fixture.service.runDueWorkflows({ now: cursor, limit: 1 }),
        ).toEqual([]);
        const saved = (
          await fixture.service.repository.listWorkflows(
            String(fixture.runtime.agentId),
          )
        ).find((item) => item.id === workflow.definition.id);
        expect(saved?.metadata.lifeopsScheduler).toMatchObject({
          nextDueAt: expected,
        });
        await fixture.service.updateWorkflow(workflow.definition.id, {
          status: "paused",
        });
      }

      // A concrete after-midnight bedtime target (Friday's sleep-day, carried
      // to Saturday 02:00) is gated on the same sleep-day as the projection.
      const concrete = buildCloudState(
        String(fixture.runtime.agentId),
        "2026-10-09T12:00:00.000Z",
        "UTC",
      );
      concrete.relativeTime.bedtimeTargetAt = "2026-10-10T02:00:00.000Z";
      concrete.baseline = {
        medianWakeLocalHour: 8,
        medianBedtimeLocalHour: 26,
        medianSleepDurationMin: 360,
        bedtimeStddevMin: 15,
        wakeStddevMin: 15,
        sampleCount: 10,
        windowDays: 28,
      };
      for (const [onDays, expected] of [
        [[5], "2026-10-10T02:00:00.000Z"],
        [[6], "2026-10-11T02:00:00.000Z"],
      ] as const) {
        expect(
          resolveNextRelativeScheduleInstant({
            schedule: {
              kind: "relative_to_bedtime",
              timezone: "UTC",
              offsetMinutes: 0,
              onDays: [...onDays],
            },
            state: concrete,
            nowMs: Date.parse("2026-10-09T12:00:00.000Z"),
          }),
        ).toBe(expected);
      }
    } finally {
      await fixture.cleanup();
    }
  });
  // A 01:30 bedtime rolled across the London spring-forward (29 Mar 2026)
  // keeps 01:30 on later days instead of the gap-shifted 02:30.
  it("builds the scheduler tick sleep state in the owner time zone", async () => {
    // On a cloud host the owner zone comes from the owner fact, not the host.
    const previousDeviceKind = process.env.ELIZA_DEVICE_KIND;
    process.env.ELIZA_DEVICE_KIND = "cloud";
    const fixture = await createFixture("lifeops-tick-owner-zone-agent");
    try {
      await resolveOwnerFactStore(fixture.runtime).update(
        { timezone: "Pacific/Auckland" },
        { source: "profile_save", recordedAt: new Date().toISOString() },
      );
      await seedScheduleTelemetry(fixture.service);
      const domain = (
        fixture.service as unknown as {
          remindersDomain: {
            processSleepCycleCheckins: (args: {
              currentSchedule: { timezone: string } | null;
            }) => Promise<unknown[]>;
          };
        }
      ).remindersDomain;
      const original = domain.processSleepCycleCheckins.bind(domain);
      let tickZone: string | null = null;
      domain.processSleepCycleCheckins = async (args) => {
        tickZone = args.currentSchedule?.timezone ?? null;
        return original(args);
      };
      await fixture.service.processScheduledWork({
        now: "2026-04-19T13:00:00.000Z",
        sleepCycleCheckins: true,
      });
      expect(tickZone).toBe("Pacific/Auckland");
    } finally {
      await fixture.cleanup();
      if (previousDeviceKind === undefined)
        delete process.env.ELIZA_DEVICE_KIND;
      else process.env.ELIZA_DEVICE_KIND = previousDeviceKind;
    }
  });

  it("emits bedtime.imminent when a scheduler tick crosses into the 30-minute window", async () => {
    const fixture = await createFixture("lifeops-bedtime-imminent-agent");
    try {
      await seedBedtimeEveningTelemetry(fixture);

      expect(await collectBedtimeImminentAcrossTicks(fixture)).toEqual([
        "2026-04-19T23:30:00.000Z",
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("emits bedtime.imminent for a regular owner who is winding down", async () => {
    const fixture = await createFixture("lifeops-bedtime-imminent-regular");
    try {
      await seedBedtimeEveningTelemetry(fixture);
      // A week of 23:30 -> 07:30 nights gives a very regular baseline, so the
      // target is the projected bedtime and the evening state is winding_down.
      for (let day = 12; day <= 18; day += 1) {
        await fixture.service.repository.upsertSleepEpisode(
          createLifeOpsSleepEpisode({
            agentId: String(fixture.runtime.agentId),
            startAt: `2026-04-${day}T23:30:00.000Z`,
            endAt: `2026-04-${day + 1}T07:30:00.000Z`,
            source: "activity_gap",
            confidence: 0.9,
            cycleType: "overnight",
            sealed: true,
            evidence: [],
          }),
        );
      }

      expect(await collectBedtimeImminentAcrossTicks(fixture)).toEqual([
        "2026-04-19T23:30:00.000Z",
      ]);
      const state = await fixture.service.repository.getScheduleMergedState(
        String(fixture.runtime.agentId),
        "local",
        "UTC",
      );
      expect(state?.circadianState).toBe("winding_down");
      expect(state?.relativeTime.bedtimeTargetSource).toBe("typical_sleep");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rolls a bedtime in the spring-forward gap back onto its clock time", () => {
    const state = buildCloudState(
      "agent",
      "2026-03-30T19:00:00.000Z",
      "Europe/London",
    );
    state.circadianState = "awake";
    state.wakeAt = "2026-03-27T08:00:00.000Z";
    state.regularity = { ...state.regularity, regularityClass: "very_regular" };
    state.baseline = {
      medianWakeLocalHour: 9,
      medianBedtimeLocalHour: 25.5,
      medianSleepDurationMin: 450,
      bedtimeStddevMin: 15,
      wakeStddevMin: 15,
      sampleCount: 20,
      windowDays: 28,
    };
    const relativeTime = resolveLifeOpsRelativeTime({
      nowMs: Date.parse("2026-03-30T19:00:00.000Z"),
      timezone: "Europe/London",
      schedule: state,
    });
    expect(relativeTime.bedtimeTargetAt).toBe("2026-03-31T00:30:00.000Z");
  });
});
