/**
 * @elizaos/plugin-xai
 *
 * Unified xAI integration for elizaOS agents:
 * - xAI Grok models for text generation and embeddings
 * - X (Twitter) API v2 for social interactions
 */

import {
  type IAgentRuntime,
  type Plugin,
  logger,
  ModelType,
} from "@elizaos/core";

import { XService } from "./services/x.service";
import { postAction } from "./actions/post";
import { getSetting } from "./utils/settings";
import {
  handleTextSmall,
  handleTextLarge,
  handleTextEmbedding,
  isGrokConfigured,
} from "./models/grok";

// Re-export types and utilities
export * from "./types";
export { XService } from "./services/x.service";
export { getSetting } from "./utils/settings";

export const XAIPlugin: Plugin = {
  name: "xai",
  description: "xAI Grok models and X (Twitter) API integration",

  actions: [postAction],
  services: [XService],

  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    logger.log("Initializing xAI plugin...");

    if (isGrokConfigured(runtime)) {
      logger.log("✓ Grok API configured");
    }

    const authMode = getSetting(runtime, "X_AUTH_MODE") || "env";
    const hasApiKey = getSetting(runtime, "X_API_KEY");
    const hasBearer = getSetting(runtime, "X_BEARER_TOKEN");

    if (authMode === "env" && hasApiKey) {
      logger.log("✓ X API configured (OAuth 1.0a)");
    } else if (authMode === "bearer" && hasBearer) {
      logger.log("✓ X API configured (Bearer token)");
    } else if (authMode === "oauth") {
      logger.log("✓ X API configured (OAuth 2.0)");
    }
  },

  models: {
    [ModelType.TEXT_SMALL]: handleTextSmall,
    [ModelType.TEXT_LARGE]: handleTextLarge,
    [ModelType.TEXT_EMBEDDING]: handleTextEmbedding,
  },

  tests: [
    {
      name: "xai_plugin_tests",
      tests: [
        {
          name: "grok_api_connectivity",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const apiKey = runtime.getSetting("XAI_API_KEY");
            if (!apiKey) return;

            const baseUrl = runtime.getSetting("XAI_BASE_URL") || "https://api.x.ai/v1";
            const response = await fetch(`${baseUrl}/models`, {
              headers: { Authorization: `Bearer ${apiKey}` },
            });

            if (!response.ok) {
              throw new Error(`Grok API error: ${response.status}`);
            }

            const data = (await response.json()) as { data: unknown[] };
            logger.info(`Grok connected: ${data.data.length} models`);
          },
        },
        {
          name: "grok_text_generation",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            if (!isGrokConfigured(runtime)) return;

            const text = await runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: "Say hello in exactly 5 words.",
            });

            if (typeof text !== "string" || !text) {
              throw new Error("Expected non-empty string");
            }

            logger.info(`Generated: "${text.slice(0, 50)}..."`);
          },
        },
      ],
    },
  ],
};

export default XAIPlugin;
