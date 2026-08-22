/** Exercises local-runtime conversation path decoding with downstream fetch isolated. */
import { beforeAll, describe, expect, mock, test } from "bun:test";

const TRANSPORT = "realtime-voice-client";

mock.module("@elizaos/shared", () => ({
  REALTIME_VOICE_CLIENT_TRANSPORT: TRANSPORT,
}));
mock.module("@/lib/voice-session/eliza-sse-bridge", () => ({
  VOICE_STREAM_PROTOCOL: "delta-v2",
}));

const VALID_BODY = JSON.stringify({
  text: "hello locally",
  metadata: {
    clientTransport: TRANSPORT,
  },
  streamProtocol: "delta-v2",
});
const SCOPE = { agentId: "agent-a", conversationId: "conv-id" };

function unusedDownstream(): typeof fetch {
  return (async () => {
    throw new Error("downstream fetch must not run on malformed encoding");
  }) as unknown as typeof fetch;
}

describe("local runtime conversation fetch encoding", () => {
  let createLocalRuntimeConversationFetch: typeof import("../lib/local-runtime-conversation-fetch").createLocalRuntimeConversationFetch;
  let LocalRuntimeConversationFetchError: typeof import("../lib/local-runtime-conversation-fetch").LocalRuntimeConversationFetchError;

  beforeAll(async () => {
    const mod = await import("../lib/local-runtime-conversation-fetch");
    createLocalRuntimeConversationFetch =
      mod.createLocalRuntimeConversationFetch;
    LocalRuntimeConversationFetchError = mod.LocalRuntimeConversationFetchError;
  });

  test("unsupported path is untouched", async () => {
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      SCOPE,
      unusedDownstream(),
    );
    await expect(
      bridge("https://cloud.example/api/v1/other", {
        method: "POST",
        body: VALID_BODY,
      }),
    ).rejects.toMatchObject({
      name: "LocalRuntimeConversationFetchError",
      message: expect.stringContaining("unsupported local voice upstream path"),
    });
  });

  test("canonical percent-encoded conversation id still reaches the loopback rewrite", async () => {
    const calls: Array<{ url: string }> = [];
    const downstream = (async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const bridge = createLocalRuntimeConversationFetch(
      "http://127.0.0.1:31337",
      SCOPE,
      downstream,
    );
    const response = await bridge(
      "https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/conv%2Did/messages/stream",
      {
        method: "POST",
        body: VALID_BODY,
      },
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:31337/api/conversations/conv-id/messages/stream",
    );
  });

  test.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed conversation id %s before downstream fetch",
    async (token) => {
      const bridge = createLocalRuntimeConversationFetch(
        "http://127.0.0.1:31337",
        SCOPE,
        unusedDownstream(),
      );
      try {
        await bridge(
          `https://cloud.example/api/v1/eliza/agents/agent-a/api/conversations/${token}/messages/stream`,
          {
            method: "POST",
            body: VALID_BODY,
          },
        );
        throw new Error("expected LocalRuntimeConversationFetchError");
      } catch (error) {
        expect(error).toBeInstanceOf(LocalRuntimeConversationFetchError);
        expect((error as Error).message).toBe(
          "conversation id is not valid percent-encoding",
        );
        expect((error as Error).name).toBe(
          "LocalRuntimeConversationFetchError",
        );
      }
    },
  );
});
