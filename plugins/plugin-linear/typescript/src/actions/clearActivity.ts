import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { LinearService } from "../services/linear";

export const clearActivityAction: Action = {
  name: "CLEAR_LINEAR_ACTIVITY",
  description: "Clear the Linear activity log",
  similes: ["clear-linear-activity", "reset-linear-activity", "delete-linear-activity"],

  examples: [
    [
      {
        name: "User",
        content: {
          text: "Clear the Linear activity log",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll clear the Linear activity log for you.",
          actions: ["CLEAR_LINEAR_ACTIVITY"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "Reset Linear activity",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll reset the Linear activity log now.",
          actions: ["CLEAR_LINEAR_ACTIVITY"],
        },
      },
    ],
  ],

  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> {
    const apiKey = runtime.getSetting("LINEAR_API_KEY");
    return !!apiKey;
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> {
    try {
      const linearService = runtime.getService<LinearService>("linear");
      if (!linearService) {
        throw new Error("Linear service not available");
      }

      await linearService.clearActivityLog();

      const successMessage = "✅ Linear activity log has been cleared.";
      await callback?.({
        text: successMessage,
        source: message.content.source,
      });

      return {
        text: successMessage,
        success: true,
      };
    } catch (error) {
      logger.error("Failed to clear Linear activity:", error);
      const errorMessage = `❌ Failed to clear Linear activity: ${error instanceof Error ? error.message : "Unknown error"}`;
      await callback?.({
        text: errorMessage,
        source: message.content.source,
      });
      return {
        text: errorMessage,
        success: false,
      };
    }
  },
};
