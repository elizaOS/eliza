/**
 * Exercises Jupiter request deadlines through native fetch and real stalled
 * HTTP responses, including caller cancellation and response-body stalls.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JUPITER_FETCH_TIMEOUT_MS, fetchJupiterJson } from "./jupiter-api";

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

async function startServer(handler: Parameters<typeof http.createServer>[0]): Promise<TestServer> {
  const server = http.createServer(handler);
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("Jupiter API request deadline", () => {
  let nativeTimeout: typeof AbortSignal.timeout;

  beforeEach(() => {
    nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes the ten-second production budget", () => {
    expect(DEFAULT_JUPITER_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("wraps a stalled response-header timeout with its original cause", async () => {
    const server = await startServer(() => undefined);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(10));
    try {
      await expect(fetchJupiterJson(fetch, server.url, "quote")).rejects.toEqual(
        expect.objectContaining({
          code: "JUPITER_QUOTE_TRANSPORT_FAILED",
          cause: expect.objectContaining({ name: "TimeoutError" }),
        })
      );
    } finally {
      await server.close();
    }
  });

  it("bounds a real partial response-body stall", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"route":"');
    });
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(10));
    try {
      const failure = await fetchJupiterJson(fetch, server.url, "swap").catch(
        (cause: unknown) => cause
      );
      expect(failure).toEqual(
        expect.objectContaining({
          code: "JUPITER_SWAP_TRANSPORT_FAILED",
          cause: expect.objectContaining({ name: "TimeoutError" }),
          severity: "ephemeral",
        })
      );
    } finally {
      await server.close();
    }
  });

  it("keeps the composed signal active through response.json", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(10));
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error("missing deadline signal");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"route":"'));
          signal.addEventListener("abort", () => controller.error(signal.reason), {
            once: true,
          });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(fetchJupiterJson(fetchFn, "https://jupiter.test/swap", "swap")).rejects.toEqual(
      expect.objectContaining({
        code: "JUPITER_SWAP_TRANSPORT_FAILED",
        cause: expect.objectContaining({ name: "TimeoutError" }),
        severity: "ephemeral",
      })
    );
  });

  it("preserves caller cancellation when composing the deadline", async () => {
    const caller = new AbortController();
    const callerReason = new DOMException("cancelled by caller", "AbortError");
    const fetchFn = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("missing composed signal");
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        })
    ) as unknown as typeof fetch;

    const pending = fetchJupiterJson(fetchFn, "https://jupiter.test/quote", "quote", {
      signal: caller.signal,
    });
    caller.abort(callerReason);

    await expect(pending).rejects.toEqual(
      expect.objectContaining({
        code: "JUPITER_QUOTE_TRANSPORT_FAILED",
        cause: callerReason,
      })
    );
  });

  it("creates a fresh deadline signal for every successful request", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const signals: AbortSignal[] = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (!init?.signal) throw new Error("missing deadline signal");
      signals.push(init.signal);
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    await fetchJupiterJson(fetchFn, "https://jupiter.test/quote", "quote");
    await fetchJupiterJson(fetchFn, "https://jupiter.test/swap", "swap");

    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_JUPITER_FETCH_TIMEOUT_MS);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  });
});
