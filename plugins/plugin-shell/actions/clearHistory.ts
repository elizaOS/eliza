import {
  type Action,
  type ActionExample,
  type Content,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { ShellService } from "../services/shellService";

const spec = requireActionSpec("CLEAR_SHELL_HISTORY");

export const clearHistory: Action = {
  name: spec.name,
  contexts: ["terminal", "settings"],
  contextGate: { anyOf: ["terminal", "settings"] },
  roleGate: { minRole: "USER" },
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
  descriptionCompressed: spec.descriptionCompressed,
  parameters: [],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions
  ): Promise<boolean> => {
    const shellService = runtime.getService<ShellService>("shell");
    if (!shellService) {
      return false;
    }

    const text = message.content.text?.toLowerCase() || "";
    const clearKeywords = ["clear", "reset", "delete", "remove", "clean"];
    const historyKeywords = ["history", "terminal", "shell", "command"];

    return (
      clearKeywords.some((keyword) => text.includes(keyword)) &&
      historyKeywords.some((keyword) => text.includes(keyword))
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ) => {
    const shellService = runtime.getService<ShellService>("shell");

    if (!shellService) {
      if (callback) {
        await callback({
          text: "Shell service is not available.",
          source: message.content.source,
        });
      }
      return { success: false, error: "Shell service is not available." };
    }

    const conversationId = message.roomId || message.agentId;
    if (!conversationId) {
      const errorMsg = "No conversation ID available";
      if (callback) {
        await callback({
          text: errorMsg,
          source: message.content.source,
        });
      }
      return { success: false, error: errorMsg };
    }
    shellService.clearCommandHistory(conversationId);

    logger.info(`Cleared shell history for conversation: ${conversationId}`);

    const response: Content = {
      text: "Shell command history has been cleared.",
      source: message.content.source,
    };

    if (callback) {
      await callback(response);
    }
    return { success: true, text: response.text };
  },
  examples: ((spec.examples?.length
    ? spec.examples
    : [
        [
          {
            name: "{{name1}}",
            content: { text: "Clear my shell command history.", source: "chat" },
          },
          {
            name: "{{agentName}}",
            content: {
              text: "Shell command history has been cleared.",
              actions: ["CLEAR_SHELL_HISTORY"],
              thought:
                "User asked to wipe shell history; CLEAR_SHELL_HISTORY clears the recorded commands for this conversation.",
            },
          },
        ],
        [
          {
            name: "{{name1}}",
            content: { text: "Reset the terminal history for this conversation.", source: "chat" },
          },
          {
            name: "{{agentName}}",
            content: {
              text: "Shell command history has been cleared.",
              actions: ["CLEAR_SHELL_HISTORY"],
              thought:
                "Reset/terminal-history phrasing maps to the same CLEAR_SHELL_HISTORY action.",
            },
          },
        ],
      ]) as ActionExample[][]),
};

export default clearHistory;
