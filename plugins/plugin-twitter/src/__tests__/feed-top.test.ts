import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { fetchFeedTopAction } from "../actions/fetchFeedTop.js";
import { X_FEED_ADAPTER_SERVICE_TYPE } from "../actions/x-feed-adapter.js";
import {
  rankFeedTweets,
  type XDirectMessage,
  type XFeedTweet,
} from "../actions/x-feed-helpers.js";

function tweet(
  overrides: Partial<XFeedTweet> & Pick<XFeedTweet, "id">,
): XFeedTweet {
  return {
    id: overrides.id,
    authorId: overrides.authorId ?? "author-1",
    username: overrides.username ?? "user1",
    text: overrides.text ?? `tweet ${overrides.id}`,
    likeCount: overrides.likeCount ?? 0,
    retweetCount: overrides.retweetCount ?? 0,
    replyCount: overrides.replyCount ?? 0,
    createdAt: overrides.createdAt ?? null,
  };
}

function fakeAdapter(tweets: XFeedTweet[]) {
  return {
    fetchHomeTimeline: async () => tweets,
    searchRecent: async () => tweets,
    listDirectMessages: async (): Promise<XDirectMessage[]> => [],
    sendDirectMessage: async () => ({ id: "noop" }),
    createTweet: async () => ({ id: "noop" }),
  };
}

function runtimeWithAdapter(
  adapter: ReturnType<typeof fakeAdapter>,
): IAgentRuntime {
  const runtime = {
    getService: (type: string) =>
      type === X_FEED_ADAPTER_SERVICE_TYPE ? adapter : null,
    useModel: async () => "",
    agentId: "test-agent",
  } as unknown as IAgentRuntime;
  return runtime;
}

const message = {
  content: { text: "Show me my X feed top posts" },
} as unknown as Memory;

describe("rankFeedTweets", () => {
  it("ranks by likes + retweets*2 and truncates to limit", () => {
    const input = [
      tweet({ id: "a", likeCount: 10, retweetCount: 0 }), // 10
      tweet({ id: "b", likeCount: 0, retweetCount: 10 }), // 20
      tweet({ id: "c", likeCount: 5, retweetCount: 5 }), // 15
      tweet({ id: "d", likeCount: 100, retweetCount: 0 }), // 100
    ];
    const ranked = rankFeedTweets(input, 2);
    expect(ranked.map((t) => t.id)).toEqual(["d", "b"]);
  });

  it("returns [] for limit 0", () => {
    expect(rankFeedTweets([tweet({ id: "a" })], 0)).toEqual([]);
  });

  it("is stable for equal scores (input order preserved for ties)", () => {
    const input = [
      tweet({ id: "a", likeCount: 5, retweetCount: 0 }),
      tweet({ id: "b", likeCount: 5, retweetCount: 0 }),
    ];
    const ranked = rankFeedTweets(input, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((t) => t.id).sort()).toEqual(["a", "b"]);
  });
});

describe("FETCH_FEED_TOP handler", () => {
  it("returns ranked top-N tweets from adapter", async () => {
    const tweets = [
      tweet({ id: "1", likeCount: 1 }),
      tweet({ id: "2", likeCount: 100, retweetCount: 50 }),
      tweet({ id: "3", likeCount: 10, retweetCount: 10 }),
    ];
    const runtime = runtimeWithAdapter(fakeAdapter(tweets));
    const result = await fetchFeedTopAction.handler(
      runtime,
      message,
      undefined,
      { limit: 2 },
    );
    expect(result?.success).toBe(true);
    const data = result?.data as { tweets: XFeedTweet[]; fetchedCount: number };
    expect(data.tweets.map((t) => t.id)).toEqual(["2", "3"]);
    expect(data.fetchedCount).toBe(3);
  });

  it("returns twitter-not-configured when adapter unavailable", async () => {
    const runtime = {
      getService: () => null,
      useModel: async () => "",
    } as unknown as IAgentRuntime;
    const result = await fetchFeedTopAction.handler(
      runtime,
      message,
      undefined,
      {},
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe(
      "twitter-not-configured",
    );
  });

  it("surfaces rate-limit errors with retry-after", async () => {
    const rateLimitErr = Object.assign(new Error("Too Many Requests"), {
      code: 429,
      rateLimit: { reset: Math.floor(Date.now() / 1000) + 30 },
    });
    const runtime = runtimeWithAdapter({
      fetchHomeTimeline: async () => {
        throw rateLimitErr;
      },
      searchRecent: async () => [],
      listDirectMessages: async () => [],
      sendDirectMessage: async () => ({ id: "x" }),
      createTweet: async () => ({ id: "x" }),
    });
    const result = await fetchFeedTopAction.handler(
      runtime,
      message,
      undefined,
      {},
    );
    expect(result?.success).toBe(false);
    const data = result?.data as {
      reason: string;
      retryAfterSeconds: number | null;
    };
    expect(data.reason).toBe("rate-limited");
    expect(data.retryAfterSeconds).not.toBeNull();
    expect(data.retryAfterSeconds).toBeGreaterThan(0);
    expect(result?.text).toMatch(/rate limit/i);
  });
});
