/**
 * Unit coverage for the native streaming-response helper and its capability
 * probe. In-process, no real bridge.
 */
import { describe, expect, it } from "vitest";

import {
  createNativeStreamingResponse,
  type NativeStreamingAgentPlugin,
  supportsNativeStreaming,
} from "./native-agent-stream";

/**
 * A fake `Agent` streaming plugin: records listeners and lets the test push
 * `agentStream*` events on demand — exactly how the native bridge will emit them
 * via Capacitor `notifyListeners`.
 */
function makeFakeAgent(
  streamId = "s1",
  completion?: Promise<unknown>,
  options: { addListenerDelayMs?: number } = {},
) {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const agent: NativeStreamingAgentPlugin = {
    async requestStream() {
      return { streamId, completion };
    },
    async addListener(eventName, listener) {
      if (options.addListenerDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.addListenerDelayMs),
        );
      }
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
  const listenerCount = () =>
    [...listeners.values()].reduce((n, a) => n + a.length, 0);
  return { agent, emit, listenerCount };
}

const b64 = (s: string) => btoa(s);
// Let the helper's internal awaits (requestStream + 3 addListener) settle.
const flush = () => new Promise((r) => setTimeout(r, 0));
// Is a promise still pending? (resolves false if it settles within a tick.)
const isPending = async (p: Promise<unknown>) => {
  const sentinel = Symbol("pending");
  const winner = await Promise.race([
    p.then(() => "settled"),
    new Promise((r) => setTimeout(() => r(sentinel), 5)),
  ]);
  return winner === sentinel;
};

describe("createNativeStreamingResponse", () => {
  it("supportsNativeStreaming detects the streaming bridge", () => {
    expect(supportsNativeStreaming(makeFakeAgent().agent)).toBe(true);
    expect(supportsNativeStreaming({ request: () => {} })).toBe(false);
    expect(supportsNativeStreaming(null)).toBe(false);
  });

  it("delivers body chunks INCREMENTALLY (not buffered) as events arrive", async () => {
    const { agent, emit } = makeFakeAgent();
    const responsePromise = createNativeStreamingResponse(agent, {
      path: "/api/conversations/x/messages/stream",
    });
    await flush();

    emit("agentStreamResponse", {
      streamId: "s1",
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/event-stream" },
    });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();

    // First token frame: available the moment its event fires.
    emit("agentStreamChunk", {
      streamId: "s1",
      dataBase64: b64("data: hel\n\n"),
    });
    const r1 = await reader.read();
    expect(r1.done).toBe(false);
    expect(dec.decode(r1.value)).toBe("data: hel\n\n");

    // The NEXT read must PEND until the next event — proves nothing was buffered
    // ahead (the buffered `request` bridge would have had the whole body already).
    const r2Promise = reader.read();
    expect(await isPending(r2Promise)).toBe(true);

    emit("agentStreamChunk", {
      streamId: "s1",
      dataBase64: b64("data: lo\n\n"),
    });
    const r2 = await r2Promise;
    expect(dec.decode(r2.value)).toBe("data: lo\n\n");

    emit("agentStreamComplete", { streamId: "s1" });
    const r3 = await reader.read();
    expect(r3.done).toBe(true);
  });

  it("ignores events addressed to a different streamId", async () => {
    const { agent, emit } = makeFakeAgent("mine");
    const responsePromise = createNativeStreamingResponse(agent, {
      path: "/x",
    });
    await flush();
    emit("agentStreamResponse", { streamId: "other", status: 500 });
    expect(await isPending(responsePromise)).toBe(true); // foreign head ignored
    emit("agentStreamResponse", { streamId: "mine", status: 200 });
    expect((await responsePromise).status).toBe(200);
  });

  it("errors the stream on a mid-stream failure", async () => {
    const { agent, emit } = makeFakeAgent();
    const responsePromise = createNativeStreamingResponse(agent, {
      path: "/x",
    });
    await flush();
    emit("agentStreamResponse", { streamId: "s1", status: 200 });
    const response = await responsePromise;
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    emit("agentStreamComplete", { streamId: "s1", error: "boom" });
    await expect(reader.read()).rejects.toThrow("boom");
  });

  it("rejects the head when the request fails before any response", async () => {
    const { agent, emit } = makeFakeAgent();
    const responsePromise = createNativeStreamingResponse(agent, {
      path: "/x",
    });
    await flush();
    emit("agentStreamComplete", { streamId: "s1", error: "connect refused" });
    await expect(responsePromise).rejects.toThrow("connect refused");
  });

  it("rejects the head when the native stream call rejects without a complete event", async () => {
    const completion = Promise.reject(new Error("native boot failed"));
    const { agent } = makeFakeAgent("s1", completion);
    const responsePromise = createNativeStreamingResponse(agent, {
      path: "/x",
    });
    await expect(responsePromise).rejects.toThrow("native boot failed");
  });

  it("removes listener handles that resolve after an early native completion rejection", async () => {
    const completion = Promise.reject(new Error("native boot failed"));
    const { agent, listenerCount } = makeFakeAgent("s1", completion, {
      addListenerDelayMs: 5,
    });
    const responsePromise = createNativeStreamingResponse(agent, {
      path: "/x",
    });
    await expect(responsePromise).rejects.toThrow("native boot failed");
    await flush();
    await flush();
    expect(listenerCount()).toBe(0);
  });

  it("errors the body when the native stream call rejects after the head", async () => {
    let rejectCompletion: (error: Error) => void = () => {};
    const completion = new Promise((_resolve, reject) => {
      rejectCompletion = reject;
    });
    const { agent, emit } = makeFakeAgent("s1", completion);
    const responsePromise = createNativeStreamingResponse(agent, {
      path: "/x",
    });
    await flush();
    emit("agentStreamResponse", { streamId: "s1", status: 200 });
    const response = await responsePromise;
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();

    rejectCompletion(new Error("native stream died"));

    await expect(reader.read()).rejects.toThrow("native stream died");
  });

  it("detaches all listeners once the stream completes", async () => {
    const { agent, emit, listenerCount } = makeFakeAgent();
    const responsePromise = createNativeStreamingResponse(agent, {
      path: "/x",
    });
    await flush();
    expect(listenerCount()).toBe(3);
    emit("agentStreamResponse", { streamId: "s1", status: 200 });
    const response = await responsePromise;
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    emit("agentStreamChunk", { streamId: "s1", dataBase64: b64("hi") });
    await reader.read();
    emit("agentStreamComplete", { streamId: "s1" });
    await reader.read();
    expect(listenerCount()).toBe(0);
  });
});
