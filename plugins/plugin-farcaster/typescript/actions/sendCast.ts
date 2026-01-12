import {
  type Action,
  createUniqueUuid,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import type { FarcasterService } from "../services/FarcasterService";
import { FARCASTER_SERVICE_NAME } from "../types";

export const sendCastAction: Action = {
  name: "SEND_CAST",
  description: "Posts a cast (message) on Farcaster",
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Can you post about the new ElizaOS features on Farcaster?",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll post about the new ElizaOS features on Farcaster now.",
          actions: ["SEND_CAST"],
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Share on Farcaster that we just launched version 2.0!",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll share the version 2.0 launch announcement on Farcaster.",
          actions: ["SEND_CAST"],
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || "";
    const keywords = ["post", "cast", "share", "announce", "farcaster"];

    const hasKeyword = keywords.some((keyword) => text.includes(keyword));

    const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
    const isServiceAvailable = !!service?.getCastService(runtime.agentId);

    return hasKeyword && isServiceAvailable;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    try {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      const postService = service?.getCastService(runtime.agentId);

      if (!postService) {
        runtime.logger.error("[SEND_CAST] PostService not available");
        return { success: false, error: "PostService not available" };
      }

      let castContent = "";

      if (state?.castContent) {
        castContent = state.castContent as string;
      } else {
        const prompt = `Based on this request: "${message.content.text}", generate a concise Farcaster cast (max 320 characters). Be engaging and use appropriate hashtags if relevant.`;

        const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
        castContent = typeof response === "string" ? response : String(response);
      }

      if (castContent.length > 320) {
        castContent = `${castContent.substring(0, 317)}...`;
      }

      const cast = await postService.createCast({
        agentId: runtime.agentId,
        roomId: createUniqueUuid(runtime, "farcaster-timeline"),
        text: castContent,
      });

      runtime.logger.info(`[SEND_CAST] Successfully posted cast: ${cast.id}`);

      await runtime.createMemory(
        {
          agentId: runtime.agentId,
          roomId: cast.roomId,
          entityId: runtime.agentId,
          content: {
            text: castContent,
            source: "farcaster",
            metadata: {
              castHash: String(cast.metadata?.castHash || ""),
              action: "SEND_CAST",
            },
          },
          createdAt: cast.timestamp,
        },
        "messages"
      );
      return { success: true, text: `Posted cast: ${cast.id}` };
    } catch (error) {
      runtime.logger.error(
        "[SEND_CAST] Error posting cast:",
        typeof error === "string" ? error : (error as Error).message
      );
      return { success: false, error: (error as Error).message };
    }
  },
};
