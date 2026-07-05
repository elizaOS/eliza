/**
 * Error-policy pin for the Twitter provider (#13415). Drives the real exported
 * `twitterProvider` methods and proves the fail-closed split:
 *   - the analytics readers (`getPostAnalytics`/`getAccountAnalytics`) PROPAGATE an
 *     internal upstream failure (throw) instead of swallowing it into a fabricated
 *     `null`; `null` stays reserved for the designed no-credentials guard the service
 *     layer treats as "provider not available";
 *   - `createPost`, `validateCredentials`, and `deletePost` still translate an upstream
 *     failure into their structured `{success:false}` / `{valid:false}` DTO (J1 boundary)
 *     that the connect + credit-refund flows depend on — a returned failure, not a throw
 *     and not a fabricated success.
 *
 * The rate-limit/transport seam (`../rate-limit`) is replaced with a no-backoff
 * pass-through that mirrors the real `!response.ok` throw, so the REAL provider mapping
 * and JSON parser run without the exponential-backoff sleeps; `globalThis.fetch` supplies
 * the raw upstream Response.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { SocialCredentials } from "../../../types/social-media";

// Pass-through withRetry: run fetch once, mirror the real non-ok throw, run the parser.
// No backoff sleeps, no retry loop — the point under test is that the provider does NOT
// catch what this throws.
mock.module("../rate-limit", () => ({
  withRetry: async <T>(
    fn: () => Promise<Response>,
    parser: (r: Response) => Promise<T>,
  ): Promise<{ data: T }> => {
    const response = await fn();
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`twitter API error ${response.status}: ${body}`);
    }
    return { data: await parser(response) };
  },
}));

const { twitterProvider } = await import("./twitter");

const CREDS = { accessToken: "tok" } as SocialCredentials;

const originalFetch = globalThis.fetch;
let fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>;

function okJson(body: unknown): Partial<Response> {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function upstreamFailure(status: number, body: string): Partial<Response> {
  return { ok: false, status, json: async () => ({}), text: async () => body };
}

beforeEach(() => {
  globalThis.fetch = mock((url: string, init?: RequestInit) =>
    fetchImpl(url, init),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("twitterProvider.getPostAnalytics — internal failure propagates, guard stays null", () => {
  it("PROPAGATES an upstream failure instead of returning a fabricated null", async () => {
    fetchImpl = async () => upstreamFailure(500, "twitter upstream boom");

    const call = twitterProvider.getPostAnalytics?.(CREDS, "post-1");
    expect(call).toBeDefined();
    await expect(call).rejects.toThrow(/twitter API error 500/);
  });

  it("returns null ONLY for the designed no-credentials guard (never for a failure)", async () => {
    let fetched = false;
    fetchImpl = async () => {
      fetched = true;
      return okJson({});
    };

    const result = await twitterProvider.getPostAnalytics?.({} as SocialCredentials, "post-1");
    expect(result).toBeNull();
    expect(fetched).toBe(false);
  });

  it("maps real metrics on success", async () => {
    fetchImpl = async () =>
      okJson({
        data: {
          public_metrics: {
            like_count: 5,
            retweet_count: 3,
            reply_count: 2,
            quote_count: 1,
            impression_count: 99,
          },
        },
      });

    const result = await twitterProvider.getPostAnalytics?.(CREDS, "post-1");
    expect(result?.metrics.likes).toBe(5);
    expect(result?.metrics.reposts).toBe(3);
    expect(result?.metrics.impressions).toBe(99);
  });
});

describe("twitterProvider.getAccountAnalytics — internal failure propagates", () => {
  it("PROPAGATES an upstream failure instead of returning a fabricated null", async () => {
    fetchImpl = async () => upstreamFailure(429, "twitter account rate limit");

    const call = twitterProvider.getAccountAnalytics?.(CREDS);
    expect(call).toBeDefined();
    await expect(call).rejects.toThrow(/twitter API error 429/);
  });

  it("returns null ONLY for the designed no-credentials guard", async () => {
    let fetched = false;
    fetchImpl = async () => {
      fetched = true;
      return okJson({});
    };

    const result = await twitterProvider.getAccountAnalytics?.({} as SocialCredentials);
    expect(result).toBeNull();
    expect(fetched).toBe(false);
  });

  it("maps real account metrics on success", async () => {
    fetchImpl = async () =>
      okJson({
        data: {
          id: "acct-1",
          public_metrics: {
            followers_count: 1000,
            following_count: 10,
            tweet_count: 42,
          },
        },
      });

    const result = await twitterProvider.getAccountAnalytics?.(CREDS);
    expect(result?.accountId).toBe("acct-1");
    expect(result?.metrics.followers).toBe(1000);
    expect(result?.metrics.totalPosts).toBe(42);
  });
});

describe("twitterProvider J1 boundaries — upstream failure becomes a structured failure DTO", () => {
  it("createPost returns {success:false} (the refund flow depends on this, not a throw)", async () => {
    fetchImpl = async () => upstreamFailure(403, "post rejected");

    const result = await twitterProvider.createPost(CREDS, { text: "hello" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("post rejected");
  });

  it("validateCredentials returns {valid:false} on an upstream auth failure", async () => {
    fetchImpl = async () => upstreamFailure(401, "bad token");

    const result = await twitterProvider.validateCredentials(CREDS);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("bad token");
  });

  it("deletePost returns {success:false} on an upstream failure", async () => {
    fetchImpl = async () => upstreamFailure(404, "not found");

    const result = await twitterProvider.deletePost?.(CREDS, "post-1");
    expect(result?.success).toBe(false);
    expect(result?.error).toContain("not found");
  });
});
