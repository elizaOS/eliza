import type {
  GenerateTextParams,
  IAgentRuntime,
  ImageDescriptionParams,
  ImageGenerationParams,
  JsonValue,
  ObjectGenerationParams,
  Plugin,
  TestCase,
  TestSuite,
  TextEmbeddingParams,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { type GatewayPluginConfig, initializeGateway } from "./init";
import {
  handleImageDescription,
  handleImageGeneration,
  handleObjectLarge,
  handleObjectSmall,
  handleTextEmbedding,
  handleTextLarge,
  handleTextSmall,
} from "./models";
import type { ImageDescriptionResult, ImageGenerationResult } from "./types";
import { getApiKeyOptional, getBaseUrl } from "./utils/config";

export { GatewayClient } from "./providers/client";

const pluginTests = [
  {
    name: "gateway_plugin_tests",
    tests: [
      {
        name: "gateway_test_api_key_validation",
        fn: async (runtime: IAgentRuntime) => {
          const apiKey = getApiKeyOptional(runtime);
          if (!apiKey) {
            throw new Error(
              "AI_GATEWAY_API_KEY, AIGATEWAY_API_KEY, or VERCEL_OIDC_TOKEN is not configured"
            );
          }
          logger.info("[Gateway Test] API key is configured");
        },
      },
      {
        name: "gateway_test_api_connectivity",
        fn: async (runtime: IAgentRuntime) => {
          const baseUrl = getBaseUrl(runtime);
          const apiKey = getApiKeyOptional(runtime);

          if (!apiKey) {
            throw new Error("API key is required for connectivity test");
          }

          const response = await fetch(`${baseUrl}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
          });

          if (!response.ok) {
            throw new Error(
              `API connectivity test failed: ${response.status} ${response.statusText}`
            );
          }

          const data = (await response.json()) as { data?: Array<Record<string, never>> };
          logger.info(`[Gateway Test] API connected. ${data.data?.length ?? 0} models available.`);
        },
      },
      {
        name: "gateway_test_text_small",
        fn: async (runtime: IAgentRuntime) => {
          const text = await runtime.useModel(ModelType.TEXT_SMALL, {
            prompt: "Say hello in exactly 5 words.",
          });

          if (typeof text !== "string" || text.length === 0) {
            throw new Error("TEXT_SMALL should return non-empty string");
          }

          logger.info(`[Gateway Test] TEXT_SMALL generated: "${text.substring(0, 50)}..."`);
        },
      },
      {
        name: "gateway_test_text_large",
        fn: async (runtime: IAgentRuntime) => {
          const text = await runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: "Explain quantum computing in 2 sentences.",
          });

          if (typeof text !== "string" || text.length === 0) {
            throw new Error("TEXT_LARGE should return non-empty string");
          }

          logger.info(`[Gateway Test] TEXT_LARGE generated: "${text.substring(0, 50)}..."`);
        },
      },
      {
        name: "gateway_test_text_embedding",
        fn: async (runtime: IAgentRuntime) => {
          const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
            text: "Hello, world!",
          });

          if (!Array.isArray(embedding) || embedding.length === 0) {
            throw new Error("Embedding should return a non-empty array");
          }

          logger.info(`[Gateway Test] Generated embedding with ${embedding.length} dimensions`);
        },
      },
      {
        name: "gateway_test_object_generation",
        fn: async (runtime: IAgentRuntime) => {
          const result = await runtime.useModel(ModelType.OBJECT_SMALL, {
            prompt:
              "Return a JSON object with exactly these fields: name (string), age (number), active (boolean)",
          });

          if (!result || typeof result !== "object") {
            throw new Error("Object generation should return an object");
          }

          logger.info(
            `[Gateway Test] Object generated: ${JSON.stringify(result).substring(0, 100)}`
          );
        },
      },
      {
        name: "gateway_test_streaming",
        fn: async (runtime: IAgentRuntime) => {
          const chunks: string[] = [];

          const result = await runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: "Count from 1 to 5, one number per line.",
            stream: true,
            onStreamChunk: (chunk: string) => {
              chunks.push(chunk);
            },
          });

          if (typeof result !== "string" || result.length === 0) {
            throw new Error("Streaming should return non-empty result");
          }

          if (chunks.length === 0) {
            throw new Error("No streaming chunks received");
          }

          logger.info(`[Gateway Test] Streaming test: ${chunks.length} chunks received`);
        },
      },
    ] as TestCase[],
  },
] as TestSuite[];

type ProcessEnvLike = Record<string, string | undefined>;

function getProcessEnv(): ProcessEnvLike {
  if (typeof process === "undefined") {
    return {};
  }
  return process.env as ProcessEnvLike;
}

const env = getProcessEnv();

export const gatewayPlugin: Plugin = {
  name: "gateway",
  description: "Vercel AI Gateway integration for text, image, audio, and embedding models",

  config: {
    AI_GATEWAY_API_KEY: env.AI_GATEWAY_API_KEY ?? null,
    AIGATEWAY_API_KEY: env.AIGATEWAY_API_KEY ?? null,
    VERCEL_OIDC_TOKEN: env.VERCEL_OIDC_TOKEN ?? null,
    AI_GATEWAY_BASE_URL: env.AI_GATEWAY_BASE_URL ?? null,
    AI_GATEWAY_SMALL_MODEL: env.AI_GATEWAY_SMALL_MODEL ?? null,
    AI_GATEWAY_LARGE_MODEL: env.AI_GATEWAY_LARGE_MODEL ?? null,
    AI_GATEWAY_EMBEDDING_MODEL: env.AI_GATEWAY_EMBEDDING_MODEL ?? null,
    AI_GATEWAY_EMBEDDING_DIMENSIONS: env.AI_GATEWAY_EMBEDDING_DIMENSIONS ?? null,
    AI_GATEWAY_IMAGE_MODEL: env.AI_GATEWAY_IMAGE_MODEL ?? null,
  },

  async init(config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    initializeGateway(config as GatewayPluginConfig, runtime);
  },

  models: {
    [ModelType.TEXT_EMBEDDING]: async (
      runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null
    ): Promise<number[]> => {
      return handleTextEmbedding(runtime, params);
    },

    [ModelType.TEXT_SMALL]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string> => {
      return handleTextSmall(runtime, params);
    },

    [ModelType.TEXT_LARGE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string> => {
      return handleTextLarge(runtime, params);
    },

    [ModelType.IMAGE]: async (
      runtime: IAgentRuntime,
      params: ImageGenerationParams
    ): Promise<ImageGenerationResult[]> => {
      return handleImageGeneration(runtime, params);
    },

    [ModelType.IMAGE_DESCRIPTION]: async (
      runtime: IAgentRuntime,
      params: ImageDescriptionParams | string
    ): Promise<ImageDescriptionResult> => {
      return handleImageDescription(runtime, params);
    },

    [ModelType.OBJECT_SMALL]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams
    ): Promise<Record<string, JsonValue>> => {
      return handleObjectSmall(runtime, params);
    },

    [ModelType.OBJECT_LARGE]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams
    ): Promise<Record<string, JsonValue>> => {
      return handleObjectLarge(runtime, params);
    },
  },

  tests: pluginTests,
};

export default gatewayPlugin;
