import {
  type IAgentRuntime,
  logger,
  ModelType,
  type Plugin,
} from "@elizaos/core";
import {
  handleTextEmbedding,
  handleTextLarge,
  handleTextSmall,
  isGrokConfigured,
} from "./models/grok";

export const XAIPlugin: Plugin = {
  name: "xai",
  description: "xAI Grok models for text generation and embeddings",
  autoEnable: {
    envKeys: ["XAI_API_KEY", "GROK_API_KEY"],
  },

  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    logger.log("Initializing xAI plugin...");
    if (isGrokConfigured(runtime)) {
      logger.log("✓ Grok API configured");
    } else {
      logger.warn("XAI_API_KEY not set; Grok models will fail at call time.");
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

            const baseUrl =
              runtime.getSetting("XAI_BASE_URL") || "https://api.x.ai/v1";
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
