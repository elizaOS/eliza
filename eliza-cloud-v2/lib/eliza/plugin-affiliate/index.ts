import {
  EventType,
  logger,
  type MessagePayload,
  type Plugin,
} from "@elizaos/core";
import { providersProvider } from "./providers/providers";
import { actionsProvider } from "./providers/actions";
import {
  characterProvider,
  recentMessagesProvider,
  appConfigProvider,
} from "../shared/providers";
import { generateImageAction } from "./actions/image-generation";
import { affiliateContextProvider } from "./providers/affiliate-context";
import { currentRunContextProvider } from "./providers/current-run-context";
import { handleMessage } from "./handler";
import { roomTitleEvaluator } from "../shared/evaluators";
import type {
  StreamChunkCallback,
  ReasoningChunkCallback,
} from "../shared/types";

/**
 * Affiliate Plugin
 *
 * Specialized handler for affiliate/miniapp characters.
 * Uses minimal providers, auto-image generation, and immersive character prompts.
 * Loaded instead of plugin-assistant when character has affiliateData settings.
 */
export const affiliatePlugin: Plugin = {
  name: "eliza-affiliate",
  description:
    "Affiliate character handler with auto-image generation for miniapps",
  events: {
    [EventType.MESSAGE_RECEIVED]: [
      async (payload: MessagePayload) => {
        if (!payload.callback) return;
        const extendedPayload = payload as MessagePayload & {
          onStreamChunk?: StreamChunkCallback;
          onReasoningChunk?: ReasoningChunkCallback;
        };
        const onStreamChunk = extendedPayload.onStreamChunk;
        const onReasoningChunk = extendedPayload.onReasoningChunk;
        logger.info(
          `[Affiliate] Message received in room ${payload.message.roomId}, streaming=${!!onStreamChunk}, reasoning=${!!onReasoningChunk}`,
        );
        await handleMessage({
          runtime: payload.runtime,
          message: payload.message,
          callback: payload.callback,
          onStreamChunk,
          onReasoningChunk,
        });
      },
    ],
  },
  providers: [
    providersProvider,
    actionsProvider,
    characterProvider,
    affiliateContextProvider,
    currentRunContextProvider,
    recentMessagesProvider,
    appConfigProvider,
  ],
  actions: [generateImageAction],
  evaluators: [roomTitleEvaluator],
};

export default affiliatePlugin;
