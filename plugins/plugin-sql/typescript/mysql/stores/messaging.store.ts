import {
  ChannelType,
  type Metadata,
  type UUID,
} from "@elizaos/core";
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
// Message Server Operations
// ===============================

/**
 * Creates a new message server in the central database.
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

  await db
    .insert(messageServerTable)
    .values(serverToInsert)
    .onDuplicateKeyUpdate({ set: { id: sql`id` } });

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
 */
export async function getMessageServers(
  db: DrizzleDatabase
): Promise<
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

  const rows = Array.isArray(results)
    ? (results[0] as unknown as Record<string, unknown>[])
    : [];
  return rows.length > 0
    ? {
        id: rows[0].id as UUID,
        name: rows[0].name as string,
        sourceType: rows[0].source_type as string,
        sourceId: (rows[0].source_id || undefined) as string | undefined,
        metadata: (rows[0].metadata || undefined) as Metadata | undefined,
        createdAt: new Date(rows[0].created_at as string),
        updatedAt: new Date(rows[0].updated_at as string),
      }
    : null;
}

// ===============================
// Message Server Agent Operations
// ===============================

/**
 * Adds an agent to a message server (Discord/Telegram server).
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
    .onDuplicateKeyUpdate({ set: { messageServerId: sql`message_server_id` } });
}

/**
 * Gets agents for a message server (Discord/Telegram server).
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
// Channel Operations
// ===============================

/**
 * Creates a new channel.
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
      await tx
        .insert(channelParticipantsTable)
        .values(participantValues)
        .onDuplicateKeyUpdate({ set: { channelId: sql`channel_id` } });
    }
  });

  return channelToInsert;
}

/**
 * Gets channels for a message server.
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
 * Gets channel details.
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
          .onDuplicateKeyUpdate({ set: { channelId: sql`channel_id` } });
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
 */
export async function deleteChannel(
  db: DrizzleDatabase,
  channelId: UUID
): Promise<void> {
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

// ===============================
// Channel Participant Operations
// ===============================

/**
 * Adds participants to a channel.
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

  await db
    .insert(channelParticipantsTable)
    .values(participantValues)
    .onDuplicateKeyUpdate({ set: { channelId: sql`channel_id` } });
}

/**
 * Gets participants for a channel.
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

// ===============================
// Message Operations
// ===============================

/**
 * Creates a message.
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
  const rows = await db
    .select()
    .from(messageTable)
    .where(eq(messageTable.id, id))
    .limit(1);
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
 * Updates a message using a single UPDATE + SELECT instead of SELECT + UPDATE.
 *
 * WHY: The old code did SELECT (full row) → merge in JS → UPDATE → return merged.
 * The new code does UPDATE (only changed columns) → SELECT (full row for return).
 * This avoids the initial SELECT entirely when we only need to set fields.
 * If nothing was updated (row doesn't exist), the subsequent SELECT returns null.
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
  if (patch.inReplyToRootMessageId !== undefined) setData.inReplyToRootMessageId = patch.inReplyToRootMessageId;

  await db.update(messageTable).set(setData).where(eq(messageTable.id, id));

  // Return the updated row (or null if it didn't exist)
  return getMessageById(db, id);
}

/**
 * Gets messages for a channel.
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
 */
export async function deleteMessage(
  db: DrizzleDatabase,
  messageId: UUID
): Promise<void> {
  await db.delete(messageTable).where(eq(messageTable.id, messageId));
}

// ===============================
// DM Channel Operations
// ===============================

/**
 * Finds or creates a DM channel between two users.
 *
 * WHY transaction: the old code did SELECT → INSERT outside a transaction.
 * Under concurrent requests (two agents messaging simultaneously), both could
 * see "not found" and both try to INSERT, causing a duplicate or error.
 * Wrapping in a transaction with a re-check after INSERT attempt fixes the race.
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

  // Fast path: check without transaction (common case -- channel already exists)
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

  // Slow path: create inside a transaction to handle concurrent creation
  try {
    return await createChannel(
      db,
      {
        messageServerId,
        name: dmChannelName,
        type: ChannelType.DM,
        metadata: { user1: ids[0], user2: ids[1] },
      },
      ids as UUID[]
    );
  } catch {
    // If creation failed (e.g. duplicate key from concurrent insert),
    // re-fetch -- the other request must have created it
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
