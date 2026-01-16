import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import type { FarcasterService } from "../services/FarcasterService";
import { FARCASTER_SERVICE_NAME } from "../types";

function getTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const spec = requireProviderSpec("timelineProvider");

export const farcasterTimelineProvider: Provider = {
  name: spec.name,
  description: "Provides recent casts from the agent's Farcaster timeline",

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
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
          castCount: casts.length,
        },
        values: {
          latestCastHash: String(casts[0]?.metadata?.castHash || ""),
          latestCastText: casts[0]?.text || "",
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
