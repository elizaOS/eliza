/** Durable owner-response review consumption against the real repository. */
import {
  ChannelType,
  hardenIncomingUserMessage,
  type Memory,
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
import { createLifeOpsTestRuntime } from "../../../test/helpers/runtime.js";
import { createLifeOpsReminderAttempt } from "../repository.js";
import { LifeOpsService } from "../service.js";
import { decideReminderReviewTransition } from "../service-helpers-reminder.js";

let fixture: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>;
let service: LifeOpsService;
let roomId: UUID;
let nextTime = Date.parse("2026-10-03T02:28:10.796Z");
beforeAll(async () => {
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
    id: crypto.randomUUID() as UUID,
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
