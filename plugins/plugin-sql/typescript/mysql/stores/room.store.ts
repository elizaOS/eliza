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
 * Creates new rooms in the database.
 * MySQL uses onDuplicateKeyUpdate instead of onConflictDoNothing() and does NOT use .returning().
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

  // MySQL: use INSERT ... ON DUPLICATE KEY UPDATE instead of ON CONFLICT DO NOTHING
  // and we can't use .returning() - use the IDs we generated
  await db.insert(roomTable).values(roomsWithIds).onDuplicateKeyUpdate({ set: { id: sql`id` } });
  return roomsWithIds.map((r) => r.id as UUID);
}

/**
 * Upsert rooms (insert or update by ID) - MySQL version
 * 
 * WHY: Same rationale as PostgreSQL - idempotent room management for
 * ensureConnection and platform sync. MySQL uses ON DUPLICATE KEY UPDATE.
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
    .onDuplicateKeyUpdate({
      set: {
        agentId: sql.raw('VALUES(`agent_id`)'),
        worldId: sql.raw('VALUES(`world_id`)'),
        name: sql.raw('VALUES(`name`)'),
        channelId: sql.raw('VALUES(`channel_id`)'),
        messageServerId: sql.raw('VALUES(`message_server_id`)'),
        source: sql.raw('VALUES(`source`)'),
        type: sql.raw('VALUES(`type`)'),
        metadata: sql.raw('VALUES(`metadata`)'),
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

  if (roomIds.length > 0) {
    await db.delete(logTable).where(inArray(logTable.roomId, roomIds));
    await db.delete(participantTable).where(inArray(participantTable.roomId, roomIds));

    const memoriesInRooms = await db
      .select({ id: memoryTable.id })
      .from(memoryTable)
      .where(inArray(memoryTable.roomId, roomIds));
    const memoryIdsInRooms = memoriesInRooms.map((m) => m.id as UUID);

    if (memoryIdsInRooms.length > 0) {
      await db
        .delete(embeddingTable)
        .where(inArray(embeddingTable.memoryId, memoryIdsInRooms));
      await db.delete(memoryTable).where(inArray(memoryTable.id, memoryIdsInRooms));
    }

    await db.delete(roomTable).where(inArray(roomTable.id, roomIds));

    logger.debug(
      {
      src: "plugin:mysql",
      worldId,
      roomsDeleted: roomIds.length,
      memoriesDeleted: memoryIdsInRooms.length,
    },
    "World cleanup completed"
  );
  }
}

// Batch room operations

/**
 * Updates multiple rooms in the database using a single CASE-based UPDATE.
 *
 * WHY single statement: eliminates N round-trips. Builds CASE expressions for
 * each column and executes one UPDATE … WHERE id IN (…) AND agent_id = ?.
 *
 * MySQL: metadata as CAST(... AS JSON); UUIDs as strings.
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
    (r) => sql`WHEN ${roomTable.id} = ${r.id} THEN ${r.worldId ?? null}`
  );
  const messageServerIdCases = rooms.map(
    (r) =>
      sql`WHEN ${roomTable.id} = ${r.id} THEN ${r.messageServerId ?? null}`
  );
  const channelIdCases = rooms.map(
    (r) => sql`WHEN ${roomTable.id} = ${r.id} THEN ${r.channelId ?? null}`
  );
  const metaCases = rooms.map(
    (r) =>
      sql`WHEN ${roomTable.id} = ${r.id} THEN CAST(${JSON.stringify(r.metadata ?? null)} AS JSON)`
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
