import {
  type Action,
  type ActionResult,
  logger,
  type Memory,
  ModelType,
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

export const summarizeFeedAction: Action = {
  name: "SUMMARIZE_FEED",
  similes: ["X_FEED_SUMMARY", "SUMMARIZE_TWITTER", "SUMMARIZE_X_FEED"],
  description:
    "Fetch the top-N X tweets and produce a concise natural-language summary using the runtime's small text model.",
  descriptionCompressed:
    "fetch top-n x tweet produce concise natural-language summary use runtime small text model",
  contexts: ["knowledge", "web", "social_posting", "connectors"],
  contextGate: { anyOf: ["knowledge", "web", "social_posting", "connectors"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "limit",
      description: "Number of top feed tweets to summarize.",
      required: false,
      schema: { type: "number", minimum: 1, maximum: 25, default: 5 },
    },
    {
      name: "fetchCount",
      description: "Number of feed tweets to fetch before ranking.",
      required: false,
      schema: { type: "number", minimum: 1, maximum: 100, default: 50 },
    },
  ],
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Summarize the top 5 tweets in my feed today." },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Pulling your X feed and summarizing.",
          action: "SUMMARIZE_FEED",
        },
      },
    ],
  ],
  validate: async (_runtime, message: Memory) => {
    const text = (message.content?.text ?? "").toLowerCase();
    return (
      /\b(summar|digest|recap)/.test(text) &&
      /\b(feed|timeline|tweets?|twitter|x\.com)\b/.test(text)
    );
  },
  handler: async (runtime, _message, _state, options) => {
    const adapter = resolveXFeedAdapter(runtime);
    if (!adapter) {
      const result = makeNotConfigured("SUMMARIZE_FEED");
      return {
        success: false,
        text: result.text,
        data: { reason: result.reason },
      } satisfies ActionResult;
    }
    const opts = (options ?? {}) as Record<string, unknown>;
    const limit = readNumberOption(opts, "limit") ?? DEFAULT_LIMIT;
    const fetchCount =
      readNumberOption(opts, "fetchCount") ??
      Math.max(limit * 4, DEFAULT_FETCH_COUNT);

    let ranked: XFeedTweet[];
    try {
      const tweets = await adapter.fetchHomeTimeline(fetchCount);
      ranked = rankFeedTweets(tweets, limit);
    } catch (error) {
      if (isRateLimitError(error)) {
        const result = makeRateLimited(
          "SUMMARIZE_FEED",
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

    if (ranked.length === 0) {
      return {
        success: true,
        text: "Your X feed is empty right now — nothing to summarize.",
        data: { tweets: ranked, summary: "" },
      } satisfies ActionResult;
    }

    const prompt = buildSummaryPrompt(ranked);
    const summary = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const summaryText =
      typeof summary === "string"
        ? summary.trim()
        : String(summary ?? "").trim();

    logger.info(
      {
        action: "SUMMARIZE_FEED",
        ranked: ranked.length,
        summaryChars: summaryText.length,
      },
      "[SUMMARIZE_FEED] produced feed summary",
    );

    return {
      success: true,
      text: summaryText,
      data: {
        tweets: ranked,
        summary: summaryText,
      },
    } satisfies ActionResult;
  },
};

export function buildSummaryPrompt(tweets: XFeedTweet[]): string {
  const lines = tweets.map((t, i) => {
    const author = t.username ? `@${t.username}` : (t.authorId ?? "unknown");
    return `${i + 1}. ${author} (likes=${t.likeCount}, rt=${t.retweetCount}): ${t.text}`;
  });
  return [
    "Summarize the following top X/Twitter posts into a concise (≤6 sentences) digest for the user.",
    "Focus on themes, noteworthy takes, and who said what. Do not link out. Do not tell the user to visit x.com.",
    "",
    "Tweets:",
    ...lines,
    "",
    "Digest:",
  ].join("\n");
}
