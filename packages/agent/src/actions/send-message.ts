import type {
  Action,
  ActionResult,
  Content,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import {
  logger,
  resolveCanonicalOwnerIdForMessage,
  stringToUuid,
} from "@elizaos/core";
import { hasAdminAccess } from "../security/access.js";
import { hasContextSignalSyncForKey, messageText } from "./context-signal.js";

type MessageTransportService = {
  sendDirectMessage?: (
    targetEntityId: string,
    content: Content,
  ) => Promise<void>;
  sendRoomMessage?: (targetRoomId: string, content: Content) => Promise<void>;
};

type SendMessageParams = {
  targetType?: "user" | "room";
  source?: string;
  target?: string;
  text?: string;
  urgency?: "normal" | "important" | "urgent";
};

const ADMIN_TARGETS = new Set(["admin", "owner"]);
const VALID_URGENCIES = new Set(["normal", "important", "urgent"]);

// ---------------------------------------------------------------------------
// Admin pathway helpers (absorbed from send-admin-message.ts)
// ---------------------------------------------------------------------------

/**
 * Resolve the admin/owner entity ID.
 *
 * Priority:
 * 1. World ownership metadata (room-aware path -- mirrors admin-trust provider)
 * 2. Deterministic fallback from agent name (mirrors chat-routes / lifeops service)
 */
export async function resolveAdminEntityId(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<UUID> {
  const ownerId = await resolveCanonicalOwnerIdForMessage(runtime, message);
  if (ownerId) {
    return ownerId as UUID;
  }

  const agentName = runtime.character?.name ?? runtime.agentId;
  return stringToUuid(`${agentName}-admin-entity`) as UUID;
}

/**
 * Handle sending a message to the admin/owner, optionally with urgency
 * escalation.
 */
async function handleAdminMessage(
  runtime: IAgentRuntime,
  message: Memory,
  text: string,
  urgency: string,
): Promise<ActionResult> {
  const adminEntityId = await resolveAdminEntityId(runtime, message);

  // Urgent messages trigger multi-channel escalation (fire-and-forget --
  // the primary send below still runs for immediate delivery).
  if (urgency === "urgent") {
    try {
      const { EscalationService } = await import("../services/escalation.js");
      await EscalationService.startEscalation(
        runtime,
        "urgent admin message",
        text,
      );
    } catch (escErr: unknown) {
      logger.warn("[SEND_MESSAGE] Escalation start failed:", String(escErr));
    }
  }

  try {
    await runtime.sendMessageToTarget(
      { source: "client_chat", entityId: adminEntityId } as Parameters<
        typeof runtime.sendMessageToTarget
      >[0],
      { text, source: "client_chat", metadata: { urgency } },
    );
  } catch (err: unknown) {
    logger.error(
      `[SEND_MESSAGE] Failed to send to admin ${adminEntityId}:`,
      String(err),
    );
    return {
      text: "Failed to send message to admin. The Eliza app may not be connected.",
      success: false,
      values: { success: false, error: "SEND_FAILED" },
      data: { actionName: "SEND_MESSAGE", targetType: "admin", urgency },
    };
  }

  return {
    text: `Message sent to admin${urgency === "urgent" ? " (URGENT)" : ""}.`,
    success: true,
    values: { success: true, urgency },
    data: { actionName: "SEND_MESSAGE", targetType: "admin", urgency },
  };
}

/**
 * Detect whether the params indicate an admin/owner target.
 */
function isAdminTarget(params: SendMessageParams): boolean {
  const { target, source } = params;
  if (target && ADMIN_TARGETS.has(target.toLowerCase())) return true;
  if (source && ADMIN_TARGETS.has(source.toLowerCase())) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Unified SEND_MESSAGE action
// ---------------------------------------------------------------------------

export const sendMessageAction: Action = {
  name: "SEND_MESSAGE",
  similes: [
    "DM",
    "MESSAGE",
    "SEND_DM",
    "POST_MESSAGE",
    // Absorbed from SEND_ADMIN_MESSAGE:
    "MESSAGE_ADMIN",
    "NOTIFY_OWNER",
    "ALERT_ADMIN",
    "SEND_OWNER_MESSAGE",
  ],
  description:
    "Send a message to a user, room, or the admin/owner. " +
    "For admin messages, set target to 'admin' or 'owner'. " +
    "Supports urgency levels for admin messages (normal, important, urgent). " +
    "Urgent admin messages trigger multi-channel escalation.",

  validate: async (runtime, message, state) => {
    if (!(await hasAdminAccess(runtime, message))) return false;
    return hasContextSignalSyncForKey(message, state, "send_message");
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasAdminAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner or admins may send routed messages.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: "SEND_MESSAGE" },
      };
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as SendMessageParams;
    const { targetType, source, target, text, urgency } = params;

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return {
        text: "SEND_MESSAGE requires a non-empty text parameter.",
        success: false,
        values: { success: false, error: "INVALID_PARAMETERS" },
        data: { actionName: "SEND_MESSAGE" },
      };
    }

    // ── Admin/owner pathway ───────────────────────────────────────────
    if (isAdminTarget(params)) {
      // Only the agent itself or admin/owner callers may send admin messages
      if (!(await hasAdminAccess(runtime, message))) {
        return {
          text: "Permission denied: only the agent or admin/owner may send admin messages.",
          success: false,
          values: { success: false, error: "PERMISSION_DENIED" },
          data: { actionName: "SEND_MESSAGE" },
        };
      }

      const adminUrgency = urgency ?? "normal";
      if (!VALID_URGENCIES.has(adminUrgency)) {
        return {
          text: `SEND_MESSAGE urgency must be one of: normal, important, urgent. Got "${adminUrgency}".`,
          success: false,
          values: { success: false, error: "INVALID_PARAMETERS" },
          data: { actionName: "SEND_MESSAGE" },
        };
      }
      return handleAdminMessage(runtime, message, text.trim(), adminUrgency);
    }

    // ── Standard service-based send ───────────────────────────────────
    if (!targetType || !source || !target) {
      return {
        text: "SEND_MESSAGE requires targetType, source, and target parameters for non-admin messages.",
        success: false,
        values: { success: false, error: "INVALID_PARAMETERS" },
        data: {
          actionName: "SEND_MESSAGE",
          targetType: targetType ?? null,
          source: source ?? null,
          target: target ?? null,
        },
      };
    }

    const service = runtime.getService(
      source,
    ) as MessageTransportService | null;
    if (!service) {
      return {
        text: `Message service '${source}' is not available.`,
        success: false,
        values: { success: false, error: "SERVICE_NOT_FOUND" },
        data: { actionName: "SEND_MESSAGE", targetType, source, target },
      };
    }

    if (targetType === "user") {
      if (!service.sendDirectMessage) {
        return {
          text: `Direct messaging is not supported by '${source}'.`,
          success: false,
          values: { success: false, error: "DIRECT_MESSAGE_UNSUPPORTED" },
          data: { actionName: "SEND_MESSAGE", targetType, source, target },
        };
      }
      await service.sendDirectMessage(target, { text: text.trim(), source });
      return {
        text: `Message sent to user ${target} on ${source}.`,
        success: true,
        values: { success: true, targetType, source, target },
        data: {
          actionName: "SEND_MESSAGE",
          targetType,
          source,
          target,
          text: text.trim(),
        },
      };
    }

    if (!service.sendRoomMessage) {
      return {
        text: `Room messaging is not supported by '${source}'.`,
        success: false,
        values: { success: false, error: "ROOM_MESSAGE_UNSUPPORTED" },
        data: { actionName: "SEND_MESSAGE", targetType, source, target },
      };
    }
    await service.sendRoomMessage(target, { text: text.trim(), source });
    return {
      text: `Message sent to room ${target} on ${source}.`,
      success: true,
      values: { success: true, targetType, source, target },
      data: {
        actionName: "SEND_MESSAGE",
        targetType,
        source,
        target,
        text: text.trim(),
      },
    };
  },

  parameters: [
    {
      name: "targetType",
      description:
        "Target entity type: user or room. Not required when target is 'admin' or 'owner'.",
      required: false,
      schema: { type: "string" as const, enum: ["user", "room"] },
    },
    {
      name: "source",
      description:
        "Messaging source/service name (e.g. telegram, discord). Not required when target is 'admin' or 'owner'.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "target",
      description:
        "Target identifier. Use 'admin' or 'owner' for admin messages. " +
        "For users: entity ID/username. For rooms: room ID/name.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "text",
      description: "Message text to send.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "urgency",
      description:
        'Message urgency level (admin messages only). Defaults to "normal". ' +
        'Use "urgent" for time-sensitive alerts that trigger multi-channel escalation.',
      required: false,
      schema: {
        type: "string" as const,
        enum: ["normal", "important", "urgent"],
      },
    },
  ],
};
