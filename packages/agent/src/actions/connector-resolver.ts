/**
 * Connector resolver — shared utilities for resolving contacts to platform
 * handles via the Rolodex (relationships graph) and finding conversations
 * with a person across all connected platforms.
 *
 * Used by MESSAGE and POST connector operations.
 *
 * @module actions/connector-resolver
 */

import type { IAgentRuntime, Memory, Room, UUID } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  RelationshipsGraphService,
  RelationshipsPersonSummary,
} from "@elizaos/core/services/relationships-graph-builder";
import { formatSpeakerLabel } from "../shared/conversation-format.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Resolved contact with platform-specific routing information. */
export type ResolvedContact = {
  person: RelationshipsPersonSummary;
  /** Best platform to reach this person (based on preference + availability). */
  recommendedPlatform: string | null;
  /** All platforms where both the contact exists AND we have a running connector. */
  reachablePlatforms: string[];
  /** Map of platform → entity ID for direct addressing. */
  platformEntityIds: Map<string, UUID>;
};

/** A conversation thread with a person on a specific platform. */
export type PersonConversation = {
  platform: string;
  roomId: UUID;
  roomName: string;
  messages: Memory[];
  messageCount: number;
  lastMessageAt: string | null;
};

/** Summary of all conversations with a person across platforms. */
export type CrossPlatformConversationView = {
  person: RelationshipsPersonSummary;
  conversations: PersonConversation[];
  totalMessages: number;
};

// ---------------------------------------------------------------------------
// Service access
// ---------------------------------------------------------------------------

export async function getGraphService(
  runtime: IAgentRuntime,
): Promise<RelationshipsGraphService | null> {
  return (
    (runtime.getService(
      "relationships",
    ) as unknown as RelationshipsGraphService | null) ?? null
  );
}

/** Returns the set of connector source names that have active send handlers. */
export function getActiveConnectors(runtime: IAgentRuntime): Set<string> {
  const active = new Set<string>();
  const rt = runtime as unknown as {
    getMessageConnectors?: () => Array<{ source?: string }>;
    sendHandlers?: Map<string, unknown>;
  };

  if (typeof rt.getMessageConnectors === "function") {
    for (const connector of rt.getMessageConnectors()) {
      if (typeof connector.source === "string" && connector.source.trim()) {
        active.add(connector.source);
      }
    }
    return active;
  }

  // Legacy compatibility: older runtimes only expose the backing sendHandlers map.
  if (rt.sendHandlers) {
    for (const key of rt.sendHandlers.keys()) {
      active.add(key);
    }
  }
  return active;
}

// ---------------------------------------------------------------------------
// Contact resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a person name to a contact with platform routing info.
 *
 * Uses the Rolodex (relationships graph) for lookup — no regex, no string
 * matching. The Rolodex handles fuzzy name/alias matching internally.
 *
 * @returns null if no match found, or a ResolvedContact with the best
 *   person match and their reachable platforms.
 */
export async function resolveContact(
  runtime: IAgentRuntime,
  name: string,
  preferredPlatform?: string,
): Promise<ResolvedContact | null> {
  const graphService = await getGraphService(runtime);
  if (!graphService) {
    logger.warn("[connector-resolver] Relationships service not available");
    return null;
  }

  const snapshot = await graphService.getGraphSnapshot({
    search: name.trim(),
    limit: 5,
  });

  if (!snapshot || snapshot.people.length === 0) {
    return null;
  }

  // Take the best match (first result — the graph service ranks by relevance)
  const person = snapshot.people[0];
  if (!person) {
    return null;
  }
  const activeConnectors = getActiveConnectors(runtime);

  // Build a map of platform → entity ID for each reachable identity
  const platformEntityIds = new Map<string, UUID>();
  for (const identity of person.identities) {
    for (const handle of identity.handles) {
      if (activeConnectors.has(handle.platform)) {
        // Use the identity's entity ID for routing
        if (!platformEntityIds.has(handle.platform)) {
          platformEntityIds.set(handle.platform, identity.entityId as UUID);
        }
      }
    }
  }

  const reachablePlatforms = [...platformEntityIds.keys()];

  // Pick recommended platform
  let recommendedPlatform: string | null = null;

  if (preferredPlatform && reachablePlatforms.includes(preferredPlatform)) {
    recommendedPlatform = preferredPlatform;
  } else if (
    person.preferredCommunicationChannel &&
    reachablePlatforms.includes(person.preferredCommunicationChannel)
  ) {
    recommendedPlatform = person.preferredCommunicationChannel;
  } else if (reachablePlatforms.length > 0) {
    // Pick the first reachable platform (the graph service orders by interaction recency)
    const fallbackPlatform = reachablePlatforms[0];
    if (fallbackPlatform) {
      recommendedPlatform = fallbackPlatform;
    }
  }

  return {
    person,
    recommendedPlatform,
    reachablePlatforms,
    platformEntityIds,
  };
}

/**
 * Resolve a person name and return ALL matching contacts (for disambiguation).
 */
export async function resolveContactCandidates(
  runtime: IAgentRuntime,
  name: string,
  limit = 5,
): Promise<RelationshipsPersonSummary[]> {
  const graphService = await getGraphService(runtime);
  if (!graphService) return [];

  const snapshot = await graphService.getGraphSnapshot({
    search: name.trim(),
    limit,
  });

  return snapshot?.people ?? [];
}

// ---------------------------------------------------------------------------
// Cross-platform conversation view
// ---------------------------------------------------------------------------

