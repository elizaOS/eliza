import { randomUUID } from "node:crypto";
import {
  AgentEventService,
  createCharacter,
  createReminderPresentation,
  ensureAgentVoice,
  NotificationService,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing";
import { expect, it, vi } from "vitest";
import { RemindersDomain } from "../../../plugins/plugin-personal-assistant/src/lifeops/domains/reminders-service.ts";
import { ensureOwnerConversation } from "../src/api/conversation-routes.ts";
import { maybeRouteAutonomyEventToConversation } from "../src/api/server-autonomy-helpers.ts";
import type { ServerState } from "../src/api/server-types.ts";

it("delivers saved facts through chat voice boundary and notification store without models", async () => {
  const runtime = createSQLiteTestRuntime({
    character: createCharacter({ name: "ReminderProof" }),
    plugins: [
      {
        name: "notice",
        description: "notice",
        services: [AgentEventService, NotificationService],
      },
    ],
    enableAutonomy: false,
    logLevel: "fatal",
  });
  const model = vi
    .spyOn(runtime, "useModel")
    .mockRejectedValue(Error("No generation allowed"));
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
    await runtime.initialize();
    const conv = await ensureOwnerConversation(state, runtime);
    const events = runtime.getService<AgentEventService>("agent_event")!;
    events.subscribe((event) => {
      if (event.stream === "assistant")
        pending.push(maybeRouteAutonomyEventToConversation(state, event));
    });
    const domain = new RemindersDomain(
      {
        runtime,
        agentId: () => runtime.agentId,
        repository: { createReminderAttempt: async () => undefined },
        emitAssistantEvent: (
          text: string,
          source: string,
          data: Record<string, unknown>,
        ) => {
          canonicalChat = text;
          events.emit({
            runId: randomUUID(),
            stream: "assistant",
            data: { text, source, ...data },
          });
          return true;
        },
      } as never,
      {} as never,
    );
    vi.spyOn(domain, "recordReminderAudit").mockResolvedValue(undefined);
    const due = "2026-09-29T14:26:01.193Z";
    const attempt = await domain.dispatchReminderAttempt({
      plan: { id: randomUUID() } as never,
      ownerType: "occurrence",
      ownerId: randomUUID(),
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
    const notices = runtime
      .getService<NotificationService>("notification")!
      .list();
    expect(notices).toHaveLength(1);
    const body = notices[0].body!;
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
    expect(model).not.toHaveBeenCalled();
    const rendered = vi
      .spyOn(domain, "renderReminderBody")
      .mockResolvedValue("Recurring reminder text");
    model.mockResolvedValue("Voiced recurring reminder");
    await domain.dispatchReminderAttempt({
      plan: { id: randomUUID() } as never,
      ownerType: "occurrence",
      ownerId: randomUUID(),
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
    expect(rendered).toHaveBeenCalledOnce();
    expect(model).toHaveBeenCalled();
    rendered.mockRestore();
    model.mockClear();

    model.mockResolvedValueOnce("A normal voiced message");
    expect(
      (
        await ensureAgentVoice(
          runtime,
          { text: "Ordinary autonomy message" },
          { source: "autonomy" },
        )
      ).text,
    ).toBe("A normal voiced message");
    expect(model).toHaveBeenCalledOnce();
    model.mockClear();

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
    model.mockRestore();
    await runtime.stop();
    await runtime.close();
  }
}, 120000);
