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
      const definition = createLifeOpsTaskDefinition({
        agentId: String(runtime.agentId),
        domain: "user_lifeops",
        subjectType: "owner",
        subjectId: String(runtime.agentId),
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
      await repository.createDefinition(definition);
      const plan = createLifeOpsReminderPlan({
        agentId: String(runtime.agentId),
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
      await repository.createReminderPlan(plan);
      const occurrence = makeOccurrence({
        runtime,
        definitionId: definition.id,
      });
      await repository.upsertOccurrence(occurrence);
      const initialAttempt = createLifeOpsReminderAttempt({
        agentId: String(runtime.agentId),
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
      await repository.createReminderAttempt(initialAttempt);

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
      expect(reviewedAttempt?.deliveryMetadata).toMatchObject({
        [REMINDER_REVIEW_STATUS_METADATA_KEY]: "escalated",
      });
    } finally {
      await runtimeHandle.cleanup();
    }
  }, 30_000);
});
