/** Verifies JSON response-body deadlines and caller cancellation with a real ReadableStream and stubbed transport. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import { ApiError } from "./client-types";
import type { AgentRequestTransport } from "./transport";

function makeClient(request: AgentRequestTransport["request"]): ElizaClient {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

function makeStalledResponse(status = 200) {
  let markReadStarted: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const cancel = vi.fn(async () => undefined);
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        markReadStarted?.();
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return {
    cancel,
    readStarted,
    response: new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    }),
  };
}

describe("ElizaClient JSON response-body lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels a stalled body when its read budget expires", async () => {
    const stalled = makeStalledResponse();
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () => stalled.response,
    );

    const result = makeClient(request).fetch("/api/status", undefined, {
      timeoutMs: 20,
    });
    await stalled.readStarted;

    await expect(result).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
      path: "/api/status",
      status: 200,
      message: "Response body timed out after 20ms",
    });
    expect(stalled.cancel).toHaveBeenCalledWith("elizaos-json-body-timeout");
  });

  it("cancels a stalled body immediately when the caller aborts after headers", async () => {
    const stalled = makeStalledResponse();
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () => stalled.response,
    );
    const controller = new AbortController();
    const callerReason = new Error("view unmounted");

    const result = makeClient(request).fetch(
      "/api/status",
      { signal: controller.signal },
      { timeoutMs: 1_000 },
    );
    await stalled.readStarted;
    controller.abort(callerReason);

    const error = await result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      kind: "network",
      path: "/api/status",
      status: 200,
      message: "Request aborted",
      cause: callerReason,
    });
    expect(stalled.cancel).toHaveBeenCalledWith(callerReason);
  });

  it("preserves a non-2xx body deadline and cancels the owned reader", async () => {
    const stalled = makeStalledResponse(418);
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () => stalled.response,
    );

    const result = makeClient(request).fetch("/api/teapot", undefined, {
      timeoutMs: 20,
    });
    await stalled.readStarted;

    await expect(result).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
      path: "/api/teapot",
      status: 418,
      message: "Response body timed out after 20ms",
    });
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(stalled.cancel).toHaveBeenCalledWith("elizaos-json-body-timeout");
  });

  it("preserves caller cancellation after non-2xx headers and cancels the owned reader", async () => {
    const stalled = makeStalledResponse(418);
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () => stalled.response,
    );
    const controller = new AbortController();
    const callerReason = new Error("view unmounted");

    const result = makeClient(request).fetch(
      "/api/teapot",
      { signal: controller.signal },
      { timeoutMs: 1_000 },
    );
    await stalled.readStarted;
    controller.abort(callerReason);

    const error = await result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      kind: "network",
      path: "/api/teapot",
      status: 418,
      message: "Request aborted",
      cause: callerReason,
    });
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(stalled.cancel).toHaveBeenCalledWith(callerReason);
  });

  it("reads a complete non-2xx body before surfacing its HTTP error and clears the deadline", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const cancel = vi.fn(async () => undefined);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"error":"short and stout"}'));
          controller.close();
        },
        cancel,
      }),
      { status: 418 },
    );
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () => response,
    );

    await expect(
      makeClient(request).fetch("/api/teapot", undefined, {
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      name: "ApiError",
      kind: "http",
      path: "/api/teapot",
      status: 418,
      message: "short and stout",
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("decodes a successful fragmented JSON body without cancelling it", async () => {
    const encoder = new TextEncoder();
    const cancel = vi.fn(async () => undefined);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"message":"hel'));
          controller.enqueue(encoder.encode('lo"}'));
          controller.close();
        },
        cancel,
      }),
      { status: 200 },
    );
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () => response,
    );

    await expect(makeClient(request).fetch("/api/status")).resolves.toEqual({
      message: "hello",
    });
    expect(cancel).not.toHaveBeenCalled();
  });
});
