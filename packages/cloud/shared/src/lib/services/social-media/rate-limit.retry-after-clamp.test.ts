/**
 * Pins the `Retry-After` sleep budget in the social-media `withRetry` transport
 * boundary. The header comes from the remote platform, so an unbounded value
 * reaches `setTimeout` directly and fails in two opposite directions:
 *
 *  - `Retry-After: 86400` (legal HTTP) parks the publishing worker for 24h per
 *    attempt with the request still open.
 *  - `setTimeout` silently coerces any delay above 2^31-1 ms to 1ms, so
 *    `Retry-After: 999999999` INVERTS the backoff — the larger the pause the
 *    provider asks for, the faster the whole retry ladder is burned through.
 *
 * The clamp must therefore have both a floor and a ceiling, and the ceiling has
 * to sit below `setTimeout`'s 32-bit range or it reproduces the inversion. It
 * must also leave ordinary values (seconds, `0`, the HTTP-date form) and the
 * value reported on the typed `RateLimitError` exactly as they are today.
 *
 * The logger is mocked to read back the wait actually chosen; the real
 * `withRetry` control flow runs and `fn` is injected, so there is no network.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const warn = mock(() => undefined);

mock.module("../../utils/logger", () => ({
  logger: { warn, info: () => {}, error: () => {}, debug: () => {} },
}));

const { withRetry, clampRateLimitWaitMs, MAX_RATE_LIMIT_WAIT_MS } = await import("./rate-limit");

/** The largest delay `setTimeout` accepts before coercing it to 1ms. */
const SET_TIMEOUT_MAX_MS = 2 ** 31 - 1;

afterEach(() => {
  mock.restore();
});

beforeEach(() => {
  warn.mockClear();
});

const rateLimited = (retryAfter: string) => async () =>
  new Response("", { status: 429, headers: { "retry-after": retryAfter } });
const parseJson = async (response: Response) => response.json();

/** The `waiting <n>ms` figure the retry loop actually handed to `sleep`. */
function loggedWaitMs(): number {
  const message = String((warn.mock.calls[0] as unknown as string[])?.[0] ?? "");
  const matched = /waiting (-?\d+)ms/.exec(message);
  if (!matched) throw new Error(`no wait logged; saw: ${message}`);
  return Number(matched[1]);
}

describe("clampRateLimitWaitMs — the ceiling has to clear setTimeout's 32-bit range", () => {
  it("never yields a delay setTimeout would silently coerce to 1ms", () => {
    // Guard the guard: the cap itself must be inside the range it protects.
    expect(MAX_RATE_LIMIT_WAIT_MS).toBeLessThanOrEqual(SET_TIMEOUT_MAX_MS);
    expect(MAX_RATE_LIMIT_WAIT_MS).toBeGreaterThan(0);

    // 2_147_484s is the first whole-second Retry-After that overflows.
    for (const seconds of [2_147_484, 999_999_999, Number.MAX_SAFE_INTEGER]) {
      const unclamped = seconds * 1000;
      expect(unclamped).toBeGreaterThan(SET_TIMEOUT_MAX_MS); // origin really does overflow
      expect(clampRateLimitWaitMs(unclamped)).toBeLessThanOrEqual(SET_TIMEOUT_MAX_MS);
      expect(clampRateLimitWaitMs(unclamped)).toBe(MAX_RATE_LIMIT_WAIT_MS);
    }
  });

  it("caps a long-but-in-range wait instead of parking the worker for a day", () => {
    expect(clampRateLimitWaitMs(86_400 * 1000)).toBe(MAX_RATE_LIMIT_WAIT_MS);
    expect(clampRateLimitWaitMs(MAX_RATE_LIMIT_WAIT_MS + 1)).toBe(MAX_RATE_LIMIT_WAIT_MS);
  });

  it("floors negatives at zero and treats a non-finite wait as the maximum, not as zero", () => {
    expect(clampRateLimitWaitMs(-1000)).toBe(0);
    expect(clampRateLimitWaitMs(Number.NEGATIVE_INFINITY)).toBe(MAX_RATE_LIMIT_WAIT_MS);
    expect(clampRateLimitWaitMs(Number.POSITIVE_INFINITY)).toBe(MAX_RATE_LIMIT_WAIT_MS);
    expect(clampRateLimitWaitMs(Number.NaN)).toBe(MAX_RATE_LIMIT_WAIT_MS);
  });

  it("leaves every ordinary wait exactly as it is today (no over-rejection)", () => {
    for (const ms of [0, 1, 1000, 5000, 30_000, MAX_RATE_LIMIT_WAIT_MS]) {
      expect(clampRateLimitWaitMs(ms)).toBe(ms);
    }
  });
});

