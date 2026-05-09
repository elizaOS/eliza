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
import type { UpdateCommentParameters } from "../types/index.js";
import { validateLinearActionIntent } from "./validate-linear-intent";

export const updateCommentAction: Action = {
  name: "UPDATE_LINEAR_COMMENT",
  contexts: ["tasks", "connectors", "automation"],
  contextGate: { anyOf: ["tasks", "connectors", "automation"] },
  roleGate: { minRole: "USER" },
  description: "Update (edit) the body of an existing Linear comment",
  descriptionCompressed: "update (edit) body exist Linear comment",
  parameters: [
    {
      name: "commentId",
      description: "Linear comment id to update.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "body",
      description: "New comment body text.",
      required: false,
      schema: { type: "string" },
    },
  ],
  similes: ["edit-linear-comment", "modify-linear-comment", "change-linear-comment"],

  examples: [
    [
      {
        name: "User",
        content: { text: "Update comment abc-123 to say: LGTM after retest" },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll update that comment.",
          actions: ["UPDATE_LINEAR_COMMENT"],
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> =>
    validateLinearActionIntent(runtime, message, state, {
      keywords: ["update", "edit", "linear", "comment"],
      regexAlternation: "update|edit|linear|comment",
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

      const params = _options?.parameters as UpdateCommentParameters | undefined;
      const commentId = params?.commentId?.trim() ?? "";
      const body = params?.body?.trim() ?? "";

      if (!commentId || !body) {
        const errorMessage = "Please provide both commentId and body to update a comment.";
        await callback?.({ text: errorMessage, source: message.content.source });
        return { text: errorMessage, success: false };
      }

      const comment = await linearService.updateComment(commentId, body);

      const successMessage = `Updated comment ${commentId}.`;
      await callback?.({ text: successMessage, source: message.content.source });
      return {
        text: successMessage,
        success: true,
        data: { commentId: comment.id },
      };
    } catch (error) {
      logger.error("Failed to update comment:", error);
      const errorMessage = `Failed to update comment: ${error instanceof Error ? error.message : "Unknown error"}`;
      await callback?.({ text: errorMessage, source: message.content.source });
      return { text: errorMessage, success: false };
    }
  },
};
