import type {
  GenerateTextParams,
  IAgentRuntime,
  ImageDescriptionParams,
  Plugin,
  TestCase,
  TestSuite,
  TextStreamResult,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { initializeAnthropic, type PluginConfig } from "./init";
import {
  handleActionPlanner,
  handleImageDescription,
  handleReasoningLarge,
  handleReasoningSmall,
  handleResponseHandler,
  handleTextLarge,
  handleTextMedium,
  handleTextMega,
  handleTextNano,
  handleTextSmall,
} from "./models";
import { getApiKeyOptional } from "./utils/config";

export type { PluginConfig } from "./init";

const pluginTests = [
  {
    name: "anthropic_plugin_tests",
    tests: [
      {
        name: "anthropic_test_api_key_validation",
        fn: async (runtime: IAgentRuntime) => {
          const apiKey = getApiKeyOptional(runtime);
          if (!apiKey) {
            throw new Error("ANTHROPIC_API_KEY is not configured");
          }
          logger.log("Anthropic API key is configured");
        },
      },
      {
        name: "anthropic_test_text_small",
        fn: async (runtime: IAgentRuntime) => {
          const text = await runtime.useModel(ModelType.TEXT_SMALL, {
            prompt: "What is the nature of reality in 10 words?",
          });

          if (typeof text !== "string" || text.length === 0) {
            throw new Error("Failed to generate text: empty response");
          }

          logger.log({ text }, "generated with test_text_small");
        },
      },
      {
        name: "anthropic_test_text_large",
        fn: async (runtime: IAgentRuntime) => {
          const text = await runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: "What is the nature of reality in 10 words?",
          });

          if (typeof text !== "string" || text.length === 0) {
            throw new Error("Failed to generate text: empty response");
          }

          logger.log({ text }, "generated with test_text_large");
        },
      },
      {
        name: "anthropic_test_streaming",
        fn: async (runtime: IAgentRuntime) => {
          const chunks: string[] = [];
          const result = await runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: "Count from 1 to 5 in five short chunks.",
            stream: true,
            onStreamChunk: (chunk: string) => {
              chunks.push(chunk);
            },
          });

          if (typeof result !== "string" || result.length === 0) {
            throw new Error("Failed to generate streaming text: empty response");
          }

          if (chunks.length === 0) {
            throw new Error("Failed to stream text: no chunks received");
          }

          logger.log({ chunks: chunks.length, text: result }, "generated with test_streaming");
        },
      },
      {
        name: "anthropic_test_structured_output_via_text_small",
        fn: async (runtime: IAgentRuntime) => {
          const result = await runtime.useModel(ModelType.TEXT_SMALL, {
            prompt: "Create a simple JSON object with a message field saying hello",
            responseSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          } as unknown as GenerateTextParams);

          if (!result || (typeof result !== "object" && typeof result !== "string")) {
            throw new Error("Failed to generate structured output: invalid response");
          }

          logger.log({ result }, "Generated structured output via TEXT_SMALL");
        },
      },
      {
        name: "anthropic_test_structured_output_via_text_large",
        fn: async (runtime: IAgentRuntime) => {
          const result = await runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: "Create a simple JSON object with a message field saying hello",
            responseSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          } as unknown as GenerateTextParams);

          if (!result || (typeof result !== "object" && typeof result !== "string")) {
            throw new Error("Failed to generate structured output: invalid response");
          }

          logger.log({ result }, "Generated structured output via TEXT_LARGE");
        },
      },
    ] as TestCase[],
  },
] as TestSuite[];

type ProcessEnvLike = Record<string, string | undefined>;

