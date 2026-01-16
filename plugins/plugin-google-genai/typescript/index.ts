import type {
  GenerateTextParams,
  IAgentRuntime,
  ImageDescriptionParams,
  ObjectGenerationParams,
  Plugin,
  TestCase,
  TestSuite,
  TextEmbeddingParams,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { GoogleGenAI } from "@google/genai";
import { initializeGoogleGenAI, type PluginConfig } from "./init";
import {
  handleImageDescription,
  handleObjectLarge,
  handleObjectSmall,
  handleTextEmbedding,
  handleTextLarge,
  handleTextSmall,
} from "./models";
import { getApiKey } from "./utils/config";

export type { PluginConfig } from "./init";
export * from "./types";

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
              `Error in test_text_embedding: ${error instanceof Error ? error.message : String(error)}`
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
              `Error in test_text_small: ${error instanceof Error ? error.message : String(error)}`
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
            logger.log("Generated with TEXT_LARGE:", `${text.substring(0, 100)}...`);
          } catch (error) {
            logger.error(
              `Error in test_text_large: ${error instanceof Error ? error.message : String(error)}`
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
              "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Vitalik_Buterin_TechCrunch_London_2015_%28cropped%29.jpg/537px-Vitalik_Buterin_TechCrunch_London_2015_%28cropped%29.jpg"
            );

            if (
              result &&
              typeof result === "object" &&
              "title" in result &&
              "description" in result
            ) {
              logger.log("Image description:", JSON.stringify(result));
            } else {
              logger.error(`Invalid image description result format: ${JSON.stringify(result)}`);
            }
          } catch (error) {
            logger.error(
              `Error in test_image_description: ${error instanceof Error ? error.message : String(error)}`
            );
            throw error;
          }
        },
      },
      {
        name: "google_test_object_generation",
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

            const result = await runtime.useModel(ModelType.OBJECT_SMALL, {
              prompt: "Generate a person profile with name, age, and hobbies.",
              schema,
            });

            logger.log("Generated object:", JSON.stringify(result));

            if (!result.name || !result.age || !result.hobbies) {
              throw new Error("Generated object missing required fields");
            }
          } catch (error) {
            logger.error(
              `Error in test_object_generation: ${error instanceof Error ? error.message : String(error)}`
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

  config: {
    GOOGLE_GENERATIVE_AI_API_KEY: env.GOOGLE_GENERATIVE_AI_API_KEY ?? null,
    GOOGLE_SMALL_MODEL: env.GOOGLE_SMALL_MODEL ?? null,
    GOOGLE_LARGE_MODEL: env.GOOGLE_LARGE_MODEL ?? null,
    GOOGLE_IMAGE_MODEL: env.GOOGLE_IMAGE_MODEL ?? null,
    GOOGLE_EMBEDDING_MODEL: env.GOOGLE_EMBEDDING_MODEL ?? null,
    SMALL_MODEL: env.SMALL_MODEL ?? null,
    LARGE_MODEL: env.LARGE_MODEL ?? null,
    IMAGE_MODEL: env.IMAGE_MODEL ?? null,
  },

  async init(config, runtime) {
    initializeGoogleGenAI(config as PluginConfig, runtime);
  },

  models: {
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

    [ModelType.TEXT_EMBEDDING]: async (
      runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null
    ): Promise<number[]> => {
      return handleTextEmbedding(runtime, params);
    },

    [ModelType.IMAGE_DESCRIPTION]: async (
      runtime: IAgentRuntime,
      params: ImageDescriptionParams | string
    ): Promise<{ title: string; description: string }> => {
      return handleImageDescription(runtime, params);
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

  tests: pluginTests,
};

export default googleGenAIPlugin;
