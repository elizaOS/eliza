/**
 * @module actions/form
 * @description Planner action for managing form sessions.
 *
 * Today only `action=restore` is implemented — it rehydrates the most recent
 * stashed form for the current entity. The action is a NOUN-shaped router so
 * future verbs (start / submit / cancel / stash) can land alongside `restore`
 * without minting new top-level action names.
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
  CANONICAL_SUBACTION_KEY,
  DEFAULT_SUBACTION_KEYS,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type JsonValue,
  logger,
  type Memory,
  normalizeSubaction,
  type State,
  type UUID,
} from "@elizaos/core";
import type { FormService } from "../service";

const FORM_SUBACTIONS = ["restore"] as const;
type FormSubaction = (typeof FORM_SUBACTIONS)[number];

const RESTORE_FIELD_LIMIT = 12;
const RESTORE_RESPONSE_MAX_CHARS = 4_000;

function truncateRestoreResponse(text: string): string {
  return text.length <= RESTORE_RESPONSE_MAX_CHARS
    ? text
    : `${text.slice(0, RESTORE_RESPONSE_MAX_CHARS)}\n\n[truncated restored form summary]`;
}

function readFormSubaction(
  options: HandlerOptions | undefined,
): FormSubaction {
  const params = options?.parameters as
    | Record<string, JsonValue | undefined>
    | undefined;
  for (const key of DEFAULT_SUBACTION_KEYS) {
    const normalized = normalizeSubaction(params?.[key]);
    if (
      normalized &&
      (FORM_SUBACTIONS as readonly string[]).includes(normalized)
    ) {
      return normalized as FormSubaction;
    }
  }
  return "restore";
}

async function handleRestore(
  runtime: IAgentRuntime,
  message: Memory,
  callback?: HandlerCallback,
): Promise<ActionResult> {
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
        [CANONICAL_SUBACTION_KEY]: "restore",
      },
    };
  } catch (error) {
    logger.error("[FormAction] restore handler error:", String(error));
    await callback?.({
      text: "Sorry, I couldn't restore your form. Please try again.",
    });
    return { success: false };
  }
}

/**
 * Form Action
 *
 * NOUN-shaped router over form session verbs. Today only `action=restore` is
 * implemented as a fast-path that preempts REPLY to provide immediate
 * restoration with summary.
 *
 * WHY action:
 * - Needs to run BEFORE provider
 * - Must generate immediate response
 * - Context needed for next message
 */
export const formAction: Action = {
  name: "FORM",
  contexts: ["tasks", "automation", "memory"],
  contextGate: { anyOf: ["tasks", "automation", "memory"] },
  roleGate: { minRole: "USER" },
  similes: ["FORM_RESTORE", "RESUME_FORM", "CONTINUE_FORM"],
  description: "Form session router. action=restore rehydrates the most recent stashed form for the current user.",
  descriptionCompressed: "Form session router (restore).",
  parameters: [
    {
      name: "action",
      description:
        "Form verb: restore. Defaults to restore when omitted.",
      required: false,
      schema: {
        type: "string",
        enum: [...FORM_SUBACTIONS],
      },
    },
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
   * Handler: dispatches by `action` to the per-verb handler. Only `restore`
   * is implemented today.
   */
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const subaction = readFormSubaction(options);
    if (subaction === "restore") {
      return handleRestore(runtime, message, callback);
    }
    // No other subactions are implemented yet — readFormSubaction defaults
    // to restore, so this branch is unreachable. Keep an explicit fallback
    // so future subactions can be added without breaking the contract.
    return {
      success: false,
      text: `FORM action=${subaction} not yet implemented`,
      data: {
        actionName: "FORM",
        [CANONICAL_SUBACTION_KEY]: subaction,
        errorCode: "not_implemented",
      },
    };
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

// Back-compat alias for prior canonical export name. Code that already
// imports `formRestoreAction` keeps working; new code should import
// `formAction`.
export const formRestoreAction = formAction;

export default formAction;
