import {
  type Action,
  type ActionExample,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { ShellService } from "../services/shellService";

export const clearHistory: Action = {
  name: "CLEAR_SHELL_HISTORY",
  similes: ["RESET_SHELL", "CLEAR_TERMINAL", "CLEAR_HISTORY", "RESET_HISTORY"],
  description: "Clears the recorded history of shell commands for the current conversation",
  validate: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<boolean> => {
    const shellService = runtime.getService<ShellService>("shell");
    if (!shellService) {
      return false;
    }

    const text = message.content.text?.toLowerCase() || "";
    const clearKeywords = ["clear", "reset", "delete", "remove", "clean"];
    const historyKeywords = ["history", "terminal", "shell", "command"];

    const hasClearKeyword = clearKeywords.some((keyword) => text.includes(keyword));
    const hasHistoryKeyword = historyKeywords.some((keyword) => text.includes(keyword));

    return hasClearKeyword && hasHistoryKeyword;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback: HandlerCallback
  ) => {
    const shellService = runtime.getService<ShellService>("shell");

    if (!shellService) {
      await callback({
        text: "Shell service is not available.",
        source: message.content.source,
      });
      return { success: false, error: "Shell service is not available." };
    }

    const conversationId = message.roomId || message.agentId;
    shellService.clearCommandHistory(conversationId);

    logger.info(`Cleared shell history for conversation: ${conversationId}`);

    const response: Content = {
      text: "Shell command history has been cleared.",
      source: message.content.source,
    };

    await callback(response);
    return { success: true, text: response.text };
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "clear my shell history",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Shell command history has been cleared.",
          actions: ["CLEAR_SHELL_HISTORY"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "reset the terminal history",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Shell command history has been cleared.",
          actions: ["CLEAR_SHELL_HISTORY"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "delete command history",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Shell command history has been cleared.",
          actions: ["CLEAR_SHELL_HISTORY"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default clearHistory;
