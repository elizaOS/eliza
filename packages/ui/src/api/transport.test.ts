/**
 * Browser-fetch transport timeout and cancellation behavior. The network
 * boundary is deterministic so the suite can prove a wedged native/WebView
 * fetch cannot hold startup forever even when that fetch ignores abort.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAgentTransport } from "./transport";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fetchAgentTransport", () => {
  it("rejects at the transport deadline even when fetch never settles", async () => {
    vi.useFakeTimers();
    const requestSignals: AbortSignal[] = [];
    globalThis.fetch = vi.fn((_url, init) => {
      if (init?.signal) requestSignals.push(init.signal);
      return new Promise<Response>(() => {});
    }) as typeof fetch;

    const pending = fetchAgentTransport.request(
      "https://agent.example/api/auth/me",
      {},
      { timeoutMs: 250 },
    );
    const rejection = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });

    await vi.advanceTimersByTimeAsync(250);

    await rejection;
    expect(requestSignals[0]?.aborted).toBe(true);
  });

  it("preserves caller cancellation while composing the timeout signal", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => {}),
    ) as typeof fetch;
    const caller = new AbortController();
    const pending = fetchAgentTransport.request(
      "https://agent.example/api/auth/me",
      { signal: caller.signal },
      { timeoutMs: 10_000 },
    );
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });

    caller.abort();

    await rejection;
  });

  it("clears the deadline after a successful fetch", async () => {
    vi.useFakeTimers();
    const requestSignals: AbortSignal[] = [];
    const response = new Response(null, { status: 204 });
    globalThis.fetch = vi.fn((_url, init) => {
      if (init?.signal) requestSignals.push(init.signal);
      return Promise.resolve(response);
    }) as typeof fetch;

    await expect(
      fetchAgentTransport.request(
        "https://agent.example/api/auth/me",
        {},
        {
          timeoutMs: 250,
        },
      ),
    ).resolves.toBe(response);
    await vi.advanceTimersByTimeAsync(500);

    expect(requestSignals[0]?.aborted).toBe(false);
  });
});
