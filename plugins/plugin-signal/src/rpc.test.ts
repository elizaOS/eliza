/**
 * Tests the signal-cli RPC helpers — base-URL normalization, request framing,
 * and check/version calls — with property-based inputs (fast-check), fake
 * timers, and a stubbed `fetch`. No live daemon.
 */
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSignalEventStream, normalizeBaseUrl, signalCheck, signalRpcRequest } from "./rpc";

describe("Signal RPC helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes explicit and shorthand base URLs without trailing slash runs", () => {
    expect(normalizeBaseUrl(" https://signal.local:8080//// ")).toBe("https://signal.local:8080");
    expect(normalizeBaseUrl("127.0.0.1:8080///")).toBe("http://127.0.0.1:8080");
    expect(() => normalizeBaseUrl("    ")).toThrow("Signal base URL is required");

    const hostChar = fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-"
    );
    fc.assert(
      fc.property(
        fc.array(hostChar, { minLength: 1, maxLength: 80 }).map((chars) => chars.join("")),
        fc.integer({ min: 0, max: 256 }),
        (host, slashCount) => {
          expect(normalizeBaseUrl(`${host}${"/".repeat(slashCount)}`)).toBe(`http://${host}`);
        }
      ),
      { numRuns: 150 }
    );
  });

  it("posts a JSON-RPC envelope and returns result payloads", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        jsonrpc: "2.0",
        method: "send",
        params: { account: "+15551234567", message: "hi" },
        id: expect.any(String),
      });
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: { timestamp: 123 } }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      signalRpcRequest(
        "send",
        { account: "+15551234567", message: "hi" },
        { baseUrl: "localhost:8080///" }
      )
    ).resolves.toEqual({ timestamp: 123 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/rpc",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  it("handles empty-success, empty-error, and JSON-RPC error responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 201 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32602, message: "bad params" },
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      signalRpcRequest("methodWithoutResult", undefined, { baseUrl: "http://localhost" })
    ).resolves.toBeUndefined();
    await expect(
      signalRpcRequest("empty", undefined, { baseUrl: "http://localhost" })
    ).rejects.toThrow("Signal RPC empty response (status 200)");
    await expect(signalRpcRequest("bad", {}, { baseUrl: "http://localhost" })).rejects.toThrow(
      "Signal RPC -32602: bad params"
    );
  });

  it("grows the reconnect delay exponentially up to the cap when the daemon stays down", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNREFUSED (daemon down)");
    });
    vi.stubGlobal("fetch", fetchMock);

    // Capture reconnect delays and defer each scheduled reconnect so the test
    // drives the cycles deterministically instead of racing the event loop.
    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    let pending: (() => void) | null = null;
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      pending = fn;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const flush = () => new Promise((resolve) => realSetTimeout(resolve, 0));

    let connects = 0;
    const stream = createSignalEventStream({
      baseUrl: "http://localhost:8080",
      onEvent: () => {},
      onError: () => {},
      onConnect: () => {
        connects += 1;
      },
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 30000,
    });

    stream.start();
    for (let i = 0; i < 7; i++) {
      await flush();
      const next = pending;
      pending = null;
      next?.();
    }
    await flush();
    stream.stop();

    // Backoff doubles from the base delay and saturates at the configured cap.
    expect(delays.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(delays.every((d) => d <= 30000)).toBe(true);
    expect(Math.max(...delays)).toBe(30000);
    // onConnect never fires because no connection was ever established.
    expect(connects).toBe(0);
  });

  it("resets the reconnect delay to base after a connection is actually established", async () => {
    const okStream = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("down");
      })
      .mockImplementationOnce(async () => {
        throw new Error("down");
      })
      .mockImplementationOnce(async () => okStream())
      .mockImplementation(async () => {
        throw new Error("down");
      });
    vi.stubGlobal("fetch", fetchMock);

    const realSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    let pending: (() => void) | null = null;
    vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      pending = fn;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const flush = async () => {
      await new Promise((resolve) => realSetTimeout(resolve, 0));
      await new Promise((resolve) => realSetTimeout(resolve, 0));
    };

    let connects = 0;
    const stream = createSignalEventStream({
      baseUrl: "http://localhost:8080",
      onEvent: () => {},
      onError: () => {},
      onConnect: () => {
        connects += 1;
      },
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 30000,
    });

    stream.start();
    for (let i = 0; i < 4; i++) {
      await flush();
      const next = pending;
      pending = null;
      next?.();
    }
    await flush();
    stream.stop();

    // Two failed dials grow the delay (1000 -> 2000); the third dial succeeds
    // and resets it, so the drop after the established stream restarts at the
    // base delay rather than continuing the pre-success ramp.
    expect(delays.slice(0, 4)).toEqual([1000, 2000, 1000, 2000]);
    // onConnect fires exactly once, only for the genuinely established stream.
    expect(connects).toBe(1);
  });

  it("cancels stale reconnect timers across stop and restart", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new Error("down");
    });
    vi.stubGlobal("fetch", fetchMock);

    const stream = createSignalEventStream({
      baseUrl: "http://localhost:8080",
      onEvent: () => {},
      onError: () => {},
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 30000,
    });

    stream.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    stream.stop();
    expect(vi.getTimerCount()).toBe(0);
    stream.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    stream.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops an in-flight dial without reporting or scheduling an abort as a failure", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();

    const stream = createSignalEventStream({
      baseUrl: "http://localhost:8080",
      onEvent: () => {},
      onError,
    });
    stream.start();
    await vi.advanceTimersByTimeAsync(0);
    stream.stop();
    await vi.advanceTimersByTimeAsync(60000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconnects after an unowned AbortError on the current generation", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new DOMException("upstream aborted independently", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();

    const stream = createSignalEventStream({
      baseUrl: "http://localhost:8080",
      onEvent: () => {},
      onError,
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 2000,
    });
    stream.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    stream.stop();
  });

  it("suppresses stale events and errors from an abort-resistant prior generation", async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const fetchMock = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const events: string[] = [];
    const onError = vi.fn();
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    const stream = createSignalEventStream({
      baseUrl: "http://localhost:8080",
      onEvent: (event) => events.push(event.data ?? ""),
      onError,
      onConnect,
      onDisconnect,
    });

    stream.start();
    await flush();
    expect(onConnect).toHaveBeenCalledTimes(1);
    stream.stop();
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    stream.start();
    await flush();
    expect(onConnect).toHaveBeenCalledTimes(2);
    expect(controllers).toHaveLength(2);

    controllers[0]?.enqueue(new TextEncoder().encode("data: stale-old-generation\n\n"));
    controllers[0]?.error(new Error("late old-generation failure"));
    await flush();

    expect(events).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(stream.isRunning()).toBe(true);

    stream.stop();
    expect(onDisconnect).toHaveBeenCalledTimes(2);
  });

  it("treats non-OK responses as failed dials without announcing a connection", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const onError = vi.fn();

    const stream = createSignalEventStream({
      baseUrl: "http://localhost:8080",
      onEvent: () => {},
      onConnect,
      onDisconnect,
      onError,
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 2000,
    });
    stream.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(onConnect).not.toHaveBeenCalled();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[0])).toContain("Signal SSE failed (503");
    expect(vi.getTimerCount()).toBe(1);
    stream.stop();
  });

  it("reports Signal health failures for non-OK and aborted checks", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(signalCheck("signal.test", 50)).resolves.toEqual({
      ok: false,
      status: 503,
      error: "HTTP 503",
    });

    vi.useFakeTimers();
    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    });
    const check = signalCheck("signal.test", 25);
    await vi.advanceTimersByTimeAsync(25);

    await expect(check).resolves.toEqual({
      ok: false,
      status: null,
      error: "aborted",
    });
  });
});
