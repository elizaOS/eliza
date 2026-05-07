import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import {
  logger,
  resolveCanonicalOwnerIdForMessage,
  stringToUuid,
} from "@elizaos/core";
import { hasAdminAccess } from "../security/access.js";
import { hasContextSignalSyncForKey } from "./context-signal.js";

type SendAdminMessageParams = {
  text?: string;
  urgency?: "normal" | "important" | "urgent";
};

const VALID_URGENCIES = new Set(["normal", "important", "urgent"]);

/**
 * Resolve the admin/owner entity ID.
 *
 * Priority:
 * 1. World ownership metadata (room-aware path — mirrors admin-trust provider)
 * 2. Deterministic fallback from agent name (mirrors chat-routes / lifeops service)
 */
async function resolveAdminEntityId(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<UUID> {
  const ownerId = await resolveCanonicalOwnerIdForMessage(runtime, message);
  if (ownerId) {
    return ownerId as UUID;
  }

  // Deterministic fallback (same as chat-routes ensureAdminEntityIdForChat
  // and lifeops service defaultOwnerEntityId)
  const agentName = runtime.character?.name ?? runtime.agentId;
  return stringToUuid(`${agentName}-admin-entity`) as UUID;
}

export const sendAdminMessageAction: Action = {
  name: "SEND_ADMIN_MESSAGE",
  contexts: ["admin", "messaging", "agent_internal"],
  roleGate: { minRole: "ADMIN" },
  similes: [
    "MESSAGE_ADMIN",
    "NOTIFY_OWNER",
    "ALERT_ADMIN",
    "SEND_OWNER_MESSAGE",
  ],
  description:
    "Send a message to the owner/admin via their Eliza app. Use when you need to notify, alert, or communicate with the owner.",
  descriptionCompressed:
    "send message owner/admin via Eliza app use need notify, alert, communicate w/ owner",

  validate: async (runtime, message, state) => {
    if (!(await hasAdminAccess(runtime, message))) return false;
    return hasContextSignalSyncForKey(message, state, "send_admin_message");
  },

  handler: async (runtime, message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | SendAdminMessageParams
      | undefined;
    const text = params?.text;
    const urgency = params?.urgency ?? "normal";

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return {
        text: "SEND_ADMIN_MESSAGE requires a non-empty text parameter.",
        success: false,
        values: { success: false, error: "INVALID_PARAMETERS" },
        data: { actionName: "SEND_ADMIN_MESSAGE" },
      };
    }

    if (!VALID_URGENCIES.has(urgency)) {
      return {
        text: `SEND_ADMIN_MESSAGE urgency must be one of: normal, important, urgent. Got "${urgency}".`,
        success: false,
        values: { success: false, error: "INVALID_PARAMETERS" },
        data: { actionName: "SEND_ADMIN_MESSAGE" },
      };
    }

    const adminEntityId = await resolveAdminEntityId(runtime, message);

    // Urgent messages trigger multi-channel escalation (fire-and-forget —
    // the primary send below still runs for immediate delivery).
    if (urgency === "urgent") {
      try {
        const { EscalationService } = await import("../services/escalation.js");
        await EscalationService.startEscalation(
          runtime,
          "urgent admin message",
          text.trim(),
        );
      } catch (escErr) {
        logger.warn(
          "[SEND_ADMIN_MESSAGE] Escalation start failed:",
          escErr instanceof Error ? escErr.message : String(escErr),
        );
      }
    }

    try {
      await runtime.sendMessageToTarget(
        // TargetInfo — source drives the send handler lookup
        { source: "client_chat", entityId: adminEntityId } as Parameters<
          typeof runtime.sendMessageToTarget
        >[0],
        { text: text.trim(), source: "client_chat", metadata: { urgency } },
      );
    } catch (err) {
      logger.error(
        `[SEND_ADMIN_MESSAGE] Failed to send to admin ${adminEntityId}:`,
        err instanceof Error ? err.message : String(err),
      );
      return {
        text: "Failed to send message to admin. The Eliza app may not be connected.",
        success: false,
        values: { success: false, error: "SEND_FAILED" },
        data: { actionName: "SEND_ADMIN_MESSAGE", urgency },
      };
    }

    return {
      text: `Message sent to admin${urgency === "urgent" ? " (URGENT)" : ""}.`,
      success: true,
      values: { success: true, urgency },
      data: { actionName: "SEND_ADMIN_MESSAGE", urgency },
    };
  },

  parameters: [
    {
      name: "text",
      description: "The message text to send to the admin/owner.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "urgency",
      description:
        'Message urgency level. Defaults to "normal". Use "urgent" for time-sensitive alerts.',
      required: false,
      schema: {
        type: "string" as const,
        enum: ["normal", "important", "urgent"],
      },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Let the owner know the deploy just finished cleanly.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Message sent to admin.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Alert the owner right now — the webhook is returning 500s.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Message sent to admin (URGENT).",
        },
      },
    ],
  ] as ActionExample[][],
};
