import type {
  GenerateTextParams,
  IAgentRuntime,
  JsonValue,
  ObjectGenerationParams,
  Plugin,
  TextEmbeddingParams,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { initializeNvidiaCloud } from "./init";
import {
  handleObjectLarge,
  handleObjectSmall,
  handleTextEmbedding,
  handleTextLarge,
  handleTextSmall,
} from "./models";
import { getApiKey, getBaseURL } from "./utils/config";

function optionalConfigValue(key: string): string | null {
  return process.env[key] ?? null;
}

export const nvidiaCloudPlugin: Plugin = {
  name: "@elizaos/plugin-nvidiacloud",
  description:
    "NVIDIA NIM cloud — OpenAI-compatible chat, objects, and embeddings via integrate.api.nvidia.com",
  config: {
    NVIDIA_API_KEY: optionalConfigValue("NVIDIA_API_KEY"),
    NVIDIA_CLOUD_API_KEY: optionalConfigValue("NVIDIA_CLOUD_API_KEY"),
    NVIDIA_BASE_URL: optionalConfigValue("NVIDIA_BASE_URL"),
    NVIDIA_EMBEDDING_BASE_URL: optionalConfigValue("NVIDIA_EMBEDDING_BASE_URL"),
    NVIDIA_BROWSER_BASE_URL: optionalConfigValue("NVIDIA_BROWSER_BASE_URL"),
    NVIDIA_SMALL_MODEL: optionalConfigValue("NVIDIA_SMALL_MODEL"),
    NVIDIA_LARGE_MODEL: optionalConfigValue("NVIDIA_LARGE_MODEL"),
    SMALL_MODEL: optionalConfigValue("SMALL_MODEL"),
    LARGE_MODEL: optionalConfigValue("LARGE_MODEL"),
    NVIDIA_EMBEDDING_MODEL: optionalConfigValue("NVIDIA_EMBEDDING_MODEL"),
    EMBEDDING_MODEL: optionalConfigValue("EMBEDDING_MODEL"),
    NVIDIA_EMBEDDING_INPUT_TYPE: optionalConfigValue(
      "NVIDIA_EMBEDDING_INPUT_TYPE",
    ),
    NVIDIA_EMBEDDING_DIMENSIONS: optionalConfigValue(
      "NVIDIA_EMBEDDING_DIMENSIONS",
    ),
    EMBEDDING_DIMENSIONS: optionalConfigValue("EMBEDDING_DIMENSIONS"),
    NVIDIA_EMBEDDING_DEBUG: optionalConfigValue("NVIDIA_EMBEDDING_DEBUG"),
  },
  async init(config, runtime) {
    initializeNvidiaCloud(config, runtime);
  },
  models: {
    [ModelType.TEXT_SMALL]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ) => {
      return handleTextSmall(runtime, params);
    },
    [ModelType.TEXT_LARGE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ) => {
      return handleTextLarge(runtime, params);
    },
    [ModelType.OBJECT_SMALL]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams,
    ) => {
      return handleObjectSmall(runtime, params) as Promise<
        Record<string, JsonValue>
      >;
    },
    [ModelType.OBJECT_LARGE]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams,
    ) => {
      return handleObjectLarge(runtime, params) as Promise<
        Record<string, JsonValue>
      >;
    },
    [ModelType.TEXT_EMBEDDING]: async (
      runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null,
    ) => {
      return handleTextEmbedding(runtime, params);
    },
  },
  autoEnable: {
    envKeys: ["NVIDIA_API_KEY", "NVIDIA_CLOUD_API_KEY"],
  },
  tests: [
    {
      name: "nvidiacloud_plugin_tests",
      tests: [
        {
          name: "nvidiacloud_test_api_key",
          fn: async (runtime: IAgentRuntime) => {
            const key = getApiKey(runtime);
            if (!key) {
              throw new Error("NVIDIA_API_KEY is not configured");
            }
            logger.log("NVIDIA API key is configured");
          },
        },
        {
          name: "nvidiacloud_test_text_small",
          fn: async (runtime: IAgentRuntime) => {
            const text = await runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: "Reply with exactly: ok",
            });
            if (!text || text.length === 0) {
              throw new Error("TEXT_SMALL returned empty");
            }
            logger.log({ text }, "nvidiacloud TEXT_SMALL");
          },
        },
        {
          name: "nvidiacloud_test_text_large",
          fn: async (runtime: IAgentRuntime) => {
            const text = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "Reply with exactly: ok",
            });
            if (!text || text.length === 0) {
              throw new Error("TEXT_LARGE returned empty");
            }
            logger.log({ text }, "nvidiacloud TEXT_LARGE");
          },
        },
        {
          name: "nvidiacloud_test_embedding",
          fn: async (runtime: IAgentRuntime) => {
            const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
              text: "hello",
            });
            if (!Array.isArray(embedding) || embedding.length === 0) {
              throw new Error("embedding invalid");
            }
            logger.log({ dim: embedding.length }, "nvidiacloud embedding");
          },
        },
      ],
    },
  ],
};

export default nvidiaCloudPlugin;
