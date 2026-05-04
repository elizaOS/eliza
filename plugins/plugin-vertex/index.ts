import type {
  GenerateTextParams,
  IAgentRuntime,
  ObjectGenerationParams,
  Plugin,
  TestCase,
  TestSuite,
  TextEmbeddingParams,
  TextStreamResult,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { initializeVertex, type PluginConfig } from "./init";
import {
  handleTextSmall,
  handleTextLarge,
  handleReasoningSmall,
  handleReasoningLarge,
  handleObjectSmall,
  handleObjectLarge,
  handleTextEmbedding,
} from "./models";
import { getProjectId } from "./utils/config";

export type { PluginConfig } from "./init";

type JsonLike =
  | string
  | number
  | boolean
  | null
  | JsonLike[]
  | { [key: string]: JsonLike };

const pluginTests = [
  {
    name: "vertex_plugin_tests",
    tests: [
      {
        name: "vertex_test_project_id",
        fn: async (runtime: IAgentRuntime) => {
          const projectId = getProjectId(runtime);
          if (!projectId) {
            throw new Error("GOOGLE_VERTEX_PROJECT_ID is not configured");
          }
          logger.log(`[Vertex] Project ID configured: ${projectId}`);
        },
      },
      {
        name: "vertex_test_text_small",
        fn: async (runtime: IAgentRuntime) => {
          const text = await runtime.useModel(ModelType.TEXT_SMALL, {
            prompt: "What is the nature of reality in 10 words?",
          });
          if (typeof text !== "string" || text.length === 0) {
            throw new Error("Failed to generate text: empty response");
          }
          logger.log({ text }, "generated with vertex text_small");
        },
      },
      {
        name: "vertex_test_text_large",
        fn: async (runtime: IAgentRuntime) => {
          const text = await runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: "What is the nature of reality in 10 words?",
          });
          if (typeof text !== "string" || text.length === 0) {
            throw new Error("Failed to generate text: empty response");
          }
          logger.log({ text }, "generated with vertex text_large");
        },
      },
    ] as TestCase[],
  },
] as TestSuite[];

const env =
  typeof process !== "undefined"
    ? process.env
    : ({} as Record<string, string | undefined>);

const TEXT_REASONING_SMALL_MODEL_TYPE = (ModelType.TEXT_REASONING_SMALL ??
  "REASONING_SMALL") as string;
const TEXT_REASONING_LARGE_MODEL_TYPE = (ModelType.TEXT_REASONING_LARGE ??
  "REASONING_LARGE") as string;

export const vertexPlugin: Plugin = {
  name: "vertex",
  description:
    "Google Vertex AI plugin — Claude + Gemini models via GCP (text, object, reasoning, embeddings)",

  config: {
    GOOGLE_VERTEX_PROJECT_ID: env.GOOGLE_VERTEX_PROJECT_ID ?? null,
    GOOGLE_VERTEX_REGION: env.GOOGLE_VERTEX_REGION ?? null,
    VERTEX_SMALL_MODEL: env.VERTEX_SMALL_MODEL ?? null,
    VERTEX_LARGE_MODEL: env.VERTEX_LARGE_MODEL ?? null,
    VERTEX_REASONING_SMALL_MODEL: env.VERTEX_REASONING_SMALL_MODEL ?? null,
    VERTEX_REASONING_LARGE_MODEL: env.VERTEX_REASONING_LARGE_MODEL ?? null,
    SMALL_MODEL: env.SMALL_MODEL ?? null,
    LARGE_MODEL: env.LARGE_MODEL ?? null,
  },

  async init(config, runtime) {
    initializeVertex(config as PluginConfig, runtime);
  },

  models: {
    [ModelType.TEXT_SMALL]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string | TextStreamResult> => {
      return handleTextSmall(runtime, params);
    },

    [ModelType.TEXT_LARGE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string | TextStreamResult> => {
      return handleTextLarge(runtime, params);
    },

    [TEXT_REASONING_SMALL_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string | TextStreamResult> => {
      return handleReasoningSmall(runtime, params);
    },

    [TEXT_REASONING_LARGE_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string | TextStreamResult> => {
      return handleReasoningLarge(runtime, params);
    },

    [ModelType.OBJECT_SMALL]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams,
    ): Promise<Record<string, JsonLike>> => {
      const result = await handleObjectSmall(runtime, params);
      return result as Record<string, JsonLike>;
    },

    [ModelType.OBJECT_LARGE]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams,
    ): Promise<Record<string, JsonLike>> => {
      const result = await handleObjectLarge(runtime, params);
      return result as Record<string, JsonLike>;
    },

    [ModelType.TEXT_EMBEDDING]: async (
      runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null,
    ): Promise<number[]> => {
      return handleTextEmbedding(runtime, params);
    },
  },

  tests: pluginTests,
};

export default vertexPlugin;
