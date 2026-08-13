/**
 * Replays canonical cloud-produced SSE frames through the shared client. The
 * frames are written by the REAL producer functions imported from
 * `@elizaos/cloud-shared` — `chatSseFrame` and `normalizeChatSseDonePayload`,
 * which every cloud chat producer (shared runtime, sandbox, sandbox bridge)
 * stamps its downstream frames with (#17122) — rather than restated wire
 * literals, so a drift between what the cloud writes and what the client
 * reduces fails here. Deterministic in-memory Responses, no network, no live
 * model.
 */
import {
  chatSseFrame,
  normalizeChatSseDonePayload,
} from "@elizaos/cloud-shared/lib/services/chat-sse-frames";
import { describe, expect, test } from "vitest";
import { ElizaClient } from "./client";

function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

function clientWithResponse(response: Response): ElizaClient {
  const client = new ElizaClient("http://agent.example:31337", "token");
  client.setRequestTransport({ request: async () => response });
  return client;
}

describe("shared client replay of canonical cloud SSE frames", () => {
  test("a normalized terminal frame drives the client with metadata intact", async () => {
    // The upstream agent's terminal event, exactly as the sandbox bridge
    // receives it. The downstream done frame is produced by the REAL
    // normalizer + frame writer the bridge proxies use — no restated wire
    // payload; an untrusted extra field must not cross the boundary.
    const upstreamDone = {
      messageId: "assistant-1",
      userMessageId: "user-1",
      fullText: "Opened notes",
      actionResults: [{ actionName: "VIEWS", success: true }],
      usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
      failureKind: "provider_gate",
      accountConnect: { provider: "openai" },
      untrustedExtra: "drop",
    };
    const response = sseResponse(
      chatSseFrame("chunk", {
        chunk: "Opened notes",
        fullText: "Opened notes",
      }) +
        chatSseFrame(
          "done",
          normalizeChatSseDonePayload(upstreamDone, {
            messageId: "assistant-1",
            fullText: "Opened notes",
          }),
        ),
    );
    const client = clientWithResponse(response);

    const result = await client.streamChatEndpoint(
      "/api/x/stream",
      "open notes",
      () => {},
    );

    expect(result.completed).toBe(true);
    expect(result.text).toBe("Opened notes");
    expect(result.messageId).toBe("assistant-1");
    expect(result.userMessageId).toBe("user-1");
    expect(result.actionResults).toEqual([
      { actionName: "VIEWS", success: true },
    ]);
    expect(result.usage).toEqual({
      promptTokens: 2,
      completionTokens: 1,
      totalTokens: 3,
    });
    expect(result.failureKind).toBe("provider_gate");
    expect(result.accountConnect).toEqual({ provider: "openai" });
  });

  test("the canonical degraded reply frames drive the client to exact text and one completion", async () => {
    const degradedReply =
      "Eliza is temporarily unavailable (no shared model configured).";
    // Same frame writer and payload shape SharedRuntimeChatService.stream()
    // uses on its degraded path (one full-reply chunk, then done).
    const response = sseResponse(
      chatSseFrame("chunk", {
        messageId: "assistant-1",
        userMessageId: "user-1",
        chunk: degradedReply,
        text: degradedReply,
        fullText: degradedReply,
        timestamp: Date.now(),
      }) +
        chatSseFrame("done", {
          messageId: "assistant-1",
          userMessageId: "user-1",
          text: degradedReply,
          fullText: degradedReply,
        }),
    );
    const client = clientWithResponse(response);

    const tokens: string[] = [];
    const result = await client.streamChatEndpoint(
      "/api/conversations/c/messages/stream",
      "hi",
      (token: string) => {
        tokens.push(token);
      },
    );

    expect(tokens).toEqual([degradedReply]);
    expect(result.text).toBe(degradedReply);
    expect(result.completed).toBe(true);
    expect(result.messageId).toBe("assistant-1");
    expect(result.userMessageId).toBe("user-1");
  });
});
