/**
 * Tests for the shared-runtime REST adapter — the mapping that lets a REST chat
 * client talk to a server-less shared agent. The load-bearing invariants:
 *   - the conversation is canonical (id === agentId === roomId), so the list is
 *     always one item and create is idempotent;
 *   - history maps SharedTurnMessage{role,content} → REST {id,role,text};
 *   - send forwards to the bridge `message.send` and returns its reply text.
 */

import { describe, expect, mock, spyOn, test } from "bun:test";

import { elizaSandboxService } from "../eliza-sandbox";
import {
  sharedRestConfig,
  sharedRestConversationCreate,
  sharedRestConversationsList,
  sharedRestFirstRun,
  sharedRestFirstRunStatus,
  sharedRestHealth,
  sharedRestMessageSend,
  sharedRestMessagesGet,
  sharedRestStatus,
  sharedRestViews,
} from "./shared-rest-adapter";

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
});

describe("shared-rest-adapter — startup shell surface", () => {
  test("status is the first gate: running + agent name", () => {
    expect(sharedRestStatus("Nova")).toEqual({ state: "running", agentName: "Nova" });
  });

  test("status falls back to a name when the agent has none", () => {
    expect(sharedRestStatus("").agentName).toBe("Eliza");
  });

  test("first-run is always complete + cloud-provisioned (no onboarding)", () => {
    expect(sharedRestFirstRunStatus()).toEqual({ complete: true, cloudProvisioned: true });
    expect(sharedRestFirstRun()).toEqual({ complete: true, ok: true });
  });

  test("config is an empty object the client tolerates", () => {
    expect(sharedRestConfig()).toEqual({});
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
});

describe("shared-rest-adapter — messages", () => {
  test("GET maps bridge turn history → REST messages", async () => {
    const spy = spyOn(elizaSandboxService, "getSharedConversationHistory").mockResolvedValue([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello!" },
    ]);
    try {
      const { messages } = await sharedRestMessagesGet(AGENT, AGENT);
      expect(messages).toEqual([
        { id: `${AGENT}:0`, role: "user", text: "hi" },
        { id: `${AGENT}:1`, role: "assistant", text: "Hello!" },
      ]);
      expect(spy).toHaveBeenCalledWith(AGENT, AGENT);
    } finally {
      spy.mockRestore();
    }
  });

  test("POST forwards to bridge message.send with roomId and returns the reply", async () => {
    const bridge = spyOn(elizaSandboxService, "bridge").mockResolvedValue({
      jsonrpc: "2.0",
      id: "x",
      result: { text: "four" },
    });
    try {
      const out = await sharedRestMessageSend(AGENT, ORG, AGENT, "2+2?", "Eliza");
      expect(out).toEqual({ text: "four", agentName: "Eliza" });
      const call = bridge.mock.calls[0];
      expect(call[0]).toBe(AGENT);
      expect(call[1]).toBe(ORG);
      expect(call[2].method).toBe("message.send");
      expect(call[2].params).toMatchObject({ text: "2+2?", roomId: AGENT });
    } finally {
      bridge.mockRestore();
    }
  });

  test("POST throws when the bridge returns an error (surfaced to the client)", async () => {
    const bridge = spyOn(elizaSandboxService, "bridge").mockResolvedValue({
      jsonrpc: "2.0",
      id: "x",
      error: { code: -32000, message: "Sandbox is not running" },
    });
    try {
      await expect(sharedRestMessageSend(AGENT, ORG, AGENT, "hi", "Eliza")).rejects.toThrow(
        "Sandbox is not running",
      );
    } finally {
      bridge.mockRestore();
    }
  });
});

void mock;
