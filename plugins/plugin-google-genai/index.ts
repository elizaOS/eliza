import type {
  GenerateTextParams,
  IAgentRuntime,
  ImageDescriptionParams,
  Plugin,
  TestCase,
  TestSuite,
  TextEmbeddingParams,
} from "@elizaos/core";
import * as ElizaCore from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { GoogleGenAI } from "@google/genai";
import { initializeGoogleGenAI, type PluginConfig } from "./init";
import {
  handleActionPlanner,
  handleImageDescription,
  handleResponseHandler,
  handleTextEmbedding,
  handleTextLarge,
  handleTextMedium,
  handleTextMega,
  handleTextNano,
  handleTextSmall,
} from "./models";
import { getApiKey } from "./utils/config";

export type { PluginConfig } from "./init";
export * from "./types";

const CORE_MODEL_TYPES =
  (ElizaCore as { ModelType?: Record<string, string> }).ModelType ?? {};
const TEXT_NANO_MODEL_TYPE = (CORE_MODEL_TYPES.TEXT_NANO ??
  "TEXT_NANO") as string;
const TEXT_MEDIUM_MODEL_TYPE = (CORE_MODEL_TYPES.TEXT_MEDIUM ??
  "TEXT_MEDIUM") as string;
const TEXT_SMALL_MODEL_TYPE = (CORE_MODEL_TYPES.TEXT_SMALL ??
  "TEXT_SMALL") as string;
const TEXT_LARGE_MODEL_TYPE = (CORE_MODEL_TYPES.TEXT_LARGE ??
  "TEXT_LARGE") as string;
const TEXT_EMBEDDING_MODEL_TYPE = (CORE_MODEL_TYPES.TEXT_EMBEDDING ??
  "TEXT_EMBEDDING") as string;
const IMAGE_DESCRIPTION_MODEL_TYPE = (CORE_MODEL_TYPES.IMAGE_DESCRIPTION ??
  "IMAGE_DESCRIPTION") as string;
const TEXT_MEGA_MODEL_TYPE = (CORE_MODEL_TYPES.TEXT_MEGA ??
  "TEXT_MEGA") as string;
const RESPONSE_HANDLER_MODEL_TYPE = (CORE_MODEL_TYPES.RESPONSE_HANDLER ??
  "RESPONSE_HANDLER") as string;
const ACTION_PLANNER_MODEL_TYPE = (CORE_MODEL_TYPES.ACTION_PLANNER ??
  "ACTION_PLANNER") as string;

