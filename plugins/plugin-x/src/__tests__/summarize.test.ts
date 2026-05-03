import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildSummaryPrompt,
  summarizeFeedAction,
} from "../actions/summarizeFeed.js";
import { X_FEED_ADAPTER_SERVICE_TYPE } from "../actions/x-feed-adapter.js";
import type { XFeedTweet } from "../actions/x-feed-helpers.js";

function tweet(i: number, likes: number, rts: number): XFeedTweet {
  return {
    id: `t${i}`,
    authorId: `a${i}`,
    username: `user${i}`,
    text: `content ${i}`,
    likeCount: likes,
    retweetCount: rts,
    replyCount: 0,
    createdAt: null,
  };
}

function fakeAdapter(tweets: XFeedTweet[]) {
  return {
    fetchHomeTimeline: async () => tweets,
    searchRecent: async () => tweets,
    listDirectMessages: async () => [],
    sendDirectMessage: async () => ({ id: "x" }),
    createTweet: async () => ({ id: "x" }),
  };
}

const message = {
  content: { text: "Summarize my feed" },
} as unknown as Memory;

describe("SUMMARIZE_FEED handler", () => {
  it("composes FETCH_FEED_TOP + useModel call", async () => {
    const useModel = vi.fn(async () => "FAKE SUMMARY");
    const adapter = fakeAdapter([
      tweet(1, 10, 0),
      tweet(2, 100, 10),
      tweet(3, 2, 1),
    ]);
    const runtime = {
      getService: (type: string) =>
        type === X_FEED_ADAPTER_SERVICE_TYPE ? adapter : null,
      useModel,
    } as unknown as IAgentRuntime;

    const result = await summarizeFeedAction.handler(
      runtime,
      message,
      undefined,
      { limit: 2 },
    );

    expect(result?.success).toBe(true);
    expect(useModel).toHaveBeenCalledTimes(1);
    const call = useModel.mock.calls[0] as unknown as [unknown, unknown];
    const [modelType, payload] = call;
    expect(String(modelType)).toMatch(/TEXT_SMALL/);
    const prompt = (payload as { prompt: string }).prompt;
    expect(prompt).toContain("Summarize");
    expect(prompt).toContain("content 2");
    const data = result?.data as {
      summary: string;
      tweets: XFeedTweet[];
    };
    expect(data.summary).toBe("FAKE SUMMARY");
    expect(data.tweets.map((t) => t.id)).toEqual(["t2", "t1"]);
  });

  it("short-circuits with empty feed (no model call)", async () => {
    const useModel = vi.fn(async () => "should not run");
    const runtime = {
      getService: (type: string) =>
        type === X_FEED_ADAPTER_SERVICE_TYPE ? fakeAdapter([]) : null,
      useModel,
    } as unknown as IAgentRuntime;
    const result = await summarizeFeedAction.handler(
      runtime,
      message,
      undefined,
      {},
    );
    expect(result?.success).toBe(true);
    expect(useModel).not.toHaveBeenCalled();
    expect(result?.text).toMatch(/empty/i);
  });

  it("surfaces rate-limit from feed fetch without calling model", async () => {
    const useModel = vi.fn(async () => "never");
    const err = Object.assign(new Error("429"), { code: 429 });
    const adapter = {
      ...fakeAdapter([]),
      fetchHomeTimeline: async () => {
        throw err;
      },
    };
    const runtime = {
      getService: (type: string) =>
        type === X_FEED_ADAPTER_SERVICE_TYPE ? adapter : null,
      useModel,
    } as unknown as IAgentRuntime;
    const result = await summarizeFeedAction.handler(
      runtime,
      message,
      undefined,
      {},
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("rate-limited");
    expect(useModel).not.toHaveBeenCalled();
  });
});

describe("buildSummaryPrompt", () => {
  it("includes each tweet and author handle", () => {
    const prompt = buildSummaryPrompt([tweet(1, 5, 1), tweet(2, 0, 0)]);
    expect(prompt).toContain("@user1");
    expect(prompt).toContain("@user2");
    expect(prompt).toContain("likes=5");
    expect(prompt).toContain("rt=1");
  });
});
