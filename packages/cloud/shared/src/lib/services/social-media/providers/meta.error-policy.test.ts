// Pins the fail-closed error policy of the Meta (Facebook/Instagram Graph API) provider's
// analytics readers: an internal Graph API / transport failure while reading post or account
// analytics must propagate (throw), while the designed "provider not configured" result stays
// a distinct `null`. Before the sweep both readers wrapped their whole body in try/catch (and
// getAccountAnalytics silently fell IG→FB) so a broken pipeline read as "no analytics".
// Deterministic fetch fixtures drive the real exported provider; no live network. Backoff
// sleeps are collapsed so a retrying failure rejects promptly.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("../../../utils/logger", () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}));

const { metaProvider } = await import("./meta");

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

// A Graph API error surfaces as a 200 body carrying `.error`; graphApiRequest's parser
// throws on it, which withRetry re-raises after exhausting retries.
const GRAPH_ERROR = {
  error: { message: "Invalid OAuth access token", code: 190, type: "OAuthException" },
};

const TOKEN = "graph-token";

beforeEach(() => {
  // Collapse the rate-limit / retry exponential backoff so a failing request rejects without
  // waiting out the real delays.
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});

describe("metaProvider.getPostAnalytics — internal failure propagates, empty stays null", () => {
  it("returns null (designed 'not configured') without any fetch when the access token is absent", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls++;
      return jsonResponse({});
    }) as typeof fetch;

    const result = await metaProvider.getPostAnalytics!({} as never, "post-1");

    expect(result).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  it("propagates a Graph API failure on the Facebook read instead of masking it as null", async () => {
    globalThis.fetch = mock(async () => jsonResponse(GRAPH_ERROR)) as typeof fetch;

    await expect(
      metaProvider.getPostAnalytics!({ accessToken: TOKEN } as never, "post-1"),
    ).rejects.toThrow();
  });

  it("propagates a Graph API failure on the Instagram read (accountId route) instead of null", async () => {
    globalThis.fetch = mock(async () => jsonResponse(GRAPH_ERROR)) as typeof fetch;

    await expect(
      metaProvider.getPostAnalytics!({ accessToken: TOKEN, accountId: "ig-1" } as never, "post-1"),
    ).rejects.toThrow();
  });

  it("returns real Facebook metrics on success (drives the real reader, not a tautology)", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({
        id: "post-1",
        likes: { summary: { total_count: 10 } },
        comments: { summary: { total_count: 4 } },
        shares: { count: 2 },
      }),
    ) as typeof fetch;

    const result = await metaProvider.getPostAnalytics!({ accessToken: TOKEN } as never, "post-1");

    expect(result).not.toBeNull();
    expect(result?.platform).toBe("facebook");
    expect(result?.metrics.likes).toBe(10);
    expect(result?.metrics.comments).toBe(4);
    expect(result?.metrics.shares).toBe(2);
  });

  it("returns real Instagram metrics on success when an accountId is configured", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ id: "post-1", like_count: 7, comments_count: 3 }),
    ) as typeof fetch;

    const result = await metaProvider.getPostAnalytics!(
      { accessToken: TOKEN, accountId: "ig-1" } as never,
      "post-1",
    );

    expect(result?.platform).toBe("instagram");
    expect(result?.metrics.likes).toBe(7);
    expect(result?.metrics.comments).toBe(3);
  });
});

describe("metaProvider.getAccountAnalytics — internal failure propagates, empty stays null", () => {
  it("returns null (designed 'not configured') without any fetch when the access token is absent", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls++;
      return jsonResponse({});
    }) as typeof fetch;

    const result = await metaProvider.getAccountAnalytics!({} as never);

    expect(result).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  it("returns null (designed 'no target configured') without any fetch when neither accountId nor pageId is set", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls++;
      return jsonResponse({});
    }) as typeof fetch;

    const result = await metaProvider.getAccountAnalytics!({ accessToken: TOKEN } as never);

    expect(result).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  it("propagates an Instagram-account read failure instead of falling through to Facebook as null", async () => {
    // The pre-sweep code caught the IG failure and fell through to Facebook (then null),
    // masking the real failure even though the caller only configured an accountId.
    globalThis.fetch = mock(async () => jsonResponse(GRAPH_ERROR)) as typeof fetch;

    await expect(
      metaProvider.getAccountAnalytics!({ accessToken: TOKEN, accountId: "ig-1" } as never),
    ).rejects.toThrow();
  });

  it("propagates a Facebook-page read failure instead of masking it as null", async () => {
    globalThis.fetch = mock(async () => jsonResponse(GRAPH_ERROR)) as typeof fetch;

    await expect(
      metaProvider.getAccountAnalytics!({ accessToken: TOKEN, pageId: "page-1" } as never),
    ).rejects.toThrow();
  });

  it("returns real Instagram account metrics on success", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({
        id: "ig-1",
        username: "milady",
        followers_count: 500,
        follows_count: 42,
        media_count: 8,
      }),
    ) as typeof fetch;

    const result = await metaProvider.getAccountAnalytics!({
      accessToken: TOKEN,
      accountId: "ig-1",
    } as never);

    expect(result?.platform).toBe("instagram");
    expect(result?.metrics.followers).toBe(500);
    expect(result?.metrics.following).toBe(42);
    expect(result?.metrics.totalPosts).toBe(8);
  });

  it("returns real Facebook page metrics on success", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ id: "page-1", name: "Milady", fan_count: 1234 }),
    ) as typeof fetch;

    const result = await metaProvider.getAccountAnalytics!({
      accessToken: TOKEN,
      pageId: "page-1",
    } as never);

    expect(result?.platform).toBe("facebook");
    expect(result?.metrics.followers).toBe(1234);
  });
});
