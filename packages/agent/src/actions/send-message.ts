import type {
  Action,
  ActionExample,
  ActionResult,
  Content,
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
import {
  formatContactCandidates,
  resolveContact,
  resolveContactCandidates,
} from "./connector-resolver.js";
import { hasContextSignalSyncForKey } from "./context-signal.js";

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
  /** Person name for rolodex resolution (alternative to explicit target). */
  recipient?: string;
  /** Platform hint for rolodex resolution. */
  platform?: string;
};

const ADMIN_TARGETS = new Set(["admin", "owner"]);
const VALID_URGENCIES = new Set(["normal", "important", "urgent"]);

// ---------------------------------------------------------------------------
// Admin pathway helpers
// ---------------------------------------------------------------------------

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

async function handleAdminMessage(
  runtime: IAgentRuntime,
  message: Memory,
  text: string,
  urgency: string,
): Promise<ActionResult> {
  const adminEntityId = await resolveAdminEntityId(runtime, message);

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

function isAdminTarget(params: SendMessageParams): boolean {
  const { target, source } = params;
  if (target && ADMIN_TARGETS.has(target.toLowerCase())) return true;
  if (source && ADMIN_TARGETS.has(source.toLowerCase())) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Rolodex-based send pathway
// ---------------------------------------------------------------------------

async function handleRolodexSend(
  runtime: IAgentRuntime,
  recipientName: string,
  text: string,
  platformHint?: string,
): Promise<ActionResult> {
  // Resolve contact via rolodex
  const resolved = await resolveContact(runtime, recipientName, platformHint);

  if (!resolved) {
    // Try to get candidates for disambiguation
    const candidates = await resolveContactCandidates(runtime, recipientName);
    if (candidates.length > 0) {
      return {
        text:
          `Found ${candidates.length} contacts matching "${recipientName}" but none have a reachable platform:\n` +
          formatContactCandidates(candidates) +
          "\nSpecify a platform or use a more specific name.",
        success: false,
        values: { success: false, error: "NO_REACHABLE_PLATFORM" },
        data: {
          actionName: "SEND_MESSAGE",
          recipient: recipientName,
          candidateCount: candidates.length,
        },
      };
    }

    return {
      text: `No contacts found matching "${recipientName}" in the Rolodex. Use SEARCH_ENTITY to find contacts.`,
      success: false,
      values: { success: false, error: "CONTACT_NOT_FOUND" },
      data: { actionName: "SEND_MESSAGE", recipient: recipientName },
    };
  }

  if (!resolved.recommendedPlatform) {
    return {
      text:
        `Found ${resolved.person.displayName} in the Rolodex, but no connected platform is available to reach them.\n` +
        `Known platforms: ${resolved.person.platforms.join(", ") || "none"}.\n` +
        `Active connectors: check that the relevant connector is configured and running.`,
      success: false,
      values: { success: false, error: "NO_ACTIVE_CONNECTOR" },
      data: {
        actionName: "SEND_MESSAGE",
        recipient: recipientName,
        resolvedName: resolved.person.displayName,
        knownPlatforms: resolved.person.platforms,
      },
    };
  }

  // Multiple reachable platforms and no clear preference — inform the user
  // which platform we're using
  const platform = resolved.recommendedPlatform;
  const entityId = resolved.platformEntityIds.get(platform);

  if (!entityId) {
    return {
      text: `Could not resolve entity ID for ${resolved.person.displayName} on ${platform}.`,
      success: false,
      values: { success: false, error: "ENTITY_RESOLUTION_FAILED" },
      data: { actionName: "SEND_MESSAGE", recipient: recipientName, platform },
    };
  }

  try {
    await runtime.sendMessageToTarget(
      { source: platform, entityId } as Parameters<
        typeof runtime.sendMessageToTarget
      >[0],
      {
        text,
        source: platform,
        metadata: {
          resolvedFrom: recipientName,
          resolvedPerson: resolved.person.displayName,
        },
      },
    );
  } catch (err: unknown) {
    logger.error(
      `[SEND_MESSAGE] Failed to send to ${resolved.person.displayName} on ${platform}:`,
      String(err),
    );
    return {
      text: `Failed to send message to ${resolved.person.displayName} on ${platform}: ${err instanceof Error ? err.message : String(err)}`,
      success: false,
      values: { success: false, error: "SEND_FAILED" },
      data: {
        actionName: "SEND_MESSAGE",
        recipient: recipientName,
        platform,
        entityId,
      },
    };
  }

  const platformNote =
    resolved.reachablePlatforms.length > 1
      ? ` (also reachable on: ${resolved.reachablePlatforms.filter((p) => p !== platform).join(", ")})`
      : "";

  return {
    text: `Message sent to ${resolved.person.displayName} on ${platform}${platformNote}.`,
    success: true,
    values: {
      success: true,
      recipient: resolved.person.displayName,
      platform,
      entityId,
    },
    data: {
      actionName: "SEND_MESSAGE",
      recipient: recipientName,
      resolvedName: resolved.person.displayName,
      platform,
      entityId,
      reachablePlatforms: resolved.reachablePlatforms,
      text,
    },
  };
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
    "TEXT_SOMEONE",
    "MESSAGE_SOMEONE",
    // Admin pathway:
    "MESSAGE_ADMIN",
    "NOTIFY_OWNER",
    "ALERT_ADMIN",
    "SEND_OWNER_MESSAGE",
  ],
  description:
    "Send a message to a person, room, or the admin/owner. " +
    "Use 'recipient' with a person's name to resolve via the Rolodex — " +
    "the agent will find the right platform and handle automatically. " +
    "For admin messages, set target to 'admin' or 'owner'. " +
    "For explicit routing, provide source + target + targetType directly. " +
    "Supports urgency levels for admin messages (normal, important, urgent).",

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
    const { targetType, source, target, text, urgency, recipient, platform } =
      params;

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

    // ── Rolodex-based send (recipient name resolution) ────────────────
    if (recipient && typeof recipient === "string" && recipient.trim()) {
      return handleRolodexSend(
        runtime,
        recipient.trim(),
        text.trim(),
        platform,
      );
    }

    // ── Explicit service-based send ───────────────────────────────────
    if (!targetType || !source || !target) {
      return {
        text:
          "SEND_MESSAGE requires either 'recipient' (person name for Rolodex lookup) " +
          "or explicit 'targetType' + 'source' + 'target' parameters.",
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
      // Fall back to runtime.sendMessageToTarget which uses registered send handlers
      try {
        await runtime.sendMessageToTarget(
          { source, entityId: target as UUID } as Parameters<
            typeof runtime.sendMessageToTarget
          >[0],
          { text: text.trim(), source },
        );
        return {
          text: `Message sent to ${targetType} ${target} on ${source}.`,
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
      } catch {
        return {
          text: `Message service '${source}' is not available.`,
          success: false,
          values: { success: false, error: "SERVICE_NOT_FOUND" },
          data: { actionName: "SEND_MESSAGE", targetType, source, target },
        };
      }
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
      name: "recipient",
      description:
        "Person's name for Rolodex-based resolution. The agent will automatically find " +
        "the right platform and handle. Preferred over explicit target/source.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "platform",
      description:
        'Platform hint for Rolodex resolution (e.g. "telegram", "discord", "signal"). ' +
        "Optional — omit to let the agent pick the best platform.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "text",
      description: "Message text to send.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "targetType",
      description:
        "Target entity type: user or room. Only needed for explicit routing (not Rolodex).",
      required: false,
      schema: { type: "string" as const, enum: ["user", "room"] },
    },
    {
      name: "source",
      description:
        "Messaging source/service name (e.g. telegram, discord). Only needed for explicit routing.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "target",
      description:
        "Target identifier. Use 'admin' or 'owner' for admin messages. " +
        "For users: entity ID/username. For rooms: room ID/name. Only needed for explicit routing.",
      required: false,
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
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Tell Jill I'm running 10 minutes late.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Message sent to Jill Park on telegram.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Drop a quick note in the #announcements room that the release is out.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Message sent to room announcements on discord.",
        },
      },
    ],
  ] as ActionExample[][],
};
