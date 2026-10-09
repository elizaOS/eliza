/** Durable owner-response review consumption against the real repository. */
import {
  attestDeliveryAudienceFromCanonicalRoom,
  bindTaskExtractionContext,
  ChannelType,
  CONTEXT_ROUTING_STATE_KEY,
  type ContextObject,
  completionContextSources,
  conversationClientUserMemoryId,
  getContextRoutingFromState,
  hardenIncomingUserMessage,
  type Memory,
  normalizeEffectReceipt,
  readTaskExtractionRequestIntents,
  runWithTrajectoryContext,
  type State,
  selectCompletionContext,
  TaskService,
  type UUID,
} from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { summarizeRuntimeActionResults } from "../../../../../packages/agent/src/api/chat-routes.js";
import { mergeAgentContexts } from "../../../../plugin-assistant/src/services/message/action-surface.js";
import { executeV5PlannedToolCall } from "../../../../plugin-assistant/src/services/message/planned-tool.js";
import {
  collectDiscoveryCatalogActions,
  createPlannerToolDiscoveryAction,
} from "../../../../plugin-assistant/src/services/message/tool-discovery.js";
import { createLifeOpsTestRuntime } from "../../../test/helpers/runtime.js";
import * as taskPlans from "../../actions/lib/extract-task-plan.js";
import { runLifeOperationHandler } from "../../actions/life.js";
import { createLifeOpsReminderAttempt } from "../repository.js";
import { LifeOpsService } from "../service.js";
import { decideReminderReviewTransition } from "../service-helpers-reminder.js";

let fixture: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>;
let service: LifeOpsService;
let roomId: UUID;
let nextTime = Date.parse("2026-10-03T02:28:10.796Z");
beforeAll(async () => {
  vi.setSystemTime(new Date("2026-10-02T20:00:00.000Z"));
  vi.stubEnv("ELIZA_DISABLE_LIFEOPS_SCHEDULER", "1");
  fixture = await createLifeOpsTestRuntime({ withLLM: false });
  await TaskService.stop(fixture.runtime);
  service = new LifeOpsService(fixture.runtime);
  const ownerId = service.ownerEntityId() as UUID;
  if (!(await fixture.runtime.getEntityById(ownerId)))
    await fixture.runtime.createEntity({
      id: ownerId,
      agentId: fixture.runtime.agentId,
      names: ["Review owner"],
      metadata: {},
    });
  const worldId = crypto.randomUUID() as UUID;
  await fixture.runtime.ensureWorldExists({
    id: worldId,
    agentId: fixture.runtime.agentId,
    name: "Review world",
    metadata: { ownership: { ownerId }, roles: { [ownerId]: "OWNER" } },
  });
  for (let index = 0; index < 2; index++) {
    const id = crypto.randomUUID() as UUID;
    await fixture.runtime.createRoom({
      id,
      worldId,
      name: `Review room ${index}`,
      source: "client_chat",
      type: ChannelType.DM,
    });
    await fixture.runtime.createRoomParticipants(
      [ownerId, fixture.runtime.agentId],
      id,
    );
    if (index === 0) roomId = id;
  }
}, 120_000);
beforeEach(() => {
  vi.spyOn(fixture.runtime, "useModel").mockRejectedValue(
    Error("No model network in review regression"),
  );
});
afterEach(() => {
  expect(fixture.runtime.useModel).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await fixture?.cleanup();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function reviewFixture(
  text: string,
  content: Partial<Memory["content"]> = {},
) {
  const attemptedAt = new Date(nextTime).toISOString();
  const respondedAt = nextTime + 638_408;
  const now = new Date(respondedAt + 60_000);
  nextTime = now.getTime() + 60_000;
  const original = await service.createDefinition({
    title: "Check final reminder notification",
    kind: "habit",
    timezone: "UTC",
    cadence: { kind: "once", dueAt: attemptedAt },
    metadata: {
      ownerSurface: "OWNER_REMINDERS",
      nativeProjection: "in_app_only",
    },
    reminderPlan: {
      steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
    },
  });
  if (!original.reminderPlan) throw new Error("Missing review plan");
  const [occurrence] = await service.repository.listOccurrencesForDefinition(
    fixture.runtime.agentId,
    original.definition.id,
  );
  const attempt = createLifeOpsReminderAttempt({
    agentId: fixture.runtime.agentId,
    planId: original.reminderPlan.id,
    ownerType: "occurrence",
    ownerId: occurrence.id,
    occurrenceId: occurrence.id,
    channel: "in_app",
    stepIndex: 0,
    scheduledFor: attemptedAt,
    attemptedAt,
    outcome: "delivered",
    connectorRef: "system:in_app",
    deliveryMetadata: { title: original.definition.title, lifecycle: "plan" },
  });
  await service.repository.createReminderAttempt(attempt);
  const message = {
    id: content.chatIdempotency
      ? conversationClientUserMemoryId(
          `${fixture.runtime.agentId}:${roomId}:${service.ownerEntityId()}`,
          (content.chatIdempotency as { clientMessageId: string })
            .clientMessageId,
        )
      : (crypto.randomUUID() as UUID),
    agentId: fixture.runtime.agentId,
    entityId: service.ownerEntityId() as UUID,
    roomId,
    createdAt: respondedAt,
    content: { text, source: "client_chat", ...content },
  } as Memory;
  await fixture.runtime.createMemory(message, "messages");
  return { original, occurrence, attempt, message, now };
}

it("vetoes the captured false-binding done even if a semantic judge would return completed", async () => {
  const f = await reviewFixture("done");
  const judge = vi
    .spyOn(service.remindersDomain, "classifyReminderOwnerResponseSemantically")
    .mockResolvedValue({
      decision: "explicit_resolution",
      resolution: "completed",
      snoozeRequest: null,
      confidence: 0.95,
      reason: "Owner explicitly marked the reminder as done.",
    });
  const review = await service.reviewOwnerResponseAfterReminderAttempt({
    subjectType: "owner",
    attempt: f.attempt,
    now: f.now,
  });
  expect(review.decision).toBe("unrelated");
  expect(judge).not.toHaveBeenCalled();
  expect(
    decideReminderReviewTransition({
      ownerType: "occurrence",
      reviewDue: false,
      responseReview: review,
    }).kind,
  ).not.toBe("resolve");
  expect(
    (
      await service.repository.getOccurrence(
        fixture.runtime.agentId,
        f.occurrence.id,
      )
    )?.metadata.reminderAcknowledgedAt,
  ).toBeUndefined();
});

it.each(["unrelated", "abstain"] as const)(
  "reuses observed %s evidence across new service instances without another classifier call",
  async (decision) => {
    const f = await reviewFixture("The invoice check is still in progress.");
    const judge = vi
      .spyOn(
        service.remindersDomain,
        "classifyReminderOwnerResponseSemantically",
      )
      .mockResolvedValue({
        decision,
        resolution: null,
        snoozeRequest: null,
        confidence: 0.8,
        reason: "not_done",
      });
    const first = await service.reviewOwnerResponseAfterReminderAttempt({
      subjectType: "owner",
      attempt: f.attempt,
      now: f.now,
    });
    expect(judge).toHaveBeenCalledTimes(1);
    const respondedAt = new Date(f.message.createdAt ?? 0).toISOString();
    expect(judge).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ respondedAt }),
      }),
    );
    expect(first.respondedAt).toBe(respondedAt);
    const restarted = new LifeOpsService(fixture.runtime);
    const replayJudge = vi
      .spyOn(
        restarted.remindersDomain,
        "classifyReminderOwnerResponseSemantically",
      )
      .mockResolvedValue({
        decision: "explicit_resolution",
        resolution: "completed",
        snoozeRequest: null,
        confidence: 0.95,
        reason: "changed_verdict",
      });
    const [persisted] = await restarted.repository.listReminderAttempts(
      fixture.runtime.agentId,
      { ownerType: "occurrence", ownerId: f.occurrence.id },
    );
    expect(persisted.deliveryMetadata.reminderReviewRespondedAt).toBe(
      respondedAt,
    );
    const repeated = await restarted.reviewOwnerResponseAfterReminderAttempt({
      subjectType: "owner",
      attempt: persisted,
      now: new Date(f.now.getTime() + 68_000),
    });
    expect(replayJudge).not.toHaveBeenCalled();
    expect(repeated.decision).toBe(first.decision);
    expect(
      (
        await restarted.repository.getOccurrence(
          fixture.runtime.agentId,
          f.occurrence.id,
        )
      )?.metadata.reminderAcknowledgedAt,
    ).toBeUndefined();
  },
);

