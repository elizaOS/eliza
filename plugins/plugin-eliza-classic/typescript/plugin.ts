import type { GenerateTextParams, IAgentRuntime, Plugin } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { generateResponseAction } from "./actions";
import { handleTextLarge, handleTextSmall } from "./models";
import { elizaGreetingProvider } from "./providers";

export const elizaClassicPlugin: Plugin = {
  name: "eliza-classic",
  description: "Classic ELIZA pattern matching psychotherapist - no LLM required",
  priority: 100,

  actions: [generateResponseAction],
  providers: [elizaGreetingProvider],

  models: {
    [ModelType.TEXT_LARGE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string> => {
      return handleTextLarge(runtime, params);
    },

    [ModelType.TEXT_SMALL]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string> => {
      return handleTextSmall(runtime, params);
    },
  },

  async init(_config, _runtime) {
    logger.info({ src: "plugin:eliza-classic" }, "ELIZA pattern matching initialized");
  },

  tests: [
    {
      name: "eliza_classic_plugin_tests",
      tests: [
        {
          name: "eliza_test_greeting",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const response = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "hello",
            });

            if (typeof response !== "string" || response.length === 0) {
              throw new Error("Greeting should return non-empty string");
            }

            logger.info(`[ELIZA Test] Greeting: "${response}"`);
          },
        },
        {
          name: "eliza_test_feeling_sad",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const response = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "I am sad today",
            });

            if (typeof response !== "string" || response.length === 0) {
              throw new Error("Response should be non-empty string");
            }

            logger.info(`[ELIZA Test] Sad response: "${response}"`);
          },
        },
        {
          name: "eliza_test_family",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const response = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "My mother is very kind",
            });

            if (typeof response !== "string" || response.length === 0) {
              throw new Error("Response should be non-empty string");
            }

            logger.info(`[ELIZA Test] Family response: "${response}"`);
          },
        },
        {
          name: "eliza_test_computer",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const response = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "I think computers are fascinating",
            });

            if (typeof response !== "string" || response.length === 0) {
              throw new Error("Response should be non-empty string");
            }

            logger.info(`[ELIZA Test] Computer response: "${response}"`);
          },
        },
        {
          name: "eliza_test_text_small",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const response = await runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: "Can you help me?",
            });

            if (typeof response !== "string" || response.length === 0) {
              throw new Error("TEXT_SMALL should return non-empty string");
            }

            logger.info(`[ELIZA Test] TEXT_SMALL: "${response}"`);
          },
        },
      ],
    },
  ],
};

export default elizaClassicPlugin;
