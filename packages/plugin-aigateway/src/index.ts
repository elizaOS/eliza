import { Plugin, IAgentRuntime, ModelType, logger } from "@elizaos/core";
import { GatewayProvider } from "./providers/gateway-provider";
import {
  generateTextAction,
  generateImageAction,
  generateEmbeddingAction,
  listModelsAction,
} from "./actions";
import { getApiKey, useOIDC } from "./utils/config";

// Global provider instance
let gatewayProvider: GatewayProvider | null = null;

/**
 * AI Gateway Plugin for elizaOS
 *
 * Provides access to 100+ AI models through unified gateways like Vercel AI Gateway,
 * OpenRouter, and others. Features automatic failover, caching, and centralized billing.
 */
export const aiGatewayPlugin: Plugin = {
  name: "aigateway",
  description: "Universal AI Gateway integration for accessing 100+ AI models",

  actions: [
    generateTextAction,
    generateImageAction,
    generateEmbeddingAction,
    listModelsAction,
  ],

  evaluators: [],

  providers: [],

  services: [],

  models: {
    [ModelType.TEXT_SMALL]: async (runtime, params) => {
      if (!gatewayProvider) {
        gatewayProvider = new GatewayProvider(runtime);
      }
      return gatewayProvider.generateTextSmall(params);
    },

    [ModelType.TEXT_LARGE]: async (runtime, params) => {
      if (!gatewayProvider) {
        gatewayProvider = new GatewayProvider(runtime);
      }
      return gatewayProvider.generateTextLarge(params);
    },

    [ModelType.TEXT_EMBEDDING]: async (runtime, params) => {
      if (!gatewayProvider) {
        gatewayProvider = new GatewayProvider(runtime);
      }
      return gatewayProvider.generateEmbedding(params);
    },

    [ModelType.IMAGE]: async (runtime, params) => {
      if (!gatewayProvider) {
        gatewayProvider = new GatewayProvider(runtime);
      }
      return gatewayProvider.generateImage(params);
    },

    [ModelType.OBJECT_SMALL]: async (runtime, params) => {
      if (!gatewayProvider) {
        gatewayProvider = new GatewayProvider(runtime);
      }
      return gatewayProvider.generateObjectSmall(params);
    },

    [ModelType.OBJECT_LARGE]: async (runtime, params) => {
      if (!gatewayProvider) {
        gatewayProvider = new GatewayProvider(runtime);
      }
      return gatewayProvider.generateObjectLarge(params);
    },
  },

  /**
   * Initialize the plugin
   */
  async init(
    config: Record<string, string>,
    runtime: IAgentRuntime,
  ): Promise<void> {
    logger.log("[AIGateway] Initializing plugin...");

    // Validate API key or OIDC configuration
    const apiKey = getApiKey(runtime);
    const useOIDCAuth = useOIDC(runtime);

    if (!apiKey && !useOIDCAuth) {
      logger.warn(
        "[AIGateway] No API key configured and OIDC not enabled. " +
          "Set AIGATEWAY_API_KEY or enable AIGATEWAY_USE_OIDC=true",
      );
    }

    // Initialize the provider
    gatewayProvider = new GatewayProvider(runtime);

    logger.log("[AIGateway] Plugin initialized successfully");
  },

  /**
   * Plugin tests
   */
  tests: [
    {
      name: "aigateway_plugin_tests",
      tests: [
        {
          name: "test_text_generation",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const text = await runtime.useModel(ModelType.TEXT_SMALL, {
                prompt: 'Say "Hello, AI Gateway!" in exactly 3 words.',
              });

              if (!text || text.length === 0) {
                throw new Error("Failed to generate text");
              }

              logger.log("[AIGateway Test] Text generation successful:", text);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              logger.error(
                `[AIGateway Test] Text generation failed: ${message}`,
              );
              throw error;
            }
          },
        },
        {
          name: "test_embedding_generation",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const embedding = await runtime.useModel(
                ModelType.TEXT_EMBEDDING,
                {
                  text: "Test embedding for AI Gateway",
                },
              );

              if (!Array.isArray(embedding) || embedding.length === 0) {
                throw new Error("Failed to generate embedding");
              }

              logger.log(
                `[AIGateway Test] Embedding generation successful: ${embedding.length} dimensions`,
              );
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              logger.error(
                `[AIGateway Test] Embedding generation failed: ${message}`,
              );
              throw error;
            }
          },
        },
      ],
    },
  ],
};

// Default export
export default aiGatewayPlugin;

// Named exports for compatibility
export const plugin = aiGatewayPlugin;
export const name = "aigateway";

// Export types and utilities
export * from "./actions";
export * from "./providers";
export * from "./utils";
