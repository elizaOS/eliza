/**
 * Handles the update_comment Linear op: updates a comment body by comment id via
 * LinearService.updateComment. `handleUpdateComment` is the router entry and
 * requires both commentId and body in the action parameters.
 */
import {
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
import { getLinearAccountId } from "./account-options";
import { formatUnknownError, getMessageSource } from "./message-source";

export async function handleUpdateComment(
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

    const params = _options?.parameters as UpdateCommentParameters | undefined;
    const commentId = params?.commentId?.trim() ?? "";
    const body = params?.body?.trim() ?? "";

    if (!commentId || !body) {
      const errorMessage = "Please provide both commentId and body to update a comment.";
      await callback?.({ text: errorMessage, source: getMessageSource(message) });
      return { text: errorMessage, success: false };
    }

    const comment = await linearService.updateComment(commentId, body, accountId);

    const successMessage = `Updated comment ${commentId}.`;
    await callback?.({ text: successMessage, source: getMessageSource(message) });
    return {
      text: successMessage,
      success: true,
      data: { commentId: comment.id, accountId },
    };
  } catch (error) {
    logger.error("Failed to update comment:", formatUnknownError(error));
    const errorMessage = `Failed to update comment: ${error instanceof Error ? error.message : "Unknown error"}`;
    await callback?.({ text: errorMessage, source: getMessageSource(message) });
    return { text: errorMessage, success: false };
  }
}
