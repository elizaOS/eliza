/**
 * Error-policy pins for the Twitter app-automation connector (#13415): an
 * outbound send failure must surface as the typed `success:false` Result with
 * the real error and must NOT be recorded as delivered, while the designed
 * "not connected" unavailable state stays distinguishable from an internal API
 * failure. Drives the real `postAppTweet` with the Twitter client, secrets, and
 * apps repository mocked; `client.v2.tweet` behaviour is swapped per test.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
// Read at module load in getTwitterClient — must exist before the dynamic import.
process.env.TWITTER_API_KEY = "test-app-key";
process.env.TWITTER_API_SECRET_KEY = "test-app-secret";

const ORG_ID = "00000000-0000-4000-8000-00000000c001";
const APP_ID = "00000000-0000-4000-8000-00000000c002";

// Per-test control knobs.
let twitterConnected = true;
let tweetImpl: (text: string) => Promise<{ data: { id: string } }>;

interface UpdateCall {
  appId: string;
  patch: Record<string, unknown>;
}
const updateCalls: UpdateCall[] = [];

const appRow = {
  id: APP_ID,
  organization_id: ORG_ID,
  name: "Test App",
  description: "An app under test",
  app_url: "https://test-app.example",
  twitter_automation: { enabled: true, totalPosts: 3 },
};

// Mock the deep `apps` module (re-exported by the repositories barrel via
// `export * from "./apps"`) so sibling repositories keep their real exports.
const appsRepositoryMock = {
  findById: async (id: string) => (id === APP_ID ? appRow : null),
  update: async (appId: string, patch: Record<string, unknown>) => {
    updateCalls.push({ appId, patch });
    return { ...appRow, ...patch };
  },
};
mock.module("../../../db/repositories/apps", () => ({
  appsRepository: appsRepositoryMock,
  AppsRepository: class {},
}));

mock.module("../secrets", () => ({
  secretsService: {
    get: async (_org: string, key: string) => {
      if (!twitterConnected) return null;
      return key === "TWITTER_ACCESS_TOKEN" ? "access-token" : "access-token-secret";
    },
  },
}));

// The connector constructs `new TwitterApi({...})` then calls `client.v2.tweet`.
mock.module("twitter-api-v2", () => ({
  TwitterApi: class {
    v2 = { tweet: (text: string) => tweetImpl(text) };
  },
}));

// Import-safety: these are pulled in at module top but unused on the
// tweetText-provided path (no generation). Mock to keep the import cheap.
mock.module("../credits", () => ({
  creditsService: {
    deductCredits: async () => ({ success: true, newBalance: 100, transaction: null }),
    refundCredits: async () => ({ transaction: {}, newBalance: 100 }),
  },
}));

const { twitterAppAutomationService } = await import("./app-automation");

const realFetch = globalThis.fetch;
beforeEach(() => {
  updateCalls.length = 0;
  twitterConnected = true;
  tweetImpl = async () => ({ data: { id: "default" } });
  // Safety net: no real network may leak through the mocked connector.
  globalThis.fetch = (async () => {
    throw new Error("network access is not allowed in this test");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("postAppTweet error policy (#13415)", () => {
  test("outbound Twitter API failure surfaces as success:false and is NOT recorded as delivered", async () => {
    tweetImpl = async () => {
      throw new Error("Twitter API rate limited (429)");
    };

    const result = await twitterAppAutomationService.postAppTweet(ORG_ID, APP_ID, "hello world");

    // Failure is distinct: no fabricated success, no tweet id, real error text.
    expect(result.success).toBe(false);
    expect(result.error).toContain("rate limited");
    expect(result.tweetId).toBeUndefined();
    expect(result.tweetUrl).toBeUndefined();
    // Crucially: a failed send must not increment totalPosts / stamp lastPostAt.
    expect(updateCalls).toHaveLength(0);
  });

  test("successful send is distinguishable: success:true, tweet id, and post recorded", async () => {
    tweetImpl = async () => ({ data: { id: "1750000000000000000" } });

    const result = await twitterAppAutomationService.postAppTweet(ORG_ID, APP_ID, "hello world");

    expect(result.success).toBe(true);
    expect(result.tweetId).toBe("1750000000000000000");
    expect(result.tweetUrl).toContain("1750000000000000000");
    // Delivery recorded exactly once, incrementing the prior count (3 -> 4).
    expect(updateCalls).toHaveLength(1);
    const automation = updateCalls[0].patch.twitter_automation as {
      totalPosts: number;
      lastPostAt: string;
    };
    expect(automation.totalPosts).toBe(4);
    expect(typeof automation.lastPostAt).toBe("string");
  });

  test("designed 'not connected' unavailable state stays distinct from an internal failure", async () => {
    twitterConnected = false;
    let tweetAttempted = false;
    tweetImpl = async () => {
      tweetAttempted = true;
      return { data: { id: "should-not-happen" } };
    };

    const result = await twitterAppAutomationService.postAppTweet(ORG_ID, APP_ID, "hello world");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Twitter not connected");
    expect(result.tweetId).toBeUndefined();
    // No send attempted, nothing recorded — a legitimately-unavailable connector,
    // not a swallowed API error.
    expect(tweetAttempted).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });
});
