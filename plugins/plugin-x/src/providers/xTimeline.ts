import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import { resolveXFeedAdapter } from "../actions/x-feed-adapter.js";
import { rankFeedTweets } from "../actions/x-feed-helpers.js";

const DEFAULT_LIMIT = 5;
const DEFAULT_FETCH_COUNT = 50;

function providerText(value: unknown): string {
  return JSON.stringify({ x_timeline: value }, null, 2);
}

export const xTimelineProvider: Provider = {
  name: "xTimeline",
  description:
    "Top tweets from the X (Twitter) home timeline ranked by engagement (likes + retweets * 2).",
  descriptionCompressed:
    "X home timeline top tweets ranked by likes + retweets*2.",
  dynamic: true,
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const adapter = resolveXFeedAdapter(runtime);
    if (!adapter) {
      return { text: providerText({ status: "not_configured" }) };
    }

    try {
      const tweets = await adapter.fetchHomeTimeline(DEFAULT_FETCH_COUNT);
      const ranked = rankFeedTweets(tweets, DEFAULT_LIMIT);
      logger.info(
        {
          provider: "xTimeline",
          fetched: tweets.length,
          returned: ranked.length,
        },
        "[xTimeline] ranked home timeline",
      );
      return {
        text: providerText({
          status: "ready",
          fetchedCount: tweets.length,
          tweets: ranked.map((t) => ({
            id: t.id,
            username: t.username ?? "",
            text: t.text,
            likeCount: t.likeCount,
            retweetCount: t.retweetCount,
            replyCount: t.replyCount,
            createdAt: t.createdAt ?? "",
          })),
        }),
        data: { tweets: ranked, fetchedCount: tweets.length },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { provider: "xTimeline", error: message },
        "[xTimeline] failed to fetch home timeline",
      );
      return { text: providerText({ status: "error", error: message }) };
    }
  },
};
