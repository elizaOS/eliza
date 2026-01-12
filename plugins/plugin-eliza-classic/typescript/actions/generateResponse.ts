import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ModelType } from "@elizaos/core";

export const generateResponseAction: Action = {
  name: "generate-response",
  similes: ["ELIZA_RESPOND", "ELIZA_CHAT", "CLASSIC_ELIZA"],
  description: "Generate an ELIZA response for user input using classic pattern matching.",

  validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const userInput =
      typeof message.content === "object" && message.content !== null
        ? (message.content as { text?: string }).text || ""
        : String(message.content || "");

    if (!userInput.trim()) {
      if (callback) {
        await callback({
          text: "I need something to respond to. What would you like to talk about?",
          source: message.content.source,
        });
      }
      return { success: false, error: "No user input provided" };
    }

    try {
      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: userInput,
      });

      if (callback) {
        await callback({
          text: response,
          source: message.content.source,
        });
      }

      return { success: true, text: response };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (callback) {
        await callback({
          text: "I encountered an issue. Please try again.",
          source: message.content.source,
        });
      }
      return { success: false, error: errorMessage };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "I am feeling very anxious today",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll use ELIZA to respond.",
          actions: ["generate-response"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "My mother always criticizes me",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll use ELIZA to explore that with you.",
          actions: ["generate-response"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default generateResponseAction;
