/**
 * Error-policy pins for the proxy retry-fetch transport boundary: a transport
 * failure (network error, or a TimeoutError that outlives its retries) must
 * PROPAGATE to the caller (fail closed), while a real upstream HTTP response of
 * any status is returned verbatim — never swallowed into a fabricated default.
 * Deterministic: `globalThis.fetch` is mocked, so no live network is touched.
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
};

describe("retryFetch error policy", () => {
  it("propagates a network error instead of swallowing it into a default", async () => {
    const boom = new Error("ECONNRESET");
    const f = mock(async () => {
      throw boom;
    });
    globalThis.fetch = f as unknown as typeof fetch;

    await expect(retryFetch({ ...baseOpts, maxRetries: 1 })).rejects.toBe(boom);
    // Non-timeout errors are surfaced on the first attempt, never retried away.
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
});