it("leaves typed control replies to their action pipeline", async () => {
  const f = await reviewFixture("done", {
    inReplyTo: crypto.randomUUID() as UUID,
    metadata: { reminderChoiceId: "source-choice" },
  });
  const judge = vi
    .spyOn(service.remindersDomain, "classifyReminderOwnerResponseSemantically")
    .mockResolvedValue({
      decision: "explicit_resolution",
      resolution: "completed",
      snoozeRequest: null,
      confidence: 1,
      reason: "wrong_pipeline",
    });
  const review = await service.reviewOwnerResponseAfterReminderAttempt({
    subjectType: "owner",
    attempt: f.attempt,
    now: f.now,
  });
  expect(review.decision).toBe("unrelated");
  expect(judge).not.toHaveBeenCalled();
  expect(review.reason).toBe("typed_reply_owned_by_action_pipeline");
});

it("preserves named semantic resolutions without replacing them with title matching", async () => {
  const f = await reviewFixture(
    "I finished the final reminder notification check.",
  );
  const judge = vi
    .spyOn(service.remindersDomain, "classifyReminderOwnerResponseSemantically")
    .mockResolvedValue({
      decision: "explicit_resolution",
      resolution: "completed",
      snoozeRequest: null,
      confidence: 0.95,
      reason: "explicit_named_reply",
    });
  const review = await service.reviewOwnerResponseAfterReminderAttempt({
    subjectType: "owner",
    attempt: f.attempt,
    now: f.now,
  });
  expect(judge).toHaveBeenCalledTimes(1);
  expect(review).toMatchObject({
    decision: "explicit_resolution",
    resolution: "completed",
    classifierSource: "semantic",
  });
});

it("skips replies bound to a different canonical reminder occurrence", async () => {
  const sourceId = crypto.randomUUID() as UUID;
  const f = await reviewFixture("I completed that reminder.", {
    inReplyTo: sourceId,
  });
  await fixture.runtime.createMemory(
    {
      id: sourceId,
      agentId: fixture.runtime.agentId,
      entityId: fixture.runtime.agentId,
      roomId,
      createdAt: f.now.getTime() - 120_000,
      content: {
        text: "Other reminder",
        source: "reminder",
        metadata: { ownerType: "occurrence", ownerId: crypto.randomUUID() },
      },
    } as Memory,
    "messages",
  );
  const judge = vi
    .spyOn(service.remindersDomain, "classifyReminderOwnerResponseSemantically")
    .mockResolvedValue({
      decision: "explicit_resolution",
      resolution: "completed",
      snoozeRequest: null,
      confidence: 1,
      reason: "wrong_target",
    });
  const review = await service.reviewOwnerResponseAfterReminderAttempt({
    subjectType: "owner",
    attempt: f.attempt,
    now: f.now,
  });
  expect(review.decision).toBe("unrelated");
  expect(judge).not.toHaveBeenCalled();
});

it("preserves an already resolved invalid legacy observation as evidence", async () => {
  const f = await reviewFixture("done");
  const metadata = {
    reminderReviewStatus: "resolved",
    reminderReviewDecision: "completed",
    reminderReviewRespondedAt: new Date(
      f.message.createdAt ?? f.now.getTime(),
    ).toISOString(),
    reminderReviewResponseText: "done",
    reviewReason: "Legacy invalid standalone verdict",
  };
  await service.repository.updateReminderAttemptOutcome(
    f.attempt.id,
    f.attempt.outcome,
    metadata,
  );
  const [before] = await service.repository.listReminderAttempts(
    fixture.runtime.agentId,
    { ownerType: "occurrence", ownerId: f.occurrence.id },
  );
  const judge = vi
    .spyOn(service.remindersDomain, "classifyReminderOwnerResponseSemantically")
    .mockResolvedValue({
      decision: "explicit_resolution",
      resolution: "completed",
      snoozeRequest: null,
      confidence: 1,
      reason: "repeat",
    });
  await service.reviewOwnerResponseAfterReminderAttempt({
    subjectType: "owner",
    attempt: before,
    now: f.now,
  });
  expect(judge).not.toHaveBeenCalled();
  expect(
    await service.repository.listReminderAttempts(fixture.runtime.agentId, {
      ownerType: "occurrence",
      ownerId: f.occurrence.id,
    }),
  ).toEqual([before]);
});

