import crypto from "node:crypto";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createRealTestRuntime } from "../../../../eliza/test/helpers/real-runtime";
import type { LifeOpsOccurrence } from "../src/contracts/index.js";
import {
  createLifeOpsReminderAttempt,
  createLifeOpsReminderPlan,
  createLifeOpsTaskDefinition,
  LifeOpsRepository,
} from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import {
  REMINDER_LIFECYCLE_METADATA_KEY,
  REMINDER_REVIEW_AT_METADATA_KEY,
  REMINDER_REVIEW_STATUS_METADATA_KEY,
  REMINDER_URGENCY_METADATA_KEY,
} from "../src/lifeops/service-constants.js";

const baseAt = new Date("2026-04-29T17:00:00.000Z");

function addMinutes(date: Date, minutes: number): string {
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

function makeOccurrence(args: {
  runtime: AgentRuntime;
  definitionId: string;
}): LifeOpsOccurrence {
  return {
    id: crypto.randomUUID(),
    agentId: String(args.runtime.agentId),
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: String(args.runtime.agentId),
    visibilityScope: "owner_agent_admin",
    contextPolicy: "explicit_only",
    definitionId: args.definitionId,
    occurrenceKey: `stretch-${baseAt.toISOString()}`,
    scheduledAt: baseAt.toISOString(),
    dueAt: null,
    relevanceStartAt: baseAt.toISOString(),
    relevanceEndAt: addMinutes(baseAt, 60),
    windowName: null,
    state: "visible",
    snoozedUntil: null,
    completionPayload: null,
    derivedTarget: null,
    metadata: { [REMINDER_URGENCY_METADATA_KEY]: "high" },
    createdAt: baseAt.toISOString(),
    updatedAt: baseAt.toISOString(),
  };
}

async function seedDueStretchReview(args: {
  runtime: AgentRuntime;
  repository: LifeOpsRepository;
}) {
  const agentId = String(args.runtime.agentId);
  const definition = createLifeOpsTaskDefinition({
    agentId,
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: agentId,
    visibilityScope: "owner_agent_admin",
    contextPolicy: "explicit_only",
    kind: "habit",
    title: "Stretch",
    description: "Stretch twice daily.",
    originalIntent: "Stretch twice daily with follow-up acknowledgements.",
    timezone: "UTC",
    status: "active",
    priority: 2,
    cadence: {
      kind: "once",
      dueAt: baseAt.toISOString(),
      visibilityLeadMinutes: 0,
      visibilityLagMinutes: 120,
    },
    windowPolicy: {},
    progressionRule: {},
    websiteAccess: null,
    reminderPlanId: null,
    goalId: null,
    source: "test",
    metadata: { [REMINDER_URGENCY_METADATA_KEY]: "high" },
  });
  await args.repository.createDefinition(definition);
  const plan = createLifeOpsReminderPlan({
    agentId,
    ownerType: "definition",
    ownerId: definition.id,
    steps: [
      { channel: "in_app", offsetMinutes: 0, label: "In app" },
      { channel: "discord", offsetMinutes: 60, label: "Discord" },
    ],
    mutePolicy: {},
    quietHours: {
      timezone: "UTC",
      startMinute: 0,
      endMinute: 0,
    },
  });
  await args.repository.createReminderPlan(plan);
  const occurrence = makeOccurrence({
    runtime: args.runtime,
    definitionId: definition.id,
  });
  await args.repository.upsertOccurrence(occurrence);
  const initialAttempt = createLifeOpsReminderAttempt({
    agentId,
    planId: plan.id,
    ownerType: "occurrence",
    ownerId: occurrence.id,
    occurrenceId: occurrence.id,
    channel: "in_app",
    stepIndex: 0,
    scheduledFor: baseAt.toISOString(),
    attemptedAt: baseAt.toISOString(),
    outcome: "delivered",
    connectorRef: "system:in_app",
    deliveryMetadata: {
      title: "Stretch",
      urgency: "high",
      [REMINDER_LIFECYCLE_METADATA_KEY]: "plan",
      [REMINDER_REVIEW_AT_METADATA_KEY]: addMinutes(baseAt, 7),
    },
  });
  await args.repository.createReminderAttempt(initialAttempt);

  return {
    definition,
    initialAttempt,
    occurrence,
    plan,
  };
}

describe("reminder review jobs real scenarios", () => {
  it("runs a persisted due review callback and escalates without waiting for plan exhaustion", async () => {
    const runtimeHandle = await createRealTestRuntime({
      characterName: "lifeops-reminder-review-job-agent",
    });
    try {
      const runtime = runtimeHandle.runtime;
      await LifeOpsRepository.bootstrapSchema(runtime);
      const repository = new LifeOpsRepository(runtime);
      const service = new LifeOpsService(runtime);
      const { initialAttempt, occurrence } = await seedDueStretchReview({
        runtime,
        repository,
      });

      const existingAttempts = await repository.listReminderAttempts(
        String(runtime.agentId),
      );
      await expect(
        repository.listDueReminderReviewAttempts(
          String(runtime.agentId),
          addMinutes(baseAt, 8),
          3,
        ),
      ).resolves.toHaveLength(1);

      const attempts = await service.processDueReminderReviewJobs({
        now: new Date(addMinutes(baseAt, 8)),
        limit: 3,
        attempts: existingAttempts,
        policies: [],
        activityProfile: null,
        timezone: "UTC",
        defaultIntensity: "normal",
      });

      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        ownerId: occurrence.id,
        channel: "in_app",
        outcome: "delivered",
      });
      expect(attempts[0]?.deliveryMetadata).toMatchObject({
        [REMINDER_LIFECYCLE_METADATA_KEY]: "escalation",
        escalationReason: "review_due_without_acknowledgement",
      });
      const persistedAttempts = await repository.listReminderAttempts(
        String(runtime.agentId),
        {
          ownerType: "occurrence",
          ownerId: occurrence.id,
        },
      );
      const reviewedAttempt = persistedAttempts.find(
        (attempt) => attempt.id === initialAttempt.id,
      );
      expect(reviewedAttempt?.reviewStatus).toBe("escalated");
      expect(reviewedAttempt?.deliveryMetadata).toMatchObject({
        [REMINDER_REVIEW_STATUS_METADATA_KEY]: "escalated",
      });
    } finally {
      await runtimeHandle.cleanup();
    }
  }, 30_000);

  it("processes due review callbacks through the scheduler entrypoint before normal deliveries", async () => {
    const runtimeHandle = await createRealTestRuntime({
      characterName: "lifeops-reminder-process-e2e-agent",
    });
    try {
      const runtime = runtimeHandle.runtime;
      await LifeOpsRepository.bootstrapSchema(runtime);
      const repository = new LifeOpsRepository(runtime);
      const service = new LifeOpsService(runtime);
      const { initialAttempt, occurrence } = await seedDueStretchReview({
        runtime,
        repository,
      });

      const result = await service.processReminders({
        now: addMinutes(baseAt, 8),
        limit: 1,
      });

      expect(result.now).toBe(addMinutes(baseAt, 8));
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]).toMatchObject({
        ownerType: "occurrence",
        ownerId: occurrence.id,
        channel: "in_app",
        outcome: "delivered",
      });
      expect(result.attempts[0]?.deliveryMetadata).toMatchObject({
        [REMINDER_LIFECYCLE_METADATA_KEY]: "escalation",
        escalationReason: "review_due_without_acknowledgement",
      });
      const persistedAttempts = await repository.listReminderAttempts(
        String(runtime.agentId),
        {
          ownerType: "occurrence",
          ownerId: occurrence.id,
        },
      );
      const reviewedAttempt = persistedAttempts.find(
        (attempt) => attempt.id === initialAttempt.id,
      );
      expect(reviewedAttempt?.reviewAt).toBe(addMinutes(baseAt, 7));
      expect(reviewedAttempt?.reviewStatus).toBe("escalated");
      expect(reviewedAttempt?.deliveryMetadata).toMatchObject({
        [REMINDER_REVIEW_STATUS_METADATA_KEY]: "escalated",
      });
    } finally {
      await runtimeHandle.cleanup();
    }
  }, 30_000);

  it("keeps observed-but-open review statuses due and excludes only closed statuses", async () => {
    const runtimeHandle = await createRealTestRuntime({
      characterName: "lifeops-reminder-review-status-agent",
    });
    try {
      const runtime = runtimeHandle.runtime;
      await LifeOpsRepository.bootstrapSchema(runtime);
      const repository = new LifeOpsRepository(runtime);
      const plan = createLifeOpsReminderPlan({
        agentId: String(runtime.agentId),
        ownerType: "definition",
        ownerId: "definition-status",
        steps: [{ channel: "in_app", offsetMinutes: 0, label: "In app" }],
        mutePolicy: {},
        quietHours: {
          timezone: "UTC",
          startMinute: 0,
          endMinute: 0,
        },
      });
      await repository.createReminderPlan(plan);
      const statuses = [
        "unrelated",
        "needs_clarification",
        "no_response",
        "resolved",
        "escalated",
        "clarification_requested",
      ];
      for (const status of statuses) {
        await repository.createReminderAttempt(
          createLifeOpsReminderAttempt({
            agentId: String(runtime.agentId),
            planId: plan.id,
            ownerType: "occurrence",
            ownerId: `occurrence-${status}`,
            occurrenceId: `occurrence-${status}`,
            channel: "in_app",
            stepIndex: 0,
            scheduledFor: baseAt.toISOString(),
            attemptedAt: baseAt.toISOString(),
            outcome: "delivered",
            connectorRef: "system:in_app",
            deliveryMetadata: {
              title: status,
              [REMINDER_LIFECYCLE_METADATA_KEY]: "plan",
              [REMINDER_REVIEW_AT_METADATA_KEY]: addMinutes(baseAt, 7),
              [REMINDER_REVIEW_STATUS_METADATA_KEY]: status,
            },
          }),
        );
      }

      const due = await repository.listDueReminderReviewAttempts(
        String(runtime.agentId),
        addMinutes(baseAt, 8),
        10,
      );

      expect(due.map((attempt) => attempt.ownerId).sort()).toEqual([
        "occurrence-needs_clarification",
        "occurrence-no_response",
        "occurrence-unrelated",
      ]);
    } finally {
      await runtimeHandle.cleanup();
    }
  }, 30_000);
});
