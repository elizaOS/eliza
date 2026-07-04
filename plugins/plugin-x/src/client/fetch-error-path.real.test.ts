/**
 * Real error-path tests for the X client read/search/follow helpers (#12272).
 *
 * The fault is injected at the twitter-api-v2 transport edge — a hand-rolled v2
 * client whose calls reject — while the real helper logic under test runs
 * unmocked. Asserts a transport/API failure now surfaces as a typed
 * `ElizaError` (with the classification `code`) instead of a fabricated
 * `null`/`[]`, and that a genuine "not found" empty payload still returns the
 * designed empty result. This is the load-bearing distinction the sweep adds:
 * "fetch failed" is no longer indistinguishable from "no such tweet".
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { TwitterAuth } from "./auth";
import { getFollowing } from "./relationships";
import { SearchMode, searchTweets } from "./search";
import { getTweet, getTweetsV2, getTweetV2 } from "./tweets";

const BOOM = new Error("HTTP 503 from api.twitter.com");

/** A TwitterAuth whose v2 client is the supplied fake. */
function authWith(v2: Record<string, unknown>): TwitterAuth {
  return {
    getV2Client: async () => ({ v2 }),
  } as unknown as TwitterAuth;
}

/** A v2 method that rejects with a transport-style error. */
function faulting(): () => Promise<never> {
  return () => Promise.reject(BOOM);
}

describe("X client read paths fail fast (do not fabricate defaults)", () => {
  it("getTweet throws X_TWEET_FETCH_FAILED (not null) on a transport fault", async () => {
    const auth = authWith({ singleTweet: faulting() });
    await expect(getTweet("123", auth)).rejects.toMatchObject({
      code: "X_TWEET_FETCH_FAILED",
    });
    await expect(getTweet("123", auth)).rejects.toBeInstanceOf(ElizaError);
  });

  it("getTweet preserves a genuine not-found as null", async () => {
    const auth = authWith({ singleTweet: async () => ({ data: undefined }) });
    await expect(getTweet("123", auth)).resolves.toBeNull();
  });

  it("getTweetV2 throws X_TWEET_FETCH_FAILED (not null) on a transport fault", async () => {
    const auth = authWith({ singleTweet: faulting() });
    await expect(getTweetV2("123", auth)).rejects.toMatchObject({
      code: "X_TWEET_FETCH_FAILED",
    });
  });

  it("getTweetV2 preserves a genuine not-found as null", async () => {
    const auth = authWith({ singleTweet: async () => ({ data: undefined }) });
    await expect(getTweetV2("123", auth)).resolves.toBeNull();
  });

  it("getTweetsV2 throws X_TWEET_FETCH_FAILED (not []) on a transport fault", async () => {
    const auth = authWith({ tweets: faulting() });
    await expect(getTweetsV2(["1", "2"], auth)).rejects.toMatchObject({
      code: "X_TWEET_FETCH_FAILED",
    });
  });

  it("getTweetsV2 preserves a genuine empty result as []", async () => {
    const auth = authWith({ tweets: async () => ({ data: [] }) });
    await expect(getTweetsV2(["1", "2"], auth)).resolves.toEqual([]);
  });

  it("getTweetsV2 preserves an all-missing response as []", async () => {
    const auth = authWith({ tweets: async () => ({ data: undefined }) });
    await expect(getTweetsV2(["1", "2"], auth)).resolves.toEqual([]);
  });

  it("getTweetsV2 throws when the v2 client is uninitialized (not [])", async () => {
    const auth = { getV2Client: async () => null } as unknown as TwitterAuth;
    await expect(getTweetsV2(["1"], auth)).rejects.toThrow(
      "V2 client is not initialized",
    );
  });
});

describe("X client search fails fast", () => {
  it("searchTweets throws X_SEARCH_FAILED (not swallowed) on a transport fault", async () => {
    const auth = authWith({ search: faulting() });
    const iterator = searchTweets("hello", 10, SearchMode.Latest, auth);
    await expect(iterator.next()).rejects.toMatchObject({
      code: "X_SEARCH_FAILED",
    });
  });
});

describe("X client relationship reads fail fast", () => {
  it("getFollowing throws X_FOLLOWING_FETCH_FAILED (not swallowed) on a fault", async () => {
    const auth = authWith({ following: faulting() });
    const iterator = getFollowing("user-1", 10, auth);
    await expect(iterator.next()).rejects.toMatchObject({
      code: "X_FOLLOWING_FETCH_FAILED",
    });
  });
});