it.each(["done", "skip"])(
  "preserves Calendar %s acknowledgment without editing the event",
  async (text) => {
    const f = await reviewFixture(text);
    if (!f.attempt.attemptedAt) throw new Error("Missing attempted timestamp");
    const event = {
      id: crypto.randomUUID(),
      externalId: crypto.randomUUID(),
      agentId: fixture.runtime.agentId,
      provider: "google" as const,
      side: "owner" as const,
      calendarId: "primary",
      title: "Calendar acknowledgment",
      description: "Original description",
      location: "Original location",
      status: "confirmed",
      startAt: f.attempt.attemptedAt,
      endAt: f.now.toISOString(),
      isAllDay: false,
      timezone: "UTC",
      htmlLink: null,
      conferenceLink: null,
      organizer: null,
      attendees: [],
      metadata: {},
      syncedAt: f.now.toISOString(),
      updatedAt: f.now.toISOString(),
    };
    await service.repository.upsertCalendarEvent(event);
    const attempt = createLifeOpsReminderAttempt({
      ...f.attempt,
      id: crypto.randomUUID(),
      ownerType: "calendar_event",
      ownerId: event.id,
      occurrenceId: null,
      deliveryMetadata: { title: event.title, deliveryRoomId: roomId },
    });
    await service.repository.createReminderAttempt(attempt);
    const respondedAt = Date.parse(event.startAt) + 60_000;
    await fixture.runtime.createMemory(
      {
        ...f.message,
        id: crypto.randomUUID() as UUID,
        createdAt: respondedAt,
        content: { text, source: "client_chat" },
      },
      "messages",
    );
    const judge = vi.spyOn(
      service.remindersDomain,
      "classifyReminderOwnerResponseSemantically",
    );
    const review = await service.reviewOwnerResponseAfterReminderAttempt({
      subjectType: "owner",
      attempt,
      now: new Date(respondedAt + 1000),
    });
    expect(review.decision).toBe("explicit_resolution");
    expect(review.resolution).toBe(text === "done" ? "completed" : "skipped");
    expect(judge).not.toHaveBeenCalled();
    if (!review.resolution)
      throw new Error("Missing Calendar acknowledgment resolution");
    await service.remindersDomain.resolveReminderReviewFromOwnerResponse({
      ownerType: "calendar_event",
      ownerId: event.id,
      attempt,
      reviewedAt: new Date(respondedAt + 1000).toISOString(),
      resolution: review.resolution,
      respondedAt: review.respondedAt,
      responseText: review.responseText,
      snoozeRequest: null,
      confidence: review.confidence,
      reason: review.reason,
      classifierSource: review.classifierSource,
    });
    const actual = (
      await service.repository.listCalendarEvents(
        fixture.runtime.agentId,
        "google",
      )
    ).find((row) => row.id === event.id);
    expect(actual).toMatchObject({
      ...event,
      updatedAt: expect.any(String),
      metadata: expect.objectContaining({
        reminderAcknowledgedResolution: review.resolution,
      }),
    });
    expect(attempt.reviewStatus).toBe("resolved");
  },
);

it("vetoes stored externally wrapped done before semantic inference", async () => {
  const message = { content: { text: "done", source: "discord" } } as Memory;
  hardenIncomingUserMessage(message);
  expect(message.content.text).not.toBe("done");
  expect(message.content.metadata).toMatchObject({
    userPayloadText: "done",
    externalContentWrapped: true,
  });
  const f = await reviewFixture(
    message.content.text as string,
    message.content,
  );
  const judge = vi
    .spyOn(service.remindersDomain, "classifyReminderOwnerResponseSemantically")
    .mockResolvedValue({
      decision: "explicit_resolution",
      resolution: "completed",
      snoozeRequest: null,
      confidence: 0.95,
      reason: "false wrapped completion",
    });
  const review = await service.reviewOwnerResponseAfterReminderAttempt({
    subjectType: "owner",
    attempt: f.attempt,
    now: f.now,
  });
  expect(review.decision).toBe("unrelated");
  expect(review.responseText).toBe("done");
  expect(review.reason).toBe("standalone_resolution_not_allowed");
  expect(judge).not.toHaveBeenCalled();
  const [persisted] = await service.repository.listReminderAttempts(
    fixture.runtime.agentId,
    { ownerType: "occurrence", ownerId: f.occurrence.id },
  );
  expect(persisted.deliveryMetadata.reminderReviewRespondedAt).toBe(
    review.respondedAt,
  );
  expect(
    (
      await service.repository.getOccurrence(
        fixture.runtime.agentId,
        f.occurrence.id,
      )
    )?.metadata.reminderAcknowledgedAt,
  ).toBeUndefined();
});

it("retries an unavailable semantic verdict without consuming it or later evidence", async () => {
  const f = await reviewFixture(
    "I finished the final reminder notification check.",
  );
  const priorCursor = new Date(
    Date.parse(f.attempt.attemptedAt ?? "") + 1000,
  ).toISOString();
  const priorMetadata = {
    reminderReviewStatus: "unrelated",
    reminderReviewDecision: "unrelated",
    reminderReviewRespondedAt: priorCursor,
    reminderReviewResponseText: "Earlier unrelated reply",
    reviewReason: "semantic_abstain",
    reminderReviewClassifierSource: "semantic_abstain",
  };
  await service.repository.updateReminderAttemptOutcome(
    f.attempt.id,
    f.attempt.outcome,
    priorMetadata,
  );
  Object.assign(f.attempt.deliveryMetadata, priorMetadata);
  await fixture.runtime.createMemory(
    {
      ...f.message,
      id: crypto.randomUUID() as UUID,
      createdAt: (f.message.createdAt ?? 0) + 1000,
      content: { text: "Another unrelated followup", source: "client_chat" },
    },
    "messages",
  );
  const unavailable = vi
    .spyOn(service.remindersDomain, "classifyReminderOwnerResponseSemantically")
    .mockResolvedValue(null);
  const first = await service.reviewOwnerResponseAfterReminderAttempt({
    subjectType: "owner",
    attempt: f.attempt,
    now: f.now,
  });
  expect(first.decision).toBe("no_response");
  expect(unavailable).toHaveBeenCalledTimes(1);
  const restarted = new LifeOpsService(fixture.runtime);
  const [persisted] = await restarted.repository.listReminderAttempts(
    fixture.runtime.agentId,
    { ownerType: "occurrence", ownerId: f.occurrence.id },
  );
  expect(persisted.deliveryMetadata).toMatchObject(priorMetadata);
  expect(
    (
      await service.repository.getOccurrence(
        fixture.runtime.agentId,
        f.occurrence.id,
      )
    )?.metadata.reminderAcknowledgedAt,
  ).toBeUndefined();
  const restored = vi
    .spyOn(
      restarted.remindersDomain,
      "classifyReminderOwnerResponseSemantically",
    )
    .mockResolvedValue({
      decision: "explicit_resolution",
      resolution: "completed",
      snoozeRequest: null,
      confidence: 0.95,
      reason: "restored_named_completed",
    });
  const recovered = await restarted.reviewOwnerResponseAfterReminderAttempt({
    subjectType: "owner",
    attempt: persisted,
    now: f.now,
  });
  expect(restored).toHaveBeenCalledTimes(1);
  expect(restored.mock.calls[0][0].text).toBe(f.message.content.text);
  expect(recovered).toMatchObject({
    decision: "explicit_resolution",
    resolution: "completed",
    respondedAt: new Date(f.message.createdAt ?? 0).toISOString(),
  });
});

