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
 * Self-contained dependency mock: bun's `mock.module` is process-global and
 * leaks across files, so spying on the real `elizaSandboxService` singleton was
 * fragile — another file (provisioning, agent-gateway-router) that mocked
 * `../eliza-sandbox` to a partial stub left `bridge`/`getSharedConversationHistory`
 * non-functions here, depending on file order. Mock the dependency with clean
 * stubs and import the adapter AFTER the mock so it binds to ours every time.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { InsufficientCreditsError } from "../../api/errors";
import * as realElizaSandbox from "../eliza-sandbox";

const bridge = mock();
const getSharedConversationHistory = mock();
const getSharedRuntimeCharacter = mock();

mock.module("../eliza-sandbox", () => ({
  ...realElizaSandbox,
  elizaSandboxService: { bridge, getSharedConversationHistory, getSharedRuntimeCharacter },
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
  mock.module("../eliza-sandbox", () => realElizaSandbox);
});

const AGENT = "de42b5ff-72d3-4a1a-8a16-19aee293bfea";
const ORG = "org-1";
const CREATED = "2026-06-18T00:00:00.000Z";

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
    getSharedRuntimeCharacter.mockReset();
  });

  test("returns the shared runtime character the turn answers as", async () => {
    getSharedRuntimeCharacter.mockResolvedValue({
      name: "Nova",
      system: "You are Nova.",
      bio: ["curious"],
      model: "gpt-oss-120b",
    });
    const out = await sharedRestCharacter(AGENT, ORG, "Nova");
    expect(out).toEqual({
      character: {
        name: "Nova",
        system: "You are Nova.",
        bio: ["curious"],
        model: "gpt-oss-120b",
      },
      agentName: "Nova",
    });
    expect(getSharedRuntimeCharacter).toHaveBeenCalledWith(AGENT, ORG);
  });

  test("falls back to an empty character object when the sandbox can't resolve", async () => {
    getSharedRuntimeCharacter.mockResolvedValue(null);
    expect(await sharedRestCharacter(AGENT, ORG, "")).toEqual({
      character: {},
      agentName: "Eliza",
    });
  });
});

describe("shared-rest-adapter — messages", () => {
  beforeEach(() => {
    bridge.mockReset();
    getSharedConversationHistory.mockReset();
  });

  test("GET maps bridge turn history → REST messages", async () => {
    const before = Date.now();
    getSharedConversationHistory.mockResolvedValue([
      { role: "user", content: "hi", createdAt: 1_783_382_400_000 },
      { role: "assistant", content: "Hello!" },
    ]);
    const { messages } = await sharedRestMessagesGet(AGENT, AGENT);
    expect(messages[0]).toEqual({
      id: `${AGENT}:0`,
      role: "user",
      text: "hi",
      timestamp: 1_783_382_400_000,
    });
    expect(messages[1]).toMatchObject({
      id: `${AGENT}:1`,
      role: "assistant",
      text: "Hello!",
    });
    expect(typeof messages[1]?.timestamp).toBe("number");
    expect(messages[1]?.timestamp).toBeLessThan(before - 60_000);
    expect(getSharedConversationHistory).toHaveBeenCalledWith(AGENT, AGENT);
  });

  test("POST forwards to bridge message.send with roomId and returns the reply", async () => {
    bridge.mockResolvedValue({
      jsonrpc: "2.0",
      id: "x",
      result: { text: "four" },
    });
    const out = await sharedRestMessageSend(AGENT, ORG, AGENT, "2+2?", "Eliza");
    expect(out).toEqual({ text: "four", agentName: "Eliza" });
    const call = bridge.mock.calls[0];
    expect(call[0]).toBe(AGENT);
    expect(call[1]).toBe(ORG);
    expect(call[2].method).toBe("message.send");
    expect(call[2].params).toMatchObject({ text: "2+2?", roomId: AGENT });
  });

  test("POST throws when the bridge returns an error (surfaced to the client)", async () => {
    bridge.mockResolvedValue({
      jsonrpc: "2.0",
      id: "x",
      error: { code: -32000, message: "Sandbox is not running" },
    });
    await expect(sharedRestMessageSend(AGENT, ORG, AGENT, "hi", "Eliza")).rejects.toThrow(
      "Sandbox is not running",
    );
  });

  test("POST surfaces a bridge credit rejection as the TYPED 402 error, not a plain Error", async () => {
    bridge.mockResolvedValue({
      jsonrpc: "2.0",
      id: "x",
      error: {
        code: realElizaSandbox.BRIDGE_INSUFFICIENT_CREDITS_CODE,
        message: "Insufficient credits. Required: $0.0500, Available: $0.0000",
      },
    });
    const rejection = sharedRestMessageSend(AGENT, ORG, AGENT, "hi", "Eliza");
    await expect(rejection).rejects.toBeInstanceOf(InsufficientCreditsError);
    await expect(rejection).rejects.toMatchObject({
      code: "insufficient_credits",
      status: 402,
      message: "Insufficient credits. Required: $0.0500, Available: $0.0000",
    });
  });
});
