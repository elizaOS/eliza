import type {
  LifeOpsReminderAttempt,
  LifeOpsReminderPlan,
} from "@elizaos/app-lifeops";
import { describe, expect, it, vi } from "vitest";
import { LifeOpsService } from "../src/lifeops/service.js";
import {
  REMINDER_LIFECYCLE_METADATA_KEY,
  REMINDER_REVIEW_AT_METADATA_KEY,
} from "../src/lifeops/service-constants.js";

const baseAt = new Date("2026-04-29T17:00:00.000Z");

function addMinutes(date: Date, minutes: number): string {
  return new Date(date.getTime() + minutes * 60_000).toISOString();
}

function makePlan(): LifeOpsReminderPlan {
  return {
    id: "plan-1",
    agentId: "agent-1",
    ownerType: "definition",
    ownerId: "definition-1",
    steps: [
      { channel: "in_app", offsetMinutes: 0, label: "In app" },
      { channel: "discord", offsetMinutes: 60, label: "Discord" },
    ],
    mutePolicy: {},
    quietHours: { timezone: "UTC", startMinute: 0, endMinute: 0 },
    createdAt: baseAt.toISOString(),
    updatedAt: baseAt.toISOString(),
  };
}

function makeAttempt(): LifeOpsReminderAttempt {
  return {
    id: "attempt-1",
    agentId: "agent-1",
    planId: "plan-1",
    ownerType: "occurrence",
    ownerId: "occurrence-1",
    occurrenceId: "occurrence-1",
    channel: "in_app",
    stepIndex: 0,
    scheduledFor: baseAt.toISOString(),
    attemptedAt: baseAt.toISOString(),
    outcome: "delivered",
    connectorRef: "system:in_app",
    deliveryMetadata: {
      [REMINDER_LIFECYCLE_METADATA_KEY]: "plan",
      [REMINDER_REVIEW_AT_METADATA_KEY]: addMinutes(baseAt, 7),
    },
  };
}

function createHarness(responseReview: Record<string, unknown>) {
  const service = Object.create(LifeOpsService.prototype) as LifeOpsService &
    Record<string, unknown>;
  const escalationAttempt: LifeOpsReminderAttempt = {
    ...makeAttempt(),
    id: "attempt-2",
    channel: "discord",
    stepIndex: 2,
    scheduledFor: addMinutes(baseAt, 7),
    attemptedAt: addMinutes(baseAt, 8),
    connectorRef: "discord:owner",
    deliveryMetadata: {
      [REMINDER_LIFECYCLE_METADATA_KEY]: "escalation",
    },
  };

  service.buildReminderPlanSchedule = vi.fn(() => [
    { stepIndex: 0, scheduledFor: baseAt.toISOString() },
    { stepIndex: 1, scheduledFor: addMinutes(baseAt, 60) },
  ]);
  service.reviewOwnerResponseAfterReminderAttempt = vi.fn(
    async () => responseReview,
  );
  service.resolveReminderEscalationChannels = vi.fn(async () => [
    "in_app",
    "discord",
  ]);
  service.dispatchReminderAttempt = vi.fn(async () => escalationAttempt);
  service.markReminderReviewObservedResponse = vi.fn(async () => undefined);
  service.markReminderReviewEscalated = vi.fn(async () => undefined);
  service.markReminderEscalationStarted = vi.fn(async () => undefined);
  service.recordReminderAudit = vi.fn(async () => undefined);
  service.resolveReminderReviewFromOwnerResponse = vi.fn(async () => undefined);
  return { service, escalationAttempt };
}

function dispatchArgs(
  plan: LifeOpsReminderPlan,
  attempt: LifeOpsReminderAttempt,
) {
  return {
    plan,
    ownerType: "occurrence" as const,
    ownerId: "occurrence-1",
    occurrenceId: "occurrence-1",
    subjectType: "owner" as const,
    title: "Stretch",
    dueAt: null,
    urgency: "high" as const,
    intensity: "normal" as const,
    quietHours: plan.quietHours,
    attemptedAt: addMinutes(baseAt, 8),
    now: new Date(addMinutes(baseAt, 8)),
    attempts: [attempt],
    policies: [],
    activityProfile: null,
    occurrence: {
      relevanceStartAt: baseAt.toISOString(),
      snoozedUntil: null,
      metadata: {},
      state: "visible",
    },
    nearbyReminderTitles: [],
    timezone: "UTC",
    definition: null,
  };
}

describe("reminder escalation review", () => {
  it("runs a due review before the reminder plan is exhausted", async () => {
    const plan = makePlan();
    const attempt = makeAttempt();
    const { service, escalationAttempt } = createHarness({
      decision: "no_response",
      resolution: null,
      respondedAt: null,
      responseText: null,
      confidence: 0,
      reason: "no_owner_response",
    });

    await expect(
      service.dispatchDueReminderEscalation(dispatchArgs(plan, attempt)),
    ).resolves.toBe(escalationAttempt);

    expect(service.dispatchReminderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        escalationReason: "review_due_without_acknowledgement",
      }),
    );
    expect(service.markReminderReviewEscalated).toHaveBeenCalledWith(
      expect.objectContaining({ attempt, escalatedAttempt: escalationAttempt }),
    );
  });

  it("does not let unrelated owner chat suppress escalation", async () => {
    const plan = makePlan();
    const attempt = makeAttempt();
    const { service } = createHarness({
      decision: "unrelated",
      resolution: null,
      respondedAt: addMinutes(baseAt, 2),
      responseText: "what time is it?",
      confidence: 0.4,
      reason: "owner_responded_without_explicit_reminder_resolution",
    });

    await service.dispatchDueReminderEscalation(dispatchArgs(plan, attempt));

    expect(service.markReminderReviewObservedResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt,
        decision: "unrelated",
      }),
    );
    expect(service.dispatchReminderAttempt).toHaveBeenCalled();
  });

  it("resolves instead of escalating when the owner explicitly acknowledges", async () => {
    const plan = makePlan();
    const attempt = makeAttempt();
    const { service } = createHarness({
      decision: "explicit_resolution",
      resolution: "completed",
      respondedAt: addMinutes(baseAt, 2),
      responseText: "done",
      confidence: 0.86,
      reason: "completion_language",
    });

    await service.dispatchDueReminderEscalation(dispatchArgs(plan, attempt));

    expect(service.resolveReminderReviewFromOwnerResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "occurrence-1",
        attempt,
        resolution: "completed",
      }),
    );
    expect(service.dispatchReminderAttempt).not.toHaveBeenCalled();
  });
});
