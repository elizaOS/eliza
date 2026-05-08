/**
 * Repository for elizaOS memories table (non-message memories).
 *
 * Handles all database operations for memories without spinning up runtime.
 */

import type { Memory } from "@elizaos/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/helpers";
import { memoryTable } from "@/db/schemas/eliza";

/**
 * Input for creating a new memory.
 */
export interface CreateMemoryInput {
  id: string;
  roomId: string;
  entityId: string;
  agentId: string;
  type: string;
  content: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  unique?: boolean;
  worldId?: string;
}

/**
 * Options for searching memories.
 */
export interface SearchMemoriesOptions {
  roomId?: string;
  agentId: string;
  type?: string;
  types?: string[];
  limit?: number;
  offset?: number;
}

/**
 * Repository for elizaOS memory database operations.
 */
export class MemoriesRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Gets messages for a room (type='messages').
   */
  async findMessages(
    roomId: string,
    options: {
      agentId?: string;
      limit?: number;
      offset?: number;
      afterTimestamp?: number;
      beforeTimestamp?: number;
    } = {},
  ): Promise<Memory[]> {
    const { agentId, limit = 50, offset = 0, afterTimestamp, beforeTimestamp } = options;

    const conditions = [eq(memoryTable.roomId, roomId), eq(memoryTable.type, "messages")];

    if (agentId) {
      conditions.push(eq(memoryTable.agentId, agentId));
    }
    if (afterTimestamp) {
      conditions.push(sql`${memoryTable.createdAt} > ${new Date(afterTimestamp)}`);
    }
    if (beforeTimestamp) {
      conditions.push(sql`${memoryTable.createdAt} < ${new Date(beforeTimestamp)}`);
    }

    const results = await dbRead
      .select()
      .from(memoryTable)
      .where(and(...conditions))
      .orderBy(desc(memoryTable.createdAt))
      .limit(limit)
      .offset(offset);

    return results as Memory[];
  }

  /**
   * Gets messages for multiple rooms.
   */
  async findMessagesByRoomIds(roomIds: string[], agentId?: string, limit = 50): Promise<Memory[]> {
    if (roomIds.length === 0) return [];

    const conditions = [inArray(memoryTable.roomId, roomIds), eq(memoryTable.type, "messages")];

    if (agentId) {
      conditions.push(eq(memoryTable.agentId, agentId));
    }

    const results = await dbRead
      .select()
      .from(memoryTable)
      .where(and(...conditions))
      .orderBy(desc(memoryTable.createdAt))
      .limit(limit);

    return results as Memory[];
  }

  /**
   * Counts messages in a room.
   */
  async countMessages(roomId: string, agentId?: string): Promise<number> {
    const conditions = [eq(memoryTable.roomId, roomId), eq(memoryTable.type, "messages")];

    if (agentId) {
      conditions.push(eq(memoryTable.agentId, agentId));
    }

    const result = await dbRead
      .select({ count: sql<number>`count(*)` })
      .from(memoryTable)
      .where(and(...conditions));

    return Number(result[0]?.count || 0);
  }

  /**
   * Counts messages by agent across all rooms.
   */
  async countMessagesByAgent(agentId: string): Promise<number> {
    const result = await dbRead
      .select({ count: sql<number>`count(*)` })
      .from(memoryTable)
      .where(and(eq(memoryTable.agentId, agentId), eq(memoryTable.type, "messages")));

    return Number(result[0]?.count || 0);
  }

  /**
   * Gets the last message timestamp for an agent.
   */
  async getLastMessageTime(agentId: string): Promise<Date | null> {
    const result = await dbRead
      .select({ createdAt: memoryTable.createdAt })
      .from(memoryTable)
      .where(and(eq(memoryTable.agentId, agentId), eq(memoryTable.type, "messages")))
      .orderBy(desc(memoryTable.createdAt))
      .limit(1);

    return result[0]?.createdAt || null;
  }

  /**
   * Gets memories for a room (excluding messages).
   */
  async findByRoomId(roomId: string, agentId: string, limit = 50, offset = 0): Promise<Memory[]> {
    const results = await dbRead
      .select()
      .from(memoryTable)
      .where(
        and(
          eq(memoryTable.roomId, roomId),
          eq(memoryTable.agentId, agentId),
          sql`${memoryTable.type} != 'messages'`, // Exclude messages
        ),
      )
      .orderBy(desc(memoryTable.createdAt))
      .limit(limit)
      .offset(offset);

    return results as Memory[];
  }

  /**
   * Gets memories by agent across all rooms (excluding messages).
   */
  async findByAgentId(agentId: string, limit = 50, offset = 0): Promise<Memory[]> {
    const results = await dbRead
      .select()
      .from(memoryTable)
      .where(
        and(
          eq(memoryTable.agentId, agentId),
          sql`${memoryTable.type} != 'messages'`, // Exclude messages
        ),
      )
      .orderBy(desc(memoryTable.createdAt))
      .limit(limit)
      .offset(offset);

    return results as Memory[];
  }

  /**
   * Gets a memory by ID.
   */
  async findById(memoryId: string): Promise<Memory | null> {
    const result = await dbRead
      .select()
      .from(memoryTable)
      .where(eq(memoryTable.id, memoryId))
      .limit(1);

    return (result[0] || null) as Memory | null;
  }

  /**
   * Searches memories with filters (excluding messages).
   */
  async search(options: SearchMemoriesOptions): Promise<Memory[]> {
    const { roomId, agentId, type, types, limit = 50, offset = 0 } = options;

    const conditions = [
      eq(memoryTable.agentId, agentId),
      sql`${memoryTable.type} != 'messages'`, // Exclude messages
    ];

    if (roomId) {
      conditions.push(eq(memoryTable.roomId, roomId));
    }

    if (type) {
      conditions.push(eq(memoryTable.type, type));
    } else if (types && types.length > 0) {
      conditions.push(inArray(memoryTable.type, types));
    }

    const results = await dbRead
      .select()
      .from(memoryTable)
      .where(and(...conditions))
      .orderBy(desc(memoryTable.createdAt))
      .limit(limit)
      .offset(offset);

    return results as Memory[];
  }

  /**
   * Counts memories for a room and agent (excluding messages).
   */
  async countByRoomId(roomId: string, agentId: string): Promise<number> {
    const result = await dbRead
      .select({ count: sql<number>`count(*)` })
      .from(memoryTable)
      .where(
        and(
          eq(memoryTable.roomId, roomId),
          eq(memoryTable.agentId, agentId),
          sql`${memoryTable.type} != 'messages'`,
        ),
      );

    return Number(result[0]?.count || 0);
  }

  /**
   * Counts memories by type.
   */
  async countByType(agentId: string, type: string, roomId?: string): Promise<number> {
    const conditions = [eq(memoryTable.agentId, agentId), eq(memoryTable.type, type)];

    if (roomId) {
      conditions.push(eq(memoryTable.roomId, roomId));
    }

    const result = await dbRead
      .select({ count: sql<number>`count(*)` })
      .from(memoryTable)
      .where(and(...conditions));

    return Number(result[0]?.count || 0);
  }

  /**
   * Gets distinct memory types for an agent (excluding messages).
   */
  async getTypes(agentId: string): Promise<string[]> {
    const result = await dbRead
      .selectDistinct({ type: memoryTable.type })
      .from(memoryTable)
      .where(and(eq(memoryTable.agentId, agentId), sql`${memoryTable.type} != 'messages'`));

    return result.map((r) => r.type).filter((t): t is string => t !== null);
  }

  /**
   * Gets the last message for a single room.
   *
   * @returns Raw Memory object or null if no messages found.
   */
  async findLastMessageForRoom(roomId: string): Promise<Memory | null> {
    const result = await dbRead
      .select()
      .from(memoryTable)
      .where(and(eq(memoryTable.roomId, roomId), eq(memoryTable.type, "messages")))
      .orderBy(desc(memoryTable.createdAt))
      .limit(1);

    return (result[0] || null) as Memory | null;
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Deletes all messages in a room.
   *
   * @returns Number of messages deleted.
   */
  async deleteMessages(roomId: string): Promise<number> {
    const result = await dbWrite
      .delete(memoryTable)
      .where(and(eq(memoryTable.roomId, roomId), eq(memoryTable.type, "messages")))
      .returning({ id: memoryTable.id });

    return result.length;
  }

  /**
   * Creates a new memory.
   */
  async create(input: CreateMemoryInput): Promise<Memory> {
    const memoryResult = (await dbWrite
      .insert(memoryTable)
      .values({
        id: input.id,
        roomId: input.roomId,
        entityId: input.entityId,
        agentId: input.agentId,
        type: input.type,
        content: input.content,
        metadata: input.metadata ?? {},
        unique: input.unique ?? false,
        worldId: input.worldId,
        createdAt: new Date(),
      })
      .returning()) as any[];

    return memoryResult[0] as Memory;
  }

  /**
   * Deletes a memory.
   *
   * @returns True if memory was deleted, false if not found.
   */
  async delete(memoryId: string): Promise<boolean> {
    const result = await dbWrite
      .delete(memoryTable)
      .where(eq(memoryTable.id, memoryId))
      .returning({ id: memoryTable.id });

    return result.length > 0;
  }

  async deleteDocumentFragments(documentId: string): Promise<number> {
    const result = await dbWrite
      .delete(memoryTable)
      .where(
        and(
          eq(memoryTable.type, "document_fragments"),
          sql`${memoryTable.metadata}->>'documentId' = ${documentId}`,
        ),
      )
      .returning({ id: memoryTable.id });

    return result.length;
  }

  /**
   * Deletes memories by room (when deleting room).
   *
   * Only deletes non-message memories. Messages are preserved.
   *
   * @returns Number of memories deleted.
   */
  async deleteByRoomId(roomId: string): Promise<number> {
    const result = await dbWrite
      .delete(memoryTable)
      .where(
        and(
          eq(memoryTable.roomId, roomId),
          sql`${memoryTable.type} != 'messages'`, // Only delete non-message memories
        ),
      )
      .returning({ id: memoryTable.id });

    return result.length;
  }

  /**
   * Deletes memories by agent (excluding messages).
   *
   * @returns Number of memories deleted.
   */
  async deleteByAgentId(agentId: string): Promise<number> {
    const result = await dbWrite
      .delete(memoryTable)
      .where(and(eq(memoryTable.agentId, agentId), sql`${memoryTable.type} != 'messages'`))
      .returning({ id: memoryTable.id });

    return result.length;
  }

  /**
   * Deletes old memories based on retention policy.
   *
   * @param agentId - Agent ID to delete memories for.
   * @param days - Minimum age in days for memories to be deleted.
   * @param types - Optional array of memory types to delete (all types if not specified).
   * @returns Number of memories deleted.
   */
  async deleteOlderThan(agentId: string, days: number, types?: string[]): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const conditions = [
      eq(memoryTable.agentId, agentId),
      sql`${memoryTable.createdAt} < ${cutoffDate}`,
      sql`${memoryTable.type} != 'messages'`,
    ];

    if (types && types.length > 0) {
      conditions.push(inArray(memoryTable.type, types));
    }

    const result = await dbWrite
      .delete(memoryTable)
      .where(and(...conditions))
      .returning({ id: memoryTable.id });

    return result.length;
  }
}

/**
 * Singleton instance of MemoriesRepository.
 */
export const memoriesRepository = new MemoriesRepository();