it.each([
  "semantic_unavailable",
  "foreground_pending",
  "archived",
  "paused",
  "archive_during_completed",
  "archive_during_snoozed",
])(
  "preserves due review ownership for %s through processReminders",
  async (mode) => {
    const isolated = await createLifeOpsTestRuntime({ withLLM: false });
    await TaskService.stop(isolated.runtime);
    const local = new LifeOpsService(isolated.runtime);
    const network = vi
      .spyOn(isolated.runtime, "useModel")
      .mockRejectedValue(Error("No model network"));
    try {
      const attemptedAt = "2026-10-03T06:00:00.000Z";
      const ownerId = local.ownerEntityId() as UUID;
      const ownerRoom = crypto.randomUUID() as UUID;
      const worldId = crypto.randomUUID() as UUID;
      await isolated.runtime.ensureConnection({
        entityId: ownerId,
        roomId: ownerRoom,
        worldId,
        userName: "Owner",
        name: "Owner",
        source: "client_chat",
        type: ChannelType.DM,
      });
      await isolated.runtime.ensureParticipantInRoom(
        isolated.runtime.agentId,
        ownerRoom,
      );
      const created = await local.createDefinition({
        title: "Check final reminder notification",
        kind: "habit",
        timezone: "UTC",
        cadence: { kind: "once", dueAt: attemptedAt },
        metadata: {
          ownerSurface: "OWNER_REMINDERS",
          nativeProjection: "in_app_only",
        },
        reminderPlan: {
          steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
        },
      });
      if (!created.reminderPlan) throw Error("Missing plan");
      const [occurrence] = await local.repository.listOccurrencesForDefinition(
        isolated.runtime.agentId,
        created.definition.id,
      );
      const priorMetadata = {
        title: created.definition.title,
        lifecycle: "plan",
        reminderReviewAt: "2026-10-03T06:07:00.000Z",
        reminderReviewStatus: "unrelated",
        reminderReviewDecision: "unrelated",
        reminderReviewRespondedAt: "2026-10-03T06:01:00.000Z",
        reminderReviewResponseText: "Earlier unrelated reply",
        reviewReason: "semantic_abstain",
        reminderReviewClassifierSource: "semantic_abstain",
        preservedEvidence: "keep",
      };
      const attempt = createLifeOpsReminderAttempt({
        agentId: isolated.runtime.agentId,
        planId: created.reminderPlan.id,
        ownerType: "occurrence",
        ownerId: occurrence.id,
        occurrenceId: occurrence.id,
        channel: "in_app",
        stepIndex: 0,
        scheduledFor: occurrence.relevanceStartAt,
        attemptedAt,
        outcome: "delivered",
        connectorRef: "system:in_app",
        deliveryMetadata: priorMetadata,
      });
      await local.repository.createReminderAttempt(attempt);
      const marker = {
        version: 1,
        scope: `${isolated.runtime.agentId}:${ownerRoom}:${ownerId}`,
        clientMessageId: crypto.randomUUID(),
        fingerprint: "b".repeat(64),
      };
      const reply = {
        id:
          mode === "foreground_pending"
            ? conversationClientUserMemoryId(
                marker.scope,
                marker.clientMessageId,
              )
            : (crypto.randomUUID() as UUID),
        agentId: isolated.runtime.agentId,
        entityId: ownerId,
        roomId: ownerRoom,
        createdAt: Date.parse("2026-10-03T06:05:00.000Z"),
        content: {
          text:
            mode === "archive_during_snoozed"
              ? "Snooze the final reminder notification check for ten minutes."
              : "I finished the final reminder notification check.",
          source: "client_chat",
          ...(mode === "foreground_pending"
            ? { channelType: ChannelType.DM, chatIdempotency: marker }
            : {}),
        },
      } as Memory;
      await isolated.runtime.createMemory(reply, "messages");
      let inactiveStatus =
        mode === "archived" || mode === "paused" ? mode : null;
      if (inactiveStatus)
        await local.updateDefinition(created.definition.id, {
          status: inactiveStatus,
        });
      let beforeOccurrence = await local.repository.getOccurrence(
        isolated.runtime.agentId,
        occurrence.id,
      );
      const emit = vi.spyOn(
        local.remindersDomain as unknown as {
          emitInAppReminderNudge: (args: unknown) => Promise<void>;
        },
        "emitInAppReminderNudge",
      );
      const unavailable = vi
        .spyOn(
          local.remindersDomain,
          "classifyReminderOwnerResponseSemantically",
        )
        .mockResolvedValue(null);
      const lease =
        mode === "foreground_pending"
          ? await isolated.runtime.roomHandlerQueue.acquire(ownerRoom)
          : undefined;
      const cancelDuringClassification = [
        "archive_during_completed",
        "archive_during_snoozed",
      ].includes(mode);
      let started: (() => void) | undefined;
      let resume: (() => void) | undefined;
      const classificationStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const classificationHeld = new Promise<void>((resolve) => {
        resume = resolve;
      });
      if (cancelDuringClassification)
        unavailable.mockImplementation(async () => {
          started?.();
          await classificationHeld;
          return {
            decision: "explicit_resolution" as const,
            resolution:
              mode === "archive_during_snoozed"
                ? ("snoozed" as const)
                : ("completed" as const),
            snoozeRequest:
              mode === "archive_during_snoozed" ? { minutes: 10 } : null,
            confidence: 0.95,
            reason: "held_semantic_resolution",
          };
        });
      const processing = local.processReminders({
        now: "2026-10-03T06:08:00.000Z",
        scope: "definitions",
      });
      if (cancelDuringClassification) {
        await classificationStarted;
        try {
          await local.updateDefinition(created.definition.id, {
            status: "archived",
          });
          inactiveStatus = "archived";
          beforeOccurrence = await local.repository.getOccurrence(
            isolated.runtime.agentId,
            occurrence.id,
          );
        } finally {
          resume?.();
        }
      }
      const first = await processing;
      expect(first.attempts).toHaveLength(0);
      if (cancelDuringClassification)
        expect(unavailable).toHaveBeenCalledTimes(1);
      else if (mode === "foreground_pending" || inactiveStatus)
        expect(unavailable).not.toHaveBeenCalled();
      else expect(unavailable).toHaveBeenCalled();
      await lease?.release();
      const [after] = await local.repository.listReminderAttempts(
        isolated.runtime.agentId,
        { ownerType: "occurrence", ownerId: occurrence.id },
      );
      if (inactiveStatus) {
        expect(after).toMatchObject({
          outcome: "delivered",
          reviewStatus: "resolved",
          deliveryMetadata: {
            reminderReviewDecision: "no_response",
            reminderReviewReason: "definition_inactive",
            reviewReason: `definition_${inactiveStatus}`,
          },
        });
        expect(
          await local.repository.getOccurrence(
            isolated.runtime.agentId,
            occurrence.id,
          ),
        ).toEqual(beforeOccurrence);
        expect(emit).not.toHaveBeenCalled();
        // An active-looking cached attempt must still read current cancellation
        // before semantic interpretation, not trust the earlier snapshot.
        const review = await local.reviewOwnerResponseAfterReminderAttempt({
          subjectType: "owner",
          attempt,
          now: new Date("2026-10-03T06:08:00.000Z"),
        });
        expect(review).toMatchObject({
          decision: "no_response",
          reason: "definition_inactive",
        });
        // Likewise a previously prepared normal delivery cannot override cancel.
        const blocked = await local.remindersDomain.dispatchReminderAttempt({
          plan: created.reminderPlan,
          ownerType: "occurrence",
          ownerId: occurrence.id,
          occurrenceId: occurrence.id,
          subjectType: "owner",
          title: occurrence.title,
          channel: "in_app",
          stepIndex: 0,
          scheduledFor: attemptedAt,
          dueAt: occurrence.dueAt,
          urgency: "high",
          quietHours: {},
          acknowledged: false,
          attemptedAt: "2026-10-03T06:08:00.000Z",
          timezone: "UTC",
          definition: created.definition,
          bodyOverride: "Stale prepared reminder",
        });
        expect(blocked).toMatchObject({
          outcome: "blocked_policy",
          deliveryMetadata: { reason: "definition_inactive" },
        });
        expect(unavailable).toHaveBeenCalledTimes(
          cancelDuringClassification ? 1 : 0,
        );
        expect(emit).not.toHaveBeenCalled();
        expect(network).not.toHaveBeenCalled();
        expect(
          await local.repository.getOccurrence(
            isolated.runtime.agentId,
            occurrence.id,
          ),
        ).toEqual(beforeOccurrence);
        return;
      }
      expect(after.deliveryMetadata).toEqual(priorMetadata);
      expect(after.reviewStatus).toBe("unrelated");
      expect(
        (
          await local.repository.getOccurrence(
            isolated.runtime.agentId,
            occurrence.id,
          )
        )?.metadata.reminderAcknowledgedAt,
      ).toBeUndefined();
      // The existing claim expires after five minutes; use its normal retry window.
      const restarted = new LifeOpsService(isolated.runtime);
      const restored = vi
        .spyOn(
          restarted.remindersDomain,
          "classifyReminderOwnerResponseSemantically",
        )
        .mockResolvedValue({
          decision: "explicit_resolution",
          resolution: "completed",
          snoozeRequest: null,
          confidence: 0.95,
          reason: "restored_named_completed",
        });
      const recovered = await restarted.processReminders({
        now: "2026-10-03T06:14:00.000Z",
        scope: "definitions",
      });
      expect(recovered.attempts).toHaveLength(0);
      expect(restored).toHaveBeenCalledTimes(1);
      expect(restored.mock.calls[0][0].text).toBe(reply.content.text);
      const [resolved] = await restarted.repository.listReminderAttempts(
        isolated.runtime.agentId,
        { ownerType: "occurrence", ownerId: occurrence.id },
      );
      expect(resolved.reviewStatus).toBe("resolved");
      expect(resolved.deliveryMetadata).toMatchObject({
        reminderReviewDecision: "completed",
        reminderReviewRespondedAt: new Date(reply.createdAt ?? 0).toISOString(),
        preservedEvidence: "keep",
      });
      const acknowledged = await restarted.repository.getOccurrence(
        isolated.runtime.agentId,
        occurrence.id,
      );
      expect(acknowledged?.metadata.reminderAcknowledgedResolution).toBe(
        "completed",
      );
      expect(acknowledged?.completionPayload).toBeNull();
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
      await isolated.cleanup();
    }
  },
  120_000,
);

