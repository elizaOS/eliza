/**
 * Handles the clear_activity Linear op: wipes the in-memory activity log
 * (optionally scoped to an account) via LinearService.clearActivityLog. Requires
 * a two-phase user confirmation first, since the clear is not undoable.
 */
import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  requireConfirmation,
  type State,
} from "@elizaos/core";
import type { LinearService } from "../services/linear";
import { getLinearAccountId, linearAccountIdParameter } from "./account-options";
import { formatUnknownError, getMessageSource } from "./message-source";
import { validateLinearActionIntent } from "./validate-linear-intent";

const CLEAR_ACTIVITY_TIMEOUT_MS = 10_000;

export const clearActivityAction: Action = {
  name: "CLEAR_LINEAR_ACTIVITY",
  contexts: ["tasks", "connectors", "automation"],
  contextGate: { anyOf: ["tasks", "connectors", "automation"] },
  roleGate: { minRole: "USER" },
  description:
    "Clear cached Linear activity log for connected account. Use for reset/wipe/refresh activity before fresh issue/comment events.",
  descriptionCompressed: "clear Linear activity log",
  similes: ["clear-linear-activity", "reset-linear-activity", "delete-linear-activity"],
  parameters: [linearAccountIdParameter],

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

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> =>
    validateLinearActionIntent(runtime, message, state),

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

      // Two-phase confirmation: clearing the activity log is destructive
      // and not undoable from the agent's side.
      const decision = await requireConfirmation({
        runtime,
        message,
        actionName: "CLEAR_LINEAR_ACTIVITY",
        pendingKey: `clear_log:${accountId}`,
        prompt: 'Clear the Linear activity log? Reply "yes" to confirm.',
        callback,
      });
      if (decision.status === "pending") {
        return {
          text: "Awaiting confirmation to clear Linear activity.",
          success: true,
          data: { awaitingUserInput: true },
        };
      }
      if (decision.status === "cancelled") {
        const cancelMessage = "Clear of Linear activity cancelled.";
        await callback?.({ text: cancelMessage, source: getMessageSource(message) });
        return {
          text: cancelMessage,
          success: true,
          data: { cancelled: true },
        };
      }

      await Promise.race([
        linearService.clearActivityLog(accountId),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Linear clear activity timeout")),
            CLEAR_ACTIVITY_TIMEOUT_MS
          )
        ),
      ]);

      const successMessage = "✅ Linear activity log has been cleared.";
      await callback?.({
        text: successMessage,
        source: getMessageSource(message),
      });

      return {
        text: successMessage,
        success: true,
      };
    } catch (error) {
      logger.error("Failed to clear Linear activity:", formatUnknownError(error));
      const errorMessage = `❌ Failed to clear Linear activity: ${error instanceof Error ? error.message : "Unknown error"}`;
      await callback?.({
        text: errorMessage,
        source: getMessageSource(message),
      });
      return {
        text: errorMessage,
        success: false,
      };
    }
  },
};