/**
 * Get all conversations with a specific person across all platforms.
 *
 * This is the "conversation handoff" view — shows recent messages from
 * every platform where the agent has interacted with this person, so
 * the user can see full context before deciding where to respond.
 */
export async function getPersonConversations(
  runtime: IAgentRuntime,
  person: RelationshipsPersonSummary,
  opts?: { limitPerPlatform?: number },
): Promise<CrossPlatformConversationView> {
  const limitPerPlatform = opts?.limitPerPlatform ?? 15;
  const conversations: PersonConversation[] = [];
  let totalMessages = 0;

  // Collect all entity IDs for this person (across all platforms)
  const entityIds = new Set<string>();
  entityIds.add(person.primaryEntityId);
  for (const id of person.memberEntityIds) {
    entityIds.add(id);
  }

  // Find all rooms where this person participates
  const seenRooms = new Set<string>();

  for (const entityId of entityIds) {
    try {
      const roomIds = await runtime.getRoomsForParticipant(entityId as UUID);
      for (const roomId of roomIds) {
        if (seenRooms.has(roomId)) continue;
        seenRooms.add(roomId);

        const room = await runtime.getRoom(roomId);
        if (!room) continue;

        const roomRecord = room as Room & { name?: string; source?: string };
        const platform = roomRecord.source ?? room.type ?? "unknown";

        // Get recent messages from this room
        const rawMemories = (await runtime.getMemories({
          tableName: "messages",
          roomId: room.id,
          limit: limitPerPlatform,
          orderBy: "createdAt" as const,
          orderDirection: "desc" as const,
        } as Parameters<typeof runtime.getMemories>[0])) as Memory[];

        if (rawMemories.length === 0) continue;

        // Reverse for chronological order
        const messages = rawMemories.reverse();

        const lastMsg = messages[messages.length - 1];
        const lastMessageAt = lastMsg?.createdAt
          ? new Date(lastMsg.createdAt).toISOString()
          : null;

        conversations.push({
          platform,
          roomId: room.id as UUID,
          roomName: roomRecord.name ?? `Room ${room.id.slice(0, 8)}`,
          messages,
          messageCount: messages.length,
          lastMessageAt,
        });

        totalMessages += messages.length;
      }
    } catch (err) {
      logger.debug(
        `[connector-resolver] Error fetching rooms for entity ${entityId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Sort conversations by most recent activity first
  conversations.sort((a, b) => {
    if (!a.lastMessageAt && !b.lastMessageAt) return 0;
    if (!a.lastMessageAt) return 1;
    if (!b.lastMessageAt) return -1;
    return b.lastMessageAt.localeCompare(a.lastMessageAt);
  });

  return { person, conversations, totalMessages };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format a cross-platform conversation view as human-readable text. */
export function formatConversationView(
  runtime: IAgentRuntime,
  view: CrossPlatformConversationView,
): string {
  const sections: string[] = [];

  sections.push(
    `Conversations with ${view.person.displayName} — ` +
      `${view.conversations.length} thread(s), ` +
      `${view.totalMessages} messages across ` +
      `${[...new Set(view.conversations.map((c) => c.platform))].join(", ")}`,
  );
  sections.push("═".repeat(60));

  for (const convo of view.conversations) {
    sections.push(
      `\n▸ [${convo.platform}] ${convo.roomName}` +
        (convo.lastMessageAt
          ? ` — last activity: ${convo.lastMessageAt.slice(0, 19)}`
          : ""),
    );
    sections.push("─".repeat(40));

    for (const [index, mem] of convo.messages.entries()) {
      if (!mem) {
        continue;
      }
      const speaker = formatSpeakerLabel(runtime, mem);
      const ts = mem.createdAt
        ? new Date(mem.createdAt).toISOString().slice(0, 19)
        : "";
      const text = (mem.content?.text ?? "").slice(0, 500);
      sections.push(
        `${String(index + 1).padStart(3, " ")} | ${ts} ${speaker}: ${text}`,
      );
    }
  }

  return sections.join("\n");
}

/**
 * Format a list of resolved contacts for disambiguation display.
 */
export function formatContactCandidates(
  candidates: RelationshipsPersonSummary[],
): string {
  const lines: string[] = [];
  for (const [index, p] of candidates.entries()) {
    if (!p) {
      continue;
    }
    const platforms = p.platforms.join(", ") || "no platforms";
    const aliases =
      p.aliases.length > 0 ? ` (aka ${p.aliases.slice(0, 2).join(", ")})` : "";
    lines.push(
      `${index + 1}. ${p.displayName}${aliases} — ${platforms} — entityId: ${p.primaryEntityId}`,
    );
  }
  return lines.join("\n");
}

/**
 * Find the room ID for a DM/conversation between the agent and an entity
 * on a specific platform.
 */
export async function findRoomForEntity(
  runtime: IAgentRuntime,
  entityId: UUID,
  platform: string,
): Promise<Room | null> {
  try {
    const roomIds = await runtime.getRoomsForParticipant(entityId);
    for (const roomId of roomIds) {
      const room = await runtime.getRoom(roomId);
      if (!room) continue;
      const roomRecord = room as Room & { source?: string };
      if (
        (roomRecord.source ?? room.type ?? "").toLowerCase() ===
        platform.toLowerCase()
      ) {
        return room;
      }
    }
  } catch {
    // Entity may not be in any rooms yet
  }
  return null;
}
