import { describe, expect, it } from "vitest";
import { ElizaClient } from "./client";
import {
  createNativeStreamingResponse,
  type NativeStreamingAgentPlugin,
} from "./native-agent-stream";
import type { AgentRequestTransport } from "./transport";

/**
 * Close-out integration for the chat SSE path over the native IPC transports
 * (#12353 / #12180 phase 4). Proves the invariant every per-platform streaming
 * adapter (Android `agentStream*`, the iOS bridge events, the Electrobun RPC
 * push events) relies on: a `Response` produced by `createNativeStreamingResponse`
 * — the transport-agnostic native streaming bridge — drives `streamChatEndpoint`
 * token-by-token, not as one buffered frame.
 *
 * The per-platform native/on-device leg (Swift/Kotlin/Electrobun RPC) is verified
 * by the device-capture lanes in the sibling PRs; here the shared JS pipeline is
 * driven end-to-end with a fake streaming plugin so the wiring is proven without a
 * device.
 */

interface FakeStreamingAgent {
  agent: NativeStreamingAgentPlugin;
  emit: (eventName: string, payload: unknown) => void;
}

function makeFakeStreamingAgent(streamId = "chat-stream"): FakeStreamingAgent {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const agent: NativeStreamingAgentPlugin = {
    async requestStream() {
      return { streamId };
    },
    async addListener(eventName, listener) {
      const arr = listeners.get(eventName) ?? [];
      arr.push(listener);
      listeners.set(eventName, arr);
      return {
        remove() {
          listeners.set(
            eventName,
            (listeners.get(eventName) ?? []).filter((l) => l !== listener),
          );
        },
      };
    },
  };
  const emit = (eventName: string, payload: unknown) => {
    for (const l of listeners.get(eventName) ?? []) l(payload);
  };
  return { agent, emit };
}

const b64 = (s: string) => btoa(s);
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * A transport that fulfils streaming requests through the native streaming
 * bridge (mirroring how each platform resolver returns a native-backed
 * `Response`) and would fail loudly on a buffered request — so the test proves
 * the streaming leg, not a buffered fallback.
 */
function nativeStreamingTransport(
  fake: FakeStreamingAgent,
): AgentRequestTransport {
  return {
    async request(url, init) {
      const accept = new Headers(init.headers ?? {}).get("accept") ?? "";
      if (!accept.toLowerCase().includes("text/event-stream")) {
        throw new Error(
          `expected a streaming chat request, got Accept: ${accept || "<none>"}`,
        );
      }
      const path = new URL(url, "http://localhost").pathname;
      return createNativeStreamingResponse(fake.agent, { path });
    },
  };
}

describe("streamChatEndpoint over a native IPC streaming transport", () => {
  it("renders tokens INCREMENTALLY as native stream events arrive", async () => {
    const fake = makeFakeStreamingAgent();
    const client = new ElizaClient("eliza-local-agent://ipc", "token");
    client.setRequestTransport(nativeStreamingTransport(fake));

    const tokens: Array<{ token: string; accumulated?: string }> = [];
    const resultPromise = client.streamChatEndpoint(
      "/api/conversations/conv-1/messages/stream",
      "hello",
      (token, accumulated) => tokens.push({ token, accumulated }),
    );

    // Let requestStream + the three addListener awaits settle, then feed the
    // response head so streamChatEndpoint starts reading the body.
    await flush();
    fake.emit("agentStreamResponse", {
      streamId: "chat-stream",
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/event-stream" },
    });

    // Two separate token frames on two separate native events: if the chat path
    // buffered the whole body it could not surface the first token before the
    // second event fired.
    fake.emit("agentStreamChunk", {
      streamId: "chat-stream",
      dataBase64: b64(
        'data: {"type":"token","text":"Hel","fullText":"Hel"}\n\n',
      ),
    });
    await flush();
    expect(tokens).toEqual([{ token: "Hel", accumulated: "Hel" }]);

    fake.emit("agentStreamChunk", {
      streamId: "chat-stream",
      dataBase64: b64(
        'data: {"type":"token","text":"lo","fullText":"Hello"}\n\n',
      ),
    });
    await flush();
    expect(tokens).toEqual([
      { token: "Hel", accumulated: "Hel" },
      { token: "lo", accumulated: "Hello" },
    ]);

    fake.emit("agentStreamChunk", {
      streamId: "chat-stream",
      dataBase64: b64(
        'data: {"type":"done","fullText":"Hello","agentName":"Eliza"}\n\n',
      ),
    });
    fake.emit("agentStreamComplete", { streamId: "chat-stream" });

    const result = await resultPromise;
    expect(result).toEqual({
      text: "Hello",
      agentName: "Eliza",
      completed: true,
    });
  });

  it("reassembles an SSE frame split across two native chunk events", async () => {
    // The native bridge chunks the body at fixed byte boundaries (8 KiB on
    // Android), so a single SSE `data:` frame can arrive across two events. The
    // chat read loop must buffer across chunk boundaries and only act on a
    // complete event — proving the transport boundary does not corrupt framing.
    const fake = makeFakeStreamingAgent();
    const client = new ElizaClient("eliza-local-agent://ipc", "token");
    client.setRequestTransport(nativeStreamingTransport(fake));

    const tokens: string[] = [];
    const resultPromise = client.streamChatEndpoint(
      "/api/conversations/conv-1/messages/stream",
      "hello",
      (token) => tokens.push(token),
    );
    await flush();
    fake.emit("agentStreamResponse", { streamId: "chat-stream", status: 200 });

    const doneFrame =
      'data: {"type":"done","fullText":"Hi","agentName":"Eliza"}\n\n';
    const split = 20;
    fake.emit("agentStreamChunk", {
      streamId: "chat-stream",
      dataBase64: b64(doneFrame.slice(0, split)),
    });
    await flush();
    // The frame is incomplete: no token yet, turn not resolved.
    expect(tokens).toEqual([]);

    fake.emit("agentStreamChunk", {
      streamId: "chat-stream",
      dataBase64: b64(doneFrame.slice(split)),
    });
    fake.emit("agentStreamComplete", { streamId: "chat-stream" });

    const result = await resultPromise;
    expect(result).toEqual({
      text: "Hi",
      agentName: "Eliza",
      completed: true,
    });
  });
});