describe("withRetry — the clamp is on the path that feeds setTimeout", () => {
  it("does not collapse an overflowing Retry-After into an instant retry storm", async () => {
    const started = Date.now();
    let settled = false;
    void withRetry(rateLimited("999999999"), parseJson, {
      platform: "twitter",
      maxRetries: 1,
      baseDelayMs: 1000,
    }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Unclamped this is sleep(999999999000) -> coerced to 1ms, so the whole
    // ladder is exhausted in single-digit milliseconds.
    expect(settled).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(loggedWaitMs()).toBe(MAX_RATE_LIMIT_WAIT_MS);
    expect(loggedWaitMs()).toBeLessThanOrEqual(SET_TIMEOUT_MAX_MS);
  });

  it("caps a 24h Retry-After yet still reports the provider's real value", async () => {
    const error = await withRetry(rateLimited("86400"), parseJson, {
      platform: "twitter",
      maxRetries: 0,
      baseDelayMs: 1000,
    }).catch((thrown) => thrown);

    // The typed error keeps the unclamped seconds so callers can reschedule.
    expect(error).toMatchObject({ rateLimited: true, platform: "twitter", retryAfter: 86400 });
  });

  it("bounds the exponential fallback used when no Retry-After is sent", () => {
    expect(clampRateLimitWaitMs(1000 * 2 ** 40)).toBe(MAX_RATE_LIMIT_WAIT_MS);
  });
});

describe("withRetry — values the live path accepts today are untouched", () => {
  it("still honours a short numeric Retry-After and recovers", async () => {
    const started = Date.now();
    let call = 0;
    const fn = async () => {
      call += 1;
      return call === 1
        ? new Response("", { status: 429, headers: { "retry-after": "1" } })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await expect(
      withRetry(fn, async (r) => (await r.json()) as { ok: boolean }, {
        platform: "twitter",
        maxRetries: 1,
        baseDelayMs: 1000,
      }),
    ).resolves.toEqual({ data: { ok: true } });

    expect(loggedWaitMs()).toBe(1000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("still preserves Retry-After: 0 as an immediate retry (#20116)", async () => {
    let call = 0;
    const fn = async () => {
      call += 1;
      return call === 1
        ? new Response("", { status: 429, headers: { "retry-after": "0" } })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await expect(
      withRetry(fn, async (r) => (await r.json()) as { ok: boolean }, {
        platform: "twitter",
        maxRetries: 1,
        baseDelayMs: 100,
      }),
    ).resolves.toEqual({ data: { ok: true } });
    expect(warn).toHaveBeenCalledWith("[twitter] Rate limited, waiting 0ms before retry 1/1");
  });

  it("still parses the HTTP-date form of Retry-After", async () => {
    const fiveSecondsOut = new Date(Date.now() + 5000).toUTCString();
    const error = await withRetry(rateLimited(fiveSecondsOut), parseJson, {
      platform: "bluesky",
      maxRetries: 0,
      baseDelayMs: 1000,
    }).catch((thrown) => thrown);

    expect(error).toMatchObject({ rateLimited: true, platform: "bluesky" });
    expect(error.retryAfter).toBeGreaterThan(0);
    expect(error.retryAfter).toBeLessThanOrEqual(5);
  });
});
