/** Durable recovery storage boundary: no model, transport or action execution. */
import { randomUUID } from "node:crypto";
import {
  type AgentRuntime,
  conversationClientUserMemoryId,
  type UUID,
} from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { persistConversationReplyRecovery } from "../src/api/conversation-routes";

it.each([
  { approved: true, uncertain: false },
  { approved: false, uncertain: false },
  { approved: true, uncertain: true },
])(
  "preserves projection authority and recovery safety: %j",
  async ({ approved, uncertain }) => {
    const agentId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    const scope = "test-owner-turn";
    const clientMessageId = "current-request";
    const userId = conversationClientUserMemoryId(scope, clientMessageId);
    const assistantId = randomUUID() as UUID;
    const navigation = {
      effect: "view_navigation",
      status: "delivered",
      viewId: "notes",
      path: "/notes",
      label: "Notes",
      stepId: null,
      handoffId: "delivery-1",
    };
    const component = vi.fn();
    const action = {
      success: true,
      transcriptVisibility: "internal" as const,
      modelReplyRequired: true,
      text: JSON.stringify(navigation),
      values: { completedActionDelivered: true },
      data: {
        view: { id: "notes", component },
        navigation,
        ...(uncertain ? { committed: "unknown" } : {}),
      },
      ...(approved
        ? {
            promptDataMode: "replace-data" as const,
            promptData: { actionName: "VIEWS_SHOW", navigation },
          }
        : {}),
    };
    const user = {
      id: userId,
      roomId,
      content: {
        text: "Open Notes and save the note",
        chatIdempotency: {
          version: 1,
          scope,
          clientMessageId,
          fingerprint: "a".repeat(64),
        },
      },
    };
    const assistant = {
      id: assistantId,
      roomId,
      entityId: agentId,
      agentId,
      content: { text: "Reply unavailable", inReplyTo: userId },
    };
    const updates: Array<{ id: UUID; content: Record<string, unknown> }> = [];
    const runtime = {
      agentId,
      getMemoriesByIds: async (ids: UUID[]) =>
        ids.map((id) => (id === userId ? user : assistant)),
      updateMemory: async (update: {
        id: UUID;
        content: Record<string, unknown>;
      }) => {
        updates.push(update);
      },
      roomHandlerQueue: {
        runInLease: async (
          _room: UUID,
          _lease: unknown,
          fn: () => Promise<void>,
        ) => fn(),
      },
      getSetting: () => undefined,
      reportError: vi.fn(),
    } as unknown as AgentRuntime;
    const result = {
      replyRecovery: {
        context:
          "Complete original request, constraints, record read and navigation receipt",
        pendingToolCalls: [],
        evaluatorOutputs: [],
        ownerExclusiveDisclosureUsed: false,
        actionResults: [
          action,
          {
            success: true,
            data: {
              actionName: "NOTES_CREATE",
              note: { title: "Saved title", body: "Keep two  spaces." },
            },
            effectReceipts: [
              {
                receiptId: "saved-note-proof",
                operation: "notes.note.create",
                resource: { kind: "notes.note", id: "saved-note" },
                artifacts: [],
                idempotency: { key: null, replayed: false },
                observedAt: "2026-09-30T18:39:00.000Z",
                outcome: "applied" as const,
                commit: {
                  kind: "durable" as const,
                  id: "saved-note",
                  committedAt: "2026-09-30T18:39:00.000Z",
                },
              },
            ],
          },
        ],
      },
    };
    const ok = await persistConversationReplyRecovery(
      runtime,
      roomId,
      userId,
      assistantId,
      result as never,
      {} as never,
    );
    expect(component).not.toHaveBeenCalled();
    expect(action.data.view.component).toBe(component);
    if (!approved) {
      expect(ok).toBe(false);
      expect(updates).toHaveLength(0);
      expect(runtime.reportError).toHaveBeenCalled();
      return;
    }
    expect(ok).toBe(!uncertain);
    expect(updates).toHaveLength(uncertain ? 1 : 2);
    const marker = updates[0].content.chatIdempotency as {
      replyRecoveryJson: string;
    };
    const saved = JSON.parse(marker.replyRecoveryJson);
    expect(saved.context).toBe(result.replyRecovery.context);
    expect(saved.actionResults[0].data).toEqual({
      actionName: "VIEWS_SHOW",
      navigation,
      ...(uncertain ? { committed: "unknown" } : {}),
    });
    expect(saved.actionResults[0].values).toEqual(action.values);
    expect(saved.actionResults[0].text).toBe(action.text);
    expect(saved.actionResults[1].data.note.body).toBe("Keep two  spaces.");
    expect(saved.actionResults[1].effectReceipts[0]).toMatchObject({
      receiptId: "saved-note-proof",
      outcome: "applied",
      resource: { kind: "notes.note", id: "saved-note" },
      commit: { kind: "durable", id: "saved-note" },
      idempotency: { replayed: false },
    });
    expect(saved.assistantMessageId).toBe(assistantId);
    if (!uncertain)
      expect(updates[1].content.replyRecoveryAvailable).toBe(true);
  },
);
