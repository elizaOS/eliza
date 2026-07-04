/**
 * Tests for registerClientChatSendHandler — the wiring that relays the agent's
 * outbound messages back into dashboard / REST conversations. Covers which relay
 * sources get a send handler, delivery into the matching conversation (including
 * an unknown dashboard-origin source routed via the default fallback), not
 * hijacking a real connector's own handler, and cross-conversation safety.
 * Deterministic against an in-memory runtime + server-state stub.
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

/** A minimal AgentRuntime stand-in that mirrors the real send-handler routing:
 *  `registerSendHandler` records a handler AND a message connector (the runtime
 *  does both), and `sendMessageToTarget` dispatches to the registered handler or
 *  throws "No send handler registered" — exactly the failure the relay fix
 *  addresses. */
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
  return { runtime, handlers, connectors, created };
}

function makeState(
  conversations: ConversationMeta[],
  activeConversationId: string | null = null,
) {
  const broadcastWs = vi.fn();
  const map = new Map<string, ConversationMeta>();
  for (const conv of conversations) map.set(conv.id, conv);
  const state = {
    conversations: map,
    activeConversationId,
    broadcastWs,
  } as unknown as ServerState;
  return { state, broadcastWs };
}

function conv(id: string, roomId: string): ConversationMeta {
  const now = new Date().toISOString();
  return {
    id,
    title: id,
    roomId: roomId as UUID,
    createdAt: now,
    updatedAt: now,
  };
}

const REQUIRED_RELAY_SOURCES = [
  "client_chat",
  "agent_message_api",
  "compat_openai",
  "compat_anthropic",
];

describe("registerClientChatSendHandler — relay source coverage", () => {
  it("registers a send handler for every dashboard/REST relay source", () => {
    const { runtime, handlers } = makeRuntime();
    const { state } = makeState([]);
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    for (const source of REQUIRED_RELAY_SOURCES) {
      expect(handlers.has(source)).toBe(true);
    }
  });

  it("does NOT register the dead sources removed from the relay list", () => {
    const { runtime, handlers } = makeRuntime();
    const { state } = makeState([]);
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    // `acpx_sub_agent` is not a real inbound origin.source anywhere; the router
    // marker is `sub_agent`, unwrapped to the real originSource before it ever
    // becomes a spawn source. `orchestrator` is only a notifier/trajectory label.
    expect(handlers.has("acpx_sub_agent")).toBe(false);
    expect(handlers.has("orchestrator")).toBe(false);
    expect(handlers.has("sub_agent")).toBe(false);
  });
});

describe("registerClientChatSendHandler — delivery", () => {
  it("delivers a known relay source into the matching conversation", async () => {
    const { runtime, created } = makeRuntime();
    const { state, broadcastWs } = makeState([conv("c1", "room-1")]);
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    await runtime.sendMessageToTarget(
      { source: "agent_message_api", roomId: "room-1" as UUID },
      { text: "done" },
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.roomId).toBe("room-1");
    expect(broadcastWs).toHaveBeenCalledTimes(1);
    expect(broadcastWs.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "c1",
    });
  });

  it("delivers an UNKNOWN dashboard-origin source instead of dropping it", async () => {
    const { runtime, created } = makeRuntime();
    const { state, broadcastWs } = makeState([conv("c1", "room-1")]);
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    // `my_custom_source` was never explicitly registered (a client-supplied
    // body.source / agent_message_api platformName). It must still be delivered
    // via the default-fallback wrapper rather than throwing "No send handler".
    await expect(
      runtime.sendMessageToTarget(
        { source: "my_custom_source", roomId: "room-1" as UUID },
        { text: "relayed result" },
      ),
    ).resolves.toBeUndefined();

    expect(created).toHaveLength(1);
    expect(created[0]?.roomId).toBe("room-1");
    expect(broadcastWs).toHaveBeenCalledTimes(1);
  });

  it("does NOT hijack a registered connector source (discord wins)", async () => {
    const { runtime, created } = makeRuntime();
    const { state, broadcastWs } = makeState([conv("c1", "room-1")]);
    const discordHandler = vi.fn(async () => undefined);
    // A real connector registers its own handler before the dashboard wires up.
    runtime.registerSendHandler("discord", discordHandler);
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    await runtime.sendMessageToTarget(
      { source: "discord", roomId: "room-1" as UUID },
      { text: "to discord" },
    );

    expect(discordHandler).toHaveBeenCalledTimes(1);
    // The dashboard deliver path never ran for the connector source.
    expect(created).toHaveLength(0);
    expect(broadcastWs).not.toHaveBeenCalled();
  });
});

describe("registerClientChatSendHandler — cross-conversation safety", () => {
  it("does NOT mis-deliver an API result into an unrelated active conversation", async () => {
    const { runtime, created } = makeRuntime();
    // The dashboard has an active conversation; the API caller's room is NOT a
    // registered dashboard conversation.
    const { state, broadcastWs } = makeState([conv("c1", "room-1")], "c1");
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    await expect(
      runtime.sendMessageToTarget(
        { source: "agent_message_api", roomId: "room-api" as UUID },
        { text: "async sub-agent result" },
      ),
    ).rejects.toThrow(/no conversation available/);

    // Crucially, nothing landed in the unrelated active conversation.
    expect(created).toHaveLength(0);
    expect(broadcastWs).not.toHaveBeenCalled();
  });

  it("still lets a proactive client_chat message use the active-conversation fallback", async () => {
    const { runtime, created } = makeRuntime();
    const { state, broadcastWs } = makeState([conv("c1", "room-1")], "c1");
    registerClientChatSendHandler(runtime as unknown as IAgentRuntime, state);

    // No roomId / non-matching room: the live dashboard UI surface (client_chat)
    // is allowed to fall back to the active conversation.
    await runtime.sendMessageToTarget(
      { source: "client_chat", roomId: "room-unknown" as UUID },
      { text: "proactive ping" },
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.roomId).toBe("room-1");
    expect(broadcastWs).toHaveBeenCalledTimes(1);
  });
});
