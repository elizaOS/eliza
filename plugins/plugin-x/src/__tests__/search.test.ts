import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { searchXAction } from "../actions/searchX.js";
import { X_FEED_ADAPTER_SERVICE_TYPE } from "../actions/x-feed-adapter.js";
import type { XFeedTweet } from "../actions/x-feed-helpers.js";

function makeAdapter(recorder: { lastQuery?: string; lastMax?: number }) {
  const tweets: XFeedTweet[] = [
    {
      id: "t1",
      authorId: "a1",
      username: "u1",
      text: "hello elizaos",
      likeCount: 2,
      retweetCount: 0,
      replyCount: 0,
      createdAt: null,
    },
  ];
  return {
    fetchHomeTimeline: async () => tweets,
    searchRecent: async (query: string, maxResults: number) => {
      recorder.lastQuery = query;
      recorder.lastMax = maxResults;
      return tweets;
    },
    listDirectMessages: async () => [],
    sendDirectMessage: async () => ({ id: "x" }),
    createTweet: async () => ({ id: "x" }),
  };
}

function runtimeWithAdapter(
  adapter: ReturnType<typeof makeAdapter>,
): IAgentRuntime {
  return {
    getService: (type: string) =>
      type === X_FEED_ADAPTER_SERVICE_TYPE ? adapter : null,
    useModel: async () => "",
  } as unknown as IAgentRuntime;
}

const baseMessage = {
  content: { text: "search twitter for elizaos" },
} as unknown as Memory;

describe("SEARCH_X handler", () => {
  it("passes explicit query + maxResults to adapter", async () => {
    const recorder: { lastQuery?: string; lastMax?: number } = {};
    const runtime = runtimeWithAdapter(makeAdapter(recorder));
    const result = await searchXAction.handler(
      runtime,
      baseMessage,
      undefined,
      {
        query: "elizaOS",
        maxResults: 25,
      },
    );
    expect(result?.success).toBe(true);
    expect(recorder.lastQuery).toBe("elizaOS");
    expect(recorder.lastMax).toBe(25);
  });

  it("clamps maxResults to [1, 100]", async () => {
    const recorder: { lastQuery?: string; lastMax?: number } = {};
    const runtime = runtimeWithAdapter(makeAdapter(recorder));
    await searchXAction.handler(runtime, baseMessage, undefined, {
      query: "x",
      maxResults: 9999,
    });
    expect(recorder.lastMax).toBe(100);

    await searchXAction.handler(runtime, baseMessage, undefined, {
      query: "x",
      maxResults: 0,
    });
    expect(recorder.lastMax).toBe(1);
  });

  it("extracts implied query from 'find recent tweets about X'", async () => {
    const recorder: { lastQuery?: string; lastMax?: number } = {};
    const runtime = runtimeWithAdapter(makeAdapter(recorder));
    const msg = {
      content: { text: "Find recent tweets about elizaOS launches" },
    } as unknown as Memory;
    const result = await searchXAction.handler(runtime, msg, undefined, {});
    expect(result?.success).toBe(true);
    expect(recorder.lastQuery).toBe("elizaOS launches");
  });

  it("fails with missing-query when no query can be resolved", async () => {
    const recorder: { lastQuery?: string; lastMax?: number } = {};
    const runtime = runtimeWithAdapter(makeAdapter(recorder));
    const msg = { content: { text: "search" } } as unknown as Memory;
    const result = await searchXAction.handler(runtime, msg, undefined, {});
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe("missing-query");
  });

  it("graceful absence when adapter missing", async () => {
    const runtime = {
      getService: () => null,
      useModel: async () => "",
    } as unknown as IAgentRuntime;
    const result = await searchXAction.handler(
      runtime,
      baseMessage,
      undefined,
      {
        query: "x",
      },
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { reason: string }).reason).toBe(
      "twitter-not-configured",
    );
  });
});
