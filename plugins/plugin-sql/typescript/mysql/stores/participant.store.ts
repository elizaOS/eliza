import { type Entity, type Metadata, type Participant, type UUID, logger } from "@elizaos/core";
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { v4 } from "uuid";
import { entityTable, participantTable } from "../tables";
import type { DrizzleDatabase } from "../types";

/**
 * Asynchronously adds multiple participants (entities) to a room.
 * Uses MySQL onDuplicateKeyUpdate with a dummy update to emulate PG's onConflictDoNothing().
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
    const values = entityIds.map((eid) => ({
      id: v4(),
      entityId: eid,
      roomId,
      agentId,
    }));
    // MySQL: use ON DUPLICATE KEY UPDATE to emulate ON CONFLICT DO NOTHING
    await db.insert(participantTable).values(values).onDuplicateKeyUpdate({ set: { id: sql`id` } });
    return entityIds;
  } catch (error) {
    logger.error(
      {
        src: "plugin:mysql",
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
    names: (Array.isArray(entityRow.names) ? entityRow.names : JSON.parse(entityRow.names as string || "[]")) as string[],
    metadata: (typeof entityRow.metadata === "string" ? JSON.parse(entityRow.metadata) : entityRow.metadata ?? {}) as Metadata,
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
 */
export async function updateParticipantUserState(
  db: DrizzleDatabase,
  agentId: UUID,
  roomId: UUID,
  entityId: UUID,
  state: "FOLLOWED" | "MUTED" | null
): Promise<void> {
  try {
    // WHY: Single UPDATE statement doesn't need a transaction wrapper.
    // Transactions add overhead (BEGIN/COMMIT round-trips) and are only
    // needed for multi-statement atomicity.
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

/**
 * Removes multiple participants in a single DELETE with OR-chained conditions.
 */
export async function deleteParticipants(
  db: DrizzleDatabase,
  agentId: UUID,
  participants: Array<{ entityId: UUID; roomId: UUID }>
): Promise<void> {
  if (participants.length === 0) return;

  try {
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
 * Update participants (batch) - MySQL version
 * 
 * WHY: Same rationale as PostgreSQL - general-purpose participant field updates
 * beyond just roomState.
 * 
 * WHY CASE expression: MySQL supports batch updates with CASE like PostgreSQL.
 * 
 * @param {DrizzleDatabase} db - The database instance
 * @param {UUID} agentId - The agent ID
 * @param {Array<{ entityId: UUID; roomId: UUID; updates: Partial<Participant> }>} participants - Updates
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

  const hasRoomStateUpdates = participants.some(p => (p.updates as any).roomState !== undefined);
  const hasMetadataUpdates = participants.some(p => (p.updates as any).metadata !== undefined);
  
  const setClauses: SQL<unknown>[] = [];
  
  if (hasRoomStateUpdates) {
    const roomStateCases = participants
      .filter(p => (p.updates as any).roomState !== undefined)
      .map(p => sql`WHEN (${participantTable.entityId} = ${p.entityId} AND ${participantTable.roomId} = ${p.roomId}) THEN ${(p.updates as any).roomState}`);
    
    if (roomStateCases.length > 0) {
      setClauses.push(sql`${participantTable.roomState} = CASE ${sql.join(roomStateCases, sql` `)} ELSE ${participantTable.roomState} END`);
    }
  }
  
  if (hasMetadataUpdates) {
    const metadataCases = participants
      .filter(p => (p.updates as any).metadata !== undefined)
      .map(p => {
        const jsonString = JSON.stringify((p.updates as any).metadata);
        return sql`WHEN (${participantTable.entityId} = ${p.entityId} AND ${participantTable.roomId} = ${p.roomId}) THEN CAST(${jsonString} AS JSON)`;
      });
    
    if (metadataCases.length > 0) {
      setClauses.push(sql`${participantTable.metadata} = CASE ${sql.join(metadataCases, sql` `)} ELSE ${participantTable.metadata} END`);
    }
  }
  
  if (setClauses.length === 0) return;
  
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
