/**
 * Timeline provider for Farcaster.
 */

import {
  type Provider,
  type IAgentRuntime,
  type Memory,
  type State,
  type ProviderResult,
} from "@elizaos/core";
import { FARCASTER_SERVICE_NAME } from "../types";
import type { FarcasterService } from "../services/FarcasterService";

/**
 * Format time ago for display.
 */
function getTimeAgo(date: Date): string {
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export const farcasterTimelineProvider: Provider = {
  name: "farcasterTimeline",
  description: "Provides recent casts from the agent's Farcaster timeline",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    try {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      const castService = service?.getCastService(runtime.agentId);

      if (!castService) {
        return {
          text: "Farcaster timeline not available.",
          data: { available: false },
        };
      }

      const casts = await castService.getCasts({
        agentId: runtime.agentId,
        limit: 5,
      });

      if (!casts || casts.length === 0) {
        return {
          text: "No recent casts in your timeline.",
          data: {
            available: true,
            casts: [],
            count: 0,
          },
        };
      }

      const formattedCasts = casts
        .map((cast, index) => {
          const timeAgo = getTimeAgo(new Date(cast.timestamp));
          return `${index + 1}. @${cast.username} (${timeAgo}): ${cast.text}`;
        })
        .join("\n");

      return {
        text: `Recent casts from your timeline:\n${formattedCasts}`,
        data: {
          available: true,
          casts: casts.map((c) => ({
            id: c.id,
            username: c.username,
            text: c.text,
            timestamp: c.timestamp,
            castHash: c.metadata?.castHash,
          })),
          count: casts.length,
        },
        values: {
          latestCastHash: casts[0]?.metadata?.castHash,
          latestCastText: casts[0]?.text,
        },
      };
    } catch (error) {
      runtime.logger.error(
        "[FarcasterTimelineProvider] Error:",
        typeof error === "string" ? error : (error as Error).message
      );
      return {
        text: "Unable to fetch Farcaster timeline.",
        data: {
          available: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  },
};

