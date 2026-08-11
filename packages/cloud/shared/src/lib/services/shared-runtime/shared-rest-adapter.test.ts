/**
 * Tests for the shared-runtime REST adapter — the mapping that lets a REST chat
 * client talk to a server-less shared agent. The load-bearing invariants:
 *   - the conversation is canonical (id === agentId === roomId), so the list is
 *     always one item and create is idempotent;
 *   - history maps SharedTurnMessage{role,content,createdAt} → REST
 *     {id,role,text,timestamp};
 *   - send forwards to the bridge `message.send` and returns its reply text;
 *   - the startup shell (status/first-run/views/config/auth-me/character) returns
 *     the exact shapes the mobile app probes on boot.
 *
 * The coordinator and cache-only character service are mocked at their explicit
 * boundaries. The legacy sandbox service is intentionally absent: reaching it
 * from this adapter would be a production database-path regression.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

class InsufficientCreditsError extends Error {}

mock.module("../../api/errors", () => ({
  InsufficientCreditsError,
}));

const coordinateSharedBridge = mock();
const coordinateSharedHistory = mock();
const getCharacter = mock();

mock.module("./conversation-coordinator", () => ({
  coordinateSharedBridge,
  coordinateSharedHistory,
}));
mock.module("./shared-runtime-chat", () => ({
  sharedRuntimeChatService: { getCharacter },
}));

// Imported after the mock so the adapter binds to our stubbed service.
const {
  sharedRestAuthMe,
  sharedRestCharacter,
  sharedRestConfig,
  sharedRestConversationCreate,
  sharedRestConversationDelete,
  sharedRestConversationUpdate,
  sharedRestConversationsList,
  sharedRestFirstRun,
  sharedRestFirstRunStatus,
  sharedRestHealth,
  sharedRestMessageSend,
  sharedRestMessagesGet,
  sharedRestStatus,
  sharedRestViews,
} = await import("./shared-rest-adapter");

// Restore the real module so this file's process-global mock doesn't strand
// later test files that use the full elizaSandboxService surface.
afterAll(() => {
  mock.restore();
});

const AGENT = "de42b5ff-72d3-4a1a-8a16-19aee293bfea";
const ORG = "org-1";
const CREATED = "2026-06-18T00:00:00.000Z";
const EXECUTION_CTX = { waitUntil() {} };
const NAMESPACE = { getByName: () => ({ fetch: async () => new Response() }) };
const SHARED_AGENT = {
  id: AGENT,
  organization_id: ORG,
  execution_tier: "shared",
  agent_name: "Nova",
  agent_config: {
    character: {
      name: "Nova",
      system: "You are Nova.",
      bio: ["curious"],
      model: "gpt-oss-120b",
    },
  },
} as never;

describe("shared-rest-adapter — conversation surface", () => {
  test("health is ok", () => {
    expect(sharedRestHealth()).toEqual({ status: "ok" });
  });

  test("list returns exactly one canonical conversation (id === agentId === roomId)", () => {
    const { conversations } = sharedRestConversationsList(AGENT, "Eliza", CREATED);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toEqual({
      id: AGENT,
      title: "Eliza",
      roomId: AGENT,
      createdAt: CREATED,
      updatedAt: CREATED,
    });
  });

  test("create is idempotent — same canonical conversation as list", () => {
    const created = sharedRestConversationCreate(AGENT, "Eliza", CREATED).conversation;
    const listed = sharedRestConversationsList(AGENT, "Eliza", CREATED).conversations[0];
    expect(created).toEqual(listed);
  });

  test("create falls back to a title when the agent has no name", () => {
    expect(sharedRestConversationCreate(AGENT, "", CREATED).conversation.title).toBe("Chat");
  });

  test("update accepts title patches for the canonical conversation", () => {
    const { conversation } = sharedRestConversationUpdate(AGENT, "Eliza", CREATED, {
      title: "Launch checklist",
    });
    expect(conversation).toEqual({
      id: AGENT,
      title: "Launch checklist",
      roomId: AGENT,
      createdAt: CREATED,
      updatedAt: CREATED,
    });
  });

  test("update falls back to the agent title for generate-only patches", () => {
    const { conversation } = sharedRestConversationUpdate(AGENT, "Eliza", CREATED, {
      generate: true,
    } as { title?: unknown });
    expect(conversation.title).toBe("Eliza");
  });

  test("delete is accepted as a canonical-conversation compatibility no-op", () => {
    expect(sharedRestConversationDelete()).toEqual({ ok: true });
  });
});

describe("shared-rest-adapter — startup shell surface", () => {
  test("status is the first gate: running + agent name", () => {
    expect(sharedRestStatus("Nova")).toEqual({
      state: "running",
      agentName: "Nova",
      canRespond: true,
    });
  });

  test("status falls back to a name when the agent has none", () => {
    expect(sharedRestStatus("").agentName).toBe("Eliza");
  });

  test("first-run is always complete + cloud-provisioned (no onboarding)", () => {
    expect(sharedRestFirstRunStatus()).toEqual({ complete: true, cloudProvisioned: true });
    expect(sharedRestFirstRun()).toEqual({ complete: true, ok: true });
  });

  test("config declares no websocket + no streaming (client uses non-stream REST)", () => {
    expect(sharedRestConfig()).toEqual({ websocket: false, streaming: false });
  });

  test("views returns the builtin chat view by default", () => {
    const { views } = sharedRestViews();
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      id: "chat",
      viewType: "gui",
      path: "/chat",
      available: true,
      builtin: true,
      pluginName: "@elizaos/builtin",
    });
  });

  test("views honors ?viewType=: gui matches, tui/xr return empty", () => {
    expect(sharedRestViews("gui").views).toHaveLength(1);
    expect(sharedRestViews("tui").views).toHaveLength(0);
    expect(sharedRestViews("xr").views).toHaveLength(0);
  });

  test("auth/me reports the authed machine identity (the app's hard gate)", () => {
    expect(sharedRestAuthMe(AGENT, "Nova")).toEqual({
      identity: { id: AGENT, displayName: "Nova", kind: "machine" },
      session: { id: "bearer", kind: "machine", expiresAt: null },
      access: { mode: "bearer", passwordConfigured: false, ownerConfigured: false },
    });
  });

  test("auth/me falls back to a display name when the agent has none", () => {
    expect(sharedRestAuthMe(AGENT, "").identity.displayName).toBe("Eliza");
  });
});

describe("shared-rest-adapter — character", () => {
  beforeEach(() => {
    getCharacter.mockReset();
  });

  test("returns the shared runtime character the turn answers as", async () => {
    getCharacter.mockResolvedValue({
      name: "Nova",
      system: "You are Nova.",
      bio: ["curious"],
      model: "gpt-oss-120b",
    });
    const out = await sharedRestCharacter(SHARED_AGENT, "Nova", EXECUTION_CTX);
    expect(out).toEqual({
      character: {
        name: "Nova",
        system: "You are Nova.",
        bio: ["curious"],
        model: "gpt-oss-120b",
      },
      agentName: "Nova",
    });
    expect(getCharacter).toHaveBeenCalledWith(SHARED_AGENT, EXECUTION_CTX);
  });
});

describe("shared-rest-adapter — messages", () => {
  beforeEach(() => {
    coordinateSharedBridge.mockReset();
    coordinateSharedHistory.mockReset();
  });

  test("GET maps stable bridge turn history → REST messages", async () => {
    const before = Date.now();
    coordinateSharedHistory.mockResolvedValue([
      { id: "user-message-1", role: "user", content: "hi", createdAt: 1_783_382_400_000 },
      { id: "assistant-message-1", role: "assistant", content: "Hello!", interrupted: true },
    ]);
    const { messages } = await sharedRestMessagesGet(AGENT, AGENT, NAMESPACE);
    expect(messages[0]).toEqual({
      id: "user-message-1",
      role: "user",
      text: "hi",
      timestamp: 1_783_382_400_000,
    });
    expect(messages[1]).toMatchObject({
      id: "assistant-message-1",
      role: "assistant",
      text: "Hello!",
      interrupted: true,
    });
    expect(typeof messages[1]?.timestamp).toBe("number");
    expect(messages[1]?.timestamp).toBeLessThan(before - 60_000);
    expect(coordinateSharedHistory).toHaveBeenCalledWith(AGENT, AGENT, {
      namespace: NAMESPACE,
    });
  });

  test("GET requires the production conversation namespace", async () => {
    coordinateSharedHistory.mockResolvedValue([
      {
        role: "assistant",
        content: "cache local",
        createdAt: 1_783_382_400_000,
      },
    ]);
    const namespace = {
      getByName: mock(() => ({ fetch: async () => new Response() })),
    };

    const { messages } = await sharedRestMessagesGet(AGENT, AGENT, namespace as never);

    expect(messages[0]?.text).toBe("cache local");
    expect(coordinateSharedHistory).toHaveBeenCalledWith(AGENT, AGENT, {
      namespace,
    });
  });

  test("POST forwards to bridge message.send with roomId and returns the reply", async () => {
    coordinateSharedBridge.mockResolvedValue({
      jsonrpc: "2.0",
      id: "x",
      result: { text: "four" },
    });
    const out = await sharedRestMessageSend(
      SHARED_AGENT,
      AGENT,
      "2+2?",
      "Eliza",
      EXECUTION_CTX,
      NAMESPACE,
      "client-turn-1",
    );
    expect(out).toEqual({ text: "four", agentName: "Eliza" });
    const call = coordinateSharedBridge.mock.calls[0];
    expect(call[0]).toBe(SHARED_AGENT);
    expect(call[1].method).toBe("message.send");
    expect(call[1].id).toBe("client-turn-1");
    expect(call[1].params).toMatchObject({ text: "2+2?", roomId: AGENT });
    expect(call[2]).toEqual({
      executionCtx: EXECUTION_CTX,
      namespace: NAMESPACE,
    });
  });

  test("POST throws when the bridge returns an error (surfaced to the client)", async () => {
    coordinateSharedBridge.mockResolvedValue({
      jsonrpc: "2.0",
      id: "x",
      error: { code: -32000, message: "Sandbox is not running" },
    });
    await expect(
      sharedRestMessageSend(SHARED_AGENT, AGENT, "hi", "Eliza", EXECUTION_CTX, NAMESPACE),
    ).rejects.toThrow("Sandbox is not running");
  });

  test("POST surfaces a bridge credit rejection as the TYPED 402 error, not a plain Error", async () => {
    coordinateSharedBridge.mockResolvedValue({
      jsonrpc: "2.0",
      id: "x",
      error: {
        code: -32002,
        message: "Insufficient credits. Required: $0.0500, Available: $0.0000",
      },
    });
    const rejection = sharedRestMessageSend(
      SHARED_AGENT,
      AGENT,
      "hi",
      "Eliza",
      EXECUTION_CTX,
      NAMESPACE,
    );
    await expect(rejection).rejects.toBeInstanceOf(InsufficientCreditsError);
    const error = await rejection.catch((caught) => caught as InsufficientCreditsError);
    expect(error.message).toBe("Insufficient credits. Required: $0.0500, Available: $0.0000");
  });
});
