/**
 * @module actions/restore
 * @description Planner action for restoring stashed form sessions.
 *
 * Restore is a planner-driven Action (not part of the post-message form
 * evaluator) because the restored form context must reach the provider
 * BEFORE the agent generates its response. If the user has an active form
 * in the current room, the action asks them to continue or stash the
 * current one. Multiple stashed forms restore the most recent.
 */

import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import type { FormService } from "../service";

const RESTORE_FIELD_LIMIT = 12;
const RESTORE_RESPONSE_MAX_CHARS = 4_000;

function truncateRestoreResponse(text: string): string {
  return text.length <= RESTORE_RESPONSE_MAX_CHARS
    ? text
    : `${text.slice(0, RESTORE_RESPONSE_MAX_CHARS)}\n\n[truncated restored form summary]`;
}

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
  contexts: ["tasks", "automation", "memory"],
  contextGate: { anyOf: ["tasks", "automation", "memory"] },
  roleGate: { minRole: "USER" },
  similes: ["RESUME_FORM", "CONTINUE_FORM"],
  description: "Restore a previously stashed form session",
  descriptionCompressed: "Restore stashed form session.",
  parameters: [
    {
      name: "sessionId",
      description: "Optional stashed form session id to restore.",
      required: false,
      schema: { type: "string" },
    },
  ],

  /**
   * Validate: action is selectable whenever the user has stashed sessions
   * and no active form in the current room. The planner picks it via the
   * action description/similes when the user actually wants to resume.
   */
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const formService = runtime.getService("FORM") as FormService;
    if (!formService) return false;

    const entityId = message.entityId as UUID;
    const roomId = message.roomId as UUID;
    if (!entityId || !roomId) return false;

    const stashed = await formService.getStashedSessions(entityId);
    if (stashed.length === 0) return false;

    const active = await formService.getActiveSession(entityId, roomId);
    return active === null;
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

      // Restore the most recent stashed session — the user likely wants what
      // they just stashed.
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
        for (const field of context.filledFields.slice(0, RESTORE_FIELD_LIMIT)) {
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
        text: truncateRestoreResponse(responseText),
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
