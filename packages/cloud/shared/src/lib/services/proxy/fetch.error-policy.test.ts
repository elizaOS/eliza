/**
 * Error-policy pins for the proxy retry-fetch transport boundary: a transport
 * failure (network error, or a TimeoutError that outlives its retries) must
 * PROPAGATE to the caller (fail closed), while a real upstream HTTP response of
 * any status is returned verbatim — never swallowed into a fabricated default.
 * Fetch fixtures and a loopback HTTP server exercise cancellation without
 * external provider calls.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import type { RetryFetchOptions } from "./fetch";
import { retryFetch } from "./fetch";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const baseOpts: RetryFetchOptions = {
  url: "https://api.example.com/v2/secret-key",
  init: { method: "POST" },
  maxRetries: 3,
  initialDelayMs: 0,
  timeoutMs: 50,
  serviceTag: "TEST",
  replayPolicy: "safe",
};

describe("retryFetch error policy", () => {
  it("does not dispatch a request whose caller already cancelled", async () => {
    const controller = new AbortController();
    const cancelled = new Error("caller cancelled");
    controller.abort(cancelled);
    const f = mock(async () => new Response("unexpected"));
    globalThis.fetch = f;

    await expect(retryFetch({ ...baseOpts, init: { signal: controller.signal } })).rejects.toBe(
      cancelled,
    );
    expect(f).not.toHaveBeenCalled();
  });

  it("ends retry backoff when the caller cancels the active request", async () => {
    const controller = new AbortController();
    const cancelled = new Error("caller cancelled", {
      cause: new Error("upstream consumer closed"),
    });
    const f = mock(async () => {
      controller.abort(cancelled);
      throw cancelled;
    });
    globalThis.fetch = f;

    await expect(
      retryFetch({
        ...baseOpts,
        init: { signal: controller.signal },
        initialDelayMs: 60_000,
      }),
    ).rejects.toBe(cancelled);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("cancels a real socket request without replaying it to the upstream", async () => {
    globalThis.fetch = realFetch;
    const controller = new AbortController();
    const cancelled = new Error("caller cancelled after upstream accepted");
    let acceptedRequests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        acceptedRequests += 1;
        controller.abort(cancelled);
        return new Response("upstream accepted");
      },
    });
    try {
      await expect(
        retryFetch({
          ...baseOpts,
          url: server.url.href,
          init: { signal: controller.signal },
          timeoutMs: 5_000,
        }),
      ).rejects.toBe(cancelled);
      expect(acceptedRequests).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  it("propagates a network error instead of swallowing it into a default", async () => {
    const boom = new Error("ECONNRESET");
    const f = mock(async () => {
      throw boom;
    });
    globalThis.fetch = f as unknown as typeof fetch;

    await expect(retryFetch({ ...baseOpts, maxRetries: 1 })).rejects.toBe(boom);
    // A single-attempt budget preserves the original transport failure.
    expect(f.mock.calls.length).toBe(1);
  });

  it("retries a TimeoutError then re-throws once retries are exhausted (fails closed)", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    const f = mock(async () => {
      throw timeout;
    });
    globalThis.fetch = f as unknown as typeof fetch;

    await expect(retryFetch({ ...baseOpts, maxRetries: 3 })).rejects.toBe(timeout);
    // Attempted maxRetries times, then the real failure is surfaced — not defaulted.
    expect(f.mock.calls.length).toBe(3);
  });

  it("returns a successful upstream Response verbatim (real result, not fabricated)", async () => {
    const ok = new Response("{}", { status: 200 });
    const f = mock(async () => ok);
    globalThis.fetch = f as unknown as typeof fetch;

    const res = await retryFetch(baseOpts);
    expect(res).toBe(ok);
    expect(f.mock.calls.length).toBe(1);
  });

  it("still performs the initial request when the retry budget is zero", async () => {
    const ok = new Response("{}", { status: 200 });
    const f = mock(async () => ok);
    globalThis.fetch = f as unknown as typeof fetch;

    const res = await retryFetch({ ...baseOpts, maxRetries: 0 });
    expect(res).toBe(ok);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("returns a non-retriable upstream error Response verbatim, without retry or throw", async () => {
    const badRequest = new Response("bad", { status: 400 });
    const f = mock(async () => badRequest);
    globalThis.fetch = f as unknown as typeof fetch;

    const res = await retryFetch(baseOpts);
    // 400 is non-retriable: the real upstream response is surfaced to the caller,
    // distinct from an internal failure (which would throw).
    expect(res).toBe(badRequest);
    expect(res.status).toBe(400);
    expect(f.mock.calls.length).toBe(1);
  });

  it("surfaces the real 5xx upstream Response after exhausting retries — failure stays distinct from success", async () => {
    const serverErr = new Response("upstream down", { status: 503 });
    const f = mock(async () => serverErr);
    globalThis.fetch = f as unknown as typeof fetch;

    const res = await retryFetch({ ...baseOpts, maxRetries: 2 });
    expect(res).toBe(serverErr);
    // Never fabricated into a 200 default; the caller decides how to translate it.
    expect(res.status).toBe(503);
    expect(f.mock.calls.length).toBe(2);
  });

  it("does not replay a custom non-retriable status", async () => {
    const serverErr = new Response("terminal upstream failure", { status: 503 });
    const f = mock(async () => serverErr);
    globalThis.fetch = f as unknown as typeof fetch;

    const res = await retryFetch({
      ...baseOpts,
      maxRetries: 3,
      nonRetriableStatuses: [503],
    });
    expect(res).toBe(serverErr);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not replay an unsafe POST after an ambiguous 5xx", async () => {
    const f = mock(async () => new Response("ambiguous", { status: 503 }));
    globalThis.fetch = f as unknown as typeof fetch;
    const res = await retryFetch({
      ...baseOpts,
      replayPolicy: "never",
      maxRetries: 3,
    });
    expect(res.status).toBe(503);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
