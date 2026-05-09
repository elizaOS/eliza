import {
  type GenerateTextParams,
  type IAgentRuntime,
  type ImageDescriptionParams,
  type ImageGenerationParams,
  type JsonValue,
  logger,
  ModelType,
  type ObjectGenerationParams,
  type Plugin,
  type TextEmbeddingParams,
} from "@elizaos/core";

import { initializeOpenRouter } from "./init";
import { handleTextEmbedding } from "./models/embedding";
import { handleImageDescription, handleImageGeneration } from "./models/image";
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

export const openrouterPlugin: Plugin = {
  name: "openrouter",
  description: "OpenRouter multi-model AI gateway plugin",
  autoEnable: {
    envKeys: ["OPENROUTER_API_KEY"],
  },

  config: {
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY ?? null,
    OPENROUTER_BASE_URL: env.OPENROUTER_BASE_URL ?? null,
    OPENROUTER_NANO_MODEL: env.OPENROUTER_NANO_MODEL ?? null,
    OPENROUTER_MEDIUM_MODEL: env.OPENROUTER_MEDIUM_MODEL ?? null,
    OPENROUTER_SMALL_MODEL: env.OPENROUTER_SMALL_MODEL ?? null,
    OPENROUTER_LARGE_MODEL: env.OPENROUTER_LARGE_MODEL ?? null,
    OPENROUTER_MEGA_MODEL: env.OPENROUTER_MEGA_MODEL ?? null,
    OPENROUTER_RESPONSE_HANDLER_MODEL: env.OPENROUTER_RESPONSE_HANDLER_MODEL ?? null,
    OPENROUTER_SHOULD_RESPOND_MODEL: env.OPENROUTER_SHOULD_RESPOND_MODEL ?? null,
    OPENROUTER_ACTION_PLANNER_MODEL: env.OPENROUTER_ACTION_PLANNER_MODEL ?? null,
    OPENROUTER_PLANNER_MODEL: env.OPENROUTER_PLANNER_MODEL ?? null,
    OPENROUTER_IMAGE_MODEL: env.OPENROUTER_IMAGE_MODEL ?? null,
    OPENROUTER_IMAGE_GENERATION_MODEL: env.OPENROUTER_IMAGE_GENERATION_MODEL ?? null,
    OPENROUTER_EMBEDDING_MODEL: env.OPENROUTER_EMBEDDING_MODEL ?? null,
    OPENROUTER_EMBEDDING_DIMENSIONS: env.OPENROUTER_EMBEDDING_DIMENSIONS ?? null,
    OPENROUTER_AUTO_CLEANUP_IMAGES: env.OPENROUTER_AUTO_CLEANUP_IMAGES ?? null,
    NANO_MODEL: env.NANO_MODEL ?? null,
    MEDIUM_MODEL: env.MEDIUM_MODEL ?? null,
    SMALL_MODEL: env.SMALL_MODEL ?? null,
    LARGE_MODEL: env.LARGE_MODEL ?? null,
    MEGA_MODEL: env.MEGA_MODEL ?? null,
    RESPONSE_HANDLER_MODEL: env.RESPONSE_HANDLER_MODEL ?? null,
    SHOULD_RESPOND_MODEL: env.SHOULD_RESPOND_MODEL ?? null,
    ACTION_PLANNER_MODEL: env.ACTION_PLANNER_MODEL ?? null,
    PLANNER_MODEL: env.PLANNER_MODEL ?? null,
    IMAGE_MODEL: env.IMAGE_MODEL ?? null,
    IMAGE_GENERATION_MODEL: env.IMAGE_GENERATION_MODEL ?? null,
    EMBEDDING_MODEL: env.EMBEDDING_MODEL ?? null,
    EMBEDDING_DIMENSIONS: env.EMBEDDING_DIMENSIONS ?? null,
  },

  async init(config: Record<string, unknown>, runtime: IAgentRuntime) {
    initializeOpenRouter(config, runtime);
  },

  models: {
    [TEXT_NANO_MODEL_TYPE]: async (runtime: IAgentRuntime, params: GenerateTextParams) => {
      return handleTextNano(runtime, params);
    },

    [ModelType.TEXT_SMALL]: async (runtime: IAgentRuntime, params: GenerateTextParams) => {
      return handleTextSmall(runtime, params);
    },

    [TEXT_MEDIUM_MODEL_TYPE]: async (runtime: IAgentRuntime, params: GenerateTextParams) => {
      return handleTextMedium(runtime, params);
    },

    [ModelType.TEXT_LARGE]: async (runtime: IAgentRuntime, params: GenerateTextParams) => {
      return handleTextLarge(runtime, params);
    },

    [TEXT_MEGA_MODEL_TYPE]: async (runtime: IAgentRuntime, params: GenerateTextParams) => {
      return handleTextMega(runtime, params);
    },

    [RESPONSE_HANDLER_MODEL_TYPE]: async (runtime: IAgentRuntime, params: GenerateTextParams) => {
      return handleResponseHandler(runtime, params);
    },

    [ACTION_PLANNER_MODEL_TYPE]: async (runtime: IAgentRuntime, params: GenerateTextParams) => {
      return handleActionPlanner(runtime, params);
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

    [ModelType.IMAGE_DESCRIPTION]: async (
      runtime: IAgentRuntime,
      params: ImageDescriptionParams | string
    ) => {
      const description = await handleImageDescription(runtime, params);
      return { title: "", description };
    },

    [ModelType.IMAGE]: async (runtime: IAgentRuntime, params: ImageGenerationParams) => {
      const result = await handleImageGeneration(runtime, params);
      return [{ url: result.imageUrl }];
    },

    [ModelType.TEXT_EMBEDDING]: async (
      runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null
    ) => {
      return handleTextEmbedding(runtime, params);
    },
  },

  tests: [
    {
      name: "openrouter_plugin_tests",
      tests: [
        {
          name: "openrouter_test_text_small",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const runModel = runtime.useModel.bind(runtime);
              const text = await runModel(ModelType.TEXT_SMALL, {
                prompt: "What is the nature of reality in 10 words?",
              });
              if (text.length === 0) {
                throw new Error("Failed to generate text");
              }
              logger.log({ text }, "generated with test_text_small");
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_text_small: ${message}`);
              throw error;
            }
          },
        },
        {
          name: "openrouter_test_text_large",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const runModel = runtime.useModel.bind(runtime);
              const text = await runModel(ModelType.TEXT_LARGE, {
                prompt: "What is the nature of reality in 10 words?",
              });
              if (text.length === 0) {
                throw new Error("Failed to generate text");
              }
              logger.log({ text }, "generated with test_text_large");
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_text_large: ${message}`);
              throw error;
            }
          },
        },
        {
          name: "openrouter_test_object_small",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const runModel = runtime.useModel.bind(runtime);
              const result = await runModel(ModelType.OBJECT_SMALL, {
                prompt: "Create a simple JSON object with a message field saying hello",
                schema: { type: "object" },
              });
              logger.log({ result }, "Generated object with test_object_small");
              if (!result || (typeof result === "object" && "error" in result)) {
                throw new Error("Failed to generate object");
              }
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_object_small: ${message}`);
              throw error;
            }
          },
        },
        {
          name: "openrouter_test_text_embedding",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const runModel = runtime.useModel.bind(runtime);
              const embedding = await runModel(ModelType.TEXT_EMBEDDING, {
                text: "Hello, world!",
              });
              logger.log({ embedding }, "embedding");
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_text_embedding: ${message}`);
              throw error;
            }
          },
        },
      ],
    },
  ],
};

export default openrouterPlugin;
