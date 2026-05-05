/**
 * Conversation proximity relationship updates.
 *
 * When a message arrives, look at the last N messages in the same room.
 * For each unique sender who posted recently, create or strengthen the
 * relationship between them and the current sender. This is deterministic
 * (no LLM calls) and lightweight — designed to run on every message.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";

/** How many recent messages to look back at for co-participants. */
const PROXIMITY_WINDOW_SIZE = 10;

/** Maximum age (ms) for a message to count as "recent" — 5 minutes. */
const PROXIMITY_MAX_AGE_MS = 5 * 60 * 1000;

/** Strength increment per co-occurring message pair. */
const STRENGTH_INCREMENT = 0.02;

/** Maximum relationship strength. */
const STRENGTH_MAX = 1.0;

/** Minimum strength to avoid creating noise relationships. */
const STRENGTH_FLOOR = 0.1;

interface ProximityPair {
  entityA: UUID;
  entityB: UUID;
  /** Number of recent messages shared in the window. */
  coOccurrences: number;
}

/**
 * Given a new message, find co-participants in the recent conversation and
 * return the pairs that should have their relationships updated.
 */
export async function findProximityPairs(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<ProximityPair[]> {
  const senderEntityId = message.entityId as UUID | undefined;
  const roomId = message.roomId as UUID | undefined;
  const agentId = runtime.agentId as UUID;

  if (!senderEntityId || !roomId) return [];
  // Don't create relationships for the agent talking to itself.
  if (senderEntityId === agentId) return [];

  const recentMessages = await runtime.getMemories({
    roomId,
    tableName: "messages",
    limit: PROXIMITY_WINDOW_SIZE + 1, // +1 because the current msg may be included
  });

  const now = message.createdAt ?? Date.now();
  const cutoff = now - PROXIMITY_MAX_AGE_MS;

  // Count how many recent messages each unique entity sent.
  const entityMessageCounts = new Map<string, number>();
  for (const m of recentMessages) {
    const eid = m.entityId as string | undefined;
    if (!eid) continue;
    if (eid === senderEntityId) continue; // skip the sender themselves
    if (eid === agentId) continue; // skip the agent
    if ((m.createdAt ?? 0) < cutoff) continue; // too old
    entityMessageCounts.set(eid, (entityMessageCounts.get(eid) ?? 0) + 1);
  }

  const pairs: ProximityPair[] = [];
  for (const [entityId, count] of entityMessageCounts) {
    // Normalize so entityA < entityB for consistent ordering.
    const [entityA, entityB] =
      senderEntityId < entityId
        ? [senderEntityId, entityId as UUID]
        : [entityId as UUID, senderEntityId];
    pairs.push({ entityA, entityB, coOccurrences: count });
  }

  return pairs;
}

/**
 * Update relationships for all proximity pairs found from a new message.
 * Creates new relationships or increments strength on existing ones.
 */
export async function updateProximityRelationships(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<number> {
  const pairs = await findProximityPairs(runtime, message);
  if (pairs.length === 0) return 0;

  let updated = 0;

  for (const pair of pairs) {
    const existing = await runtime.getRelationships({
      entityIds: [pair.entityA],
    });

    const relationship = existing.find(
      (r) =>
        (r.sourceEntityId === pair.entityA &&
          r.targetEntityId === pair.entityB) ||
        (r.sourceEntityId === pair.entityB &&
          r.targetEntityId === pair.entityA),
    );

    if (relationship) {
      // Increment strength based on co-occurrences.
      const meta = { ...(relationship.metadata ?? {}) };
      const currentStrength =
        typeof meta.strength === "number" ? meta.strength : 0.5;
      const increment = STRENGTH_INCREMENT * pair.coOccurrences;
      const newStrength = Math.min(currentStrength + increment, STRENGTH_MAX);

      const currentCount =
        typeof meta.interactionCount === "number" ? meta.interactionCount : 0;

      await runtime.updateRelationship({
        ...relationship,
        tags: [
          ...new Set([
            ...(relationship.tags ?? []),
            "relationships",
            "conversation",
          ]),
        ],
        metadata: {
          ...meta,
          strength: newStrength,
          interactionCount: currentCount + 1,
          lastInteractionAt: new Date().toISOString(),
        },
      });
      updated++;
    } else {
      // Create a new conversation-based relationship.
      await runtime.createRelationship({
        sourceEntityId: pair.entityA,
        targetEntityId: pair.entityB,
        tags: ["relationships", "conversation", "shared_room"],
        metadata: {
          sentiment: "neutral",
          autoDetected: true,
          strength: STRENGTH_FLOOR + STRENGTH_INCREMENT * pair.coOccurrences,
          relationshipType: "acquaintance",
          interactionCount: 1,
          lastInteractionAt: new Date().toISOString(),
        },
      });
      updated++;
    }
  }

  return updated;
}
