import type {
  GenerateTextParams,
  IAgentRuntime,
  ObjectGenerationParams,
  Plugin,
  TextEmbeddingParams,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";

const _globalThis = globalThis as typeof globalThis & {
  AI_SDK_LOG_WARNINGS?: boolean;
};
_globalThis.AI_SDK_LOG_WARNINGS ??= false;

import { handleTextEmbedding } from "./models/embedding";
import { handleObjectLarge, handleObjectSmall } from "./models/object";
import {
  handleActionPlanner,
  handleResponseHandler,
  handleTextLarge,
  handleTextMedium,
  handleTextMega,
  handleTextNano,
  handleTextSmall,
} from "./models/text";
import { getApiBase, getBaseURL } from "./utils/config";

type ProcessEnvLike = Record<string, string | undefined>;

function getProcessEnv(): ProcessEnvLike {
  if (typeof process === "undefined" || !process.env) {
    return {};
  }
  return process.env as ProcessEnvLike;
}

const env = getProcessEnv();
const TEXT_NANO_MODEL_TYPE = (ModelType.TEXT_NANO ?? "TEXT_NANO") as string;
const TEXT_MEDIUM_MODEL_TYPE = (ModelType.TEXT_MEDIUM ?? "TEXT_MEDIUM") as string;
const TEXT_MEGA_MODEL_TYPE = (ModelType.TEXT_MEGA ?? "TEXT_MEGA") as string;
const RESPONSE_HANDLER_MODEL_TYPE = (ModelType.RESPONSE_HANDLER ?? "RESPONSE_HANDLER") as string;
const ACTION_PLANNER_MODEL_TYPE = (ModelType.ACTION_PLANNER ?? "ACTION_PLANNER") as string;

export const ollamaPlugin: Plugin = {
  name: "ollama",
  description: "Ollama plugin for local LLM inference",

  config: {
    OLLAMA_API_ENDPOINT: env.OLLAMA_API_ENDPOINT ?? null,
    OLLAMA_NANO_MODEL: env.OLLAMA_NANO_MODEL ?? null,
    OLLAMA_SMALL_MODEL: env.OLLAMA_SMALL_MODEL ?? null,
    OLLAMA_MEDIUM_MODEL: env.OLLAMA_MEDIUM_MODEL ?? null,
    OLLAMA_LARGE_MODEL: env.OLLAMA_LARGE_MODEL ?? null,
    OLLAMA_MEGA_MODEL: env.OLLAMA_MEGA_MODEL ?? null,
    OLLAMA_RESPONSE_HANDLER_MODEL: env.OLLAMA_RESPONSE_HANDLER_MODEL ?? null,
    OLLAMA_SHOULD_RESPOND_MODEL: env.OLLAMA_SHOULD_RESPOND_MODEL ?? null,
    OLLAMA_ACTION_PLANNER_MODEL: env.OLLAMA_ACTION_PLANNER_MODEL ?? null,
    OLLAMA_PLANNER_MODEL: env.OLLAMA_PLANNER_MODEL ?? null,
    NANO_MODEL: env.NANO_MODEL ?? null,
    MEDIUM_MODEL: env.MEDIUM_MODEL ?? null,
    SMALL_MODEL: env.SMALL_MODEL ?? null,
    LARGE_MODEL: env.LARGE_MODEL ?? null,
    MEGA_MODEL: env.MEGA_MODEL ?? null,
    RESPONSE_HANDLER_MODEL: env.RESPONSE_HANDLER_MODEL ?? null,
    SHOULD_RESPOND_MODEL: env.SHOULD_RESPOND_MODEL ?? null,
    ACTION_PLANNER_MODEL: env.ACTION_PLANNER_MODEL ?? null,
    PLANNER_MODEL: env.PLANNER_MODEL ?? null,
    OLLAMA_EMBEDDING_MODEL: env.OLLAMA_EMBEDDING_MODEL ?? null,
  },

  async init(_config, runtime) {
    const baseURL = getBaseURL(runtime);
    const apiBase = getApiBase(runtime);

    if (!baseURL || baseURL === "http://localhost:11434/api") {
      const endpoint = runtime.getSetting("OLLAMA_API_ENDPOINT");
      if (!endpoint) {
        logger.warn("OLLAMA_API_ENDPOINT not set, using default localhost:11434");
      }
    }

    try {
      const response = await fetch(`${apiBase}/api/tags`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        logger.warn(`Ollama API validation failed: ${response.statusText}`);
      }
    } catch (fetchError: unknown) {
      const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
      logger.warn(`Ollama API validation error: ${message}`);
    }
  },

  models: {
    [ModelType.TEXT_EMBEDDING]: async (
      runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null
    ): Promise<number[]> => {
      return handleTextEmbedding(runtime, params);
    },

    [TEXT_NANO_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string> => {
      return handleTextNano(runtime, params);
    },

    [ModelType.TEXT_SMALL]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string> => {
      return handleTextSmall(runtime, params);
    },

    [TEXT_MEDIUM_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string> => {
      return handleTextMedium(runtime, params);
    },

    [ModelType.TEXT_LARGE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string> => {
      return handleTextLarge(runtime, params);
    },

    [TEXT_MEGA_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string> => {
      return handleTextMega(runtime, params);
    },

    [RESPONSE_HANDLER_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string> => {
      return handleResponseHandler(runtime, params);
    },

    [ACTION_PLANNER_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string> => {
      return handleActionPlanner(runtime, params);
    },

    [ModelType.OBJECT_SMALL]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams
    ): Promise<Record<string, string | number | boolean | null>> => {
      return handleObjectSmall(runtime, params);
    },

    [ModelType.OBJECT_LARGE]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams
    ): Promise<Record<string, string | number | boolean | null>> => {
      return handleObjectLarge(runtime, params);
    },
  },

  tests: [
    {
      name: "ollama_plugin_tests",
      tests: [
        {
          name: "ollama_test_url_validation",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const apiBase = getApiBase(runtime);
              const response = await fetch(`${apiBase}/api/tags`);
              if (!response.ok) {
                logger.error(`Failed to validate Ollama API: ${response.statusText}`);
              }
            } catch (error) {
              logger.error({ error }, "Error in ollama_test_url_validation");
            }
          },
        },
        {
          name: "ollama_test_text_embedding",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const runModel = runtime.useModel.bind(runtime);
              const embedding = await runModel(ModelType.TEXT_EMBEDDING, {
                text: "Hello, world!",
              });
              logger.log({ embedding }, "Generated embedding");
            } catch (error) {
              logger.error({ error }, "Error in test_text_embedding");
            }
          },
        },
        {
          name: "ollama_test_text_large",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const runModel = runtime.useModel.bind(runtime);
              const text = await runModel(ModelType.TEXT_LARGE, {
                prompt: "What is the nature of reality in 10 words?",
              });
              if (text.length === 0) {
                logger.error("Failed to generate text");
                return;
              }
              logger.log({ text }, "Generated with test_text_large");
            } catch (error) {
              logger.error({ error }, "Error in test_text_large");
            }
          },
        },
        {
          name: "ollama_test_text_small",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const runModel = runtime.useModel.bind(runtime);
              const text = await runModel(ModelType.TEXT_SMALL, {
                prompt: "What is the nature of reality in 10 words?",
              });
              if (text.length === 0) {
                logger.error("Failed to generate text");
                return;
              }
              logger.log({ text }, "Generated with test_text_small");
            } catch (error) {
              logger.error({ error }, "Error in test_text_small");
            }
          },
        },
        {
          name: "ollama_test_object_small",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const runModel = runtime.useModel.bind(runtime);
              const object = await runModel(ModelType.OBJECT_SMALL, {
                prompt:
                  "Generate a JSON object representing a user profile with name, age, and hobbies",
                temperature: 0.7,
                schema: undefined,
              });
              logger.log({ object }, "Generated object");
            } catch (error) {
              logger.error({ error }, "Error in test_object_small");
            }
          },
        },
        {
          name: "ollama_test_object_large",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const runModel = runtime.useModel.bind(runtime);
              const object = await runModel(ModelType.OBJECT_LARGE, {
                prompt:
                  "Generate a detailed JSON object representing a restaurant with name, cuisine type, menu items with prices, and customer reviews",
                temperature: 0.7,
                schema: undefined,
              });
              logger.log({ object }, "Generated object");
            } catch (error) {
              logger.error({ error }, "Error in test_object_large");
            }
          },
        },
      ],
    },
  ],
};
