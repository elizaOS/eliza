/**
 * @module actions/restore
 * @description Action for restoring stashed form sessions
 *
 * ## Why an Action (Not Evaluator)
 *
 * The restore operation is unique among form intents because:
 *
 * 1. **Timing Matters**: The restored form context must be available
 *    to the agent BEFORE it generates a response. Evaluators run
 *    AFTER response generation.
 *
 * 2. **Preemption**: When user says "resume my form", the FORM_RESTORE
 *    action should preempt REPLY, generate its own response with the
 *    restored context, and let the agent continue naturally.
 *
 * 3. **Immediate Context**: After restore, the provider runs and gives
 *    the agent the restored form context for its response.
 *
 * ## Flow Comparison
 *
 * ### Other Intents (via Evaluator):
 * ```
 * Message → Provider (no context) → REPLY → Evaluator (updates state)
 *                                              ↓
 *                                    Next message has updated context
 * ```
 *
 * ### Restore Intent (via Action):
 * ```
 * Message → FORM_RESTORE.validate() → true
 *                    ↓
 *         FORM_RESTORE.handler() → Restore session → Generate response
 *                                        ↓
 *                               Next message has restored context immediately
 * ```
 *
 * ## Handling Multiple Stashed Forms
 *
 * If user has multiple stashed forms, this action restores the most recent.
 * Future enhancement: Let user choose which form to restore.
 *
 * ## Conflicts with Active Forms
 *
 * If user has an active form in the current room and tries to restore,
 * the action asks them to either continue or stash the current one.
 */

import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  type ActionResult,
  type HandlerOptions,
  type UUID,
  logger,
} from "@elizaos/core";
import { FormService } from "../service";
import { quickIntentDetect } from "../intent";

/**
 * Form Restore Action
 *
 * Fast-path action for restoring stashed forms.
 * Preempts REPLY to provide immediate restoration with summary.
 *
 * WHY action:
 * - Needs to run BEFORE provider
 * - Must generate immediate response
 * - Context needed for next message
 */
export const formRestoreAction: Action = {
  name: "FORM_RESTORE",
  similes: ["RESUME_FORM", "CONTINUE_FORM"],
  description: "Restore a previously stashed form session",

  /**
   * Validate: Only trigger for restore intent with stashed sessions.
   *
   * Fast path: Uses quickIntentDetect for English keywords.
   * Evaluator handles non-English via LLM.
   *
   * @returns true if action should run
   */
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    try {
      const text = message.content?.text || "";

      // Quick check for restore intent
      // WHY quick path: Avoid LLM call for simple English phrases
      const intent = quickIntentDetect(text);
      if (intent !== "restore") {
        return false;
      }

      const formService = runtime.getService("FORM") as FormService;
      if (!formService) {
        return false;
      }

      // Check for stashed sessions
      // WHY check stashed: No point restoring if nothing to restore
      const entityId = message.entityId as UUID;
      if (!entityId) return false;
      const stashed = await formService.getStashedSessions(entityId);

      return stashed.length > 0;
    } catch (error) {
      logger.error("[FormRestoreAction] Validation error:", String(error));
      return false;
    }
  },

  /**
   * Handler: Restore the most recent stashed session.
   *
   * 1. Check for conflicts (active session in room)
   * 2. Restore the session
   * 3. Generate summary response
   *
   * @returns ActionResult with success status and session data
   */
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const formService = runtime.getService("FORM") as FormService;
      if (!formService) {
        await callback?.({
          text: "Sorry, I couldn't find the form service.",
        });
        return { success: false };
      }

      const entityId = message.entityId as UUID;
      const roomId = message.roomId as UUID;

      if (!entityId || !roomId) {
        await callback?.({
          text: "Sorry, I couldn't identify you.",
        });
        return { success: false };
      }

      // Check for existing active session in this room
      // WHY check: Can't have two active sessions in same room
      const existing = await formService.getActiveSession(entityId, roomId);
      if (existing) {
        const form = formService.getForm(existing.formId);
        await callback?.({
          text: `You already have an active form: "${form?.name || existing.formId}". Would you like to continue with that one, or should I save it and restore your other form?`,
        });
        return { success: false };
      }

      // Get stashed sessions
      const stashed = await formService.getStashedSessions(entityId);

      if (stashed.length === 0) {
        await callback?.({
          text: "You don't have any saved forms to resume.",
        });
        return { success: false };
      }

      // Restore the most recent stashed session
      // WHY most recent: User likely wants what they just stashed
      // TODO: Let user choose if multiple
      const sessionToRestore = stashed.sort(
        (a, b) => b.updatedAt - a.updatedAt,
      )[0];
      const session = await formService.restore(sessionToRestore.id, entityId);

      const form = formService.getForm(session.formId);
      const context = formService.getSessionContext(session);

      // Generate response with restored context
      // WHY immediate response: User knows what happened
      let responseText = `I've restored your "${form?.name || session.formId}" form. `;
      responseText += `You're ${context.progress}% complete. `;

      if (context.filledFields.length > 0) {
        responseText += `\n\nHere's what I have so far:\n`;
        for (const field of context.filledFields) {
          responseText += `• ${field.label}: ${field.displayValue}\n`;
        }
      }

      if (context.nextField) {
        responseText += `\nLet's continue with ${context.nextField.label}.`;
        if (context.nextField.askPrompt) {
          responseText += ` ${context.nextField.askPrompt}`;
        }
      } else if (context.status === "ready") {
        responseText += `\nEverything looks complete! Ready to submit?`;
      }

      await callback?.({
        text: responseText,
      });

      return {
        success: true,
        data: {
          sessionId: session.id,
          formId: session.formId,
          progress: context.progress,
        },
      };
    } catch (error) {
      logger.error("[FormRestoreAction] Handler error:", String(error));
      await callback?.({
        text: "Sorry, I couldn't restore your form. Please try again.",
      });
      return { success: false };
    }
  },

  // Example conversations for training/documentation
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Resume my form" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I've restored your form. Let's continue where you left off.",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Continue with my registration" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I've restored your Registration form. You're 60% complete.",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Pick up where I left off" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I've restored your form. Here's what you have so far...",
        },
      },
    ],
  ],
};

export default formRestoreAction;
