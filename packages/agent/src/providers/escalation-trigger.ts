/**
 * Escalation trigger provider.
 *
 * Monitors conditions that may warrant escalating to the owner and injects
 * escalation context into the agent's prompt when triggers are detected.
 *
 * Checks:
 * 1. Active (unresolved) escalation in progress
 * 2. Owner inactive for 24+ hours (only during autonomous agent loops)
 * 3. Pending identity verification relationships for the current entity
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
  UUID,
} from "@elizaos/core";
import { logger, resolveCanonicalOwnerIdForMessage } from "@elizaos/core";
import { hasAdminAccess } from "../security/access.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Urgency = "high" | "medium" | "low";

interface Trigger {
  type: string;
  message: string;
  urgency: Urgency;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hours of owner inactivity before suggesting a check-in. */
const OWNER_INACTIVE_HOURS = 24;

/** Max rooms to scan when checking owner recency. */
const MAX_OWNER_ROOMS = 5;

/** Max messages to fetch per room when checking owner recency. */
const MESSAGES_PER_ROOM = 3;

const URGENCY_ORDER: Record<Urgency, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const EMPTY: ProviderResult = {
  text: "",
  values: { hasEscalationTriggers: false },
  data: {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check when the owner last sent a message across their rooms.
 * Returns 0 if no messages found.
 */
async function findLastOwnerMessageTimestamp(
  runtime: IAgentRuntime,
  ownerEntityId: string,
): Promise<number> {
  const roomIds = await runtime.getRoomsForParticipant(ownerEntityId as UUID);
  if (roomIds.length === 0) return 0;

  // Limit scan breadth
  const targetRoomIds = roomIds.slice(0, MAX_OWNER_ROOMS) as UUID[];

  const memories = await runtime.getMemoriesByRoomIds({
    tableName: "messages",
    roomIds: targetRoomIds,
    limit: MESSAGES_PER_ROOM * MAX_OWNER_ROOMS,
  });

  let latest = 0;
  for (const m of memories) {
    if (
      m.entityId === ownerEntityId &&
      m.createdAt != null &&
      m.createdAt > latest
    ) {
      latest = m.createdAt;
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Trigger checks
// ---------------------------------------------------------------------------

async function checkActiveEscalation(triggers: Trigger[]): Promise<void> {
  try {
    const { EscalationService } = await import("../services/escalation.js");
    const active = EscalationService.getActiveEscalationSync();
    if (active && !active.resolved) {
      triggers.push({
        type: "active_escalation",
        message: `Active escalation in progress (step ${active.currentStep + 1}): "${active.reason}". Channels notified: ${active.channelsSent.join(", ")}. Owner has not responded yet.`,
        urgency: "high",
      });
    }
  } catch (err) {
    logger.debug(
      `[escalation-trigger] Could not check active escalation: ${String(err)}`,
    );
  }
}

async function checkOwnerInactivity(
  runtime: IAgentRuntime,
  message: Memory,
  triggers: Trigger[],
): Promise<void> {
  // Only run during autonomous agent loops (agent talking to itself).
  if (message.entityId !== runtime.agentId) return;

  const ownerEntityId = await resolveCanonicalOwnerIdForMessage(
    runtime,
    message,
  );
  if (!ownerEntityId) return;

  const lastOwnerMessage = await findLastOwnerMessageTimestamp(
    runtime,
    ownerEntityId,
  );
  if (lastOwnerMessage === 0) return;

  const hoursSinceOwner = (Date.now() - lastOwnerMessage) / (1000 * 60 * 60);
  if (hoursSinceOwner > OWNER_INACTIVE_HOURS) {
    triggers.push({
      type: "owner_inactive",
      message: `Owner last seen ${Math.round(hoursSinceOwner)} hours ago. Consider checking in if there are pending items.`,
      urgency: "low",
    });
  }
}

async function checkPendingVerifications(
  runtime: IAgentRuntime,
  message: Memory,
  triggers: Trigger[],
): Promise<void> {
  try {
    const relationships = await runtime.getRelationships({
      entityIds: [message.entityId as string],
      tags: ["identity_link"],
    });
    const pending = relationships.filter((r) => {
      const meta = r.metadata as Record<string, unknown> | undefined;
      return meta?.status === "proposed";
    });
    if (pending.length > 0) {
      triggers.push({
        type: "pending_verifications",
        message: `${pending.length} identity verification(s) pending for the current user. You can ask them to confirm or have an admin verify.`,
        urgency: "medium",
      });
    }
  } catch {
    // Silently skip if relationships unavailable
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const escalationTriggerProvider: Provider =
  createEscalationTriggerProvider();

export function createEscalationTriggerProvider(): Provider {
  return {
    name: "escalationTrigger",
    description:
      "Monitors conditions that may warrant escalating to the owner. Injects escalation context when triggers are detected.",
    descriptionCompressed:
      "monitor condition warrant escalat owner inject escalation context trigger detect",
    dynamic: true,
    position: 15,
    contexts: ["general"],
    contextGate: { anyOf: ["general"] },
    cacheStable: false,
    cacheScope: "turn",
    roleGate: { minRole: "USER" },

    async get(
      runtime: IAgentRuntime,
      message: Memory,
      _state: State,
    ): Promise<ProviderResult> {
      const triggers: Trigger[] = [];
      const isAdminViewer = await hasAdminAccess(runtime, message);

      if (isAdminViewer) {
        await Promise.all([
          checkActiveEscalation(triggers),
          checkOwnerInactivity(runtime, message, triggers),
          checkPendingVerifications(runtime, message, triggers),
        ]);
      } else {
        await checkPendingVerifications(runtime, message, triggers);
      }

      if (triggers.length === 0) {
        return EMPTY;
      }

      const lines = triggers.map(
        (t) => `- [${t.urgency.toUpperCase()}] ${t.message}`,
      );
      const text = `# Escalation Context\n${lines.join("\n")}`;

      const highestUrgency = triggers.reduce<Urgency>((max, t) => {
        return (URGENCY_ORDER[t.urgency] ?? 0) > (URGENCY_ORDER[max] ?? 0)
          ? t.urgency
          : max;
      }, "low");

      return {
        text,
        values: {
          hasEscalationTriggers: true,
          triggerCount: triggers.length,
          highestUrgency,
        },
        data: { triggers },
      };
    },
  };
}