function requestMarker() {
  return {
    version: 1,
    scope: `${fixture.runtime.agentId}:${roomId}:${service.ownerEntityId()}`,
    clientMessageId: crypto.randomUUID(),
    fingerprint: "a".repeat(64),
  };
}
function bindCreateRequest(
  message: Memory,
  intents: string[],
  historyMode = "selected",
) {
  if (!message.id) throw new Error("Missing request id");
  const state: State = { text: "current request", values: {}, data: {} };
  const original: ContextObject = {
    id: message.id,
    metadata: { messageId: message.id, roomId: message.roomId },
    events: [
      ...[0, 1].map((i) => ({
        id: `old${i}`,
        type: "segment" as const,
        source: "prior-dialogue",
        segment: {
          id: `old${i}`,
          label: "prior_message:user",
          content: "Old dialogue",
          stable: false,
        },
      })),
      {
        id: "handler",
        type: "message_handler",
        source: "message-service",
        metadata: { processMessage: "RESPOND", plan: { intents } },
      },
    ],
  };
  if (historyMode === "none")
    original.events = original.events.filter(
      (event) => event.source !== "prior-dialogue",
    );
  original.metadata = {
    ...original.metadata,
    completionContext: {
      mode: "selected",
      complete: true,
      sourceSetId: completionContextSources(original).sourceSetId,
      relevantSourceIds: ["h1"],
      constraintSourceIds: [],
      referentSourceIds: [],
      pendingIntentSourceIds: [],
    },
  };
  bindTaskExtractionContext(
    state,
    message,
    original,
    historyMode === "selected"
      ? selectCompletionContext(original).context
      : original,
  );
  expect(readTaskExtractionRequestIntents(state, message)).toEqual(intents);
  return state;
}
const nativeCreatePlan = {
  mode: "create",
  requestKind: "reminder",
  nativeProjection: "in_app_only",
  title: "Stretch shoulders",
  description: null,
  cadenceKind: "once",
  dueInMinutes: 2,
  dueDate: null,
  dueInDays: null,
  dueWeekday: null,
  multiStep: false,
};
it("preserves certified creation after registered discovery in the complete host outcome", async () => {
  const marker = requestMarker();
  const f = await reviewFixture("Remind me here to stretch in two minutes.", {
    channelType: ChannelType.DM,
    chatIdempotency: marker,
  });
  await attestDeliveryAudienceFromCanonicalRoom(fixture.runtime, f.message);
  const state = bindCreateRequest(f.message, ["Create one reminder"]);
  const bindings = Reflect.get(
    globalThis,
    Symbol.for("eliza.task-extraction-context"),
  ) as WeakMap<object, { original: ContextObject }>;
  const original = bindings.get(state.data)?.original;
  if (!original) throw Error("Missing actual planner binding");
  const catalog = collectDiscoveryCatalogActions({
    actions: fixture.runtime.actions,
    message: f.message,
    selectedContexts: ["general"],
    userRoles: ["OWNER"],
  });
  const discovery = createPlannerToolDiscoveryAction(catalog, (discovered) => {
    const routing = getContextRoutingFromState(state);
    state.values[CONTEXT_ROUTING_STATE_KEY] = {
      primaryContext: routing.primaryContext ?? "general",
      secondaryContexts: mergeAgentContexts(
        routing.secondaryContexts,
        ...discovered.map((action) => action.contexts),
      ),
    };
  });
  const actions = [...fixture.runtime.actions, discovery];
  const executorCtx = {
    message: f.message,
    state,
    userRoles: ["OWNER" as const],
    activeContexts: ["general" as const],
    replyOwner: "planner" as const,
  };
  const found = await executeV5PlannedToolCall({
    runtime: fixture.runtime,
    plannerRuntime: fixture.runtime as never,
    plannerContext: original,
    toolCall: {
      name: "DISCOVER_ACTIONS",
      params: { query: "create reminder one-time notification" },
    },
    executorCtx,
    executorOptions: { actions },
  });
  expect(found.success).toBe(true);
  expect(found.data?.readOnlyOperation).toBe(true);
  const created = await runWithTrajectoryContext({ userRole: "OWNER" }, () =>
    executeV5PlannedToolCall({
      runtime: fixture.runtime,
      plannerRuntime: fixture.runtime as never,
      plannerContext: original,
      toolCall: {
        name: "OWNER_REMINDERS_CREATE",
        params: {
          createPlan: {
            ...nativeCreatePlan,
            title: "Stretch after registered discovery",
          },
        },
      },
      executorCtx,
      executorOptions: { actions },
    }),
  );
  expect(created.success).toBe(true);
  const actionResults = summarizeRuntimeActionResults(
    fixture.runtime,
    f.message.id,
    [found, created],
  );
  expect(actionResults.map((result) => result.actionName)).toEqual([
    "DISCOVER_ACTIONS",
    "OWNER_REMINDERS_CREATE",
  ]);
  expect(actionResults[1].values?.ownerRequestHandling).toMatchObject({
    kind: "single_create",
    sourceMessageId: f.message.id,
  });
  await fixture.runtime.updateMemory({
    id: f.message.id as UUID,
    content: {
      ...f.message.content,
      chatIdempotency: {
        ...marker,
        outcomeJson: JSON.stringify({
          userMessageId: f.message.id,
          actionResults,
        }),
      },
    },
  });
  const judge = vi
    .spyOn(service.remindersDomain, "classifyReminderOwnerResponseSemantically")
    .mockResolvedValue({
      decision: "unrelated",
      resolution: null,
      snoozeRequest: null,
      confidence: 1,
      reason: "New reminder is unrelated",
    });
  const review = await service.reviewOwnerResponseAfterReminderAttempt({
    subjectType: "owner",
    attempt: f.attempt,
    now: f.now,
  });
  expect(review.reason).toBe("foreground_single_create_owned");
  expect(judge).not.toHaveBeenCalled();
});
it("defers an active valid host request without consuming the old reminder response", async () => {
  const f = await reviewFixture("Remind me here to stretch in two minutes.", {
    channelType: ChannelType.DM,
    chatIdempotency: requestMarker(),
  });
  const judge = vi
    .spyOn(service.remindersDomain, "classifyReminderOwnerResponseSemantically")
    .mockResolvedValue({
      decision: "unrelated",
      resolution: null,
      snoozeRequest: null,
      confidence: 1,
      reason: "Idle request is unrelated",
    });
  const lease = await fixture.runtime.roomHandlerQueue.acquire(roomId);
  try {
    const review = await service.reviewOwnerResponseAfterReminderAttempt({
      subjectType: "owner",
      attempt: f.attempt,
      now: f.now,
    });
    expect(review).toMatchObject({
      decision: "no_response",
      classifierSource: "none",
      reason: "foreground_request_pending",
    });
    expect(judge).not.toHaveBeenCalled();
    expect(
      await service.repository.listReminderAttempts(fixture.runtime.agentId, {
        ownerType: f.attempt.ownerType,
        ownerId: f.attempt.ownerId,
      }),
    ).toContainEqual(f.attempt);
  } finally {
    await lease.release();
  }
  const idle = await service.reviewOwnerResponseAfterReminderAttempt({
    subjectType: "owner",
    attempt: f.attempt,
    now: f.now,
  });
  expect(idle.reason).not.toBe("foreground_request_pending");
  expect(judge).toHaveBeenCalled();
});
it.each([
  "single",
  "compound",
  "missing_binding",
  "foreign",
  "malformed",
  "failed_receipt",
  "stale_pending",
  "missing_refresh",
  "failed_refresh",
  "same_reminder",
  "queue_live_during_refresh",
  "no_history",
  "full_history",
  "full_history_compound",
  "fallback_projection",
  "fallback_compound",
  "fallback_missing_body",
  "fallback_multistep",
  "discovery_failed",
  "discovery_unknown",
  "discovery_effect",
  "discovery_update",
  "discovery_multiple_creates",
  "discovery_compound",
  "discovery_missing_binding",
])(
  "current creation through the raw host summary preserves %s ownership",
  async (kind) => {
    const marker = requestMarker();
    const f = await reviewFixture(
      "Remind me here to stretch my shoulders in two minutes.",
      { channelType: ChannelType.DM, chatIdempotency: marker },
    );
    if (kind === "same_reminder") {
      const source: Memory = {
        id: crypto.randomUUID() as UUID,
        agentId: fixture.runtime.agentId,
        entityId: fixture.runtime.agentId,
        roomId,
        createdAt: (f.message.createdAt ?? 0) - 1,
        content: {
          text: "The old reminder is due",
          source: "reminder",
          metadata: {
            ownerType: f.attempt.ownerType,
            ownerId: f.attempt.ownerId,
          },
        },
      };
      await fixture.runtime.createMemory(source, "messages");
      f.message.content.inReplyTo = source.id;
      await fixture.runtime.updateMemory({
        id: f.message.id as UUID,
        content: f.message.content,
      });
    }
    const state = ["missing_binding", "discovery_missing_binding"].includes(
      kind,
    )
      ? undefined
      : bindCreateRequest(
          f.message,
          [
            "compound",
            "full_history_compound",
            "fallback_compound",
            "discovery_compound",
          ].includes(kind)
            ? ["Create reminder", "Snooze an older reminder"]
            : ["Create reminder"],
          kind === "no_history"
            ? "none"
            : ["full_history", "full_history_compound"].includes(kind)
              ? "full"
              : "selected",
        );
    const fallback = kind.startsWith("fallback_");
    if (fallback) {
      const extracted = taskPlans.buildTaskCreatePlan(nativeCreatePlan);
      if (!extracted) throw Error("Invalid extraction fixture");
      vi.spyOn(taskPlans, "extractTaskCreatePlanWithLlm").mockResolvedValue(
        extracted,
      );
    }
    const createPlan = {
      ...nativeCreatePlan,
      title: `Stretch shoulders ${kind}`,
      ...(fallback ? { nativeProjection: null } : {}),
      ...(kind === "fallback_multistep" ? { multiStep: true } : {}),
    };
    if (kind === "fallback_missing_body")
      delete (createPlan as Partial<typeof createPlan>).description;
    const result = await runLifeOperationHandler(
      fixture.runtime,
      f.message,
      state,
      {
        parameters: {
          action: "create",
          kind: "habit",
          ownerSurface: "OWNER_REMINDERS",
          intent: f.message.content.text,
          createPlan,
        },
      },
    );
    expect(result.success).toBe(true);
    const actionResults = summarizeRuntimeActionResults(
      fixture.runtime,
      f.message.id,
      [{ ...result, actionName: "OWNER_REMINDERS_CREATE" }],
    );
    expect(actionResults[0].values?.ownerRequestHandling !== undefined).toBe(
      ![
        "compound",
        "full_history_compound",
        "missing_binding",
        "fallback_compound",
        "fallback_missing_body",
        "fallback_multistep",
        "discovery_compound",
        "discovery_missing_binding",
      ].includes(kind),
    );
    if (kind === "foreign")
      marker.scope = `${fixture.runtime.agentId}:${roomId}:foreign`;
    if (kind === "malformed")
      actionResults[0].values = {
        ownerRequestHandling: { kind: "single_create" },
      };
    if (kind === "failed_receipt")
      actionResults[0].effectReceipts = [
        normalizeEffectReceipt({
          ...actionResults[0].effectReceipts?.[0],
          outcome: "failed",
          commit: undefined,
          failure: {
            code: "TEST_REJECTED",
            retryable: false,
            acceptance: "rejected",
          },
        }),
      ];
    if (kind.startsWith("discovery_")) {
      actionResults.unshift({
        actionName: "DISCOVER_ACTIONS",
        success: kind !== "discovery_failed",
      });
      if (kind === "discovery_unknown")
        actionResults[0].actionName = "UNKNOWN_ACTION";
      if (kind === "discovery_effect")
        actionResults[0].effectReceipts = actionResults[1].effectReceipts;
      if (kind === "discovery_update")
        actionResults.push({
          actionName: "OWNER_REMINDERS_UPDATE",
          success: true,
          effectReceipts: actionResults[1].effectReceipts,
        });
      if (kind === "discovery_multiple_creates")
        actionResults.push({ ...actionResults[1] });
    }
    await fixture.runtime.updateMemory({
      id: f.message.id as UUID,
      content: {
        ...f.message.content,
        chatIdempotency: {
          ...marker,
          outcomeJson: JSON.stringify({
            userMessageId: f.message.id,
            actionResults,
          }),
        },
      },
    });
    let releaseRefreshLease: (() => Promise<void>) | undefined;
    if (
      [
        "stale_pending",
        "missing_refresh",
        "failed_refresh",
        "queue_live_during_refresh",
      ].includes(kind)
    ) {
      const readSnapshot = fixture.runtime.getMemoriesByRoomIds.bind(
        fixture.runtime,
      );
      vi.spyOn(fixture.runtime, "getMemoriesByRoomIds").mockImplementation(
        async (args) =>
          (await readSnapshot(args)).map((memory) =>
            memory.id === f.message.id ? f.message : memory,
          ),
      );
      if (kind === "missing_refresh")
        vi.spyOn(fixture.runtime, "getMemoryById").mockResolvedValue(null);
      if (kind === "queue_live_during_refresh")
        vi.spyOn(fixture.runtime, "getMemoryById").mockImplementation(
          async () => {
            const lease =
              await fixture.runtime.roomHandlerQueue.acquire(roomId);
            releaseRefreshLease = () => lease.release();
            return f.message;
          },
        );
      if (kind === "failed_refresh")
        vi.spyOn(fixture.runtime, "getMemoryById").mockRejectedValue(
          Error("Read unavailable"),
        );
    }
    const judge = vi
      .spyOn(
        service.remindersDomain,
        "classifyReminderOwnerResponseSemantically",
      )
      .mockResolvedValue({
        decision: "unrelated",
        resolution: null,
        snoozeRequest: null,
        confidence: 1,
        reason: "Unrelated new request",
      });
    const review = await service
      .reviewOwnerResponseAfterReminderAttempt({
        subjectType: "owner",
        attempt: f.attempt,
        now: f.now,
      })
      .finally(async () => {
        await releaseRefreshLease?.();
      });
    if (kind === "queue_live_during_refresh") {
      expect(review).toMatchObject({
        decision: "no_response",
        classifierSource: "none",
        reason: "foreground_request_pending",
      });
      expect(judge).not.toHaveBeenCalled();
      return;
    }
    if (["missing_refresh", "failed_refresh"].includes(kind)) {
      expect(review).toMatchObject({
        decision: "no_response",
        classifierSource: "none",
        reason: "foreground_request_refresh_unknown",
      });
      expect(judge).not.toHaveBeenCalled();
      return;
    }
    expect(review.decision).toBe("unrelated");
    if (
      [
        "single",
        "stale_pending",
        "no_history",
        "full_history",
        "fallback_projection",
      ].includes(kind)
    ) {
      expect(review.reason).toBe("foreground_single_create_owned");
      expect(judge).not.toHaveBeenCalled();
    } else expect(judge).toHaveBeenCalled();
  },
);

