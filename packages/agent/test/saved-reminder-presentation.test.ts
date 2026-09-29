import { randomUUID } from "node:crypto";
import {
  AgentEventService,
  createReminderPresentation,
  ensureAgentVoice,
  ModelType,
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
  try {
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const conv = await ensureOwnerConversation(state, runtime);
    const events = runtime.getService<AgentEventService>("agent_event");
    if (!events) throw new Error("Missing agent event service");
    events.subscribe((event) => {
      if (event.stream === "assistant") {
        canonicalChat =
          typeof event.data.text === "string" ? event.data.text : undefined;
        pending.push(maybeRouteAutonomyEventToConversation(state, event));
      }
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
    expect(body).toContain('Check "Monday"  exactly');
    expect(body).not.toContain("all clear");
    expect(body).toContain("7:26:01 AM");
    const messages = await runtime.getMemories({
      roomId: conv.roomId,
      tableName: "messages",
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].content.text).toBe(canonicalChat);
    expect(canonicalChat?.split("\n\n[CHOICE:")[0]).toBe(body);
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({ text: canonicalChat }),
      }),
    );
    expect(messages[0].content.text).toContain("[CHOICE:lifeops-reminder");
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
      },
    });
    await Promise.all(pending);
    expect(modelCalls).toBeGreaterThan(0);
    modelCalls = 0;

    modelResponse = "A normal voiced message";
    expect(
      (
        await ensureAgentVoice(
          runtime,
          { text: "Ordinary autonomy message" },
          { source: "autonomy" },
        )
      ).text,
    ).toBe("A normal voiced message");
    expect(modelCalls).toBe(1);
    modelCalls = 0;

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
  } finally {
    await Promise.allSettled(pending);
    await host.cleanup();
  }
}, 120000);
