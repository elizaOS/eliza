import { type ChannelType, type Metadata, type Room, type UUID, logger } from "@elizaos/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { v4 } from "uuid";
import {
  embeddingTable,
  logTable,
  memoryTable,
  participantTable,
  roomTable,
} from "../tables";
import type { DrizzleDatabase } from "../types";

/**
 * Retrieves rooms from the database by their IDs, scoped to a specific agent.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent.
 * @param {UUID[]} roomIds - The IDs of the rooms to retrieve.
 * @returns {Promise<Room[] | null>} A Promise that resolves to the rooms if found, null otherwise.
 */
export async function getRoomsByIds(
  db: DrizzleDatabase,
  agentId: UUID,
  roomIds: UUID[]
): Promise<Room[] | null> {
  const result = await db
    .select({
      id: roomTable.id,
      name: roomTable.name,
      channelId: roomTable.channelId,
      agentId: roomTable.agentId,
      messageServerId: roomTable.messageServerId,
      worldId: roomTable.worldId,
      type: roomTable.type,
      source: roomTable.source,
      metadata: roomTable.metadata,
    })
    .from(roomTable)
    .where(and(inArray(roomTable.id, roomIds), eq(roomTable.agentId, agentId)));

  // Map the result to properly typed Room objects
  const rooms = result.map((room) => ({
    ...room,
    id: room.id as UUID,
    name: room.name ?? undefined,
    agentId: room.agentId as UUID,
    messageServerId: room.messageServerId as UUID,
    serverId: room.messageServerId as UUID, // Backward compatibility alias
    worldId: room.worldId as UUID,
    channelId: room.channelId as UUID,
    type: room.type as ChannelType,
    metadata: room.metadata as Metadata,
  }));

  return rooms;
}

/**
 * Retrieves all rooms belonging to a specific world.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} worldId - The ID of the world to retrieve rooms from.
 * @returns {Promise<Room[]>} A Promise that resolves to an array of rooms.
 */
export async function getRoomsByWorld(
  db: DrizzleDatabase,
  worldId: UUID,
  limit?: number,
  offset?: number
): Promise<Room[]> {
  let query = db.select().from(roomTable).where(eq(roomTable.worldId, worldId));

  // WHY: Apply pagination to limit result size. Previously returned ALL rooms in world.
  if (limit) {
    query = query.limit(limit) as typeof query;
  }
  if (offset) {
    query = query.offset(offset) as typeof query;
  }

  const result = await query;
  const rooms = result.map((room) => ({
    ...room,
    id: room.id as UUID,
    name: room.name ?? undefined,
    agentId: room.agentId as UUID,
    source: room.source as string,
    messageServerId: room.messageServerId as UUID,
    serverId: room.messageServerId as UUID, // Backward compatibility alias
    worldId: room.worldId as UUID,
    channelId: room.channelId as UUID,
    type: room.type as ChannelType,
    metadata: room.metadata as Metadata,
  }));
  return rooms;
}

/**
 * Creates new rooms in the database, ignoring conflicts.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent.
 * @param {Room[]} rooms - The room objects to create.
 * @returns {Promise<UUID[]>} A Promise that resolves to the IDs of the created rooms.
 */
export async function createRooms(
  db: DrizzleDatabase,
  agentId: UUID,
  rooms: Room[]
): Promise<UUID[]> {
  const roomsWithIds = rooms.map((room) => ({
    ...room,
    agentId,
    id: room.id || v4(), // ensure each room has a unique ID
  }));

  const insertedRooms = (await db
    .insert(roomTable)
    .values(roomsWithIds)
    .onConflictDoNothing()
    .returning()) as Array<{ id: string }>;
  const insertedIds = insertedRooms.map((r) => r.id as UUID);
  return insertedIds;
}

