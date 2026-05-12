/**
 * Repository for elizaOS rooms table.
 *
 * Handles all database operations for rooms without spinning up runtime.
 */

import type { Room as BaseRoom } from "@elizaos/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import { memoryTable, participantTable, roomTable } from "@/db/schemas/eliza";
import { userCharacters } from "@/db/schemas/user-characters";

/**
 * Room type from elizaOS core.
 */
export type Room = BaseRoom;

/**
 * Room metadata with locked state.
 */
export interface RoomMetadata {
  locked?: boolean;
  createdCharacterId?: string;
  createdCharacterName?: string;
  lockedAt?: number;
  createdAt?: number;
  creatorUserId?: string;
  [key: string]: unknown;
}

/**
 * Room with last message preview for sidebar/list views.
 *
 * All data comes from a single optimized query.
 */
export interface RoomWithPreview {
  id: string;
  name: string | null;
  characterId: string | null; // agentId from room
  characterName: string | null; // character name from user_characters
  characterAvatarUrl: string | null; // avatar_url from user_characters
  createdAt: Date;
  lastMessageTime: Date | null;
  lastMessageText: string | null;
  metadata: RoomMetadata | null; // Room metadata including locked state
}

/**
 * Input for creating a new room.
 */
export interface CreateRoomInput {
  id: string;
  agentId?: string; // Optional - can be set later when runtime initializes
  source?: string;
  type?: string;
  name?: string;
  serverId?: string;
  channelId?: string;
  worldId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input for updating a room.
 */
export interface UpdateRoomInput {
  name?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Repository for elizaOS room database operations.
 */
export class RoomsRepository {
  /**
   * Gets a room by ID.
   */
  async findById(roomId: string): Promise<Room | null> {
    const result = await dbRead.select().from(roomTable).where(eq(roomTable.id, roomId)).limit(1);

    return (result[0] || null) as Room | null;
  }

  /**
   * Gets multiple rooms by IDs.
   */
  async findByIds(roomIds: string[]): Promise<Room[]> {
    if (roomIds.length === 0) return [];

    const results = await dbRead.select().from(roomTable).where(inArray(roomTable.id, roomIds));

    return results as Room[];
  }

  /**
   * Finds rooms by agent ID, sorted by last activity.
   */
  async findByAgentId(agentId: string, limit = 50): Promise<Room[]> {
    const results = await dbRead.select().from(roomTable).where(eq(roomTable.agentId, agentId));

    // Sort by lastTime from metadata in memory
    const sorted = results.sort((a, b) => {
      const timeA = (a.metadata?.lastTime as number) || 0;
      const timeB = (b.metadata?.lastTime as number) || 0;
      return timeB - timeA; // Descending
    });

    return sorted.slice(0, limit) as Room[];
  }

  /**
   * Creates a new room.
   *
   * Note: source and type are required in the database (notNull, no defaults).
   */
  async create(input: CreateRoomInput): Promise<Room> {
    const [roomResult] = await dbWrite
      .insert(roomTable)
      .values({
        id: input.id,
        agentId: input.agentId,
        source: input.source || "web",
        type: input.type || "DIRECT",
        name: input.name,
        serverId: input.serverId,
        channelId: input.channelId,
        worldId: input.worldId,
        metadata: input.metadata,
        createdAt: new Date(),
      } as typeof roomTable.$inferInsert)
      .returning();

    return roomResult as Room;
  }

  /**
   * Updates a room.
   */
  async update(roomId: string, input: UpdateRoomInput): Promise<Room> {
    const [room] = await dbWrite
      .update(roomTable)
      .set(input as typeof roomTable.$inferInsert)
      .where(eq(roomTable.id, roomId))
      .returning();

    return room as Room;
  }

  /**
   * Deletes a room.
   */
  async delete(roomId: string): Promise<void> {
    await dbWrite.delete(roomTable).where(eq(roomTable.id, roomId));
  }

  /**
   * Checks if a room exists.
   */
  async exists(roomId: string): Promise<boolean> {
    const result = await dbRead
      .select({ id: roomTable.id })
      .from(roomTable)
      .where(eq(roomTable.id, roomId))
      .limit(1);

    return result.length > 0;
  }

  /**
   * Counts rooms for an agent.
   */
  async countByAgentId(agentId: string): Promise<number> {
    const results = await dbRead.select().from(roomTable).where(eq(roomTable.agentId, agentId));

    return results.length;
  }

  /**
   * Updates room metadata by merging with existing metadata.
   */
  async updateMetadata(roomId: string, metadata: Record<string, unknown>): Promise<void> {
    // Read current metadata
    const room = await this.findById(roomId);
    if (!room) return;

    const currentMetadata = room.metadata || {};

    // Merge and write back
    await dbWrite
      .update(roomTable)
      .set({
        metadata: {
          ...currentMetadata,
          ...metadata,
        } as typeof roomTable.$inferInsert.metadata,
      })
      .where(eq(roomTable.id, roomId));
  }

  /**
   * Gets all rooms for an entity (user) with last message preview.
   *
   * Uses a single optimized query with joins. Returns rooms sorted by most recent activity.
   * Includes character name and avatar from user_characters table.
   *
   * @param entityId - The user's ID (from auth).
   * @returns Rooms with preview data, sorted by most recent activity.
   */
  async findRoomsWithPreviewForEntity(entityId: string): Promise<RoomWithPreview[]> {
    // Use a subquery to get the latest message per room
    const latestMessagesSubquery = dbRead
      .select({
        roomId: memoryTable.roomId,
        createdAt: memoryTable.createdAt,
        text: sql<string | null>`${memoryTable.content}->>'text'`.as("text"),
        // Use row_number to pick the latest message per room
        rn: sql<number>`row_number() over (partition by ${memoryTable.roomId} order by ${memoryTable.createdAt} desc)`.as(
          "rn",
        ),
      })
      .from(memoryTable)
      .where(eq(memoryTable.type, "messages"))
      .as("latest_messages");

    // Main query: join participants -> rooms -> latest messages -> user_characters
    const results = await dbRead
      .select({
        id: roomTable.id,
        name: roomTable.name,
        characterId: roomTable.agentId,
        characterName: userCharacters.name,
        characterAvatarUrl: userCharacters.avatar_url,
        createdAt: roomTable.createdAt,
        lastMessageTime: latestMessagesSubquery.createdAt,
        lastMessageText: latestMessagesSubquery.text,
        metadata: roomTable.metadata,
      })
      .from(participantTable)
      .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
      .leftJoin(
        latestMessagesSubquery,
        and(eq(latestMessagesSubquery.roomId, roomTable.id), eq(latestMessagesSubquery.rn, 1)),
      )
      .leftJoin(userCharacters, eq(roomTable.agentId, userCharacters.id))
      .where(eq(participantTable.entityId, entityId));

    // Sort by last message time, falling back to room creation time
    results.sort((a, b) => {
      const timeA = a.lastMessageTime?.getTime() || a.createdAt.getTime();
      const timeB = b.lastMessageTime?.getTime() || b.createdAt.getTime();
      return timeB - timeA;
    });

    return results as RoomWithPreview[];
  }
}

/**
 * Singleton instance of RoomsRepository.
 */
export const roomsRepository = new RoomsRepository();
