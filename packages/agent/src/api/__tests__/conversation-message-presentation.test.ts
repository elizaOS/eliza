/**
 * Route-level proof for durable stopped-response presentation. A terminal
 * answer may finish server-side before its paced UI/audio presentation drains;
 * stopping it must persist exactly the visible prefix, mark it interrupted,
 * and rewrite the exact idempotency outcome so reload/replay cannot resurrect
 * hidden text. Uses the real room queue and route handler with an in-memory
 * message store; no model, network, or browser mock.
 */
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { RoomHandlerQueue } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetChatDedupeForTests,
  admitChatMessageId,
  getChatMessageIdOutcome,
  setChatMessageIdOutcome,
} from "../chat-routes.ts";
import {
  type ConversationRouteContext,
  type ConversationRouteState,
  handleConversationRoutes,
} from "../conversation-routes.ts";
import type { ConversationMeta } from "../server-types.ts";

const AGENT_ID = "00000000-0000-4000-8000-0000000000a0" as UUID;
const USER_ID = "00000000-0000-4000-8000-0000000000b0" as UUID;
const ASSISTANT_ID = "00000000-0000-4000-8000-0000000000c0" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-0000000000d0" as UUID;
const FOREIGN_ROOM_ID = "00000000-0000-4000-8000-0000000000e0" as UUID;
const FULL_TEXT = "Visible prefix followed by a hidden durable suffix.";
const VISIBLE_TEXT = "Visible prefix";
const SCOPE = String(ROOM_ID);
const CLIENT_MESSAGE_ID = "presentation-stop-1";

interface Captured {
  status: number;
  body: unknown;
}

function conversation(): ConversationMeta {
  return {
    id: "conv-1",
    title: "Presentation stop",
    roomId: ROOM_ID,
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(1).toISOString(),
  };
}

function userMemory(): Memory {
  return {
    id: USER_ID,
    entityId: USER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    createdAt: 1,
    content: {
      text: "Please explain this.",
      chatIdempotency: {
        version: 1,
        scope: SCOPE,
        clientMessageId: CLIENT_MESSAGE_ID,
        fingerprint: "a".repeat(64),
        outcomeJson: JSON.stringify({
          text: FULL_TEXT,
          agentName: "Eliza",
          messageId: ASSISTANT_ID,
          userMessageId: USER_ID,
        }),
      },
    },
  };
}

function assistantMemory(roomId: UUID = ROOM_ID): Memory {
  return {
    id: ASSISTANT_ID,
    entityId: AGENT_ID,
    agentId: AGENT_ID,
    roomId,
    createdAt: 2,
    content: { text: FULL_TEXT, inReplyTo: USER_ID },
  };
}

function makeState(seed: Memory[]): {
  state: ConversationRouteState;
  store: Memory[];
  updateMemory: ReturnType<typeof vi.fn>;
} {
  const store = seed.map((memory) => ({ ...memory }));
  const roomHandlerQueue = new RoomHandlerQueue();
  const updateMemory = vi.fn(
    async (replacement: Partial<Memory> & { id: UUID }) => {
      expect(roomHandlerQueue.currentLease(ROOM_ID)).toBeDefined();
      const index = store.findIndex((memory) => memory.id === replacement.id);
      if (index < 0) throw new Error("missing memory");
      store[index] = { ...store[index], ...replacement } as Memory;
    },
  );
  const runtime = {
    agentId: AGENT_ID,
    roomHandlerQueue,
    getMemoriesByIds: vi.fn(async (ids: UUID[]) =>
      store.filter((memory) => memory.id && ids.includes(memory.id)),
    ),
    getMemories: vi.fn(async ({ roomId }: { roomId: UUID }) =>
      store.filter((memory) => memory.roomId === roomId),
    ),
    updateMemory,
  } as unknown as AgentRuntime;
  return {
    state: {
      runtime,
      agentName: "Eliza",
      conversations: new Map([["conv-1", conversation()]]),
      deletedConversationIds: new Set<string>(),
      broadcastWs: vi.fn(),
      logBuffer: [],
    } as unknown as ConversationRouteState,
    store,
    updateMemory,
  };
}

async function callRoute(
  state: ConversationRouteState,
  options: {
    method: "GET" | "PATCH";
    messageId?: string;
    body?: Record<string, unknown>;
  },
): Promise<Captured> {
  const suffix = options.messageId ? `/${options.messageId}` : "";
  const pathname = `/api/conversations/conv-1/messages${suffix}`;
  const captured: Partial<Captured> = {};
  const ctx = {
    req: {
      url: pathname,
      headers: { host: "localhost" },
      socket: { remoteAddress: "127.0.0.1" },
    },
    res: {},
    method: options.method,
    pathname,
    requestUrl: new URL(pathname, "http://localhost"),
    readJsonBody: vi.fn(async () => options.body ?? {}),
    json: (_res: unknown, body: unknown, status = 200) => {
      captured.status = status;
      captured.body = body;
    },
    error: (_res: unknown, message: string, status = 500) => {
      captured.status = status;
      captured.body = { error: message };
    },
    state,
  } as unknown as ConversationRouteContext;
  await handleConversationRoutes(ctx);
  if (captured.status === undefined) {
    throw new Error("conversation route completed without a response");
  }
  return captured as Captured;
}