/**
 * Upsert rooms (insert or update by ID)
 * 
 * WHY: Rooms are created during ensureConnection or when syncing external
 * platforms (Discord, Telegram). Concurrent connection attempts should be
 * idempotent.
 * 
 * WHY DO UPDATE: Room metadata, names, and settings can change over time.
 * We want to keep the latest version, not skip updates with DO NOTHING.
 * 
 * WHY complex fields: Rooms have many fields (name, type, worldId, channelId,
 * messageServerId, metadata). All must be updated to keep rooms in sync with
 * external platforms.
 * 
 * @param {DrizzleDatabase} db - The database instance
 * @param {UUID} agentId - The ID of the agent (always set for upserts)
 * @param {Room[]} rooms - Array of rooms to upsert (id, worldId required)
 */
export async function upsertRooms(
  db: DrizzleDatabase,
  agentId: UUID,
  rooms: Room[]
): Promise<void> {
  if (rooms.length === 0) return;

  const roomsWithAgentId = rooms.map((room) => ({
    ...room,
    agentId,
  }));

  await db
    .insert(roomTable)
    .values(roomsWithAgentId)
    .onConflictDoUpdate({
      target: roomTable.id,
      set: {
        agentId: roomTable.agentId,
        worldId: roomTable.worldId,
        name: roomTable.name,
        channelId: roomTable.channelId,
        messageServerId: roomTable.messageServerId,
        source: roomTable.source,
        type: roomTable.type,
        metadata: roomTable.metadata,
      },
    });
}

/**
 * Retrieves all room IDs that a specific entity participates in, scoped to an agent.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent.
 * @param {UUID} entityId - The ID of the entity to retrieve rooms for.
 * @returns {Promise<UUID[]>} A Promise that resolves to an array of room IDs.
 */
export async function getRoomsForParticipant(
  db: DrizzleDatabase,
  agentId: UUID,
  entityId: UUID
): Promise<UUID[]> {
  const result = await db
    .select({ roomId: participantTable.roomId })
    .from(participantTable)
    .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
    .where(and(eq(participantTable.entityId, entityId), eq(roomTable.agentId, agentId)));

  return result.map((row) => row.roomId as UUID);
}

/**
 * Retrieves all distinct room IDs that any of the provided entities participate in, scoped to an agent.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent.
 * @param {UUID[]} entityIds - The IDs of the entities to retrieve rooms for.
 * @returns {Promise<UUID[]>} A Promise that resolves to an array of room IDs.
 */
export async function getRoomsForParticipants(
  db: DrizzleDatabase,
  agentId: UUID,
  entityIds: UUID[]
): Promise<UUID[]> {
  const result = await db
    .selectDistinct({ roomId: participantTable.roomId })
    .from(participantTable)
    .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
    .where(
      and(inArray(participantTable.entityId, entityIds), eq(roomTable.agentId, agentId))
    );

  return result.map((row) => row.roomId as UUID);
}

/**
 * Deletes all rooms belonging to a world, along with their associated logs, participants,
 * memories, and embeddings.
 *
 * WHY transaction: wrap all DELETEs in a single transaction for atomicity—if any step fails,
 * the whole operation rolls back.
 * WHY subquery for embeddings: delete embeddings via subquery instead of fetching memory IDs
 * first, eliminating a round-trip and keeping the operation in one transaction.
 *
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent.
 * @param {UUID} worldId - The ID of the world whose rooms should be deleted.
 * @returns {Promise<void>} A Promise that resolves when the cleanup is completed.
 */
