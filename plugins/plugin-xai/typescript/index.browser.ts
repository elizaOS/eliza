import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import {
  handleTextEmbedding,
  handleTextLarge,
  handleTextSmall,
  isGrokConfigured,
} from "./models/grok";

export type { TwitterConfig } from "./environment";
export type { ActionResponse, IXClient, MediaData, Post } from "./types";

export const XAIPlugin: Plugin = {
  name: "xai",
  description: "xAI Grok models (browser-safe, no X actions/services)",

  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    logger.log("Initializing xAI browser plugin...");
    if (isGrokConfigured(runtime)) {
      logger.log("✓ Grok API configured");
    }
  },

  models: {
    [ModelType.TEXT_SMALL]: handleTextSmall,
    [ModelType.TEXT_LARGE]: handleTextLarge,
    [ModelType.TEXT_EMBEDDING]: handleTextEmbedding,
  },
};

export default XAIPlugin;
