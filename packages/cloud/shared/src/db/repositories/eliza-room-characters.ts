// Persists eliza room characters records for cloud services through the shared DB boundary.
import { count, eq, inArray, sql } from "drizzle-orm";
import { logger } from "../../lib/utils/logger";
import { sqlRows } from "../execute-helpers";
import { dbRead, dbWrite } from "../helpers";
import {
  type ElizaRoomCharacter,
  elizaRoomCharactersTable,
  type NewElizaRoomCharacter,
  userCharacters,
} from "../schemas";

/**
 * Repository for Eliza room-character mapping database operations.
 *
 * Maps elizaOS rooms to user-created characters, allowing each conversation
 * room to use a different character.
 */
export const elizaRoomCharactersRepository = {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Count rooms for a specific user
   */
  async countByUserId(userId: string): Promise<number> {
    const result = await dbRead
      .select({ count: count() })
      .from(elizaRoomCharactersTable)
      .where(eq(elizaRoomCharactersTable.user_id, userId));

    return result[0]?.count ?? 0;
  },

  /**
   * Count rooms for a specific character
   */
  async countByCharacterId(characterId: string): Promise<number> {
    const result = await dbRead
      .select({ count: count() })
      .from(elizaRoomCharactersTable)
      .where(eq(elizaRoomCharactersTable.character_id, characterId));

    return result[0]?.count ?? 0;
  },

  /**
   * Count rooms for multiple characters in one query
   */
  async countByCharacterIds(characterIds: string[]): Promise<Map<string, number>> {
    if (characterIds.length === 0) {
      return new Map();
    }

    const results = await dbRead
      .select({
        character_id: elizaRoomCharactersTable.character_id,
        count: count(),
      })
      .from(elizaRoomCharactersTable)
      .where(inArray(elizaRoomCharactersTable.character_id, characterIds))
      .groupBy(elizaRoomCharactersTable.character_id);

    const countMap = new Map<string, number>();
    for (const result of results) {
      countMap.set(result.character_id, result.count);
    }

    // Fill in 0 for characters with no rooms
    for (const id of characterIds) {
      if (!countMap.has(id)) {
        countMap.set(id, 0);
      }
    }

    return countMap;
  },

  /**
   * Finds character mapping for a room ID.
   *
   * Note: Always fetches from DB (caching disabled for serverless compatibility).
   */
  async findByRoomId(roomId: string): Promise<ElizaRoomCharacter | undefined> {
    const result = await dbRead
      .select()
      .from(elizaRoomCharactersTable)
      .where(eq(elizaRoomCharactersTable.room_id, roomId))
      .limit(1);

    const character = result[0];
    logger.debug("[RoomCharRepo] findByRoomId", {
      roomId,
      characterId: character?.character_id,
    });

    return character;
  },

  /**
   * Resolves the owning organization of a room via its mapped character.
   *
   * `eliza_room_characters.room_id → character_id → user_characters.organization_id`
   * is the authority for which org a conversation room belongs to. Used to
   * confirm a payment-callback channel targets a room the charge creator owns
   * before writing an agent message into it (cross-tenant guard, #10253).
   *
   * Returns `undefined` when the room has no character mapping (callers must
   * treat that as unverifiable and fail closed).
   */
  async findOrganizationIdByRoomId(roomId: string): Promise<string | undefined> {
    const [row] = await dbRead
      .select({ organizationId: userCharacters.organization_id })
      .from(elizaRoomCharactersTable)
      .innerJoin(userCharacters, eq(userCharacters.id, elizaRoomCharactersTable.character_id))
      .where(eq(elizaRoomCharactersTable.room_id, roomId))
      .limit(1);

    return row?.organizationId ?? undefined;
  },

  /**
   * Finds character mappings for multiple room IDs.
   *
   * @returns Map of room ID to character ID.
   */
  async findByRoomIds(roomIds: string[]): Promise<Map<string, string>> {
    if (roomIds.length === 0) {
      return new Map();
    }

    const results = await dbRead
      .select()
      .from(elizaRoomCharactersTable)
      .where(inArray(elizaRoomCharactersTable.room_id, roomIds));

    const mappings = new Map<string, string>();
    for (const result of results) {
      mappings.set(result.room_id, result.character_id);
    }

    return mappings;
  },

  /**
   * Finds affiliate characters that a user has interacted with but are still
   * owned by anonymous/affiliate users. These characters are claimable by the user.
   */
  async findClaimableAffiliateCharacters(userId: string): Promise<
    Array<{
      characterId: string;
      characterName: string;
      ownerId: string;
      roomId: string;
    }>
  > {
    const rows = await sqlRows<{
      character_id: string;
      character_name: string;
      owner_id: string;
      room_id: string;
    }>(
      dbRead,
      sql`
      SELECT DISTINCT 
        rc.character_id,
        c.name as character_name,
        c.user_id as owner_id,
        rc.room_id
      FROM eliza_room_characters rc
      JOIN user_characters c ON rc.character_id = c.id
      JOIN users u ON c.user_id = u.id
      WHERE rc.user_id = ${userId}
        AND c.user_id != ${userId}
        AND (
          u.is_anonymous = true 
          OR (u.email LIKE 'affiliate-%@anonymous.elizacloud.ai' AND u.steward_user_id IS NULL)
        )
    `,
    );

    return rows.map((r) => ({
      characterId: r.character_id,
      characterName: r.character_name,
      ownerId: r.owner_id,
      roomId: r.room_id,
    }));
  },

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new room-character mapping.
   */
  async create(data: NewElizaRoomCharacter): Promise<ElizaRoomCharacter> {
    const result = await dbWrite.insert(elizaRoomCharactersTable).values(data).returning();

    return result[0];
  },

  /**
   * Updates the character mapping for a room.
   */
  async update(roomId: string, characterId: string): Promise<ElizaRoomCharacter | undefined> {
    const result = await dbWrite
      .update(elizaRoomCharactersTable)
      .set({
        character_id: characterId,
        updated_at: new Date(),
      })
      .where(eq(elizaRoomCharactersTable.room_id, roomId))
      .returning();

    return result[0];
  },

  /**
   * Deletes a room-character mapping.
   */
  async delete(roomId: string): Promise<void> {
    await dbWrite
      .delete(elizaRoomCharactersTable)
      .where(eq(elizaRoomCharactersTable.room_id, roomId));
  },
};
