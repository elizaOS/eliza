import type { GenerateTextParams, IAgentRuntime, Plugin, TestCase, TestSuite } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { initializeZai, type PluginConfig } from "./init";
import { handleTextLarge, handleTextSmall } from "./models";
import { getApiKeyOptional } from "./utils/config";

export type { PluginConfig } from "./init";

const pluginTests = [
  {
    name: "zai_plugin_tests",
    tests: [
      {
        name: "zai_test_api_key_validation",
        fn: async (runtime: IAgentRuntime) => {
          const apiKey = getApiKeyOptional(runtime);
          if (!apiKey) {
            throw new Error("ZAI_API_KEY is not configured");
          }
          logger.log("z.ai API key is configured");
        },
      },
      {
        name: "zai_test_text_small",
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
        name: "zai_test_text_large",
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

export const zaiPlugin: Plugin = {
  name: "zai",
  description: "z.ai plugin (OpenAI-compatible direct API; supports text generation)",
  config: {
    ZAI_API_KEY: env.ZAI_API_KEY ?? env.Z_AI_API_KEY ?? null,
    Z_AI_API_KEY: env.Z_AI_API_KEY ?? null,
    ZAI_SMALL_MODEL: env.ZAI_SMALL_MODEL ?? null,
    ZAI_LARGE_MODEL: env.ZAI_LARGE_MODEL ?? null,
    ZAI_EXPERIMENTAL_TELEMETRY: env.ZAI_EXPERIMENTAL_TELEMETRY ?? null,
    ZAI_BASE_URL: env.ZAI_BASE_URL ?? null,
    ZAI_BROWSER_BASE_URL: env.ZAI_BROWSER_BASE_URL ?? null,
    ZAI_COT_BUDGET: env.ZAI_COT_BUDGET ?? null,
    ZAI_COT_BUDGET_SMALL: env.ZAI_COT_BUDGET_SMALL ?? null,
    ZAI_COT_BUDGET_LARGE: env.ZAI_COT_BUDGET_LARGE ?? null,
    ZAI_THINKING_TYPE: env.ZAI_THINKING_TYPE ?? null,
  },

  async init(config, runtime) {
    initializeZai(config as PluginConfig, runtime);
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
  },

  tests: pluginTests as TestSuite[],
};

export default zaiPlugin;
