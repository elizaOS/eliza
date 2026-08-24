/**
 * Covers social-platform retry handling and the rate-limit wait clamp.
 *
 * The clamp is the load-bearing piece, and its two bounds guard opposite
 * failures. Without an upper bound a provider's `Retry-After: 86400` parks the
 * publishing worker for a day per attempt; worse, any wait above 2^31-1 ms is
 * coerced by `setTimeout` to 1ms, which *inverts* the backoff so the longest
 * requested pause produces the fastest retry storm. Without a lower bound a
 * negative header reaches `setTimeout` the same way. A non-finite wait must
 * therefore clamp to the MAXIMUM, not to zero.
 *
 * Retries use `baseDelayMs: 0` so the suite exercises the real ladder without
 * real waiting.
 */
import { describe, expect, test } from "bun:test";

import type { SocialPlatform } from "../../types/social-media";
import {
  clampRateLimitWaitMs,
  createRateLimitError,
  getRateLimitConfig,
  isRateLimitResponse,
  MAX_RATE_LIMIT_WAIT_MS,
  type RateLimitError,
  withRetry,
} from "./rate-limit";

const PLATFORM = "twitter" as SocialPlatform;
const ALL_PLATFORMS = [
  "twitter",
  "bluesky",
  "discord",
  "telegram",
  "slack",
  "reddit",
  "facebook",
  "instagram",
  "tiktok",
  "linkedin",
  "mastodon",
] as SocialPlatform[];

const ok = (body = '{"v":1}') => new Response(body, { status: 200 });
const limited = (headers: Record<string, string> = {}) =>
  new Response("", { status: 429, headers });
const parseJson = async (response: Response) => response.json();

describe("clampRateLimitWaitMs", () => {
  test("passes an in-range wait through unchanged", () => {
    expect(clampRateLimitWaitMs(1_000)).toBe(1_000);
    expect(clampRateLimitWaitMs(0)).toBe(0);
    expect(clampRateLimitWaitMs(MAX_RATE_LIMIT_WAIT_MS)).toBe(MAX_RATE_LIMIT_WAIT_MS);
  });

  test("caps a very large provider-requested wait", () => {
    // `Retry-After: 86400` is legal HTTP and would otherwise park one attempt
    // for a day.
    expect(clampRateLimitWaitMs(86_400_000)).toBe(MAX_RATE_LIMIT_WAIT_MS);
  });

  test("stays well below the setTimeout coercion threshold", () => {
    // Anything above 2^31-1 ms is coerced to 1ms, inverting the backoff.
    expect(clampRateLimitWaitMs(2 ** 31)).toBeLessThan(2 ** 31 - 1);
    expect(clampRateLimitWaitMs(999_999_999_999)).toBe(MAX_RATE_LIMIT_WAIT_MS);
  });

  test("floors a negative wait at zero rather than passing it to setTimeout", () => {
    expect(clampRateLimitWaitMs(-1)).toBe(0);
    expect(clampRateLimitWaitMs(-999_999)).toBe(0);
  });

  test("clamps a non-finite wait to the MAXIMUM, not to zero", () => {
    // Clamping down would turn a malformed header into a retry storm.
    expect(clampRateLimitWaitMs(Number.NaN)).toBe(MAX_RATE_LIMIT_WAIT_MS);
    expect(clampRateLimitWaitMs(Number.POSITIVE_INFINITY)).toBe(MAX_RATE_LIMIT_WAIT_MS);
    expect(clampRateLimitWaitMs(Number.NEGATIVE_INFINITY)).toBe(MAX_RATE_LIMIT_WAIT_MS);
  });
});

describe("isRateLimitResponse", () => {
  test("matches 429 and nothing else", () => {
    expect(isRateLimitResponse(limited())).toBe(true);
    for (const status of [200, 400, 403, 500, 503]) {
      expect(isRateLimitResponse(new Response("", { status }))).toBe(false);
    }
  });
});

describe("createRateLimitError", () => {
  test("carries the typed marker, platform, and retryAfter", () => {
    const error = createRateLimitError(PLATFORM, 30);
    expect(error).toBeInstanceOf(Error);
    expect(error.rateLimited).toBe(true);
    expect(error.platform).toBe(PLATFORM);
    expect(error.retryAfter).toBe(30);
    expect(error.message).toContain(PLATFORM);
  });

  test("leaves retryAfter undefined when the provider did not say", () => {
    expect(createRateLimitError(PLATFORM).retryAfter).toBeUndefined();
  });
});

describe("getRateLimitConfig", () => {
  test("returns a usable window for every supported platform", () => {
    for (const platform of ALL_PLATFORMS) {
      const config = getRateLimitConfig(platform);
      expect(config.requestsPerWindow).toBeGreaterThan(0);
      expect(config.windowMs).toBeGreaterThan(0);
    }
  });
});

describe("withRetry", () => {
  test("returns parsed data on a first-attempt success", async () => {
    const result = await withRetry(async () => ok(), parseJson, {
      platform: PLATFORM,
      baseDelayMs: 0,
    });
    expect(result).toEqual({ data: { v: 1 } });
  });

  test("retries a transient failure and succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("network blip");
        return ok();
      },
      parseJson,
      { platform: PLATFORM, baseDelayMs: 0 },
    );
    expect(calls).toBe(2);
    expect(result.data).toEqual({ v: 1 });
  });

  test("propagates the last error after exhausting retries", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("always down");
        },
        parseJson,
        { platform: PLATFORM, baseDelayMs: 0, maxRetries: 2 },
      ),
    ).rejects.toThrow("always down");
    expect(calls).toBe(3);
  });

  test("retries a 429 and succeeds once the limit clears", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        return calls === 1 ? limited() : ok();
      },
      parseJson,
      { platform: PLATFORM, baseDelayMs: 0 },
    );
    expect(calls).toBe(2);
    expect(result.data).toEqual({ v: 1 });
  });

  test("throws a typed rate-limit error once retries are exhausted", async () => {
    const error = (await withRetry(async () => limited({ "retry-after": "30" }), parseJson, {
      platform: PLATFORM,
      baseDelayMs: 0,
      maxRetries: 0,
    }).catch((e) => e)) as RateLimitError;
    expect(error.rateLimited).toBe(true);
    expect(error.platform).toBe(PLATFORM);
    // Reported verbatim in SECONDS, deliberately unclamped, so callers can
    // schedule against what the provider actually said.
    expect(error.retryAfter).toBe(30);
  });

  test("reports a very large Retry-After verbatim rather than clamped", async () => {
    const error = (await withRetry(async () => limited({ "retry-after": "86400" }), parseJson, {
      platform: PLATFORM,
      baseDelayMs: 0,
      maxRetries: 0,
    }).catch((e) => e)) as RateLimitError;
    expect(error.retryAfter).toBe(86_400);
  });

  test("does not retry a rate-limit error raised by the caller's parser", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          return ok();
        },
        async () => {
          throw createRateLimitError(PLATFORM, 5);
        },
        { platform: PLATFORM, baseDelayMs: 0, maxRetries: 3 },
      ),
    ).rejects.toMatchObject({ rateLimited: true });
    expect(calls).toBe(1);
  });

  test("surfaces a non-ok status with the platform and status in the message", async () => {
    await expect(
      withRetry(async () => new Response("boom", { status: 500 }), parseJson, {
        platform: PLATFORM,
        baseDelayMs: 0,
        maxRetries: 0,
      }),
    ).rejects.toThrow(/twitter API error 500/);
  });
});
