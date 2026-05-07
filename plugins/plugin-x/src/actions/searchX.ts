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
  readNumberOption,
  readStringOption,
} from "./x-feed-helpers.js";

const DEFAULT_MAX_RESULTS = 10;

export const searchXAction: Action = {
  name: "SEARCH_X",
  similes: ["SEARCH_TWITTER", "SEARCH_TWEETS", "X_SEARCH"],
  description:
    "Search X recent tweets using the v2 recent search endpoint. Parameters: query (required), maxResults (optional, default 10).",
  descriptionCompressed:
    "search x recent tweet use v2 recent search endpoint parameter: query (require), maxresult (optional, default 10)",
  contexts: ["knowledge", "web", "social_posting", "connectors"],
  contextGate: { anyOf: ["knowledge", "web", "social_posting", "connectors"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "query",
      description: "Search query to run against X recent tweets.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "maxResults",
      description: "Maximum tweets to return (1-100).",
      required: false,
      schema: { type: "number", minimum: 1, maximum: 100, default: 10 },
    },
  ],
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Find recent tweets about elizaOS" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Searching X for recent elizaOS tweets.",
          action: "SEARCH_X",
        },
      },
    ],
  ],
  validate: async (_runtime, message: Memory) => {
    const text = (message.content?.text ?? "").toLowerCase();
    return (
      /\b(search|find|recent)\b/.test(text) &&
      /\b(tweet|twitter|x\.com|on x)\b/.test(text)
    );
  },
  handler: async (runtime, message, _state, options) => {
    const adapter = resolveXFeedAdapter(runtime);
    if (!adapter) {
      const result = makeNotConfigured("SEARCH_X");
      return {
        success: false,
        text: result.text,
        data: { reason: result.reason },
      } satisfies ActionResult;
    }
    const opts = (options ?? {}) as Record<string, unknown>;
    const query =
      readStringOption(opts, "query") ??
      readStringOption(opts, "q") ??
      extractImpliedQuery(message.content?.text);
    if (!query) {
      return {
        success: false,
        text: "SEARCH_X requires a query parameter.",
        data: { reason: "missing-query" },
      } satisfies ActionResult;
    }
    const maxResults = clampMaxResults(
      readNumberOption(opts, "maxResults") ?? DEFAULT_MAX_RESULTS,
    );

    try {
      const tweets = await adapter.searchRecent(query, maxResults);
      logger.info(
        { action: "SEARCH_X", query, maxResults, returned: tweets.length },
        "[SEARCH_X] recent search completed",
      );
      return {
        success: true,
        text: `Found ${tweets.length} tweet(s) matching "${query}".`,
        data: {
          query,
          maxResults,
          tweets,
        },
      } satisfies ActionResult;
    } catch (error) {
      if (isRateLimitError(error)) {
        const result = makeRateLimited(
          "SEARCH_X",
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

function clampMaxResults(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.max(1, Math.floor(n)), 100);
}

function extractImpliedQuery(text: string | undefined): string | null {
  if (!text) return null;
  // "find recent tweets about X" / "search X for Y"
  const about = text.match(/about\s+(.+?)(?:[.!?]|$)/i);
  if (about?.[1]) return about[1].trim();
  const forMatch = text.match(
    /(?:search|find)\s+(?:for|x for|twitter for)\s+(.+?)(?:[.!?]|$)/i,
  );
  if (forMatch?.[1]) return forMatch[1].trim();
  return null;
}
