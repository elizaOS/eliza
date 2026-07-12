/**
 * Error-policy pin for the TikTok provider (#13415). Drives the real exported
 * `tiktokProvider` methods and proves the fail-closed split:
 *   - the analytics readers (`getPostAnalytics`/`getAccountAnalytics`) PROPAGATE an
 *     internal upstream failure (throw) instead of swallowing it into a fabricated
 *     `null`, while `null` stays reserved for the designed-empty "no rows" result;
 *   - `createPost` and `validateCredentials` still translate an upstream failure into
 *     their structured `{success:false}` / `{valid:false}` DTO (J1 boundary) that the
 *     credit-refund + connect flows depend on — a returned failure, not a fabricated
 *     success.
 *
 * The rate-limit/transport seam (`../rate-limit`) is replaced with a no-retry
 * pass-through so the REAL `tiktokApiRequest` parser and provider branching run
 * without the exponential-backoff sleeps; `globalThis.fetch` supplies the raw
 * upstream JSON.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { SocialCredentials } from "../../../types/social-media";
import * as realRateLimit from "../rate-limit";

// bun's `mock.module` patches the process-global module registry (afterEach
// here only restores fetch). Under the batched cloud-unit runner (`--isolate`
// occasionally fails to contain these on a memory-pressured runner) this
// tiktok-specific `../rate-limit` double otherwise bleeds into the shared
// rate-limit / token-refresh suites. Snapshot the real exports now and
// reinstall them in afterAll so this file's stub is strictly local.
const realRateLimitExports = { ...realRateLimit };

// Pass-through withRetry: run fetch once, run the REAL parser (which is where
// tiktokApiRequest turns an upstream error code into a throw), no backoff sleeps.
mock.module("../rate-limit", () => ({
  withRetry: async <T>(
    fn: () => Promise<Response>,
    parser: (r: Response) => Promise<T>,
  ): Promise<{ data: T }> => {
    const response = await fn();
    return { data: await parser(response) };
  },
}));

const { tiktokProvider } = await import("./tiktok");

const CREDS = { accessToken: "tok" } as SocialCredentials;

const originalFetch = globalThis.fetch;
let fetchImpl: (url: string, init?: RequestInit) => Promise<unknown>;

function upstream(body: unknown): { json: () => Promise<unknown> } {
  return { json: async () => body };
}

beforeEach(() => {
  globalThis.fetch = mock((url: string, init?: RequestInit) =>
    fetchImpl(url, init),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.module("../rate-limit", () => realRateLimitExports);
});

describe("tiktokProvider.getPostAnalytics — internal failure propagates, empty stays null", () => {
  it("PROPAGATES an upstream failure instead of returning a fabricated null", async () => {
    fetchImpl = async () =>
      upstream({ error: { code: "internal_error", message: "tiktok upstream 500" } });

    const call = tiktokProvider.getPostAnalytics?.(CREDS, "post-1");
    expect(call).toBeDefined();
    await expect(call).rejects.toThrow("tiktok upstream 500");
  });

  it("returns null ONLY for the designed-empty result (upstream reports zero videos)", async () => {
    fetchImpl = async () => upstream({ data: { videos: [] } });

    const result = await tiktokProvider.getPostAnalytics?.(CREDS, "post-1");
    expect(result).toBeNull();
  });

  it("maps real metrics on success", async () => {
    fetchImpl = async () =>
      upstream({
        data: {
          videos: [
            { id: "post-1", like_count: 5, comment_count: 2, share_count: 1, view_count: 99 },
          ],
        },
      });

    const result = await tiktokProvider.getPostAnalytics?.(CREDS, "post-1");
    expect(result?.metrics.likes).toBe(5);
    expect(result?.metrics.videoViews).toBe(99);
  });

  it("returns null (not a throw) when no access token is configured", async () => {
    const result = await tiktokProvider.getPostAnalytics?.({} as SocialCredentials, "post-1");
    expect(result).toBeNull();
  });
});

describe("tiktokProvider.getAccountAnalytics — internal failure propagates", () => {
  it("PROPAGATES an upstream failure instead of returning a fabricated null", async () => {
    fetchImpl = async () =>
      upstream({ error: { code: "rate_limited", message: "tiktok account 429" } });

    const call = tiktokProvider.getAccountAnalytics?.(CREDS);
    expect(call).toBeDefined();
    await expect(call).rejects.toThrow("tiktok account 429");
  });

  it("maps real account metrics on success", async () => {
    fetchImpl = async () =>
      upstream({
        data: {
          user: {
            open_id: "acct-1",
            display_name: "Tester",
            follower_count: 1000,
            following_count: 10,
            video_count: 42,
          },
        },
      });

    const result = await tiktokProvider.getAccountAnalytics?.(CREDS);
    expect(result?.accountId).toBe("acct-1");
    expect(result?.metrics.followers).toBe(1000);
    expect(result?.metrics.totalPosts).toBe(42);
  });
});

describe("tiktokProvider J1 boundaries — upstream failure becomes a structured failure DTO", () => {
  it("createPost returns {success:false} (the refund flow depends on this, not a throw)", async () => {
    fetchImpl = async () =>
      upstream({ error: { code: "spam_risk_too_many_posts", message: "post rejected" } });

    const result = await tiktokProvider.createPost(CREDS, {
      text: "hello",
      media: [{ type: "video", url: "https://example.com/v.mp4" }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("post rejected");
  });

  it("validateCredentials returns {valid:false} on an upstream auth failure", async () => {
    fetchImpl = async () =>
      upstream({ error: { code: "access_token_invalid", message: "bad token" } });

    const result = await tiktokProvider.validateCredentials(CREDS);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("bad token");
  });
});
