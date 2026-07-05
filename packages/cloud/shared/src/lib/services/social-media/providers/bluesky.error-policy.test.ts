// Pins the fail-closed error policy of the Bluesky provider's analytics readers: an
// internal fetch failure while retrieving post/account analytics must propagate (throw),
// while the designed "analytics unavailable for an unconfigured account" result stays a
// distinct `null`. Deterministic fetch fixtures drive the real exported provider; no live
// network. Backoff sleeps are collapsed so a retrying failure rejects promptly.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("../../../utils/logger", () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}));

const { blueskyProvider } = await import("./bluesky");

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

const VALID_SESSION = {
  did: "did:plc:abc123",
  handle: "alice.bsky.social",
  accessJwt: "access-jwt",
  refreshJwt: "refresh-jwt",
};

const CREDS = { handle: "alice.bsky.social", appPassword: "app-pass" } as never;
const NO_CREDS = {} as never;

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof Request) return input.url;
  return String(input);
}

beforeEach(() => {
  // Collapse rate-limit / retry backoff sleeps so a failing request rejects without
  // waiting out the real exponential-backoff delays.
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});

describe("blueskyProvider analytics error policy", () => {
  it("getPostAnalytics returns null (designed 'not configured') without any fetch when credentials are absent", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls++;
      return jsonResponse({});
    }) as typeof fetch;

    const result = await blueskyProvider.getPostAnalytics?.(
      NO_CREDS,
      "at://did/app.bsky.feed.post/1",
    );

    expect(result).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  it("getPostAnalytics propagates an internal fetch failure instead of masking it as null", async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      const url = urlOf(input);
      if (url.includes("createSession")) return jsonResponse(VALID_SESSION);
      if (url.includes("getPostThread")) {
        return jsonResponse({ error: "InternalServerError", message: "boom" }, { status: 500 });
      }
      return jsonResponse({});
    }) as typeof fetch;

    await expect(
      blueskyProvider.getPostAnalytics?.(CREDS, "at://did/app.bsky.feed.post/1"),
    ).rejects.toThrow();
  });

  it("getPostAnalytics returns real metrics on success (drives the real reader, not a tautology)", async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      const url = urlOf(input);
      if (url.includes("createSession")) return jsonResponse(VALID_SESSION);
      if (url.includes("getPostThread")) {
        return jsonResponse({ post: { likeCount: 5, repostCount: 2, replyCount: 1 } });
      }
      return jsonResponse({});
    }) as typeof fetch;

    const result = await blueskyProvider.getPostAnalytics?.(CREDS, "at://did/app.bsky.feed.post/1");

    expect(result).not.toBeNull();
    expect(result?.platform).toBe("bluesky");
    expect(result?.metrics.likes).toBe(5);
    expect(result?.metrics.reposts).toBe(2);
    expect(result?.metrics.comments).toBe(1);
  });

  it("getAccountAnalytics returns null (designed 'not configured') without any fetch when credentials are absent", async () => {
    let fetchCalls = 0;
    globalThis.fetch = mock(async () => {
      fetchCalls++;
      return jsonResponse({});
    }) as typeof fetch;

    const result = await blueskyProvider.getAccountAnalytics?.(NO_CREDS);

    expect(result).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  it("getAccountAnalytics propagates an internal fetch failure instead of masking it as null", async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      const url = urlOf(input);
      if (url.includes("createSession")) return jsonResponse(VALID_SESSION);
      if (url.includes("getProfile"))
        return jsonResponse({ error: "Boom", message: "profile down" });
      return jsonResponse({});
    }) as typeof fetch;

    await expect(blueskyProvider.getAccountAnalytics?.(CREDS)).rejects.toThrow();
  });
});
