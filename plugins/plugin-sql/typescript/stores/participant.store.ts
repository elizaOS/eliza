import { type Entity, type Metadata, type Participant, type UUID, logger } from "@elizaos/core";
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { entityTable, participantTable } from "../tables";
import type { DrizzleDatabase } from "../types";

/**
 * Asynchronously adds multiple participants (entities) to a room.
 * Uses onConflictDoNothing() to handle duplicate entries gracefully.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent.
 * @param {UUID[]} entityIds - The IDs of the entities to add to the room.
 * @param {UUID} roomId - The ID of the room to add the entities to.
 * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the participants were added successfully.
 */
export async function createRoomParticipants(
  db: DrizzleDatabase,
  agentId: UUID,
  entityIds: UUID[],
  roomId: UUID
): Promise<UUID[]> {
  try {
    const values = entityIds.map((id) => ({
      entityId: id,
      roomId,
      agentId,
    }));
    await db.insert(participantTable).values(values).onConflictDoNothing().execute();
    // Return the entity IDs as the participant IDs (participants are identified by entityId+roomId composite key)
    return entityIds;
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        roomId,
        agentId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to add participants to room"
    );
    throw error;
  }
}

/**
 * Asynchronously retrieves all participants for an entity from the database.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} entityId - The ID of the entity to retrieve participants for.
 * @returns {Promise<Participant[]>} A Promise that resolves to an array of participants.
 */
export async function getParticipantsForEntity(
  db: DrizzleDatabase,
  entityId: UUID
): Promise<Participant[]> {
  // WHY: Run both queries in parallel instead of sequentially (saves one
  // round-trip). Also fetch entity directly from the entities table instead
  // of calling getEntitiesByIds, which performs a heavy LEFT JOIN on
  // components just to populate the optional `components` field.
  const [participantRows, entityRows] = await Promise.all([
    db
      .select({
        id: participantTable.id,
        entityId: participantTable.entityId,
        roomId: participantTable.roomId,
      })
      .from(participantTable)
      .where(eq(participantTable.entityId, entityId)),
    // WHY: Only fetch the 4 columns we actually map into the Entity object.
    // The entity table may carry additional payload (e.g. createdAt) that we
    // never use here — skipping those saves wire bytes and deserialization.
    db
      .select({
        id: entityTable.id,
        agentId: entityTable.agentId,
        names: entityTable.names,
        metadata: entityTable.metadata,
      })
      .from(entityTable)
      .where(eq(entityTable.id, entityId))
      .limit(1),
  ]);

  if (entityRows.length === 0) {
    return [];
  }

  const entityRow = entityRows[0];
  const entity: Entity = {
    id: entityRow.id as UUID,
    agentId: entityRow.agentId as UUID,
    names: (entityRow.names ?? []) as string[],
    metadata: (entityRow.metadata ?? {}) as Metadata,
  };

  return participantRows.map((row) => ({
    id: row.id as UUID,
    entity,
  }));
}

/**
 * Asynchronously retrieves all participant entity IDs for a room.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} roomId - The ID of the room to retrieve participants for.
 * @returns {Promise<UUID[]>} A Promise that resolves to an array of entity IDs.
 */
export async function getParticipantsForRoom(
  db: DrizzleDatabase,
  roomId: UUID
): Promise<UUID[]> {
  const result = await db
    .select({ entityId: participantTable.entityId })
    .from(participantTable)
    .where(eq(participantTable.roomId, roomId));

  return result.map((row) => row.entityId as UUID);
}

/**
 * Checks if an entity is a participant in a specific room/channel.
 * More efficient than getParticipantsForRoom when only checking membership.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} roomId - The ID of the room to check.
 * @param {UUID} entityId - The ID of the entity to check.
 * @returns {Promise<boolean>} A Promise that resolves to true if entity is a participant.
 */
export async function isRoomParticipant(
  db: DrizzleDatabase,
  roomId: UUID,
  entityId: UUID
): Promise<boolean> {
  // WHY: SELECT 1 instead of SELECT * — we only need to know if the row
  // exists, not fetch all columns. Reduces data transfer and memory.
  const result = await db
    .select({ one: sql`1` })
    .from(participantTable)
    .where(and(eq(participantTable.roomId, roomId), eq(participantTable.entityId, entityId)))
    .limit(1);

  return result.length > 0;
}

/**
 * Asynchronously retrieves the user state for a participant in a room.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent.
 * @param {UUID} roomId - The ID of the room to retrieve the participant's user state for.
 * @param {UUID} entityId - The ID of the entity to retrieve the user state for.
 * @returns {Promise<"FOLLOWED" | "MUTED" | null>} A Promise that resolves to the participant's user state.
 */
export async function getParticipantUserState(
  db: DrizzleDatabase,
  agentId: UUID,
  roomId: UUID,
  entityId: UUID
): Promise<"FOLLOWED" | "MUTED" | null> {
  const result = await db
    .select({ roomState: participantTable.roomState })
    .from(participantTable)
    .where(
      and(
        eq(participantTable.roomId, roomId),
        eq(participantTable.entityId, entityId),
        eq(participantTable.agentId, agentId)
      )
    )
    .limit(1);

  const result0 = result[0];
  return (result0?.roomState as "FOLLOWED" | "MUTED" | null) ?? null;
}

