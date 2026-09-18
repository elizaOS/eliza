/**
 * Pins the delivery target chosen by the proactive `client_chat` recency
 * fallback when a conversation carries an unparseable `updatedAt`.
 *
 * Drives the real exported `registerClientChatSendHandler` through a runtime
 * stand-in that mirrors send-handler routing, and asserts where the message was
 * actually persisted — the observable consequence is the room it landed in, not
 * the sorted array. Kept in its own file so the case does not depend on the
 * heavier swarm imports the sibling suite pulls in.
 */
import crypto from "node:crypto";
import type {
  Content,
  IAgentRuntime,
  Memory,
  SendHandlerFunction,
  TargetInfo,
  UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ConversationMeta, ServerState } from "../api/server-types.ts";
import { registerClientChatSendHandler } from "./client-chat-sender.ts";

function makeRuntime() {
  const handlers = new Map<string, SendHandlerFunction>();
  const connectors: Array<{ source: string }> = [];
  const created: Memory[] = [];
  const runtime = {
    agentId: crypto.randomUUID() as UUID,
    registerSendHandler(source: string, handler: SendHandlerFunction) {
      handlers.set(source, handler);
      connectors.push({ source });
    },
    registerInternalSendHandler(source: string, handler: SendHandlerFunction) {
      handlers.set(source, handler);
    },
    getMessageConnectors() {
      return connectors;
    },
    createMemory: vi.fn(async (memory: Memory) => {
      created.push(memory);
      return memory.id as UUID;
    }),
    async sendMessageToTarget(
      target: TargetInfo,
      content: Content,
    ): Promise<Memory | undefined> {
      const source =
        typeof target.source === "string" ? target.source.trim() : "";
      const handler = handlers.get(source);
      if (!handler) {
        throw new Error(`No send handler registered for source: ${source}`);
      }
      return (await handler(
        runtime as unknown as IAgentRuntime,
        target,
        content,
      )) as Memory | undefined;
    },
  };
  return { runtime, created };
}

function makeState(conversations: ConversationMeta[]) {
  const map = new Map<string, ConversationMeta>();
  for (const conversation of conversations)
    map.set(conversation.id, conversation);
  const broadcastWs = vi.fn();
  return {
    state: {
      conversations: map,
      activeConversationId: null,
      broadcastWs,
    } as unknown as ServerState,
    broadcastWs,
  };
}

function conv(id: string, roomId: string, updatedAt: string): ConversationMeta {
  return {
    id,
    title: id,
    roomId: roomId as UUID,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}

describe("client_chat recency fallback", () => {
  it("delivers into the genuinely most-recent conversation, not one whose updatedAt is unparseable", async () => {
    const { runtime, created } = makeRuntime();
    // No active conversation, so the most-recently-updated fallback is what
    // picks the delivery target. "stale" carries a malformed updatedAt.
    const { state } = makeState([
      conv("stale", "room-stale", "not-a-date"),
      conv("recent", "room-recent", "2026-01-02T00:00:00.000Z"),
      conv("older", "room-older", "2026-01-01T00:00:00.000Z"),
    ]);
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    await runtime.sendMessageToTarget(
      { source: "client_chat", roomId: "room-unknown" as UUID },
      { text: "proactive ping" },
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.roomId).toBe("room-recent");
  });

  it("still delivers into the most-recent conversation when every updatedAt is valid", async () => {
    const { runtime, created } = makeRuntime();
    const { state } = makeState([
      conv("older", "room-older", "2026-01-01T00:00:00.000Z"),
      conv("recent", "room-recent", "2026-01-02T00:00:00.000Z"),
    ]);
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    await runtime.sendMessageToTarget(
      { source: "client_chat", roomId: "room-unknown" as UUID },
      { text: "proactive ping" },
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.roomId).toBe("room-recent");
  });
});
