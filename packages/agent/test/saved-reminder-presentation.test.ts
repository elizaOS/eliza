import { randomUUID } from "node:crypto";
import {
  AgentEventService,
  createReminderPresentation,
  ensureAgentVoice,
  ModelType,
  NOTIFICATION_STREAM,
  NotificationService,
} from "@elizaos/core";
import { expect, it } from "vitest";
import {
  createLifeOpsReminderPlan,
  LifeOpsRepository,
} from "../../../plugins/plugin-personal-assistant/src/lifeops/repository.ts";
import { LifeOpsService } from "../../../plugins/plugin-personal-assistant/src/lifeops/service.ts";
import { createRealTestRuntime } from "../../app/test/helpers/real-runtime.ts";
import { ensureOwnerConversation } from "../src/api/conversation-routes.ts";
import { maybeRouteAutonomyEventToConversation } from "../src/api/server-autonomy-helpers.ts";
import type { ServerState } from "../src/api/server-types.ts";
import { AUTONOMY_NOTIFICATION_DELIVERY } from "../src/runtime/agent-event-service.ts";

it("delivers saved facts through chat voice boundary and notification store without models", async () => {
  const host = await createRealTestRuntime({
    characterName: "ReminderProof",
    plugins: [
      {
        name: "notice",
        description: "notice",
        services: [AgentEventService, NotificationService],
      },
    ],
  });
  const runtime = host.runtime;
  let modelCalls = 0;
  let modelResponse: string | undefined;
  runtime.registerModel(
    ModelType.TEXT_SMALL,
    async () => {
      modelCalls++;
      if (modelResponse === undefined) throw new Error("No generation allowed");
      return modelResponse;
    },
    "reminder-test-provider",
    1000,
  );
  const broadcasts: unknown[] = [];
  const state = {
    runtime,
    config: {},
    agentName: "ReminderProof",
    adminEntityId: null,
    chatUserId: null,
    logBuffer: [],
    conversations: new Map(),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
    broadcastWs: (e: unknown) => broadcasts.push(e),
  } as unknown as ServerState;
  const pending: Promise<void>[] = [];
  let canonicalChat: string | undefined;
  const requestedBody =
    "\n  Clock scope reminder QA, verification cdfaacf9.\nRésumé — café ☕; exact punctuation!  \n";
  const nativeEvents: Record<string, unknown>[] = [];
  try {
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const conv = await ensureOwnerConversation(state, runtime);
    const events = runtime.getService<AgentEventService>("agent_event");
    if (!events) throw new Error("Missing agent event service");
    events.subscribe((event) => {
      if (event.stream === NOTIFICATION_STREAM) nativeEvents.push(event.data);
      if (event.stream === "assistant") {
        canonicalChat =
          typeof event.data.text === "string" ? event.data.text : undefined;
        pending.push(maybeRouteAutonomyEventToConversation(state, event));
      }
    });
    const duplicateRoute = events.subscribe((event) => {
      if (event.stream === "assistant")
        pending.push(maybeRouteAutonomyEventToConversation(state, event));
      expect(JSON.stringify(event.data)).not.toContain('"publish":');
      expect(JSON.stringify(event.data)).not.toContain('"routed":');
    });
    const domain = new LifeOpsService(runtime);
    const plan = createLifeOpsReminderPlan({
      agentId: runtime.agentId,
      ownerType: "occurrence",
      ownerId: randomUUID(),
      steps: [],
      mutePolicy: {},
      quietHours: {},
    });
    await repository.createReminderPlan(plan);
    const notifier = runtime.getService<NotificationService>("notification");
    if (!notifier) throw Error("Missing notification service");
    const committedSources = new Set<string>();
    const createMemory = runtime.createMemory.bind(runtime);
    runtime.createMemory = async (
      ...args: Parameters<typeof runtime.createMemory>
    ) => {
      const result = await createMemory(...args);
      if (args[0].content.source === "reminder")
        committedSources.add(args[0].id ?? "");
      return result;
    };
    const notify = notifier.notify.bind(notifier);
    const publishedBodies: string[] = [];
    notifier.notify = async (input) => {
      if (typeof input.body === "string") publishedBodies.push(input.body);
      const messageId = input.data?.messageId;
      if (typeof messageId === "string") {
        expect(committedSources.has(messageId)).toBe(true);
        expect(
          await runtime.getMemoriesByIds(
            [messageId as import("@elizaos/core").UUID],
            "messages",
          ),
        ).toHaveLength(1);
      }
      return notify(input);
    };
    const due = "2026-09-29T14:26:01.193Z";
    const attempt = await domain.dispatchReminderAttempt({
      plan,
      ownerType: "occurrence",
      ownerId: plan.ownerId,
      occurrenceId: randomUUID(),
      subjectType: "owner",
      title: 'Check "Monday"  exactly',
      channel: "in_app",
      stepIndex: 0,
      scheduledFor: due,
      dueAt: due,
      urgency: "medium",
      quietHours: {},
      acknowledged: false,
      attemptedAt: "2026-09-29T14:26:37Z",
      timezone: "America/Los_Angeles",
      definition: {
        kind: "habit",
        description: requestedBody,
        metadata: { ownerSurface: "OWNER_REMINDERS" },
        cadence: { kind: "once", dueAt: due },
      },
    });
    await Promise.all(pending);
    expect(attempt.outcome).toBe("delivered");
    const notifications =
      runtime.getService<NotificationService>("notification");
    if (!notifications) throw new Error("Missing notification service");
    const notices = notifications.list();
    expect(notices).toHaveLength(1);
    const body = notices[0]?.body;
    if (typeof body !== "string") throw new Error("Missing notification body");
    expect(body).toBe(requestedBody);
    expect(
      publishedBodies.filter((text) => text === requestedBody),
    ).toHaveLength(1);
    const nativeBodyEvents = nativeEvents.filter(
      (data) =>
        data.type === "notification" &&
        (data.notification as { body?: string } | undefined)?.body ===
          requestedBody,
    );
    expect(nativeBodyEvents).toHaveLength(1);
    const messages = await runtime.getMemories({
      roomId: conv.roomId,
      tableName: "messages",
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].content.text).toBe(canonicalChat);
    expect(messages[0].content.metadata).toMatchObject({
      ownerType: "occurrence",
      ownerId: plan.ownerId,
      subjectType: "owner",
      scheduledFor: due,
      dueAt: due,
    });
    expect(canonicalChat).toBe(body);
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({ text: canonicalChat }),
      }),
    );
    expect(messages[0].content.text).not.toContain("[CHOICE:");
    expect(notices[0].deepLink).toBe("/chat");
    expect(notices[0].data).toMatchObject({
      conversationId: conv.id,
      messageId: messages[0].id,
    });
    expect(JSON.stringify(messages[0].content)).not.toContain(
      "notificationDelivery",
    );
    expect(modelCalls).toBe(0);
    expect(
      await repository.listReminderAttempts(runtime.agentId),
    ).toContainEqual(
      expect.objectContaining({
        id: attempt.id,
        outcome: "delivered",
        deliveryMetadata: expect.objectContaining({ message: body }),
      }),
    );
    const secondOwner = randomUUID();
    const secondPlan = { ...plan, id: randomUUID(), ownerId: secondOwner };
    await repository.createReminderPlan(secondPlan);
    await domain.dispatchReminderAttempt({
      plan: secondPlan,
      ownerType: "occurrence",
      ownerId: secondOwner,
      occurrenceId: secondOwner,
      subjectType: "owner",
      title: "Second reminder",
      channel: "in_app",
      stepIndex: 0,
      scheduledFor: due,
      dueAt: due,
      urgency: "medium",
      quietHours: {},
      acknowledged: false,
      attemptedAt: "2026-09-29T14:26:37Z",
      timezone: "UTC",
      definition: {
        kind: "habit",
        metadata: { ownerSurface: "OWNER_REMINDERS" },
        cadence: { kind: "once", dueAt: due },
      },
    });
    await Promise.all(pending);
    const linked = notifications.list();
    const stored = await runtime.getMemories({
      roomId: conv.roomId,
      tableName: "messages",
    });
    expect(linked).toHaveLength(2);
    expect(stored).toHaveLength(2);
    expect(new Set(linked.map((n) => n.data?.messageId)).size).toBe(2);
    for (const notification of linked) {
      const memory = stored.find((m) => m.id === notification.data?.messageId);
      expect(memory).toBeDefined();
      expect(notification.data?.conversationId).toBe(conv.id);
      expect(memory?.content.metadata).not.toHaveProperty("publish");
      expect(memory?.content.metadata).not.toHaveProperty("notification");
    }
    duplicateRoute();

    modelResponse = "Voiced recurring reminder";
    await domain.dispatchReminderAttempt({
      plan,
      ownerType: "occurrence",
      ownerId: plan.ownerId,
      occurrenceId: randomUUID(),
      subjectType: "owner",
      title: "Recurring",
      channel: "in_app",
      stepIndex: 0,
      scheduledFor: due,
      dueAt: due,
      urgency: "medium",
      quietHours: {},
      acknowledged: false,
      attemptedAt: "2026-09-29T14:26:37Z",
      timezone: "UTC",
      definition: {
        kind: "habit",
        metadata: { ownerSurface: "OWNER_REMINDERS" },
        cadence: { kind: "daily", windows: ["morning"] },
        description: "Internal scheduling context for a habit",
      },
    });
    await Promise.all(pending);
    expect(modelCalls).toBeGreaterThan(0);
    expect(notifications.list().at(-1)?.body).not.toContain(
      "Internal scheduling context",
    );
    modelCalls = 0;

    const previousConversations = new Map(state.conversations);
    state.conversations.clear();
    const fallbackOwner = randomUUID();
    await domain.dispatchReminderAttempt({
      plan: { ...plan, ownerId: fallbackOwner },
      ownerType: "occurrence",
      ownerId: fallbackOwner,
      occurrenceId: fallbackOwner,
      subjectType: "owner",
      title: "Fallback reminder",
      channel: "in_app",
      stepIndex: 0,
      scheduledFor: due,
      dueAt: due,
      urgency: "medium",
      quietHours: {},
      acknowledged: false,
      attemptedAt: "2026-09-29T14:26:37Z",
      timezone: "UTC",
      definition: {
        kind: "habit",
        metadata: { ownerSurface: "OWNER_REMINDERS" },
        cadence: { kind: "once", dueAt: due },
      },
    });
    await Promise.all(pending);
    const fallback = notifications
      .list()
      .filter((n) => n.data?.ownerId === fallbackOwner);
    expect(fallback).toHaveLength(1);
    expect(fallback[0].data).not.toHaveProperty("messageId");
    expect(fallback[0].deepLink).toBe("/chat");
    state.conversations = previousConversations;

    modelResponse = "\n  A normal voiced message  \n";
    await maybeRouteAutonomyEventToConversation(state, {
      runId: randomUUID(),
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "\n  Ordinary autonomy message  \n", source: "autonomy" },
    });
    const ordinaryMessages = await runtime.getMemories({
      roomId: conv.roomId,
      tableName: "messages",
    });
    expect(
      ordinaryMessages.find((m) => m.content.source === "autonomy")?.content
        .text,
    ).toBe("A normal voiced message");
    expect(modelCalls).toBe(1);
    modelCalls = 0;
    await maybeRouteAutonomyEventToConversation(state, {
      runId: randomUUID(),
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "\n  Ephemeral relay  \n", source: "coordinator" },
    });
    expect(broadcasts.at(-1)).toMatchObject({
      message: { text: "Ephemeral relay" },
    });
    expect(
      await runtime.getMemories({ roomId: conv.roomId, tableName: "messages" }),
    ).toHaveLength(ordinaryMessages.length);
    expect(modelCalls).toBe(0);

    const marker = createReminderPresentation(body, body, "Reminder");
    await expect(
      ensureAgentVoice(
        runtime,
        {
          text: "Hey Nubs, just a nudge: time to check that in-app notification. You're all clear otherwise until Monday.",
          reminderPresentation: marker,
        },
        { source: "reminder" },
      ),
    ).rejects.toThrow("mismatched");
    await expect(
      ensureAgentVoice(
        runtime,
        {
          text: body,
          reminderPresentation: JSON.parse(JSON.stringify(marker)),
        },
        { source: "reminder" },
      ),
    ).rejects.toThrow("Untrusted");
    const messageCount = (
      await runtime.getMemories({ roomId: conv.roomId, tableName: "messages" })
    ).length;
    const notificationCount = notifications.list().length;
    const broadcastCount = broadcasts.length;
    let forgedPublications = 0;
    for (const data of [
      { text: body, reminderPresentation: JSON.parse(JSON.stringify(marker)) },
      { text: body.trim(), reminderPresentation: marker },
      { text: `${body}altered`, reminderPresentation: marker },
      {
        text: body,
        reminderPresentation: { ...marker, chatText: `${body}altered` },
      },
    ]) {
      const handoff = {
        publish: async () => {
          forgedPublications++;
          return notifications.notify({
            title: "Rejected presentation",
            body,
            category: "reminder",
            source: "lifeops",
          });
        },
      };
      await expect(
        maybeRouteAutonomyEventToConversation(state, {
          runId: randomUUID(),
          seq: 1,
          stream: "assistant",
          ts: Date.now(),
          data: {
            ...data,
            source: "reminder",
            [AUTONOMY_NOTIFICATION_DELIVERY]: handoff,
          },
        }),
      ).rejects.toThrow(/Untrusted|mismatched/);
    }
    expect(forgedPublications).toBe(0);
    expect(
      await runtime.getMemories({ roomId: conv.roomId, tableName: "messages" }),
    ).toHaveLength(messageCount);
    expect(notifications.list()).toHaveLength(notificationCount);
    expect(broadcasts).toHaveLength(broadcastCount);
    expect(modelCalls).toBe(0);
  } finally {
    await Promise.allSettled(pending);
    await host.cleanup();
  }
}, 120000);
