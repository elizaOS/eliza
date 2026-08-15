/**
 * Authoritative user-format preservation at the ElizaClient boundary.
 *
 * Modern producers explicitly mark text that is already the user-visible
 * payload. Unmarked legacy response-handler envelopes retain the historical
 * `{reply}` / `{response}` unwrapping behavior.
 */

import {
  REALTIME_VOICE_CLIENT_MESSAGE_ID_PREFIX,
  REALTIME_VOICE_CLIENT_TRANSPORT,
} from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client";
import type { AgentRequestTransport } from "./transport";

function clientReturning(response: () => Response): ElizaClient {
  const client = new ElizaClient("http://agent.example:31337", "token");
  client.setRequestTransport({ request: vi.fn(async () => response()) });
  return client;
}

function sseResponse(events: readonly Record<string, unknown>[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("ElizaClient authoritative text preservation", () => {
  it.each([' \n{"response":"yes"}\n ', '\t{"reply":"REPLACEMENT_OK"}\n'])(
    "keeps marked terminal stream text byte-identical: %j",
    async (authoritativeText) => {
      const token = authoritativeText.slice(0, -1);
      const onToken = vi.fn();
      const client = clientReturning(() =>
        sseResponse([
          { type: "token", text: token },
          {
            type: "done",
            fullText: authoritativeText,
            agentName: "Eliza",
            preserveUserRequestedFormat: true,
          },
        ]),
      );

      const result = await client.streamChatEndpoint(
        "/api/conversations/c/messages/stream",
        "return exact JSON",
        onToken,
      );

      expect(onToken).toHaveBeenCalledWith(token, token, false);
      expect(result.text).toBe(authoritativeText);
      expect(result.preserveUserRequestedFormat).toBe(true);
    },
  );

  it.each([
    ['{"response":"yes"}', "yes"],
    ['{"reply":"legacy reply"}', "legacy reply"],
  ])(
    "keeps legacy terminal envelope normalization for %s",
    async (legacyEnvelope, expected) => {
      const client = clientReturning(() =>
        sseResponse([
          {
            type: "done",
            fullText: legacyEnvelope,
            agentName: "Eliza",
          },
        ]),
      );

      const result = await client.streamChatEndpoint(
        "/api/conversations/c/messages/stream",
        "legacy request",
        vi.fn(),
      );

      expect(result.text).toBe(expected);
      expect(result).not.toHaveProperty("preserveUserRequestedFormat");
    },
  );

  it("preserves marked persisted history while normalizing unmarked legacy envelopes", async () => {
    const markedText = ' \n{"response":"yes"}\n ';
    const client = clientReturning(
      () =>
        new Response(
          JSON.stringify({
            messages: [
              {
                id: "marked",
                role: "assistant",
                text: markedText,
                timestamp: 1,
                preserveUserRequestedFormat: true,
              },
              {
                id: "legacy",
                role: "assistant",
                text: '{"reply":"legacy reply"}',
                timestamp: 2,
              },
              {
                id: "non-boolean",
                role: "assistant",
                text: '{"response":"strict legacy"}',
                timestamp: 3,
                preserveUserRequestedFormat: "true",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await client.getConversationMessages("conversation-id", {
      around: "force-http-path",
    });

    expect(result.messages.map(({ text }) => text)).toEqual([
      markedText,
      "legacy reply",
      "strict legacy",
    ]);
    expect(result.messages[0]?.preserveUserRequestedFormat).toBe(true);
  });

  it("applies the same strict marker to the non-stream response", async () => {
    const authoritativeText = '\n{"reply":"literal REST JSON"}\n';
    const client = clientReturning(
      () =>
        new Response(
          JSON.stringify({
            text: authoritativeText,
            agentName: "Eliza",
            preserveUserRequestedFormat: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await client.sendConversationMessage(
      "conversation-id",
      "return exact JSON",
    );

    expect(result.text).toBe(authoritativeText);
    expect(result.preserveUserRequestedFormat).toBe(true);
  });

  it("keeps the exact realtime VOICE_DM marker and id in the stream request body", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      sseResponse([{ type: "done", fullText: "ok", agentName: "Eliza" }]),
    );
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({ request });
    const voiceTurnId = "browser-turn-7";
    const clientMessageId = `${REALTIME_VOICE_CLIENT_MESSAGE_ID_PREFIX}${voiceTurnId}`;

    await client.sendConversationMessageStream(
      "conversation-id",
      "exact voice request",
      vi.fn(),
      "VOICE_DM",
      undefined,
      undefined,
      {
        clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT,
        voiceTurnId,
      },
      undefined,
      undefined,
      clientMessageId,
    );

    const init = request.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      channelType: "VOICE_DM",
      clientMessageId,
      metadata: {
        clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT,
        voiceTurnId,
      },
    });
  });

  it("targets an abort at the exact request id instead of the room's newer turn", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({
        aborted: false,
        roomId: "room-1",
        reason: "ui-chat-stop",
      }),
    );
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({ request });
    const clientMessageId = `${REALTIME_VOICE_CLIENT_MESSAGE_ID_PREFIX}browser-turn-7`;

    await client.abortConversationTurn(
      "room-1",
      "ui-chat-stop",
      clientMessageId,
    );

    const init = request.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({
      reason: "ui-chat-stop",
      clientMessageId,
    });
  });

  it("keeps an ordinary chat abort room-scoped by omitting clientMessageId", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({
        aborted: true,
        roomId: "room-1",
        reason: "ui-chat-stop",
      }),
    );
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.setRequestTransport({ request });

    await client.abortConversationTurn("room-1", "ui-chat-stop");

    const init = request.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({
      reason: "ui-chat-stop",
    });
  });
});
