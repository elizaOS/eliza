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

const spec = requireActionSpec("CLEAR_HISTORY");

export const clearHistory: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
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
  examples: (spec.examples ?? []) as ActionExample[][],
};

export default clearHistory;
