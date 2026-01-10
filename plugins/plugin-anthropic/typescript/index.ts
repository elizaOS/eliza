/**
 * Anthropic Plugin for elizaOS
 *
 * Provides text and object generation using Anthropic's Claude models.
 *
 * ## Supported Models
 *
 * - TEXT_SMALL: claude-3-5-haiku (fast, efficient)
 * - TEXT_LARGE: claude-sonnet-4 (most capable)
 * - OBJECT_SMALL: JSON generation with small model
 * - OBJECT_LARGE: JSON generation with large model
 *
 * ## Configuration
 *
 * Required:
 * - ANTHROPIC_API_KEY: Your Anthropic API key
 *
 * Optional:
 * - ANTHROPIC_SMALL_MODEL: Override small model (default: claude-3-5-haiku-20241022)
 * - ANTHROPIC_LARGE_MODEL: Override large model (default: claude-sonnet-4-20250514)
 * - ANTHROPIC_BASE_URL: Custom API endpoint
 * - ANTHROPIC_BROWSER_BASE_URL: Browser proxy endpoint
 * - ANTHROPIC_EXPERIMENTAL_TELEMETRY: Enable telemetry (default: false)
 * - ANTHROPIC_COT_BUDGET: Chain-of-thought token budget
 * - ANTHROPIC_COT_BUDGET_SMALL: CoT budget for small model
 * - ANTHROPIC_COT_BUDGET_LARGE: CoT budget for large model
 */

import type {
  GenerateTextParams,
  IAgentRuntime,
  ObjectGenerationParams,
  Plugin,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { initializeAnthropic } from "./init";
import { handleObjectLarge, handleObjectSmall, handleTextLarge, handleTextSmall } from "./models";
import { getApiKeyOptional } from "./utils/config";

// Re-export types for consumers
export * from "./types";

/**
 * Plugin configuration object structure
 */
export interface PluginConfig {
  readonly ANTHROPIC_API_KEY?: string;
  readonly ANTHROPIC_SMALL_MODEL?: string;
  readonly ANTHROPIC_LARGE_MODEL?: string;
  readonly ANTHROPIC_EXPERIMENTAL_TELEMETRY?: string;
  readonly ANTHROPIC_BASE_URL?: string;
  readonly ANTHROPIC_BROWSER_BASE_URL?: string;
  readonly ANTHROPIC_COT_BUDGET?: string;
  readonly ANTHROPIC_COT_BUDGET_SMALL?: string;
  readonly ANTHROPIC_COT_BUDGET_LARGE?: string;
}

/**
 * Test suite for the Anthropic plugin.
 */
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
        name: "anthropic_test_object_small",
        fn: async (runtime: IAgentRuntime) => {
          const result = await runtime.useModel(ModelType.OBJECT_SMALL, {
            prompt: "Create a simple JSON object with a message field saying hello",
            schema: { type: "object" },
          });

          if (!result || typeof result !== "object") {
            throw new Error("Failed to generate object: invalid response");
          }

          if ("error" in result) {
            throw new Error(`Failed to generate object: ${String(result["error"])}`);
          }

          logger.log({ result }, "Generated object with test_object_small");
        },
      },
      {
        name: "anthropic_test_object_large",
        fn: async (runtime: IAgentRuntime) => {
          const result = await runtime.useModel(ModelType.OBJECT_LARGE, {
            prompt: "Create a simple JSON object with a message field saying hello",
            schema: { type: "object" },
          });

          if (!result || typeof result !== "object") {
            throw new Error("Failed to generate object: invalid response");
          }

          if ("error" in result) {
            throw new Error(`Failed to generate object: ${String(result["error"])}`);
          }

          logger.log({ result }, "Generated object with test_object_large");
        },
      },
      {
        name: "anthropic_test_object_with_code_blocks",
        fn: async (runtime: IAgentRuntime) => {
          const result = await runtime.useModel(ModelType.OBJECT_SMALL, {
            prompt: "Give me instructions to install Node.js",
            schema: { type: "object" },
          });

          if (!result || typeof result !== "object") {
            throw new Error("Failed to generate object with code blocks: invalid response");
          }

          if ("error" in result) {
            throw new Error(`Failed to generate object: ${String(result["error"])}`);
          }

          logger.log({ result }, "Generated object with code blocks");
        },
      },
    ],
  },
];

/**
 * Anthropic plugin for elizaOS.
 *
 * Provides text generation and JSON object generation using Claude models.
 */
export const anthropicPlugin: Plugin = {
  name: "anthropic",
  description: "Anthropic plugin (supports text and object generation)",

  config: {
    ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
    ANTHROPIC_SMALL_MODEL: process.env["ANTHROPIC_SMALL_MODEL"],
    ANTHROPIC_LARGE_MODEL: process.env["ANTHROPIC_LARGE_MODEL"],
    ANTHROPIC_EXPERIMENTAL_TELEMETRY: process.env["ANTHROPIC_EXPERIMENTAL_TELEMETRY"],
    ANTHROPIC_BASE_URL: process.env["ANTHROPIC_BASE_URL"],
    ANTHROPIC_BROWSER_BASE_URL: process.env["ANTHROPIC_BROWSER_BASE_URL"],
    ANTHROPIC_COT_BUDGET: process.env["ANTHROPIC_COT_BUDGET"],
    ANTHROPIC_COT_BUDGET_SMALL: process.env["ANTHROPIC_COT_BUDGET_SMALL"],
    ANTHROPIC_COT_BUDGET_LARGE: process.env["ANTHROPIC_COT_BUDGET_LARGE"],
  },

  async init(config, runtime) {
    initializeAnthropic(config as PluginConfig, runtime);
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
    ): Promise<Record<string, unknown>> => {
      return handleObjectSmall(runtime, params);
    },

    [ModelType.OBJECT_LARGE]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams,
    ): Promise<Record<string, unknown>> => {
      return handleObjectLarge(runtime, params);
    },
  },

  tests: pluginTests,
};

export default anthropicPlugin;
