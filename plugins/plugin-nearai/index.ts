/**
 * Assembles the `nearaiPlugin` Plugin object: registers `TEXT_SMALL` and
 * `TEXT_LARGE` model handlers that route text generation through NEAR AI
 * Cloud's OpenAI-compatible inference API, seeds `config` from the `NEARAI_*`
 * environment variables, and wires initialization via `initializeNearAI`.
 *
 * The plugin registers no actions, providers, evaluators, or routes — only the
 * two text-model handlers (delegated to `models/text.ts`). The bundled
 * `tests` suite drives both handlers against a live NEAR AI key when present.
 * Node and browser entry points re-export from here.
 */
import type {
  GenerateTextParams,
  IAgentRuntime,
  Plugin,
  ProcessEnvLike,
  TestCase,
  TestSuite,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { initializeNearAI, type PluginConfig } from "./init";
import { handleTextLarge, handleTextSmall } from "./models";
import { getApiKeyOptional } from "./utils/config";

export type { PluginConfig } from "./init";

const pluginTests = [
  {
    name: "nearai_plugin_tests",
    tests: [
      {
        name: "nearai_test_api_key_validation",
        fn: async (runtime: IAgentRuntime) => {
          const apiKey = getApiKeyOptional(runtime);
          if (!apiKey) {
            throw new Error("NEARAI_API_KEY is not configured");
          }
          logger.log("NEAR AI API key is configured");
        },
      },
      {
        name: "nearai_test_text_small",
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
        name: "nearai_test_text_large",
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

function getProcessEnv(): ProcessEnvLike {
  // In browsers, `process` is not defined (and we must not reference it unguarded).
  if (typeof process === "undefined") {
    return {};
  }
  return process.env as ProcessEnvLike;
}

const env = getProcessEnv();

export const nearaiPlugin: Plugin = {
  name: "nearai",
  description:
    "NEAR AI Cloud TEE inference plugin (OpenAI-compatible API; supports text generation)",
  config: {
    NEARAI_API_KEY: env.NEARAI_API_KEY ?? null,
    NEARAI_SMALL_MODEL: env.NEARAI_SMALL_MODEL ?? null,
    NEARAI_LARGE_MODEL: env.NEARAI_LARGE_MODEL ?? null,
    NEARAI_EXPERIMENTAL_TELEMETRY: env.NEARAI_EXPERIMENTAL_TELEMETRY ?? null,
    NEARAI_BASE_URL: env.NEARAI_BASE_URL ?? null,
    NEARAI_BROWSER_BASE_URL: env.NEARAI_BROWSER_BASE_URL ?? null,
  },

  async init(config: Record<string, string>, runtime: IAgentRuntime) {
    initializeNearAI(config as PluginConfig, runtime);
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

export default nearaiPlugin;
