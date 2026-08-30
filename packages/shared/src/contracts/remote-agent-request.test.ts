/** Covers the cross-runtime route allowlist before encrypted dispatch. */

import { describe, expect, it } from "vitest";
import {
  classifyRemoteAgentRequestPath,
  parseRemoteAgentRequest,
  REMOTE_AGENT_REQUEST_BODY_LIMIT_BYTES,
} from "./remote-agent-request.js";

const conversationId = "11111111-1111-4111-8111-111111111111";

describe("remote agent request contract", () => {
  it("admits the bounded conversation routes needed by a selected runtime", () => {
    expect(classifyRemoteAgentRequestPath("/api/health", "GET")).toBe("health");
    expect(classifyRemoteAgentRequestPath("/api/conversations", "GET")).toBe(
      "conversation-list",
    );
    expect(
      classifyRemoteAgentRequestPath(
        `/api/conversations/${conversationId}/messages?before=1730000000000&limit=50`,
        "GET",
      ),
    ).toBe("conversation-messages");
    expect(
      classifyRemoteAgentRequestPath(
        `/api/conversations/${conversationId}/messages/stream`,
        "POST",
      ),
    ).toBe("conversation-message-stream");
  });

  it("parses an idempotent chat send with bounded view metadata", () => {
    const body = JSON.stringify({
      text: "hello",
      channelType: "DM",
      clientMessageId: "message-1",
      streamProtocol: "delta-v2",
      metadata: {
        uiView: "chat",
        uiViewCapabilities: ["general-chat"],
        __responseContext: {
          primaryContext: "general",
          secondaryContexts: ["general"],
        },
      },
    });
    expect(
      parseRemoteAgentRequest({
        path: `/api/conversations/${conversationId}/messages/stream`,
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          "x-elizaos-client-id": "ui-controller-1",
          "x-elizaos-turn-attempt": "1",
          "x-elizaos-turn-correlation": conversationId,
        },
        body,
      }),
    ).toEqual({
      path: `/api/conversations/${conversationId}/messages/stream`,
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        "x-elizaos-client-id": "ui-controller-1",
        "x-elizaos-turn-attempt": "1",
        "x-elizaos-turn-correlation": conversationId,
      },
      body,
    });
  });

  it("rejects arbitrary routes, mutations, bodies, and caller credentials", () => {
    for (const candidate of [
      {
        path: "/api/files",
        method: "GET",
        headers: {},
      },
      {
        path: "/api/conversations",
        method: "DELETE",
        headers: {},
      },
      {
        path: "/api/conversations",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "safe", admin: true }),
      },
      {
        path: "/api/status",
        method: "GET",
        headers: { authorization: "Bearer renderer-secret" },
      },
    ]) {
      expect(() => parseRemoteAgentRequest(candidate)).toThrow(
        "Remote agent request is invalid",
      );
    }
  });

  it("rejects unsafe metadata and over-limit request bodies", () => {
    const base = {
      path: `/api/conversations/${conversationId}/messages/stream`,
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
      },
    } as const;
    expect(() =>
      parseRemoteAgentRequest({
        ...base,
        body: JSON.stringify({
          text: "hello",
          channelType: "DM",
          clientMessageId: "message-1",
          streamProtocol: "delta-v2",
          metadata: JSON.parse('{"__proto__":{"admin":true}}'),
        }),
      }),
    ).toThrow("unsafe key");
    expect(() =>
      parseRemoteAgentRequest({
        ...base,
        body: JSON.stringify({
          text: "x".repeat(REMOTE_AGENT_REQUEST_BODY_LIMIT_BYTES),
          channelType: "DM",
          clientMessageId: "message-1",
          streamProtocol: "delta-v2",
        }),
      }),
    ).toThrow("byte limit");
  });

  it("rejects ambiguous pagination and non-UUID conversation paths", () => {
    for (const path of [
      `/api/conversations/${conversationId}/messages?before=1&before=2`,
      `/api/conversations/${conversationId}/messages?around=${conversationId}&before=1`,
      `/api/conversations/${conversationId}/messages?limit=50`,
      "/api/conversations/not-a-uuid/messages",
      `https://attacker.invalid/api/conversations/${conversationId}/messages`,
      `//attacker.invalid/api/conversations/${conversationId}/messages`,
      `/api/conversations/${conversationId}/messages#ignored`,
    ]) {
      expect(classifyRemoteAgentRequestPath(path, "GET")).toBeNull();
    }
  });
});
