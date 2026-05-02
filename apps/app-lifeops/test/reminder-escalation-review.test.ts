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
  service.markReminderReviewClarificationRequested = vi.fn(
    async () => undefined,
  );
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

  it("reviews the specific due callback attempt instead of the latest pending attempt", async () => {
    const plan = makePlan();
    const dueAttempt = makeAttempt();
    const laterAttempt: LifeOpsReminderAttempt = {
      ...makeAttempt(),
      id: "attempt-later",
      attemptedAt: addMinutes(baseAt, 5),
      scheduledFor: addMinutes(baseAt, 5),
      deliveryMetadata: {
        [REMINDER_LIFECYCLE_METADATA_KEY]: "plan",
        [REMINDER_REVIEW_AT_METADATA_KEY]: addMinutes(baseAt, 20),
      },
    };
    const { service, escalationAttempt } = createHarness({
      decision: "no_response",
      resolution: null,
      respondedAt: null,
      responseText: null,
      confidence: 0,
      reason: "no_owner_response",
    });

    await expect(
      service.dispatchDueReminderEscalation({
        ...dispatchArgs(plan, dueAttempt),
        attempts: [dueAttempt, laterAttempt],
        reviewAttempt: dueAttempt,
      }),
    ).resolves.toBe(escalationAttempt);

    expect(
      service.reviewOwnerResponseAfterReminderAttempt,
    ).toHaveBeenCalledWith(expect.objectContaining({ attempt: dueAttempt }));
    expect(service.markReminderReviewEscalated).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: dueAttempt }),
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

  it("does not resolve vague snooze language without a concrete snooze time", async () => {
    const plan = makePlan();
    const attempt = makeAttempt();
    const { service } = createHarness({
      decision: "needs_clarification",
      resolution: null,
      snoozeRequest: null,
      respondedAt: addMinutes(baseAt, 2),
      responseText: "remind me later",
      confidence: 0.68,
      reason: "snooze_needs_duration",
    });

    await service.dispatchDueReminderEscalation(dispatchArgs(plan, attempt));

    expect(service.markReminderReviewObservedResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt,
        decision: "needs_clarification",
      }),
    );
    expect(service.dispatchReminderAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "in_app",
        escalationReason: "snooze_needs_clarification",
        bodyOverride: expect.stringContaining("30 minutes"),
      }),
    );
    expect(service.markReminderReviewClarificationRequested).toHaveBeenCalled();
    expect(
      service.resolveReminderReviewFromOwnerResponse,
    ).not.toHaveBeenCalled();
  });

  it("does not close the review callback when escalation delivery is blocked", async () => {
    const plan = makePlan();
    const attempt = makeAttempt();
    const { service } = createHarness({
      decision: "no_response",
      resolution: null,
      respondedAt: null,
      responseText: null,
      confidence: 0,
      reason: "no_owner_response",
    });
    const blockedAttempt: LifeOpsReminderAttempt = {
      ...makeAttempt(),
      id: "attempt-blocked",
      channel: "discord",
      stepIndex: 2,
      scheduledFor: addMinutes(baseAt, 7),
      attemptedAt: addMinutes(baseAt, 8),
      outcome: "blocked_connector",
      deliveryMetadata: {
        [REMINDER_LIFECYCLE_METADATA_KEY]: "escalation",
      },
    };
    service.dispatchReminderAttempt = vi.fn(async () => blockedAttempt);

    await service.dispatchDueReminderEscalation(dispatchArgs(plan, attempt));

    expect(service.markReminderReviewEscalated).not.toHaveBeenCalled();
    expect(service.markReminderReviewObservedResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt,
        decision: "no_response",
        reason: "review_escalation_attempt_blocked_connector",
      }),
    );
  });

  it("snoozes the occurrence when the owner gives a concrete snooze duration", async () => {
    const service = Object.create(LifeOpsService.prototype) as LifeOpsService &
      Record<string, unknown>;
    const attempt = makeAttempt();
    service.repository = {
      updateReminderAttemptOutcome: vi.fn(async () => undefined),
    };
    service.snoozeOccurrence = vi.fn(async () => ({ id: "occurrence-1" }));
    service.resolveReminderEscalation = vi.fn(async () => undefined);

    await service.resolveReminderReviewFromOwnerResponse({
      ownerType: "occurrence",
      ownerId: "occurrence-1",
      attempt,
      reviewedAt: addMinutes(baseAt, 8),
      resolution: "snoozed",
      responseText: "remind me in 30 minutes",
      respondedAt: addMinutes(baseAt, 2),
      snoozeRequest: { preset: "30m" },
      confidence: 0.86,
      reason: "snooze_30m",
    });

    expect(
      service.repository.updateReminderAttemptOutcome,
    ).toHaveBeenCalledWith(
      attempt.id,
      attempt.outcome,
      expect.objectContaining({
        reminderReviewStatus: "resolved",
        reminderReviewDecision: "snoozed",
      }),
    );
    expect(service.snoozeOccurrence).toHaveBeenCalledWith(
      "occurrence-1",
      { preset: "30m" },
      new Date(addMinutes(baseAt, 2)),
    );
  });

  it("does not bind standalone acknowledgement from a different room", async () => {
    const service = Object.create(LifeOpsService.prototype) as LifeOpsService &
      Record<string, unknown>;
    const attempt = {
      ...makeAttempt(),
      deliveryMetadata: {
        ...makeAttempt().deliveryMetadata,
        title: "Stretch",
        routeEndpoint: "room-reminder",
      },
    };
    service.agentId = vi.fn(() => "agent-1");
    service.ownerEntityId = vi.fn(() => "owner-1");
    service.ownerRoutingEntityId = vi.fn(async () => "owner-1");
    service.runtime = {
      getRoomsForParticipants: vi.fn(async () => [
        "room-reminder",
        "room-other",
      ]),
      getMemoriesByRoomIds: vi.fn(async () => [
        {
          entityId: "owner-1",
          roomId: "room-other",
          createdAt: new Date(addMinutes(baseAt, 2)).getTime(),
          content: { text: "done" },
        },
      ]),
    };

    await expect(
      service.reviewOwnerResponseAfterReminderAttempt({
        subjectType: "owner",
        attempt,
        now: new Date(addMinutes(baseAt, 8)),
      }),
    ).resolves.toMatchObject({
      decision: "unrelated",
      resolution: null,
    });
  });

  it("processes due review jobs independent of the overview window", async () => {
    const plan = makePlan();
    const attempt = makeAttempt();
    const service = Object.create(LifeOpsService.prototype) as LifeOpsService &
      Record<string, unknown>;
    const escalationAttempt: LifeOpsReminderAttempt = {
      ...attempt,
      id: "attempt-2",
      channel: "discord",
      stepIndex: 2,
      scheduledFor: addMinutes(baseAt, 7),
      attemptedAt: addMinutes(baseAt, 8),
      deliveryMetadata: { [REMINDER_LIFECYCLE_METADATA_KEY]: "escalation" },
    };
    service.agentId = vi.fn(() => "agent-1");
    service.repository = {
      listDueReminderReviewAttempts: vi.fn(async () => [attempt]),
      getReminderPlan: vi.fn(async () => plan),
      getOccurrenceView: vi.fn(async () => ({
        id: "occurrence-1",
        definitionId: "definition-1",
        subjectType: "owner",
        title: "Stretch",
        dueAt: null,
        priority: 2,
        metadata: {},
        state: "visible",
        relevanceStartAt: baseAt.toISOString(),
        snoozedUntil: null,
      })),
      getDefinition: vi.fn(async () => ({
        id: "definition-1",
        kind: "habit",
        metadata: {},
      })),
    };
    service.getReminderPreference = vi.fn(async () => ({
      effective: { intensity: "normal" },
    }));
    service.dispatchDueReminderEscalation = vi.fn(
      async () => escalationAttempt,
    );

    await expect(
      service.processDueReminderReviewJobs({
        now: new Date(addMinutes(baseAt, 8)),
        limit: 5,
        attempts: [],
        policies: [],
        activityProfile: null,
        timezone: "UTC",
        defaultIntensity: "normal",
      }),
    ).resolves.toEqual([escalationAttempt]);

    expect(
      service.repository.listDueReminderReviewAttempts,
    ).toHaveBeenCalledWith("agent-1", addMinutes(baseAt, 8), 5);
    expect(service.dispatchDueReminderEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: "occurrence",
        ownerId: "occurrence-1",
        attempts: expect.arrayContaining([attempt]),
      }),
    );
  });

  it("runs due review jobs from the normal reminder processor entrypoint", async () => {
    const service = Object.create(LifeOpsService.prototype) as LifeOpsService &
      Record<string, unknown>;
    const reviewAttempt = makeAttempt();
    service.agentId = vi.fn(() => "agent-1");
    service.ownerEntityId = vi.fn(() => "owner-1");
    service.withReminderProcessingLock = vi.fn(async (callback) => callback());
    service.refreshDefinitionOccurrences = vi.fn(async () => undefined);
    service.buildReminderPreferenceResponse = vi.fn(() => ({
      effective: { intensity: "normal" },
    }));
    service.resolveEffectiveReminderPlan = vi.fn((plan) => plan);
    service.readReminderActivityProfileSnapshot = vi.fn(async () => null);
    service.processDueReminderReviewJobs = vi.fn(async () => [reviewAttempt]);
    service.scanReadReceipts = vi.fn(async () => undefined);
    service.repository = {
      listActiveDefinitions: vi.fn(async () => []),
      listOccurrenceViewsForOverview: vi.fn(async () => []),
      listReminderPlansForOwners: vi.fn(async () => []),
      listChannelPolicies: vi.fn(async () => []),
      listCalendarEvents: vi.fn(async () => []),
      listReminderAttempts: vi.fn(async () => []),
    };

    await expect(
      service.processReminders({
        now: addMinutes(baseAt, 8),
        limit: 3,
      }),
    ).resolves.toMatchObject({
      now: addMinutes(baseAt, 8),
      attempts: [reviewAttempt],
    });

    expect(service.processDueReminderReviewJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        now: new Date(addMinutes(baseAt, 8)),
        limit: 3,
        attempts: [],
      }),
    );
  });
});