const pluginTests = [
  {
    name: "google_genai_plugin_tests",
    tests: [
      {
        name: "google_test_api_key_validation",
        fn: async (runtime: IAgentRuntime) => {
          const apiKey = getApiKey(runtime);
          if (!apiKey) {
            throw new Error("GOOGLE_GENERATIVE_AI_API_KEY not set");
          }
          const genAI = new GoogleGenAI({ apiKey });
          const modelList = await genAI.models.list();
          const models = [];
          for await (const model of modelList) {
            models.push(model);
          }
          logger.log(`Available models: ${models.length}`);
        },
      },
      {
        name: "google_test_text_embedding",
        fn: async (runtime: IAgentRuntime) => {
          try {
            const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
              text: "Hello, world!",
            });
            logger.log(`Embedding dimension: ${embedding.length}`);
            if (embedding.length === 0) {
              throw new Error("Failed to generate embedding");
            }
          } catch (error) {
            logger.error(
              `Error in test_text_embedding: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
          }
        },
      },
      {
        name: "google_test_text_small",
        fn: async (runtime: IAgentRuntime) => {
          try {
            const text = await runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: "What is the nature of reality in 10 words?",
            });
            if (text.length === 0) {
              throw new Error("Failed to generate text");
            }
            logger.log("Generated with TEXT_SMALL:", text);
          } catch (error) {
            logger.error(
              `Error in test_text_small: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
          }
        },
      },
      {
        name: "google_test_text_large",
        fn: async (runtime: IAgentRuntime) => {
          try {
            const text = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "Explain quantum mechanics in simple terms.",
            });
            if (text.length === 0) {
              throw new Error("Failed to generate text");
            }
            logger.log(
              "Generated with TEXT_LARGE:",
              `${text.substring(0, 100)}...`,
            );
          } catch (error) {
            logger.error(
              `Error in test_text_large: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
          }
        },
      },
      {
        name: "google_test_image_description",
        fn: async (runtime: IAgentRuntime) => {
          try {
            const result = await runtime.useModel(
              ModelType.IMAGE_DESCRIPTION,
              "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Vitalik_Buterin_TechCrunch_London_2015_%28cropped%29.jpg/537px-Vitalik_Buterin_TechCrunch_London_2015_%28cropped%29.jpg",
            );

            if (
              result != null &&
              typeof result === "object" &&
              "title" in result &&
              "description" in result
            ) {
              logger.log("Image description:", JSON.stringify(result));
            } else {
              logger.error(
                `Invalid image description result format: ${JSON.stringify(result)}`,
              );
            }
          } catch (error) {
            logger.error(
              `Error in test_image_description: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
          }
        },
      },
      {
        name: "google_test_structured_output_via_text_large",
        fn: async (runtime: IAgentRuntime) => {
          try {
            const schema = {
              type: "object",
              properties: {
                name: { type: "string" },
                age: { type: "number" },
                hobbies: { type: "array", items: { type: "string" } },
              },
              required: ["name", "age", "hobbies"],
            };

            const result = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "Generate a person profile with name, age, and hobbies.",
              responseSchema: schema,
            } as GenerateTextParams);

            logger.log("Generated structured output:", JSON.stringify(result));

            if (!result) {
              throw new Error("Generated structured output is empty");
            }
          } catch (error) {
            logger.error(
              `Error in test_structured_output_via_text_large: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
          }
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

export const googleGenAIPlugin: Plugin = {
  name: "google-genai",
  description: "Google Generative AI plugin for Gemini models",
  autoEnable: {
    envKeys: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  },

  config: {
    GOOGLE_GENERATIVE_AI_API_KEY: env.GOOGLE_GENERATIVE_AI_API_KEY ?? null,
    GOOGLE_NANO_MODEL: env.GOOGLE_NANO_MODEL ?? null,
    GOOGLE_MEDIUM_MODEL: env.GOOGLE_MEDIUM_MODEL ?? null,
    GOOGLE_SMALL_MODEL: env.GOOGLE_SMALL_MODEL ?? null,
    GOOGLE_LARGE_MODEL: env.GOOGLE_LARGE_MODEL ?? null,
    GOOGLE_MEGA_MODEL: env.GOOGLE_MEGA_MODEL ?? null,
    GOOGLE_RESPONSE_HANDLER_MODEL: env.GOOGLE_RESPONSE_HANDLER_MODEL ?? null,
    GOOGLE_SHOULD_RESPOND_MODEL: env.GOOGLE_SHOULD_RESPOND_MODEL ?? null,
    GOOGLE_ACTION_PLANNER_MODEL: env.GOOGLE_ACTION_PLANNER_MODEL ?? null,
    GOOGLE_PLANNER_MODEL: env.GOOGLE_PLANNER_MODEL ?? null,
    GOOGLE_IMAGE_MODEL: env.GOOGLE_IMAGE_MODEL ?? null,
    GOOGLE_EMBEDDING_MODEL: env.GOOGLE_EMBEDDING_MODEL ?? null,
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
  },

  async init(config, runtime) {
    initializeGoogleGenAI(config as PluginConfig, runtime);
  },

  models: {
    [TEXT_NANO_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      return handleTextNano(runtime, params);
    },

    [TEXT_MEDIUM_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      return handleTextMedium(runtime, params);
    },

    [TEXT_SMALL_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      return handleTextSmall(runtime, params);
    },

    [TEXT_LARGE_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      return handleTextLarge(runtime, params);
    },

    [TEXT_MEGA_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      return handleTextMega(runtime, params);
    },

    [RESPONSE_HANDLER_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      return handleResponseHandler(runtime, params);
    },

    [ACTION_PLANNER_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      return handleActionPlanner(runtime, params);
    },

    [TEXT_EMBEDDING_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null,
    ): Promise<number[]> => {
      return handleTextEmbedding(runtime, params);
    },

    [IMAGE_DESCRIPTION_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: ImageDescriptionParams | string,
    ): Promise<{ title: string; description: string }> => {
      return handleImageDescription(runtime, params);
    },
  },

  tests: pluginTests,
};

export default googleGenAIPlugin;
