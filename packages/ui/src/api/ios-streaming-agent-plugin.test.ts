/**
 * Unit tests for the iOS streaming adapter (#12354). They drive
 * `createIosStreamingAgentPlugin` with a fake ElizaBunRuntime whose
 * `http_request_stream` `call` fans `agentStream*` events out through the
 * `addListener`-registered listeners — the same shape the native `stream_emit`
 * host-call produces — and assert the adapter satisfies the
 * `NativeStreamingAgentPlugin` contract that `createNativeStreamingResponse`
 * consumes, end-to-end, with no device.
 *
 * The load-bearing property is ordering: the native call blocks until the
 * stream completes, so `requestStream` must resolve a `streamId` BEFORE the
 * events fire, or the caller's listeners miss every token.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createIosStreamingAgentPlugin,
  type IosStreamingRuntime,
} from "./ios-streaming-agent-plugin";
import {
  createNativeStreamingResponse,
  supportsNativeStreaming,
} from "./native-agent-stream";

type Listener = (event: unknown) => void;

/**
 * A runtime whose `http_request_stream` call, once invoked, emits a response
 * head, one chunk per `tokens` entry, then a complete — through whatever
 * listeners are currently registered. It records whether listeners were live
 * when the call was invoked so the ordering guarantee can be asserted.
 */
function makeFakeRuntime(tokens: string[]): {
  runtime: IosStreamingRuntime;
  listenerCountAtCall: () => number;
  callArgs: () => unknown;
} {
  const listeners = new Map<string, Set<Listener>>();
  let listenerCountAtCall = -1;
  let recordedArgs: unknown = null;

  const emit = (eventName: string, data: unknown): void => {
    for (const listener of listeners.get(eventName) ?? []) listener(data);
  };

  const runtime: IosStreamingRuntime = {
    async call(options): Promise<{ result: unknown }> {
      recordedArgs = options.args;
      const streamId =
        (options.args as { streamId?: string } | undefined)?.streamId ?? "s";
      // Deliver on a later macrotask, mimicking Capacitor's event dispatch —
      // events land after the caller has attached its listeners.
      await new Promise((r) => setTimeout(r, 0));
      // Snapshot listener count at emit time: the fire-and-forget design is only
      // correct if the caller attached its `agentStream*` listeners before now.
      listenerCountAtCall = [...listeners.values()].reduce(
        (n, set) => n + set.size,
        0,
      );
      emit("agentStreamResponse", {
        streamId,
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/event-stream" },
      });
      for (const token of tokens) {
        emit("agentStreamChunk", {
          streamId,
          dataBase64: Buffer.from(token, "utf8").toString("base64"),
        });
      }
      emit("agentStreamComplete", { streamId, error: null });
      return { result: { streamId, done: true } };
    },
    async addListener(eventName, listener) {
      const set = listeners.get(eventName) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(eventName, set);
      return {
        remove: () => {
          set.delete(listener);
        },
      };
    },
  };

  return {
    runtime,
    listenerCountAtCall: () => listenerCountAtCall,
    callArgs: () => recordedArgs,
  };
}

describe("createIosStreamingAgentPlugin", () => {
  it("satisfies the NativeStreamingAgentPlugin type guard", () => {
    const { runtime } = makeFakeRuntime([]);
    const plugin = createIosStreamingAgentPlugin(runtime);
    expect(supportsNativeStreaming(plugin)).toBe(true);
  });

  it("resolves a streamId synchronously and forwards the request args", async () => {
    const { runtime, callArgs } = makeFakeRuntime(["hi"]);
    const plugin = createIosStreamingAgentPlugin(runtime);
    const { streamId } = await plugin.requestStream({
      method: "POST",
      path: "/api/conversations/c1/messages/stream",
      headers: { accept: "text/event-stream" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(streamId).toMatch(/^ios-stream-/);
    // Let the fire-and-forget call run.
    await new Promise((r) => setTimeout(r, 0));
    expect(callArgs()).toMatchObject({
      method: "POST",
      path: "/api/conversations/c1/messages/stream",
      streamId,
    });
  });

  it("streams token-by-token through createNativeStreamingResponse", async () => {
    const { runtime, listenerCountAtCall } = makeFakeRuntime([
      "Hel",
      "lo ",
      "world",
    ]);
    const plugin = createIosStreamingAgentPlugin(runtime);

    const response = await createNativeStreamingResponse(plugin, {
      method: "POST",
      path: "/api/conversations/c1/messages/stream",
      headers: { accept: "text/event-stream" },
      body: null,
    });

    expect(response.status).toBe(200);
    // Listeners were attached before the native call fired its events — otherwise
    // tokens would be lost (the whole point of the fire-and-forget design).
    expect(listenerCountAtCall()).toBe(3);

    const text = await response.text();
    expect(text).toBe("Hello world");
  });

  it("surfaces a call rejection to onStreamError and the stream completion", async () => {
    const onError = vi.fn();
    const runtime: IosStreamingRuntime = {
      async call(): Promise<{ result: unknown }> {
        throw new Error("bridge exploded");
      },
      async addListener() {
        return { remove: () => {} };
      },
    };
    const plugin = createIosStreamingAgentPlugin(runtime, onError);
    const { streamId, completion } = await plugin.requestStream({
      method: "POST",
      path: "/api/conversations/c1/messages/stream",
    });
    expect(streamId).toMatch(/^ios-stream-/);
    await expect(completion).rejects.toThrow("bridge exploded");
    expect(onError).toHaveBeenCalledOnce();
    expect(String(onError.mock.calls[0][0])).toContain("bridge exploded");
  });

  it("rejects the response head when the native call rejects before emitting a head", async () => {
    const runtime: IosStreamingRuntime = {
      async call(): Promise<{ result: unknown }> {
        throw new Error("backend failed before stream head");
      },
      async addListener() {
        return { remove: () => {} };
      },
    };
    const plugin = createIosStreamingAgentPlugin(runtime);

    await expect(
      createNativeStreamingResponse(plugin, {
        method: "POST",
        path: "/api/conversations/c1/messages/stream",
      }),
    ).rejects.toThrow("backend failed before stream head");
  });
});
