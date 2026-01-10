/**
 * @elizaos/plugin-twitter
 *
 * Twitter/X API v2 integration for elizaOS agents.
 * Provides:
 * - Full Twitter/X API v2 client for tweets, timelines, and interactions
 * - Optional xAI (Grok) model integration for AI-powered content
 * - Autonomous posting, discovery, and engagement capabilities
 */

import {
  type IAgentRuntime,
  type Plugin,
  type GenerateTextParams,
  type TextEmbeddingParams,
  logger,
  ModelType,
} from "@elizaos/core";

import { TwitterService } from "./services/twitter.service";
import { postTweetAction } from "./actions/postTweet";
import { getSetting } from "./utils/settings";
import {
  handleTextSmall,
  handleTextLarge,
  handleTextEmbedding,
  isGrokConfigured,
} from "./models/grok";

// Re-export types and utilities
export * from "./types";
export * from "./client";
export { TwitterService } from "./services/twitter.service";
export { getSetting } from "./utils/settings";

// ============================================================================
// Plugin Definition
// ============================================================================

export const TwitterPlugin: Plugin = {
  name: "twitter",
  description:
    "Twitter/X API v2 client with posting, interactions, timeline actions, and optional Grok AI integration",

  actions: [postTweetAction],
  services: [TwitterService],

  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    logger.log("🔧 Initializing Twitter plugin...");

    const mode = (getSetting(runtime, "TWITTER_AUTH_MODE") || "env").toLowerCase();

    if (mode === "env") {
      const apiKey = getSetting(runtime, "TWITTER_API_KEY");
      const apiSecretKey = getSetting(runtime, "TWITTER_API_SECRET_KEY");
      const accessToken = getSetting(runtime, "TWITTER_ACCESS_TOKEN");
      const accessTokenSecret = getSetting(runtime, "TWITTER_ACCESS_TOKEN_SECRET");

      if (!apiKey || !apiSecretKey || !accessToken || !accessTokenSecret) {
        const missing = [];
        if (!apiKey) missing.push("TWITTER_API_KEY");
        if (!apiSecretKey) missing.push("TWITTER_API_SECRET_KEY");
        if (!accessToken) missing.push("TWITTER_ACCESS_TOKEN");
        if (!accessTokenSecret) missing.push("TWITTER_ACCESS_TOKEN_SECRET");

        logger.warn(
          `Twitter env auth not configured - Twitter functionality will be limited. Missing: ${missing.join(", ")}`
        );
      } else {
        logger.log("✅ Twitter env credentials found");
      }
    } else if (mode === "oauth") {
      const clientId = getSetting(runtime, "TWITTER_CLIENT_ID");
      const redirectUri = getSetting(runtime, "TWITTER_REDIRECT_URI");
      if (!clientId || !redirectUri) {
        const missing = [];
        if (!clientId) missing.push("TWITTER_CLIENT_ID");
        if (!redirectUri) missing.push("TWITTER_REDIRECT_URI");
        logger.warn(
          `Twitter OAuth not configured - Twitter functionality will be limited. Missing: ${missing.join(", ")}`
        );
      } else {
        logger.log("✅ Twitter OAuth configuration found");
      }
    } else if (mode === "broker") {
      const brokerUrl = getSetting(runtime, "TWITTER_BROKER_URL");
      if (!brokerUrl) {
        logger.warn(
          "TWITTER_AUTH_MODE=broker requires TWITTER_BROKER_URL (broker auth is not implemented yet)."
        );
      } else {
        logger.log("ℹ️ Twitter broker mode configured (stub; not functional yet)");
      }
    } else {
      logger.warn(`Invalid TWITTER_AUTH_MODE=${mode}. Expected env|oauth|broker.`);
    }

    // Log Grok status
    if (isGrokConfigured(runtime)) {
      logger.log("✅ xAI (Grok) API configured");
    }
  },

  // Grok model handlers
  models: {
    [ModelType.TEXT_SMALL]: async (runtime: IAgentRuntime, params: GenerateTextParams): Promise<string> => {
      const result = await handleTextSmall(runtime, params);
      return typeof result === "string" ? result : result.text;
    },

    [ModelType.TEXT_LARGE]: async (runtime: IAgentRuntime, params: GenerateTextParams): Promise<string> => {
      const result = await handleTextLarge(runtime, params);
      return typeof result === "string" ? result : result.text;
    },

    [ModelType.TEXT_EMBEDDING]: (runtime: IAgentRuntime, params: TextEmbeddingParams | string | null): Promise<number[]> =>
      handleTextEmbedding(runtime, params ?? ""),
  },

  tests: [
    {
      name: "twitter_plugin_tests",
      tests: [
        {
          name: "grok_api_connectivity",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const apiKey = runtime.getSetting("XAI_API_KEY");
            if (!apiKey) {
              logger.info("[Grok Test] XAI_API_KEY not set, skipping");
              return;
            }

            const baseUrl = runtime.getSetting("XAI_BASE_URL") || "https://api.x.ai/v1";
            const response = await fetch(`${baseUrl}/models`, {
              headers: { Authorization: `Bearer ${apiKey}` },
            });

            if (!response.ok) {
              throw new Error(`Grok API error: ${response.status} ${response.statusText}`);
            }

            const data = (await response.json()) as { data: unknown[] };
            logger.info(`[Grok Test] Connected. ${data.data.length} models available.`);
          },
        },
        {
          name: "grok_text_generation",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            if (!isGrokConfigured(runtime)) {
              logger.info("[Grok Test] XAI_API_KEY not set, skipping");
              return;
            }

            const text = await runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: "Say hello in exactly 5 words.",
            });

            if (typeof text !== "string" || !text) {
              throw new Error("Expected non-empty string response");
            }

            logger.info(`[Grok Test] Generated: "${text.slice(0, 50)}..."`);
          },
        },
      ],
    },
  ],
};

export default TwitterPlugin;