function getProcessEnv(): ProcessEnvLike {
  // In browsers, `process` is not defined (and we must not reference it unguarded).
  if (typeof process === "undefined") {
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
const TEXT_REASONING_SMALL_MODEL_TYPE = (ModelType.TEXT_REASONING_SMALL ??
  "REASONING_SMALL") as string;
const TEXT_REASONING_LARGE_MODEL_TYPE = (ModelType.TEXT_REASONING_LARGE ??
  "REASONING_LARGE") as string;

export const anthropicPlugin: Plugin = {
  name: "anthropic",
  description: "Anthropic plugin (supports text, object, and image description generation)",
  autoEnable: {
    envKeys: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
  },

  config: {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? null,
    ANTHROPIC_NANO_MODEL: env.ANTHROPIC_NANO_MODEL ?? null,
    ANTHROPIC_MEDIUM_MODEL: env.ANTHROPIC_MEDIUM_MODEL ?? null,
    ANTHROPIC_SMALL_MODEL: env.ANTHROPIC_SMALL_MODEL ?? null,
    ANTHROPIC_LARGE_MODEL: env.ANTHROPIC_LARGE_MODEL ?? null,
    ANTHROPIC_MEGA_MODEL: env.ANTHROPIC_MEGA_MODEL ?? null,
    ANTHROPIC_RESPONSE_HANDLER_MODEL: env.ANTHROPIC_RESPONSE_HANDLER_MODEL ?? null,
    ANTHROPIC_SHOULD_RESPOND_MODEL: env.ANTHROPIC_SHOULD_RESPOND_MODEL ?? null,
    ANTHROPIC_ACTION_PLANNER_MODEL: env.ANTHROPIC_ACTION_PLANNER_MODEL ?? null,
    ANTHROPIC_PLANNER_MODEL: env.ANTHROPIC_PLANNER_MODEL ?? null,
    NANO_MODEL: env.NANO_MODEL ?? null,
    MEDIUM_MODEL: env.MEDIUM_MODEL ?? null,
    SMALL_MODEL: env.SMALL_MODEL ?? null,
    LARGE_MODEL: env.LARGE_MODEL ?? null,
    MEGA_MODEL: env.MEGA_MODEL ?? null,
    RESPONSE_HANDLER_MODEL: env.RESPONSE_HANDLER_MODEL ?? null,
    SHOULD_RESPOND_MODEL: env.SHOULD_RESPOND_MODEL ?? null,
    ACTION_PLANNER_MODEL: env.ACTION_PLANNER_MODEL ?? null,
    PLANNER_MODEL: env.PLANNER_MODEL ?? null,
    ANTHROPIC_EXPERIMENTAL_TELEMETRY: env.ANTHROPIC_EXPERIMENTAL_TELEMETRY ?? null,
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL ?? null,
    ANTHROPIC_BROWSER_BASE_URL: env.ANTHROPIC_BROWSER_BASE_URL ?? null,
    ANTHROPIC_COT_BUDGET: env.ANTHROPIC_COT_BUDGET ?? null,
    ANTHROPIC_COT_BUDGET_SMALL: env.ANTHROPIC_COT_BUDGET_SMALL ?? null,
    ANTHROPIC_COT_BUDGET_LARGE: env.ANTHROPIC_COT_BUDGET_LARGE ?? null,
    ANTHROPIC_AUTH_MODE: env.ANTHROPIC_AUTH_MODE ?? null,
    ANTHROPIC_REASONING_SMALL_MODEL: env.ANTHROPIC_REASONING_SMALL_MODEL ?? null,
    ANTHROPIC_REASONING_LARGE_MODEL: env.ANTHROPIC_REASONING_LARGE_MODEL ?? null,
  },

  async init(config, runtime) {
    initializeAnthropic(config as PluginConfig, runtime);
  },

  models: {
    [TEXT_NANO_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextNano(runtime, params);
    },

    [ModelType.TEXT_SMALL]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextSmall(runtime, params);
    },

    [TEXT_MEDIUM_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextMedium(runtime, params);
    },

    [ModelType.TEXT_LARGE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextLarge(runtime, params);
    },

    [TEXT_MEGA_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextMega(runtime, params);
    },

    [RESPONSE_HANDLER_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleResponseHandler(runtime, params);
    },

    [ACTION_PLANNER_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleActionPlanner(runtime, params);
    },

    [TEXT_REASONING_SMALL_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleReasoningSmall(runtime, params);
    },

    [TEXT_REASONING_LARGE_MODEL_TYPE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleReasoningLarge(runtime, params);
    },

    [ModelType.IMAGE_DESCRIPTION]: async (
      runtime: IAgentRuntime,
      params: ImageDescriptionParams | string
    ): Promise<{ title: string; description: string }> => {
      return handleImageDescription(runtime, params);
    },
  },

  tests: pluginTests as TestSuite[],
};

export default anthropicPlugin;
