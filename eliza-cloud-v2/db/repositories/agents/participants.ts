/**
 * Repository for elizaOS participants table.
 *
 * Handles all database operations for participants without spinning up runtime.
 */

import { dbRead, dbWrite } from "@/db/helpers";
import { participantTable } from "@/db/schemas/eliza";
import { eq, and, inArray, sql } from "drizzle-orm";
import type { Participant } from "@elizaos/core";

/**
 * Input for creating a new participant.
 */
export interface CreateParticipantInput {
  roomId: string;
  entityId: string;
  agentId: string;
  roomState?: Record<string, unknown>;
}

/**
 * Repository for elizaOS participant database operations.
 */
export class ParticipantsRepository {
  // ============================================================================
  // READ OPERATIONS (use read replica)
  // ============================================================================

  /**
   * Gets all participants for a room.
   */
  async findByRoomId(roomId: string): Promise<Participant[]> {
    const results = await dbRead
      .select()
      .from(participantTable)
      .where(eq(participantTable.roomId, roomId));

    return results;
  }

  /**
   * Gets all room IDs for an entity (user).
   *
   * @param entityId - User's database ID (UUID).
   */
  async findRoomsByEntityId(entityId: string): Promise<string[]> {
    const results = await dbRead
      .select({ roomId: participantTable.roomId })
      .from(participantTable)
      .where(eq(participantTable.entityId, entityId));

    return results.map((r) => r.roomId);
  }

  /**
   * Gets all room IDs for multiple entities.
   *
   * @returns Map of entity ID to array of room IDs.
   */
  async findRoomsByEntityIds(
    entityIds: string[],
  ): Promise<Map<string, string[]>> {
    if (entityIds.length === 0) return new Map();

    const results = await dbRead
      .select({
        entityId: participantTable.entityId,
        roomId: participantTable.roomId,
      })
      .from(participantTable)
      .where(inArray(participantTable.entityId, entityIds));

    const map = new Map<string, string[]>();
    for (const result of results) {
      const existing = map.get(result.entityId) || [];
      existing.push(result.roomId);
      map.set(result.entityId, existing);
    }

    return map;
  }

  /**
   * Checks if an entity is a participant in a room.
   */
  async isParticipant(roomId: string, entityId: string): Promise<boolean> {
    const result = await dbRead
      .select({ id: participantTable.id })
      .from(participantTable)
      .where(
        and(
          eq(participantTable.roomId, roomId),
          eq(participantTable.entityId, entityId),
        ),
      )
      .limit(1);

    return result.length > 0;
  }

  /**
   * Counts participants in a room.
   */
  async countByRoomId(roomId: string): Promise<number> {
    const result = await dbRead
      .select({ count: sql<number>`count(*)` })
      .from(participantTable)
      .where(eq(participantTable.roomId, roomId));

    return Number(result[0]?.count || 0);
  }

  /**
   * Gets all entity IDs for a room.
   */
  async getEntityIdsByRoomId(roomId: string): Promise<string[]> {
    const results = await dbRead
      .select({ entityId: participantTable.entityId })
      .from(participantTable)
      .where(eq(participantTable.roomId, roomId));

    return results.map((r) => r.entityId);
  }

  // ============================================================================
  // WRITE OPERATIONS (use NA primary)
  // ============================================================================

  /**
   * Adds a participant to a room.
   *
   * @param input - Participant creation input (entityId should be user's database UUID).
   * @returns Existing participant if already present, otherwise new participant.
   */
  async create(input: CreateParticipantInput): Promise<Participant> {
    // Check if already exists
    const exists = await this.isParticipant(input.roomId, input.entityId);
    if (exists) {
      // Return existing participant - use dbWrite to avoid replication lag
      const existing = await dbWrite
        .select()
        .from(participantTable)
        .where(
          and(
            eq(participantTable.roomId, input.roomId),
            eq(participantTable.entityId, input.entityId),
          ),
        )
        .limit(1);
      return existing[0];
    }

    const [participant] = await dbWrite
      .insert(participantTable)
      .values({
        roomId: input.roomId,
        entityId: input.entityId,
        agentId: input.agentId,
        roomState: input.roomState,
        createdAt: new Date(),
      })
      .returning();

    return participant;
  }

  /**
   * Removes a participant from a room.
   *
   * @returns True if participant was removed, false if not found.
   */
  async delete(roomId: string, entityId: string): Promise<boolean> {
    const result = await dbWrite
      .delete(participantTable)
      .where(
        and(
          eq(participantTable.roomId, roomId),
          eq(participantTable.entityId, entityId),
        ),
      )
      .returning({ id: participantTable.id });

    return result.length > 0;
  }

  /**
   * Deletes all participants for a room (when deleting room).
   *
   * @returns Number of participants deleted.
   */
  async deleteByRoomId(roomId: string): Promise<number> {
    const result = await dbWrite
      .delete(participantTable)
      .where(eq(participantTable.roomId, roomId))
      .returning({ id: participantTable.id });

    return result.length;
  }

  /**
   * Updates a participant's room state.
   */
  async updateRoomState(
    roomId: string,
    entityId: string,
    roomState: Record<string, unknown>,
  ): Promise<Participant> {
    const [participant] = await dbWrite
      .update(participantTable)
      .set({ roomState })
      .where(
        and(
          eq(participantTable.roomId, roomId),
          eq(participantTable.entityId, entityId),
        ),
      )
      .returning();

    return participant;
  }
}

/**
 * Singleton instance of ParticipantsRepository.
 */
export const participantsRepository = new ParticipantsRepository();
