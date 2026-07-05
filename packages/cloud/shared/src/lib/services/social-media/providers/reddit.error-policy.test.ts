/**
 * Pins the fail-closed contract of the Reddit analytics readers (#13415).
 *
 * Before the sweep, `getPostAnalytics`/`getAccountAnalytics` wrapped their whole
 * body in `catch { return null }`, so an internal failure (expired auth, 5xx,
 * transport, rate-limit) returned the SAME `null` that signals a
 * legitimately-empty result (a post that does not exist / an unsupported
 * provider). A broken pipeline read as "no analytics". These tests drive the
 * real exported `redditProvider` methods and prove the two are now
 * distinguishable: a designed-empty upstream still resolves to `null`, while an
 * internal request failure PROPAGATES instead of being swallowed.
 *
 * The `rate-limit` boundary (`withRetry`) is replaced with a fast, sleepless
 * pass-through that mirrors its real semantics (throw on non-OK / 429, else run
 * the parser) so the changed branch — not the retry backoff — is under test.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SocialCredentials } from "../../../types/social-media";

mock.module("../rate-limit", () => ({
  withRetry: async (fn: () => Promise<Response>, parser: (r: Response) => Promise<unknown>) => {
    const response = await fn();
    if (response.status === 429) throw new Error("Rate limited by reddit");
    if (!response.ok) throw new Error(`reddit API error ${response.status}`);
    return { data: await parser(response) };
  },
  isRateLimitResponse: (r: Response) => r.status === 429,
}));

const { redditProvider } = await import("./reddit");

const creds = {
  apiKey: "client-id",
  apiSecret: "client-secret",
  username: "bob",
  password: "hunter2",
} as SocialCredentials;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const TOKEN = { access_token: "tok", token_type: "bearer", expires_in: 3600, scope: "*" };

let fetchQueue: Array<() => Response>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchQueue = [];
  globalThis.fetch = mock(async () => {
    const next = fetchQueue.shift();
    if (!next) throw new Error("unexpected fetch call — queue empty");
    return next();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

async function rejects(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected promise to reject, but it resolved");
}

describe("redditProvider.getPostAnalytics — fail closed vs designed empty", () => {
  test("returns null for a genuinely-missing post (empty children)", async () => {
    fetchQueue = [() => json(TOKEN), () => json([{ data: { children: [] } }])];

    const result = await redditProvider.getPostAnalytics!(creds, "t3_missing");
    expect(result).toBeNull();
  });

  test("returns metrics for an existing post", async () => {
    fetchQueue = [
      () => json(TOKEN),
      () =>
        json([
          {
            data: {
              children: [{ data: { id: "abc", score: 42, num_comments: 7, upvote_ratio: 0.9 } }],
            },
          },
        ]),
    ];

    const result = await redditProvider.getPostAnalytics!(creds, "t3_abc");
    expect(result).not.toBeNull();
    expect(result?.metrics.likes).toBe(42);
    expect(result?.metrics.comments).toBe(7);
  });

  test("PROPAGATES an internal failure (5xx on the info call) instead of returning null", async () => {
    fetchQueue = [() => json(TOKEN), () => json({ error: "server" }, 500)];

    const err = await rejects(redditProvider.getPostAnalytics!(creds, "t3_abc"));
    expect(err.message).toContain("500");
  });

  test("PROPAGATES a rate-limit failure instead of returning null", async () => {
    fetchQueue = [() => json(TOKEN), () => json({}, 429)];

    const err = await rejects(redditProvider.getPostAnalytics!(creds, "t3_abc"));
    expect(err.message).toContain("Rate limited");
  });

  test("PROPAGATES an auth failure (token endpoint down) instead of returning null", async () => {
    fetchQueue = [() => json({ error: "unauthorized" }, 401)];

    const err = await rejects(redditProvider.getPostAnalytics!(creds, "t3_abc"));
    expect(err.message).toContain("401");
  });
});

describe("redditProvider.getAccountAnalytics — fail closed", () => {
  test("returns metrics on success", async () => {
    fetchQueue = [
      () => json(TOKEN),
      () => json({ data: { id: "u1", name: "bob", link_karma: 5, comment_karma: 3 } }),
    ];

    const result = await redditProvider.getAccountAnalytics!(creds);
    expect(result?.accountId).toBe("u1");
    expect(result?.metrics.totalPosts).toBe(8);
  });

  test("PROPAGATES an internal failure (5xx on /api/v1/me) instead of returning null", async () => {
    fetchQueue = [() => json(TOKEN), () => json({ error: "server" }, 503)];

    const err = await rejects(redditProvider.getAccountAnalytics!(creds));
    expect(err.message).toContain("503");
  });
});
