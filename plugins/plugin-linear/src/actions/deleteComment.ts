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
import type { DeleteCommentParameters } from "../types/index.js";
import { getLinearAccountId, linearAccountIdParameter } from "./account-options";
import { validateLinearActionIntent } from "./validate-linear-intent";

export const deleteCommentAction: Action = {
  name: "DELETE_LINEAR_COMMENT",
  contexts: ["tasks", "connectors", "automation"],
  contextGate: { anyOf: ["tasks", "connectors", "automation"] },
  roleGate: { minRole: "USER" },
  description: "Delete a Linear comment by id",
  descriptionCompressed: "delete Linear comment id",
  parameters: [
    {
      name: "commentId",
      description: "Linear comment id to delete.",
      required: false,
      schema: { type: "string" },
    },
    linearAccountIdParameter,
  ],
  similes: ["remove-linear-comment", "erase-linear-comment"],

  examples: [
    [
      {
        name: "User",
        content: { text: "Delete comment abc-123 from ENG-456." },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll delete that comment.",
          actions: ["DELETE_LINEAR_COMMENT"],
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> =>
    validateLinearActionIntent(runtime, message, state, {
      keywords: ["delete", "remove", "linear", "comment"],
      regexAlternation: "delete|remove|linear|comment",
    }),

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
      const accountId = getLinearAccountId(runtime, _options);

      const params = _options?.parameters as DeleteCommentParameters | undefined;
      const commentId = params?.commentId?.trim() ?? "";

      if (!commentId) {
        const errorMessage = "Please provide a commentId to delete.";
        await callback?.({ text: errorMessage, source: message.content.source });
        return { text: errorMessage, success: false };
      }

      await linearService.deleteComment(commentId, accountId);

      const successMessage = `Deleted comment ${commentId}.`;
      await callback?.({ text: successMessage, source: message.content.source });
      return {
        text: successMessage,
        success: true,
        data: { commentId, accountId },
      };
    } catch (error) {
      logger.error("Failed to delete comment:", error);
      const errorMessage = `Failed to delete comment: ${error instanceof Error ? error.message : "Unknown error"}`;
      await callback?.({ text: errorMessage, source: message.content.source });
      return { text: errorMessage, success: false };
    }
  },
};
