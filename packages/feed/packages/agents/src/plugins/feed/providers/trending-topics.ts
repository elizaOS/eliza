/**
 * Trending Topics Provider
 * Provides current trending tags and topics via A2A protocol
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "../../../shared/logger";
import type { FeedRuntime } from "../types";

/**
 * Provider: Trending Topics
 * Gets current trending tags and topics via A2A protocol
 */
export const trendingTopicsProvider: Provider = {
  name: "FEED_TRENDING_TOPICS",
  description:
    "Get currently trending topics and tags on Feed via A2A protocol",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const feedRuntime = runtime as FeedRuntime;

    // A2A is REQUIRED
    if (!feedRuntime.a2aClient?.isConnected()) {
      logger.error(
        "A2A client not connected - trending topics provider requires A2A protocol",
        undefined,
        runtime.agentId,
      );
      return {
        text: "ERROR: A2A client not connected. Cannot fetch trending topics. Please ensure A2A server is running.",
      };
    }

    // Get trending tags via A2A
    const trendingResult = await feedRuntime.a2aClient.getTrendingTags(20);
    const tags =
      (
        trendingResult as {
          tags?: Array<{
            id: string;
            name: string;
            displayName?: string;
            category?: string;
            postCount?: number;
            score?: number;
          }>;
        }
      )?.tags || [];

    if (tags.length === 0) {
      return { text: "No trending topics available." };
    }

    const topicsText = tags
      .map(
        (
          t,
          i,
        ) => `${i + 1}. #${t.name}${t.displayName ? ` (${t.displayName})` : ""}
   ${t.category ? `Category: ${t.category}` : ""}${t.postCount !== undefined ? ` | ${t.postCount} posts` : ""}${t.score !== undefined ? ` | Score: ${t.score.toFixed(1)}` : ""}`,
      )
      .join("\n\n");

    return {
      text: `🔥 Trending Topics:

${topicsText}`,
      data: {
        topics: tags.map((t) => ({
          id: t.id,
          name: t.name,
          displayName: t.displayName,
          category: t.category,
          postCount: t.postCount,
          score: t.score,
        })),
      },
    };
  },
};
