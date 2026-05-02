import { EventType, logger, type MessagePayload, type Plugin } from "@elizaos/core";
import { roomTitleEvaluator } from "../shared/evaluators/room-title";
import { appConfigProvider } from "../shared/providers/app-config";
import { characterProvider } from "../shared/providers/character";
import { recentMessagesProvider } from "../shared/providers/recent-messages";
import type { StreamChunkCallback } from "../shared/types";
import { handleMessage } from "./handler";

export const chatPlaygroundPlugin: Plugin = {
  name: "eliza-chat-playground",
  description: "Simple chat mode with MCP tool support",
  events: {
    [EventType.MESSAGE_RECEIVED]: [
      async (payload: MessagePayload) => {
        if (!payload.callback) return;
        // Extract onStreamChunk if present (added by eliza-cloud message handler)
        const onStreamChunk = (payload as MessagePayload & { onStreamChunk?: StreamChunkCallback })
          .onStreamChunk;
        logger.info(
          `[Playground] Message received in room ${payload.message.roomId}, streaming=${!!onStreamChunk}`,
        );
        await handleMessage({
          runtime: payload.runtime,
          message: payload.message,
          callback: payload.callback,
          onStreamChunk,
        });
      },
    ],
  },
  providers: [characterProvider, recentMessagesProvider, appConfigProvider],
  actions: [],
  evaluators: [roomTitleEvaluator],
};

export default chatPlaygroundPlugin;
