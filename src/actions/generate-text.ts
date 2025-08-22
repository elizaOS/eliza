import {
  Action,
  IAgentRuntime,
  Memory,
  State,
  ModelType,
  HandlerCallback,
} from "@elizaos/core";

export const generateTextAction: Action = {
  name: "GENERATE_TEXT",
  description: "Generate text using AI Gateway models",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const content = message.content;
    return !!content.text || !!content.prompt;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: any,
    callback?: HandlerCallback,
  ): Promise<void> => {
    const content = message.content;
    const prompt = content.text || content.prompt;
    const temperature = content.temperature || 0.7;
    const maxTokens = content.maxTokens || 1000;
    const modelType = content.useSmallModel
      ? ModelType.TEXT_SMALL
      : ModelType.TEXT_LARGE;

    try {
      const response = await runtime.useModel(modelType, {
        prompt,
        temperature,
        maxTokens,
      });

      if (callback) {
        await callback({
          text: response,
          success: true,
        });
      }

      return;
    } catch (error) {
      // Error occurred while generating text

      if (callback) {
        await callback({
          text: "Sorry, I encountered an error while generating text.",
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return;
    }
  },

  examples: [
    [
      {
        name: "user",
        content: {
          text: "Generate a haiku about artificial intelligence",
        },
      },
      {
        name: "assistant",
        content: {
          text: "Silicon minds wake\nLearning from endless data\nFuture blooms in code",
          action: "GENERATE_TEXT",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Write a short story about space exploration",
          maxTokens: 500,
        },
      },
      {
        name: "assistant",
        content: {
          text: "The starship Horizon drifted through the cosmic void...",
          action: "GENERATE_TEXT",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Explain quantum computing in simple terms",
          useSmallModel: true,
        },
      },
      {
        name: "assistant",
        content: {
          text: "Quantum computing uses quantum bits that can be both 0 and 1 at the same time...",
          action: "GENERATE_TEXT",
        },
      },
    ],
  ],

  similes: [
    "generate_text",
    "create_text",
    "write_text",
    "ai_generate",
    "text_generation",
  ],
};
