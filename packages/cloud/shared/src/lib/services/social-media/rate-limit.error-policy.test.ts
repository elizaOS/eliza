/**
 * Fail-closed error propagation for the social-media `withRetry` transport
 * boundary (#13415). withRetry wraps every outbound platform API call; a
 * regression that swallowed a transport/HTTP failure into a fabricated
 * `{ data }` would make a broken connector look healthy. These tests pin the
 * two distinguishable outcomes: an INTERNAL failure (429 exhaustion, non-ok
 * status, thrown fn) PROPAGATES as a thrown error, while a legitimately-EMPTY
 * domain result from the parser passes through as `{ data: [] }` untouched.
 *
 * The logger dependency is mocked to silence retry warnings; the real
 * `withRetry` control flow runs. No real network — `fn` is injected, so we feed
 * it deterministic `Response` objects.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const warn = mock(() => undefined);

mock.module("../../utils/logger", () => ({
  logger: { warn, info: () => {}, error: () => {}, debug: () => {} },
}));

const { withRetry, isRateLimitResponse, createRateLimitError } = await import("./rate-limit");

afterEach(() => {
  mock.restore();
});

beforeEach(() => {
  warn.mockClear();
});

const NO_WAIT = { platform: "twitter" as const, maxRetries: 0, baseDelayMs: 0 };

describe("withRetry — internal failure propagates vs designed-empty passes through", () => {
  it("PROPAGATES a non-ok HTTP status as a thrown error (never fabricates data)", async () => {
    const fn = async () => new Response("boom", { status: 500 });
    const parser = async (r: Response) => r.json();
    await expect(withRetry(fn, parser, NO_WAIT)).rejects.toThrow("twitter API error 500: boom");
  });

  it("logs failed error-body reads without clobbering the HTTP status failure", async () => {
    const fn = async () =>
      ({
        ok: false,
        status: 503,
        text: async () => {
          throw new Error("body stream locked");
        },
      }) as Response;
    const parser = async (r: Response) => r.json();

    await expect(withRetry(fn, parser, NO_WAIT)).rejects.toThrow("twitter API error 503:");
    expect(warn.mock.calls.some(([message]) => String(message).includes("Failed to read"))).toBe(
      true,
    );
  });

  it("throws a typed RateLimitError after 429 exhaustion (fail-closed, not empty)", async () => {
    const fn = async () => new Response("", { status: 429, headers: { "retry-after": "7" } });
    const parser = async (r: Response) => r.json();
    const err = await withRetry(fn, parser, NO_WAIT).catch((e) => e);
    expect(err).toMatchObject({ rateLimited: true, platform: "twitter", retryAfter: 7 });
  });

  it("PROPAGATES a thrown fn (network/parse) as the final error, not a default", async () => {
    const fn = async () => {
      throw new Error("ECONNRESET");
    };
    const parser = async (r: Response) => r.json();
    await expect(withRetry(fn, parser, NO_WAIT)).rejects.toThrow("ECONNRESET");
  });

  it("passes a legitimately-EMPTY domain result through as { data: [] } (distinct from failure)", async () => {
    const fn = async () => new Response(JSON.stringify([]), { status: 200 });
    const parser = async (r: Response) => (await r.json()) as unknown[];
    const result = await withRetry(fn, parser, NO_WAIT);
    expect(result).toEqual({ data: [] });
  });

  it("recovers after a transient 429 then a 200 (retry surfaces success, no swallow)", async () => {
    let call = 0;
    const fn = async () => {
      call += 1;
      return call === 1
        ? new Response("", { status: 429 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const parser = async (r: Response) => (await r.json()) as { ok: boolean };
    const result = await withRetry(fn, parser, {
      platform: "twitter",
      maxRetries: 1,
      baseDelayMs: 0,
    });
    expect(result).toEqual({ data: { ok: true } });
    expect(call).toBe(2);
  });

  it("helpers stay honest: 429 detected, createRateLimitError carries platform + retryAfter", () => {
    expect(isRateLimitResponse(new Response("", { status: 429 }))).toBe(true);
    expect(isRateLimitResponse(new Response("", { status: 200 }))).toBe(false);
    const e = createRateLimitError("bluesky", 12);
    expect(e).toMatchObject({ rateLimited: true, platform: "bluesky", retryAfter: 12 });
    expect(e.message).toContain("bluesky");
  });
});