async function stopPresentation(
  state: ConversationRouteState,
  body: Record<string, unknown> = {
    state: "stopped",
    visibleText: VISIBLE_TEXT,
    expectedText: FULL_TEXT,
  },
): Promise<Captured> {
  return callRoute(state, {
    method: "PATCH",
    messageId: ASSISTANT_ID,
    body,
  });
}

afterEach(() => {
  __resetChatDedupeForTests();
});

describe("PATCH conversation assistant presentation", () => {
  it("persists only the visible prefix and rewrites durable replay truth", async () => {
    const { state, store, updateMemory } = makeState([
      userMemory(),
      assistantMemory(),
    ]);
    const admission = admitChatMessageId(SCOPE, CLIENT_MESSAGE_ID, {
      fingerprint: "a".repeat(64),
    });
    expect(admission.kind).toBe("owner");
    if (admission.kind !== "owner") {
      throw new Error("expected to own the seeded idempotency entry");
    }
    setChatMessageIdOutcome(
      SCOPE,
      CLIENT_MESSAGE_ID,
      {
        text: FULL_TEXT,
        agentName: "Eliza",
        messageId: ASSISTANT_ID,
        userMessageId: USER_ID,
      },
      admission.reservation,
    );

    const result = await stopPresentation(state);

    expect(result).toMatchObject({
      status: 200,
      body: {
        ok: true,
        messageId: ASSISTANT_ID,
        state: "stopped",
        text: VISIBLE_TEXT,
        interrupted: true,
        alreadyApplied: false,
      },
    });
    const assistant = store.find((memory) => memory.id === ASSISTANT_ID);
    expect(assistant?.content).toMatchObject({
      text: VISIBLE_TEXT,
      interrupted: true,
      interruptionReason: "user_stop",
    });
    expect(typeof assistant?.content.interruptedAt).toBe("number");

    const user = store.find((memory) => memory.id === USER_ID);
    const marker = user?.content.chatIdempotency as { outcomeJson: string };
    expect(JSON.parse(marker.outcomeJson)).toMatchObject({
      text: VISIBLE_TEXT,
      interrupted: true,
      messageId: ASSISTANT_ID,
    });
    expect(getChatMessageIdOutcome(SCOPE, CLIENT_MESSAGE_ID)).toMatchObject({
      text: VISIBLE_TEXT,
      interrupted: true,
    });
    expect(updateMemory).toHaveBeenCalledTimes(2);
    expect(state.broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({ type: "conversation-updated" }),
    );
  });

  it("is idempotent and repairs replay metadata on an already-stopped row", async () => {
    const stopped = assistantMemory();
    stopped.content = {
      ...stopped.content,
      text: VISIBLE_TEXT,
      interrupted: true,
      interruptedAt: 123,
      interruptionReason: "user_stop",
    };
    const { state, store } = makeState([userMemory(), stopped]);

    const result = await stopPresentation(state);

    expect(result).toMatchObject({
      status: 200,
      body: { alreadyApplied: true, stoppedAt: 123 },
    });
    const marker = store.find((memory) => memory.id === USER_ID)?.content
      .chatIdempotency as { outcomeJson: string };
    expect(JSON.parse(marker.outcomeJson)).toMatchObject({
      text: VISIBLE_TEXT,
      interrupted: true,
    });
  });

  it("fails closed when the durable answer changed after the client snapshot", async () => {
    const changed = assistantMemory();
    changed.content = {
      ...changed.content,
      text: "A newer authoritative edit",
    };
    const { state, store, updateMemory } = makeState([userMemory(), changed]);

    const result = await stopPresentation(state);

    expect(result).toMatchObject({ status: 409 });
    expect(
      store.find((memory) => memory.id === ASSISTANT_ID)?.content.text,
    ).toBe("A newer authoritative edit");
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it("rejects non-prefix input and assistant ids outside the conversation", async () => {
    const invalidState = makeState([userMemory(), assistantMemory()]).state;
    const invalid = await stopPresentation(invalidState, {
      state: "stopped",
      visibleText: "not a prefix",
      expectedText: FULL_TEXT,
    });
    expect(invalid.status).toBe(400);

    const foreign = makeState([userMemory(), assistantMemory(FOREIGN_ROOM_ID)]);
    const missing = await stopPresentation(foreign.state);
    expect(missing.status).toBe(404);
    expect(foreign.updateMemory).not.toHaveBeenCalled();
  });

  it("round-trips the stopped prefix and marker through GET history", async () => {
    const { state } = makeState([userMemory(), assistantMemory()]);
    expect((await stopPresentation(state)).status).toBe(200);

    const history = await callRoute(state, { method: "GET" });

    expect(history.status).toBe(200);
    expect(history.body).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          id: ASSISTANT_ID,
          role: "assistant",
          text: VISIBLE_TEXT,
          interrupted: true,
        }),
      ]),
    });
  });
});