/**
 * Asynchronously sets the user state for a participant in a room.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent.
 * @param {UUID} roomId - The ID of the room to set the participant's user state for.
 * @param {UUID} entityId - The ID of the entity to set the user state for.
 * @param {string | null} state - The state to set the participant's user state to.
 * @returns {Promise<void>} A Promise that resolves when the participant's user state is set.
 *
 * WHY no transaction: a single UPDATE is already atomic in PostgreSQL. Wrapping it in
 * a transaction adds unnecessary overhead.
 */
export async function updateParticipantUserState(
  db: DrizzleDatabase,
  agentId: UUID,
  roomId: UUID,
  entityId: UUID,
  state: "FOLLOWED" | "MUTED" | null
): Promise<void> {
  try {
    await db
      .update(participantTable)
      .set({ roomState: state })
      .where(
        and(
          eq(participantTable.roomId, roomId),
          eq(participantTable.entityId, entityId),
          eq(participantTable.agentId, agentId)
        )
      );
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        roomId,
        entityId,
        state,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to set participant follow state"
    );
    throw error;
  }
}

// ── Batch participant operations ─────────────────────────────────────
//
// WHY single DELETE with OR instead of N individual DELETEs:
//   Old: N DELETE statements inside a transaction (N round-trips to DB)
//   New: 1 DELETE with compound OR conditions (1 round-trip)
//
// PostgreSQL optimizes OR-chains on indexed columns into an index scan,
// so this is both fewer queries AND potentially faster per-query.

/**
 * Removes multiple participants from their respective rooms in a single DELETE.
 *
 * Uses OR-chained compound conditions instead of looping:
 *   DELETE FROM participants
 *   WHERE agent_id = $1
 *     AND ((entity_id = $2 AND room_id = $3)
 *       OR (entity_id = $4 AND room_id = $5)
 *       OR ...)
 */
export async function deleteParticipants(
  db: DrizzleDatabase,
  agentId: UUID,
  participants: Array<{ entityId: UUID; roomId: UUID }>
): Promise<void> {
  if (participants.length === 0) return;

  try {
    // Build compound OR conditions for all (entityId, roomId) pairs
    const pairConditions = participants.map(({ entityId, roomId }) =>
      and(
        eq(participantTable.entityId, entityId),
        eq(participantTable.roomId, roomId)
      )
    );

    await db
      .delete(participantTable)
      .where(
        and(
          eq(participantTable.agentId, agentId),
          or(...pairConditions)
        )
      );
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        agentId,
        count: participants.length,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to delete participants"
    );
    throw error;
  }
}

/**
 * Update participants (batch)
 * 
 * WHY: Participants have fields beyond roomState (metadata, lastSeenAt, etc.).
 * This provides general-purpose participant updates.
 * 
 * WHY CASE expression: Single UPDATE with CASE for each field is more efficient
 * than N individual UPDATE statements.
 * 
 * WHY composite key: Participant table's PK is (entityId, roomId, agentId).
 * Each update must specify all key fields.
 * 
 * @param {DrizzleDatabase} db - The database instance
 * @param {UUID} agentId - The agent ID
 * @param {Array<{ entityId: UUID; roomId: UUID; updates: Partial<Participant> }>} participants - Participant updates
 */
export async function updateParticipants(
  db: DrizzleDatabase,
  agentId: UUID,
  participants: Array<{
    entityId: UUID;
    roomId: UUID;
    updates: Partial<Participant>;
  }>
): Promise<void> {
  if (participants.length === 0) return;

  // Build CASE expressions for each field being updated
  const hasRoomStateUpdates = participants.some(p => 'roomState' in p.updates);
  const hasMetadataUpdates = participants.some(p => 'metadata' in p.updates);
  
  const setClauses: SQL<unknown>[] = [];
  
  if (hasRoomStateUpdates) {
    const roomStateCases = participants
      .filter((p): p is typeof p & { updates: Partial<Participant> & { roomState: string } } => 'roomState' in p.updates)
      .map(p => sql`WHEN (${participantTable.entityId} = ${p.entityId} AND ${participantTable.roomId} = ${p.roomId}) THEN ${p.updates.roomState}`);
    
    if (roomStateCases.length > 0) {
      setClauses.push(sql`${participantTable.roomState} = CASE ${sql.join(roomStateCases, sql` `)} ELSE ${participantTable.roomState} END`);
    }
  }
  
  if (hasMetadataUpdates) {
    const metadataCases = participants
      .filter((p): p is typeof p & { updates: Partial<Participant> & { metadata: unknown } } => 'metadata' in p.updates)
      .map(p => {
        const jsonString = JSON.stringify(p.updates.metadata);
        return sql`WHEN (${participantTable.entityId} = ${p.entityId} AND ${participantTable.roomId} = ${p.roomId}) THEN ${jsonString}::jsonb`;
      });
    
    if (metadataCases.length > 0) {
      setClauses.push(sql`${participantTable.metadata} = CASE ${sql.join(metadataCases, sql` `)} ELSE ${participantTable.metadata} END`);
    }
  }
  
  if (setClauses.length === 0) return;
  
  // Build OR condition for all (entityId, roomId) pairs
  const pairConditions = participants.map(({ entityId, roomId }) =>
    and(
      eq(participantTable.entityId, entityId),
      eq(participantTable.roomId, roomId)
    )
  );
  
  await db
    .update(participantTable)
    .set(sql`${sql.join(setClauses, sql`, `)}`)
    .where(
      and(
        eq(participantTable.agentId, agentId),
        or(...pairConditions)
      )
    );
}
