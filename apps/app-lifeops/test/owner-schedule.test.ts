import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../../test/helpers/real-runtime";
import { ownerScheduleAction } from "../src/actions/owner-schedule.js";
import {
  createLifeOpsReminderPlan,
  LifeOpsRepository,
} from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";

type ScheduleFixture = {
  runtime: AgentRuntime;
  service: LifeOpsService;
  cleanup: () => Promise<void>;
};

async function createFixture(name: string): Promise<ScheduleFixture> {
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

function ownerMessage(runtime: IAgentRuntime, text: string) {
  return {
    id: `msg-${Math.random()}`,
    entityId: runtime.agentId,
    roomId: runtime.agentId,
    content: { text },
  };
}

describe("owner schedule surfaces", () => {
  it("inspects schedule inference from local telemetry", async () => {
    const fixture = await createFixture("lifeops-schedule-inspection-agent");
    try {
      await seedScheduleTelemetry(fixture.service);

      const inspection = await fixture.service.inspectSchedule({
        timezone: "UTC",
        now: new Date("2026-04-19T13:00:00.000Z"),
      });

      expect(inspection.insight.sleepStatus).toBe("slept");
      expect(inspection.insight.wakeAt).toBe("2026-04-19T07:30:00.000Z");
      expect(inspection.insight.nextMealLabel).toBe("lunch");
      expect(inspection.sleepEpisodes.length).toBeGreaterThan(0);
      expect(inspection.counts.screenTimeSessionCount).toBe(3);
    } finally {
      await fixture.cleanup();
    }
  });

  it("derives adaptive windows from inferred wake time without a proactive profile", async () => {
    const fixture = await createFixture("lifeops-schedule-policy-agent");
    try {
      await seedScheduleTelemetry(fixture.service);

      const policy = await fixture.service.resolveAdaptiveWindowPolicy(
        "UTC",
        new Date("2026-04-19T13:00:00.000Z"),
      );

      expect(policy).not.toBeNull();
      expect(policy?.windows[0]?.name).toBe("morning");
      expect(policy?.windows[0]?.startMinute).toBe(420);
    } finally {
      await fixture.cleanup();
    }
  });

  it("blocks reminder delivery when the owner is probably sleeping", async () => {
    const fixture = await createFixture("lifeops-sleep-block-agent");
    try {
      const plan = createLifeOpsReminderPlan({
        agentId: String(fixture.runtime.agentId),
        ownerType: "definition",
        ownerId: "definition-1",
        steps: [{ channel: "in_app", offsetMinutes: 0, label: "In app" }],
        mutePolicy: {},
        quietHours: {
          timezone: "UTC",
          startMinute: 0,
          endMinute: 0,
        },
      });

      const attempt = await fixture.service.dispatchReminderAttempt({
        plan,
        ownerType: "occurrence",
        ownerId: "occ-1",
        occurrenceId: "occ-1",
        subjectType: "owner",
        title: "Take vitamins",
        channel: "in_app",
        stepIndex: 0,
        scheduledFor: "2026-04-19T06:00:00.000Z",
        dueAt: null,
        urgency: "normal",
        quietHours: plan.quietHours,
        acknowledged: false,
        attemptedAt: "2026-04-19T06:00:00.000Z",
        activityProfile: {
          primaryPlatform: "mobile_app",
          secondaryPlatform: null,
          lastSeenPlatform: "mobile_app",
          isCurrentlyActive: false,
          lastSeenAt: null,
          isProbablySleeping: true,
          sleepConfidence: 0.91,
          schedulePhase: "sleeping",
          lastSleepEndedAt: null,
          nextMealLabel: null,
          nextMealWindowStartAt: null,
          nextMealWindowEndAt: null,
        },
        nearbyReminderTitles: [],
        timezone: "UTC",
        definition: null,
      });

      expect(attempt.outcome).toBe("blocked_quiet_hours");
      expect(attempt.channel).toBe("in_app");
    } finally {
      await fixture.cleanup();
    }
  });

  it("owner schedule action returns a summary from inferred state", async () => {
    const fixture = await createFixture("lifeops-owner-schedule-agent");
    try {
      await seedScheduleTelemetry(fixture.service);

      const result = await ownerScheduleAction.handler!(
        fixture.runtime,
        ownerMessage(fixture.runtime, "did i sleep last night?") as never,
        undefined,
        { parameters: { subaction: "summary", timezone: "UTC" } } as never,
        undefined,
      );

      expect(result.success).toBe(true);
      expect(result.text.toLowerCase()).toContain("schedule phase");
      expect(result.text.toLowerCase()).toMatch(
        /(?:last inferred wake|likely asleep)/,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