it("keeps normal delivery admitted for a freshly active definition", async () => {
  const f = await reviewFixture("Unrelated current request");
  if (!f.original.reminderPlan) throw Error("Missing plan");
  const emit = vi
    .spyOn(
      service.remindersDomain as unknown as {
        emitInAppReminderNudge: (args: unknown) => Promise<void>;
      },
      "emitInAppReminderNudge",
    )
    .mockResolvedValue(undefined);
  const before = await service.repository.getOccurrence(
    fixture.runtime.agentId,
    f.occurrence.id,
  );
  const delivered = await service.remindersDomain.dispatchReminderAttempt({
    plan: f.original.reminderPlan,
    ownerType: "occurrence",
    ownerId: f.occurrence.id,
    occurrenceId: f.occurrence.id,
    subjectType: "owner",
    title: f.occurrence.title,
    channel: "in_app",
    stepIndex: 0,
    scheduledFor: f.attempt.scheduledFor,
    dueAt: f.occurrence.dueAt,
    urgency: "high",
    quietHours: {},
    acknowledged: false,
    attemptedAt: f.now.toISOString(),
    timezone: "UTC",
    definition: f.original.definition,
    bodyOverride: "Admitted active reminder",
  });
  expect(delivered.outcome).toBe("delivered");
  expect(emit).toHaveBeenCalledTimes(1);
  expect(
    await service.repository.getOccurrence(
      fixture.runtime.agentId,
      f.occurrence.id,
    ),
  ).toEqual(before);
});

