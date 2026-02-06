import type {
  GenerateTextParams,
  IAgentRuntime,
  JsonValue,
  ObjectGenerationParams,
  Plugin,
  TestCase,
  TestSuite,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { initializeCopilotProxy, type PluginConfig } from "./init";
import {
  handleObjectLarge,
  handleObjectSmall,
  handleTextLarge,
  handleTextSmall,
} from "./models";
import { getBaseUrlOptional, isPluginEnabled } from "./utils/config";

export type { PluginConfig } from "./init";

const pluginTests = [
  {
    name: "copilot_proxy_plugin_tests",
    tests: [
      {
        name: "copilot_proxy_test_configuration",
        fn: async (runtime: IAgentRuntime) => {
          if (!isPluginEnabled(runtime)) {
            logger.log("Copilot Proxy plugin is disabled, skipping test");
            return;
          }
          const baseUrl = getBaseUrlOptional(runtime);
          logger.log(
            `Copilot Proxy base URL: ${baseUrl ?? "default (http://localhost:3000/v1)"}`,
          );
        },
      },
      {
        name: "copilot_proxy_test_text_small",
        fn: async (runtime: IAgentRuntime) => {
          if (!isPluginEnabled(runtime)) {
            logger.log("Copilot Proxy plugin is disabled, skipping test");
            return;
          }
          const text = await runtime.useModel(ModelType.TEXT_SMALL, {
            prompt: "What is 2 + 2? Answer with just the number.",
          });

          if (typeof text !== "string" || text.length === 0) {
            throw new Error("Failed to generate text: empty response");
          }

          logger.log({ text }, "generated with test_text_small");
        },
      },
      {
        name: "copilot_proxy_test_text_large",
        fn: async (runtime: IAgentRuntime) => {
          if (!isPluginEnabled(runtime)) {
            logger.log("Copilot Proxy plugin is disabled, skipping test");
            return;
          }
          const text = await runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: "What is the capital of France? Answer in one word.",
          });

          if (typeof text !== "string" || text.length === 0) {
            throw new Error("Failed to generate text: empty response");
          }

          logger.log({ text }, "generated with test_text_large");
        },
      },
      {
        name: "copilot_proxy_test_object_small",
        fn: async (runtime: IAgentRuntime) => {
          if (!isPluginEnabled(runtime)) {
            logger.log("Copilot Proxy plugin is disabled, skipping test");
            return;
          }
          const result = await runtime.useModel(ModelType.OBJECT_SMALL, {
            prompt:
              "Create a simple JSON object with a message field saying hello",
            schema: { type: "object" },
          });

          if (!result || typeof result !== "object") {
            throw new Error("Failed to generate object: invalid response");
          }

          if ("error" in result) {
            throw new Error(
              `Failed to generate object: ${String(result["error"])}`,
            );
          }

          logger.log({ result }, "Generated object with test_object_small");
        },
      },
      {
        name: "copilot_proxy_test_object_large",
        fn: async (runtime: IAgentRuntime) => {
          if (!isPluginEnabled(runtime)) {
            logger.log("Copilot Proxy plugin is disabled, skipping test");
            return;
          }
          const result = await runtime.useModel(ModelType.OBJECT_LARGE, {
            prompt:
              "Create a simple JSON object with a message field saying hello",
            schema: { type: "object" },
          });

          if (!result || typeof result !== "object") {
            throw new Error("Failed to generate object: invalid response");
          }

          if ("error" in result) {
            throw new Error(
              `Failed to generate object: ${String(result["error"])}`,
            );
          }

          logger.log({ result }, "Generated object with test_object_large");
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

export const copilotProxyPlugin: Plugin = {
  name: "copilot-proxy",
  description:
    "Copilot Proxy model provider plugin (OpenAI-compatible local proxy for VS Code Copilot)",

  config: {
    ["COPILOT_PROXY_BASE_URL"]: env["COPILOT_PROXY_BASE_URL"] ?? null,
    ["COPILOT_PROXY_MODEL"]: env["COPILOT_PROXY_MODEL"] ?? null,
    ["COPILOT_PROXY_ENABLED"]: env["COPILOT_PROXY_ENABLED"] ?? null,
    ["COPILOT_PROXY_SMALL_MODEL"]: env["COPILOT_PROXY_SMALL_MODEL"] ?? null,
    ["COPILOT_PROXY_LARGE_MODEL"]: env["COPILOT_PROXY_LARGE_MODEL"] ?? null,
    ["COPILOT_PROXY_TIMEOUT_SECONDS"]:
      env["COPILOT_PROXY_TIMEOUT_SECONDS"] ?? null,
    ["COPILOT_PROXY_MAX_TOKENS"]: env["COPILOT_PROXY_MAX_TOKENS"] ?? null,
    ["COPILOT_PROXY_CONTEXT_WINDOW"]:
      env["COPILOT_PROXY_CONTEXT_WINDOW"] ?? null,
  },

  async init(config, runtime) {
    initializeCopilotProxy(config as PluginConfig, runtime);
  },

  models: {
    [ModelType.TEXT_SMALL]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      return handleTextSmall(runtime, params);
    },

    [ModelType.TEXT_LARGE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      return handleTextLarge(runtime, params);
    },

    [ModelType.OBJECT_SMALL]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams,
    ): Promise<Record<string, JsonValue>> => {
      const result = await handleObjectSmall(runtime, params);
      return result as unknown as Record<string, JsonValue>;
    },

    [ModelType.OBJECT_LARGE]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams,
    ): Promise<Record<string, JsonValue>> => {
      const result = await handleObjectLarge(runtime, params);
      return result as unknown as Record<string, JsonValue>;
    },
  },

  tests: pluginTests as TestSuite[],
};

export default copilotProxyPlugin;