export async function deleteRoomsByWorldId(
  db: DrizzleDatabase,
  agentId: UUID,
  worldId: UUID
): Promise<void> {
  const rooms = await db
    .select({ id: roomTable.id })
    .from(roomTable)
    .where(and(eq(roomTable.worldId, worldId), eq(roomTable.agentId, agentId)));

  if (rooms.length === 0) {
    return;
  }

  const roomIds = rooms.map((room) => room.id as UUID);

  await db.transaction(async (tx) => {
    await tx.delete(logTable).where(inArray(logTable.roomId, roomIds));
    await tx.delete(participantTable).where(inArray(participantTable.roomId, roomIds));

    // Use subquery to delete embeddings without fetching memory IDs (eliminates round-trip)
    await tx
      .delete(embeddingTable)
      .where(
        sql`${embeddingTable.memoryId} IN (SELECT ${memoryTable.id} FROM ${memoryTable} WHERE ${inArray(memoryTable.roomId, roomIds)})`
      );
    await tx.delete(memoryTable).where(inArray(memoryTable.roomId, roomIds));
    await tx.delete(roomTable).where(inArray(roomTable.id, roomIds));
  });

  logger.debug(
    {
      src: "plugin:sql",
      worldId,
      roomsDeleted: roomIds.length,
    },
    "World cleanup completed"
  );
}

// Batch room operations

/**
 * Updates multiple rooms in the database using a single CASE-based UPDATE.
 *
 * WHY single statement: eliminates N round-trips. Builds CASE expressions for
 * each column and executes one UPDATE … WHERE id IN (…) AND agent_id = ?.
 */
export async function updateRooms(
  db: DrizzleDatabase,
  agentId: UUID,
  rooms: Room[]
): Promise<void> {
  if (rooms.length === 0) return;

  const ids = rooms.map((r) => r.id);

  const sourceCases = rooms.map(
    (r) => sql`WHEN ${roomTable.id} = ${r.id} THEN ${r.source}`
  );
  const typeCases = rooms.map(
    (r) => sql`WHEN ${roomTable.id} = ${r.id} THEN ${r.type}`
  );
  const nameCases = rooms.map(
    (r) => sql`WHEN ${roomTable.id} = ${r.id} THEN ${r.name ?? null}`
  );
  const worldIdCases = rooms.map(
    (r) => sql`WHEN ${roomTable.id} = ${r.id} THEN ${r.worldId ?? null}::uuid`
  );
  const messageServerIdCases = rooms.map(
    (r) =>
      sql`WHEN ${roomTable.id} = ${r.id} THEN ${r.messageServerId ?? null}::uuid`
  );
  const channelIdCases = rooms.map(
    (r) => sql`WHEN ${roomTable.id} = ${r.id} THEN ${r.channelId ?? null}`
  );
  const metaCases = rooms.map(
    (r) =>
      sql`WHEN ${roomTable.id} = ${r.id} THEN ${JSON.stringify(r.metadata ?? null)}::jsonb`
  );

  await db
    .update(roomTable)
    .set({
      source: sql`CASE ${sql.join(sourceCases, sql` `)} ELSE ${roomTable.source} END`,
      type: sql`CASE ${sql.join(typeCases, sql` `)} ELSE ${roomTable.type} END`,
      name: sql`CASE ${sql.join(nameCases, sql` `)} ELSE ${roomTable.name} END`,
      worldId: sql`CASE ${sql.join(worldIdCases, sql` `)} ELSE ${roomTable.worldId} END`,
      messageServerId: sql`CASE ${sql.join(messageServerIdCases, sql` `)} ELSE ${roomTable.messageServerId} END`,
      channelId: sql`CASE ${sql.join(channelIdCases, sql` `)} ELSE ${roomTable.channelId} END`,
      metadata: sql`CASE ${sql.join(metaCases, sql` `)} ELSE ${roomTable.metadata} END`,
    })
    .where(and(inArray(roomTable.id, ids), eq(roomTable.agentId, agentId)));
}

/**
 * Deletes multiple rooms from the database.
 */
export async function deleteRooms(
  db: DrizzleDatabase,
  agentId: UUID,
  roomIds: UUID[]
): Promise<void> {
  if (roomIds.length === 0) return;

  await db
    .delete(roomTable)
    .where(and(inArray(roomTable.id, roomIds), eq(roomTable.agentId, agentId)));
}