it.each(["completed", "snoozed"] as const)(
  "enforces active admission at the %s mutation boundary",
  async (resolution) => {
    for (const change of ["archived", "active_revision", "none"] as const) {
      const f = await reviewFixture(`Admission ${resolution} ${change}`);
      const definitionRevision = f.original.definition.updatedAt;
      const originalUpdate = service.repository.updateOccurrence.bind(
        service.repository,
      );
      const originalSnooze = service.snoozeOccurrence.bind(service);
      let changed = false;
      const changeDefinition = async () => {
        if (changed || change === "none") return;
        changed = true;
        await service.updateDefinition(
          f.original.definition.id,
          change === "archived"
            ? { status: "archived" }
            : { title: "Still active but changed" },
        );
      };
      const update = vi
        .spyOn(service.repository, "updateOccurrence")
        .mockImplementation(async (occurrence, options) => {
          if (occurrence.id === f.occurrence.id && resolution === "completed")
            await changeDefinition();
          return originalUpdate(occurrence, options);
        });
      const snooze = vi
        .spyOn(service, "snoozeOccurrence")
        .mockImplementation(async (id, request, now, options) => {
          if (id === f.occurrence.id) await changeDefinition();
          return originalSnooze(id, request, now, options);
        });
      try {
        const resolving =
          service.remindersDomain.resolveReminderReviewFromOwnerResponse({
            ownerType: "occurrence",
            ownerId: f.occurrence.id,
            attempt: f.attempt,
            reviewedAt: f.now.toISOString(),
            resolution,
            responseText: "Bound owner response",
            respondedAt: f.now.toISOString(),
            snoozeRequest: resolution === "snoozed" ? { minutes: 10 } : null,
            confidence: 1,
            reason: "admitted_semantic_response",
            classifierSource: "semantic",
          });
        if (change === "active_revision")
          await expect(resolving).rejects.toMatchObject({
            code: "LIFEOPS_OCCURRENCE_CONFLICT",
          });
        else await resolving;
        const [attempt] = await service.repository.listReminderAttempts(
          fixture.runtime.agentId,
          { ownerType: "occurrence", ownerId: f.occurrence.id },
        );
        const occurrence = await service.repository.getOccurrence(
          fixture.runtime.agentId,
          f.occurrence.id,
        );
        if (change === "none") {
          expect(attempt.reviewStatus).toBe("resolved");
          if (resolution === "snoozed")
            expect(occurrence?.state).toBe("snoozed");
          else
            expect(occurrence?.metadata.reminderAcknowledgedResolution).toBe(
              "completed",
            );
        } else {
          expect(occurrence?.metadata.reminderAcknowledgedAt).toBeUndefined();
          expect(occurrence?.snoozedUntil).toBeNull();
          if (change === "archived")
            expect(attempt).toMatchObject({
              reviewStatus: "resolved",
              deliveryMetadata: {
                reviewReason: "definition_archived",
                reminderReviewDecision: "no_response",
              },
            });
          else
            expect(attempt.deliveryMetadata).toEqual(
              f.attempt.deliveryMetadata,
            );
        }
        expect(
          update.mock.calls.find(([row]) => row.id === f.occurrence.id)?.[1]
            ?.expectedDefinitionUpdatedAt,
        ).toBe(definitionRevision);
        if (resolution === "snoozed")
          expect(snooze.mock.calls[0]?.[3]?.expectedDefinitionUpdatedAt).toBe(
            definitionRevision,
          );
      } finally {
        update.mockRestore();
        snooze.mockRestore();
      }
    }
  },
);
