import {
  type Action,
  type ActionResult,
  logger,
  type Memory,
} from "@elizaos/core";
import { resolveXFeedAdapter } from "./x-feed-adapter.js";
import {
  extractRetryAfterSeconds,
  isRateLimitError,
  makeNotConfigured,
  makeRateLimited,
  rankFeedTweets,
  readNumberOption,
  type XFeedTweet,
} from "./x-feed-helpers.js";

const DEFAULT_LIMIT = 5;
const DEFAULT_FETCH_COUNT = 50;

export const fetchFeedTopAction: Action = {
  name: "FETCH_FEED_TOP",
  similes: ["GET_X_FEED", "TOP_TWEETS", "FEED_TOP"],
  description:
    "Fetch the home timeline from X and return the top-N tweets ranked by engagement (likes + retweets * 2).",
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What are the top tweets in my feed today?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Fetching your X feed now.",
          action: "FETCH_FEED_TOP",
        },
      },
    ],
  ],
  validate: async (_runtime, message: Memory) => {
    const text = (message.content?.text ?? "").toLowerCase();
    return /\b(feed|timeline|tweets?|x\.com|twitter)\b/.test(text);
  },
  handler: async (runtime, _message, _state, options) => {
    const adapter = resolveXFeedAdapter(runtime);
    if (!adapter) {
      const result = makeNotConfigured("FETCH_FEED_TOP");
      return {
        success: false,
        text: result.text,
        data: { reason: result.reason },
      } satisfies ActionResult;
    }
    const limit =
      readNumberOption(options as Record<string, unknown>, "limit") ??
      DEFAULT_LIMIT;
    const fetchCount =
      readNumberOption(options as Record<string, unknown>, "fetchCount") ??
      Math.max(limit * 4, DEFAULT_FETCH_COUNT);

    try {
      const tweets: XFeedTweet[] = await adapter.fetchHomeTimeline(fetchCount);
      const ranked = rankFeedTweets(tweets, limit);
      logger.info(
        {
          action: "FETCH_FEED_TOP",
          fetched: tweets.length,
          returned: ranked.length,
        },
        "[FETCH_FEED_TOP] ranked home timeline",
      );
      return {
        success: true,
        text: `Fetched ${ranked.length} top tweet(s) from your X feed.`,
        data: {
          tweets: ranked,
          fetchedCount: tweets.length,
        },
      } satisfies ActionResult;
    } catch (error) {
      if (isRateLimitError(error)) {
        const result = makeRateLimited(
          "FETCH_FEED_TOP",
          extractRetryAfterSeconds(error),
        );
        return {
          success: false,
          text: result.text,
          data: {
            reason: result.reason,
            retryAfterSeconds: result.retryAfterSeconds,
          },
        } satisfies ActionResult;
      }
      throw error;
    }
  },
};
