import { ChannelType, logger, type Metadata, type UUID } from "@elizaos/core";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { v4 } from "uuid";
import {
  channelParticipantsTable,
  channelTable,
  messageServerAgentsTable,
  messageServerTable,
  messageTable,
} from "../tables";
import type { DrizzleDatabase } from "../types";

// ===============================
// Message Server Methods
// ===============================

/**
 * Creates a new message server (Discord/Telegram server).
 * @param {DrizzleDatabase} db - The database instance.
 * @param {object} data - The message server data.
 * @returns The created or existing message server.
 */
export async function createMessageServer(
  db: DrizzleDatabase,
  data: {
    id?: UUID;
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: Metadata;
  }
): Promise<{
  id: UUID;
  name: string;
  sourceType: string;
  sourceId?: string;
  metadata?: Metadata;
  createdAt: Date;
  updatedAt: Date;
}> {
  const newId = data.id || (v4() as UUID);
  const now = new Date();
  const serverToInsert = {
    id: newId,
    name: data.name,
    sourceType: data.sourceType,
    sourceId: data.sourceId,
    metadata: data.metadata,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(messageServerTable).values(serverToInsert).onConflictDoNothing();

  // If server already existed, fetch it
  if (data.id) {
    const existing = await db
      .select()
      .from(messageServerTable)
      .where(eq(messageServerTable.id, data.id))
      .limit(1);
    if (existing.length > 0) {
      return {
        id: existing[0].id as UUID,
        name: existing[0].name,
        sourceType: existing[0].sourceType,
        sourceId: existing[0].sourceId || undefined,
        metadata: (existing[0].metadata || undefined) as Metadata | undefined,
        createdAt: existing[0].createdAt,
        updatedAt: existing[0].updatedAt,
      };
    }
  }

  return serverToInsert;
}

/**
 * Gets all message servers.
 * @param {DrizzleDatabase} db - The database instance.
 * @returns An array of message servers.
 */
export async function getMessageServers(db: DrizzleDatabase): Promise<
  Array<{
    id: UUID;
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  }>
> {
  const results = await db.select().from(messageServerTable);
  return results.map((r) => ({
    id: r.id as UUID,
    name: r.name,
    sourceType: r.sourceType,
    sourceId: r.sourceId || undefined,
    metadata: (r.metadata || undefined) as Metadata | undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * Gets a message server by ID.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} serverId - The ID of the message server.
 * @returns The message server or null if not found.
 */
export async function getMessageServerById(
  db: DrizzleDatabase,
  serverId: UUID
): Promise<{
  id: UUID;
  name: string;
  sourceType: string;
  sourceId?: string;
  metadata?: Metadata;
  createdAt: Date;
  updatedAt: Date;
} | null> {
  const results = await db
    .select()
    .from(messageServerTable)
    .where(eq(messageServerTable.id, serverId))
    .limit(1);
  return results.length > 0
    ? {
        id: results[0].id as UUID,
        name: results[0].name,
        sourceType: results[0].sourceType,
        sourceId: results[0].sourceId || undefined,
        metadata: (results[0].metadata || undefined) as Metadata | undefined,
        createdAt: results[0].createdAt,
        updatedAt: results[0].updatedAt,
      }
    : null;
}

/**
 * Gets a message server by RLS server_id.
 * The server_id column is added dynamically when RLS is enabled.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} rlsServerId - The RLS server ID.
 * @returns The message server or null if not found.
 */
export async function getMessageServerByRlsServerId(
  db: DrizzleDatabase,
  rlsServerId: UUID
): Promise<{
  id: UUID;
  name: string;
  sourceType: string;
  sourceId?: string;
  metadata?: Metadata;
  createdAt: Date;
  updatedAt: Date;
} | null> {
  // Use raw SQL since server_id column is dynamically added by RLS and not in Drizzle schema
  const results = await db.execute(sql`
    SELECT id, name, source_type, source_id, metadata, created_at, updated_at
    FROM message_servers
    WHERE server_id = ${rlsServerId}
    LIMIT 1
  `);

  const rows = results.rows || results;
  return (rows as Record<string, unknown>[]).length > 0
    ? {
        id: (rows as Record<string, unknown>[])[0].id as UUID,
        name: (rows as Record<string, unknown>[])[0].name as string,
        sourceType: (rows as Record<string, unknown>[])[0].source_type as string,
        sourceId: ((rows as Record<string, unknown>[])[0].source_id || undefined) as
          | string
          | undefined,
        metadata: ((rows as Record<string, unknown>[])[0].metadata || undefined) as
          | Metadata
          | undefined,
        createdAt: new Date((rows as Record<string, unknown>[])[0].created_at as string),
        updatedAt: new Date((rows as Record<string, unknown>[])[0].updated_at as string),
      }
    : null;
}

/**
 * Adds an agent to a message server (Discord/Telegram server).
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} messageServerId - The ID of the message server.
 * @param {UUID} agentId - The ID of the agent.
 */
export async function addAgentToMessageServer(
  db: DrizzleDatabase,
  messageServerId: UUID,
  agentId: UUID
): Promise<void> {
  await db
    .insert(messageServerAgentsTable)
    .values({
      messageServerId,
      agentId,
    })
    .onConflictDoNothing();
}

/**
 * Gets agents for a message server (Discord/Telegram server).
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} messageServerId - The ID of the message server.
 * @returns An array of agent UUIDs.
 */
export async function getAgentsForMessageServer(
  db: DrizzleDatabase,
  messageServerId: UUID
): Promise<UUID[]> {
  const results = await db
    .select({ agentId: messageServerAgentsTable.agentId })
    .from(messageServerAgentsTable)
    .where(eq(messageServerAgentsTable.messageServerId, messageServerId));

  return results.map((r) => r.agentId as UUID);
}

/**
 * Removes an agent from a message server (Discord/Telegram server).
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} messageServerId - The ID of the message server.
 * @param {UUID} agentId - The ID of the agent.
 */
export async function removeAgentFromMessageServer(
  db: DrizzleDatabase,
  messageServerId: UUID,
  agentId: UUID
): Promise<void> {
  await db
    .delete(messageServerAgentsTable)
    .where(
      and(
        eq(messageServerAgentsTable.messageServerId, messageServerId),
        eq(messageServerAgentsTable.agentId, agentId)
      )
    );
}

// ===============================
// Channel Methods
// ===============================

/**
 * Creates a new channel.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {object} data - The channel data.
 * @param {UUID[]} [participantIds] - Optional list of participant entity IDs.
 * @returns The created channel.
 */
export async function createChannel(
  db: DrizzleDatabase,
  data: {
    id?: UUID;
    messageServerId: UUID;
    name: string;
    type: string;
    sourceType?: string;
    sourceId?: string;
    topic?: string;
    metadata?: Metadata;
  },
  participantIds?: UUID[]
): Promise<{
  id: UUID;
  messageServerId: UUID;
  name: string;
  type: string;
  sourceType?: string;
  sourceId?: string;
  topic?: string;
  metadata?: Metadata;
  createdAt: Date;
  updatedAt: Date;
}> {
  const newId = data.id || (v4() as UUID);
  const now = new Date();
  const channelToInsert = {
    id: newId,
    messageServerId: data.messageServerId,
    name: data.name,
    type: data.type,
    sourceType: data.sourceType,
    sourceId: data.sourceId,
    topic: data.topic,
    metadata: data.metadata,
    createdAt: now,
    updatedAt: now,
  };

  await db.transaction(async (tx) => {
    await tx.insert(channelTable).values(channelToInsert);

    if (participantIds && participantIds.length > 0) {
      const participantValues = participantIds.map((entityId) => ({
        channelId: newId,
        entityId: entityId,
      }));
      await tx.insert(channelParticipantsTable).values(participantValues).onConflictDoNothing();
    }
  });

  return channelToInsert;
}

/**
 * Gets channels for a message server.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} messageServerId - The ID of the message server.
 * @returns An array of channels.
 */
export async function getChannelsForMessageServer(
  db: DrizzleDatabase,
  messageServerId: UUID
): Promise<
  Array<{
    id: UUID;
    messageServerId: UUID;
    name: string;
    type: string;
    sourceType?: string;
    sourceId?: string;
    topic?: string;
    metadata?: Metadata;
    createdAt: Date;
    updatedAt: Date;
  }>
> {
  const results = await db
    .select()
    .from(channelTable)
    .where(eq(channelTable.messageServerId, messageServerId));
  return results.map((r) => ({
    id: r.id as UUID,
    messageServerId: r.messageServerId as UUID,
    name: r.name,
    type: r.type,
    sourceType: r.sourceType || undefined,
    sourceId: r.sourceId || undefined,
    topic: r.topic || undefined,
    metadata: (r.metadata || undefined) as Metadata | undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * Gets channel details by ID.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} channelId - The ID of the channel.
 * @returns The channel details or null if not found.
 */
export async function getChannelDetails(
  db: DrizzleDatabase,
  channelId: UUID
): Promise<{
  id: UUID;
  messageServerId: UUID;
  name: string;
  type: string;
  sourceType?: string;
  sourceId?: string;
  topic?: string;
  metadata?: Metadata;
  createdAt: Date;
  updatedAt: Date;
} | null> {
  const results = await db
    .select()
    .from(channelTable)
    .where(eq(channelTable.id, channelId))
    .limit(1);
  return results.length > 0
    ? {
        id: results[0].id as UUID,
        messageServerId: results[0].messageServerId as UUID,
        name: results[0].name,
        type: results[0].type,
        sourceType: results[0].sourceType || undefined,
        sourceId: results[0].sourceId || undefined,
        topic: results[0].topic || undefined,
        metadata: (results[0].metadata || undefined) as Metadata | undefined,
        createdAt: results[0].createdAt,
        updatedAt: results[0].updatedAt,
      }
    : null;
}

/**
 * Updates a channel.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} channelId - The ID of the channel to update.
 * @param {object} updates - The fields to update.
 * @returns The updated channel.
 */
export async function updateChannel(
  db: DrizzleDatabase,
  channelId: UUID,
  updates: {
    name?: string;
    participantCentralUserIds?: UUID[];
    metadata?: Metadata;
  }
): Promise<{
  id: UUID;
  messageServerId: UUID;
  name: string;
  type: string;
  sourceType?: string;
  sourceId?: string;
  topic?: string;
  metadata?: Metadata;
  createdAt: Date;
  updatedAt: Date;
}> {
  const now = new Date();

  // WHY diff-based sync: the old code did DELETE-all + re-INSERT for participants.
  // For a channel with 100 participants where 1 changed, that's 1 DELETE + 100 INSERTs.
  // Diff-based: 1 SELECT + 1 DELETE + 1 INSERT, and zero writes if nothing changed.
  await db.transaction(async (tx) => {
    const updateData: Record<string, unknown> = { updatedAt: now };
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.metadata !== undefined) updateData.metadata = updates.metadata;

    // NOTE: RETURNING could be used here to avoid the post-transaction getChannelDetails call,
    // but getChannelDetails may return a different shape (e.g. joined participants). Keeping
    // current pattern to avoid breaking the return shape.
    await tx.update(channelTable).set(updateData).where(eq(channelTable.id, channelId));

    if (updates.participantCentralUserIds !== undefined) {
      const desired = new Set(updates.participantCentralUserIds);

      // Read current participants
      const currentRows = await tx
        .select({ entityId: channelParticipantsTable.entityId })
        .from(channelParticipantsTable)
        .where(eq(channelParticipantsTable.channelId, channelId));

      const current = new Set(currentRows.map((r) => r.entityId));

      // Compute diff
      const toRemove = [...current].filter((id) => !desired.has(id as UUID));
      const toAdd = [...desired].filter((id) => !current.has(id));

      if (toRemove.length > 0) {
        await tx
          .delete(channelParticipantsTable)
          .where(
            and(
              eq(channelParticipantsTable.channelId, channelId),
              inArray(channelParticipantsTable.entityId, toRemove)
            )
          );
      }

      if (toAdd.length > 0) {
        await tx
          .insert(channelParticipantsTable)
          .values(toAdd.map((entityId) => ({ channelId, entityId })))
          .onConflictDoNothing();
      }
    }
  });

  // Return updated channel details
  const updatedChannel = await getChannelDetails(db, channelId);
  if (!updatedChannel) {
    throw new Error(`Channel ${channelId} not found after update`);
  }
  return updatedChannel;
}

/**
 * Deletes a channel and all its associated data.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} channelId - The ID of the channel to delete.
 */
export async function deleteChannel(db: DrizzleDatabase, channelId: UUID): Promise<void> {
  await db.transaction(async (tx) => {
    // Delete all messages in the channel
    await tx.delete(messageTable).where(eq(messageTable.channelId, channelId));

    // Delete all participants
    await tx
      .delete(channelParticipantsTable)
      .where(eq(channelParticipantsTable.channelId, channelId));

    // Delete the channel itself
    await tx.delete(channelTable).where(eq(channelTable.id, channelId));
  });
}

/**
 * Adds participants to a channel.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} channelId - The ID of the channel.
 * @param {UUID[]} entityIds - The entity IDs to add as participants.
 */
export async function addChannelParticipants(
  db: DrizzleDatabase,
  channelId: UUID,
  entityIds: UUID[]
): Promise<void> {
  if (!entityIds || entityIds.length === 0) return;

  const participantValues = entityIds.map((entityId) => ({
    channelId: channelId,
    entityId: entityId,
  }));

  await db.insert(channelParticipantsTable).values(participantValues).onConflictDoNothing();
}

/**
 * Gets participants for a channel.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} channelId - The ID of the channel.
 * @returns An array of entity UUIDs.
 */
export async function getChannelParticipants(
  db: DrizzleDatabase,
  channelId: UUID
): Promise<UUID[]> {
  const results = await db
    .select({ entityId: channelParticipantsTable.entityId })
    .from(channelParticipantsTable)
    .where(eq(channelParticipantsTable.channelId, channelId));

  return results.map((r) => r.entityId as UUID);
}

/**
 * Check if an entity is a participant in a specific messaging channel.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} channelId - The ID of the channel to check.
 * @param {UUID} entityId - The ID of the entity to check.
 * @returns True if entity is a participant.
 */
export async function isChannelParticipant(
  db: DrizzleDatabase,
  channelId: UUID,
  entityId: UUID
): Promise<boolean> {
  // WHY: SELECT 1 instead of SELECT * — we only need to know if the row
  // exists, not fetch all columns. Mirrors isRoomParticipant pattern.
  const result = await db
    .select({ one: sql`1` })
    .from(channelParticipantsTable)
    .where(
      and(
        eq(channelParticipantsTable.channelId, channelId),
        eq(channelParticipantsTable.entityId, entityId)
      )
    )
    .limit(1);

  return result.length > 0;
}

/**
 * Finds or creates a DM channel between two users.
 * @param {DrizzleDatabase} db - The database instance.
 * Finds or creates a DM channel between two users.
 *
 * WHY try/catch retry: the old code did SELECT → INSERT outside a transaction.
 * Under concurrent requests, both could see "not found" and race to INSERT,
 * causing duplicate key errors. The optimistic pattern (try INSERT, catch + re-read)
 * handles this without serializable isolation.
 *
 * @param {UUID} user1Id - The first user ID.
 * @param {UUID} user2Id - The second user ID.
 * @param {UUID} messageServerId - The message server ID.
 * @returns The DM channel.
 */
export async function findOrCreateDmChannel(
  db: DrizzleDatabase,
  user1Id: UUID,
  user2Id: UUID,
  messageServerId: UUID
): Promise<{
  id: UUID;
  messageServerId: UUID;
  name: string;
  type: string;
  sourceType?: string;
  sourceId?: string;
  topic?: string;
  metadata?: Metadata;
  createdAt: Date;
  updatedAt: Date;
}> {
  const ids = [user1Id, user2Id].sort();
  const dmChannelName = `DM-${ids[0]}-${ids[1]}`;

  const mapRow = (row: typeof channelTable.$inferSelect) => ({
    id: row.id as UUID,
    messageServerId: row.messageServerId as UUID,
    name: row.name,
    type: row.type,
    sourceType: row.sourceType || undefined,
    sourceId: row.sourceId || undefined,
    topic: row.topic || undefined,
    metadata: (row.metadata || undefined) as Metadata | undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  // Fast path: common case -- channel already exists
  const existing = await db
    .select()
    .from(channelTable)
    .where(
      and(
        eq(channelTable.type, ChannelType.DM),
        eq(channelTable.name, dmChannelName),
        eq(channelTable.messageServerId, messageServerId)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    return mapRow(existing[0]);
  }

  // Slow path: create, with retry on concurrent insert race
  try {
    return await createChannel(
      db,
      {
        messageServerId,
        name: dmChannelName,
        type: ChannelType.DM,
        metadata: { user1: ids[0], user2: ids[1] },
      },
      ids
    );
  } catch {
    // Concurrent insert won the race -- re-read the channel they created
    const retryExisting = await db
      .select()
      .from(channelTable)
      .where(
        and(
          eq(channelTable.type, ChannelType.DM),
          eq(channelTable.name, dmChannelName),
          eq(channelTable.messageServerId, messageServerId)
        )
      )
      .limit(1);

    if (retryExisting.length > 0) {
      return mapRow(retryExisting[0]);
    }
    throw new Error(`Failed to find or create DM channel: ${dmChannelName}`);
  }
}

// ===============================
// Message Methods
// ===============================

/**
 * Creates a message.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {object} data - The message data.
 * @returns The created message.
 */
export async function createMessage(
  db: DrizzleDatabase,
  data: {
    channelId: UUID;
    authorId: UUID;
    content: string;
    rawMessage?: Record<string, unknown>;
    sourceType?: string;
    sourceId?: string;
    metadata?: Metadata;
    inReplyToRootMessageId?: UUID;
    messageId?: UUID;
  }
): Promise<{
  id: UUID;
  channelId: UUID;
  authorId: UUID;
  content: string;
  rawMessage?: Record<string, unknown>;
  sourceType?: string;
  sourceId?: string;
  metadata?: Metadata;
  inReplyToRootMessageId?: UUID;
  createdAt: Date;
  updatedAt: Date;
}> {
  const newId = data.messageId || (v4() as UUID);
  const now = new Date();
  const messageToInsert = {
    id: newId,
    channelId: data.channelId,
    authorId: data.authorId,
    content: data.content,
    rawMessage: data.rawMessage,
    sourceType: data.sourceType,
    sourceId: data.sourceId,
    metadata: data.metadata,
    inReplyToRootMessageId: data.inReplyToRootMessageId,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(messageTable).values(messageToInsert);
  return messageToInsert;
}

/**
 * Gets a message by ID.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} id - The message ID.
 * @returns The message or null if not found.
 */
export async function getMessageById(
  db: DrizzleDatabase,
  id: UUID
): Promise<{
  id: UUID;
  channelId: UUID;
  authorId: UUID;
  content: string;
  rawMessage?: Record<string, unknown>;
  sourceType?: string;
  sourceId?: string;
  metadata?: Metadata;
  inReplyToRootMessageId?: UUID;
  createdAt: Date;
  updatedAt: Date;
} | null> {
  const rows = await db.select().from(messageTable).where(eq(messageTable.id, id)).limit(1);
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id as UUID,
    channelId: row.channelId as UUID,
    authorId: row.authorId as UUID,
    content: row.content,
    rawMessage: row.rawMessage || undefined,
    sourceType: row.sourceType || undefined,
    sourceId: row.sourceId || undefined,
    metadata: (row.metadata || undefined) as Metadata | undefined,
    inReplyToRootMessageId: (row.inReplyToRootMessageId || undefined) as UUID | undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Updates a message using UPDATE → SELECT instead of SELECT → UPDATE.
 *
 * WHY: The old code fetched the full row just to merge defaults, then wrote it back.
 * Since SQL UPDATE already preserves unmentioned columns, we only need to SET
 * the fields that were actually provided, then re-read to return the result.
 *
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} id - The message ID.
 * @param {object} patch - The fields to update.
 * @returns The updated message or null if not found.
 */
export async function updateMessage(
  db: DrizzleDatabase,
  id: UUID,
  patch: {
    content?: string;
    rawMessage?: Record<string, unknown>;
    sourceType?: string;
    sourceId?: string;
    metadata?: Metadata;
    inReplyToRootMessageId?: UUID;
  }
): Promise<{
  id: UUID;
  channelId: UUID;
  authorId: UUID;
  content: string;
  rawMessage?: Record<string, unknown>;
  sourceType?: string;
  sourceId?: string;
  metadata?: Metadata;
  inReplyToRootMessageId?: UUID;
  createdAt: Date;
  updatedAt: Date;
} | null> {
  const updatedAt = new Date();

  // Build SET clause with only the fields that were provided
  const setData: Record<string, unknown> = { updatedAt };
  if (patch.content !== undefined) setData.content = patch.content;
  if (patch.rawMessage !== undefined) setData.rawMessage = patch.rawMessage;
  if (patch.sourceType !== undefined) setData.sourceType = patch.sourceType;
  if (patch.sourceId !== undefined) setData.sourceId = patch.sourceId;
  if (patch.metadata !== undefined) setData.metadata = patch.metadata;
  if (patch.inReplyToRootMessageId !== undefined)
    setData.inReplyToRootMessageId = patch.inReplyToRootMessageId;

  await db.update(messageTable).set(setData).where(eq(messageTable.id, id));

  // Return the updated row (or null if it didn't exist)
  return getMessageById(db, id);
}

/**
 * Gets messages for a channel.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} channelId - The channel ID.
 * @param {number} [limit=50] - Maximum number of messages to return.
 * @param {Date} [beforeTimestamp] - Only return messages created before this timestamp.
 * @returns An array of messages.
 */
export async function getMessagesForChannel(
  db: DrizzleDatabase,
  channelId: UUID,
  limit: number = 50,
  beforeTimestamp?: Date
): Promise<
  Array<{
    id: UUID;
    channelId: UUID;
    authorId: UUID;
    content: string;
    rawMessage?: Record<string, unknown>;
    sourceType?: string;
    sourceId?: string;
    metadata?: Metadata;
    inReplyToRootMessageId?: UUID;
    createdAt: Date;
    updatedAt: Date;
  }>
> {
  const conditions = [eq(messageTable.channelId, channelId)];
  if (beforeTimestamp) {
    conditions.push(lt(messageTable.createdAt, beforeTimestamp));
  }

  const query = db
    .select()
    .from(messageTable)
    .where(and(...conditions))
    .orderBy(desc(messageTable.createdAt))
    .limit(limit);

  const results = await query;
  return results.map((r) => ({
    id: r.id as UUID,
    channelId: r.channelId as UUID,
    authorId: r.authorId as UUID,
    content: r.content,
    rawMessage: r.rawMessage || undefined,
    sourceType: r.sourceType || undefined,
    sourceId: r.sourceId || undefined,
    metadata: r.metadata || undefined,
    inReplyToRootMessageId: r.inReplyToRootMessageId as UUID | undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * Deletes a message.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} messageId - The ID of the message to delete.
 */
export async function deleteMessage(db: DrizzleDatabase, messageId: UUID): Promise<void> {
  await db.delete(messageTable).where(eq(messageTable.id, messageId));
}
