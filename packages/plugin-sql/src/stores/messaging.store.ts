import { ChannelType, type Metadata, type UUID } from '@elizaos/core';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { v4 } from 'uuid';
import {
  channelParticipantsTable,
  channelTable,
  messageServerAgentsTable,
  messageServerTable,
  messageTable,
} from '../schema/index';
import type { DrizzleDatabase } from '../types';
import type { Store, StoreContext } from './types';

// Type definitions for messaging entities
export type MessageServer = {
  id: UUID;
  name: string;
  sourceType: string;
  sourceId?: string;
  metadata?: Metadata;
  createdAt: Date;
  updatedAt: Date;
};

// Raw SQL row type (snake_case columns from database)
type RawMessageServerRow = {
  id: string;
  name: string;
  source_type: string;
  source_id: string | null;
  metadata: Metadata | null;
  created_at: string;
  updated_at: string;
};

export type Channel = {
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
};

export type Message = {
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
};

export class MessagingStore implements Store {
  constructor(public readonly ctx: StoreContext) {}

  private get db(): DrizzleDatabase {
    return this.ctx.getDb();
  }

  // ============================================
  // Message Server Operations
  // ============================================

  async createMessageServer(data: {
    id?: UUID;
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: Metadata;
  }): Promise<MessageServer> {
    return this.ctx.withRetry(async () => {
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

      await this.db.insert(messageServerTable).values(serverToInsert).onConflictDoNothing();

      // If server already existed, fetch it
      if (data.id) {
        const existing = await this.db
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
            metadata: existing[0].metadata || undefined,
            createdAt: existing[0].createdAt,
            updatedAt: existing[0].updatedAt,
          };
        }
      }

      return serverToInsert;
    }, 'MessagingStore.createMessageServer');
  }

  async getMessageServers(): Promise<MessageServer[]> {
    const result = await this.ctx.withRetry(async () => {
      const results = await this.db.select().from(messageServerTable);
      return results.map((r) => ({
        id: r.id as UUID,
        name: r.name,
        sourceType: r.sourceType,
        sourceId: r.sourceId || undefined,
        metadata: r.metadata || undefined,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    }, 'MessagingStore.getMessageServers');
    return result || [];
  }

  async getMessageServerById(serverId: UUID): Promise<MessageServer | null> {
    return this.ctx.withRetry(async () => {
      const results = await this.db
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
            metadata: results[0].metadata || undefined,
            createdAt: results[0].createdAt,
            updatedAt: results[0].updatedAt,
          }
        : null;
    }, 'MessagingStore.getMessageServerById');
  }

  async getMessageServerByRlsServerId(rlsServerId: UUID): Promise<MessageServer | null> {
    return this.ctx.withRetry(async () => {
      // Use raw SQL since server_id column is dynamically added by RLS and not in Drizzle schema
      const results = await this.db.execute<RawMessageServerRow>(sql`
        SELECT id, name, source_type, source_id, metadata, created_at, updated_at
        FROM message_servers
        WHERE server_id = ${rlsServerId}
        LIMIT 1
      `);

      const rows = results.rows || results;
      if (rows.length === 0) return null;

      const row = rows[0];
      return {
        id: row.id as UUID,
        name: row.name,
        sourceType: row.source_type,
        sourceId: row.source_id || undefined,
        metadata: row.metadata || undefined,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      };
    }, 'MessagingStore.getMessageServerByRlsServerId');
  }

  // ============================================
  // Server Agent Operations
  // ============================================

  async addAgentToMessageServer(messageServerId: UUID, agentId: UUID): Promise<void> {
    return this.ctx.withRetry(async () => {
      await this.db
        .insert(messageServerAgentsTable)
        .values({
          messageServerId,
          agentId,
        })
        .onConflictDoNothing();
    }, 'MessagingStore.addAgentToMessageServer');
  }

  async getAgentsForMessageServer(messageServerId: UUID): Promise<UUID[]> {
    return this.ctx.withRetry(async () => {
      const results = await this.db
        .select({ agentId: messageServerAgentsTable.agentId })
        .from(messageServerAgentsTable)
        .where(eq(messageServerAgentsTable.messageServerId, messageServerId));

      return results.map((r) => r.agentId as UUID);
    }, 'MessagingStore.getAgentsForMessageServer');
  }

  async removeAgentFromMessageServer(messageServerId: UUID, agentId: UUID): Promise<void> {
    return this.ctx.withRetry(async () => {
      await this.db
        .delete(messageServerAgentsTable)
        .where(
          and(
            eq(messageServerAgentsTable.messageServerId, messageServerId),
            eq(messageServerAgentsTable.agentId, agentId)
          )
        );
    }, 'MessagingStore.removeAgentFromMessageServer');
  }

  // ============================================
  // Channel Operations
  // ============================================

  async createChannel(
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
  ): Promise<Channel> {
    return this.ctx.withRetry(async () => {
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

      // UPSERT: insert channel, ignore if already exists
      await this.db.insert(channelTable).values(channelToInsert).onConflictDoNothing();

      // UPSERT: insert participants, ignore duplicates
      if (participantIds && participantIds.length > 0) {
        const participantValues = participantIds.map((entityId) => ({
          channelId: newId,
          entityId: entityId,
        }));
        await this.db
          .insert(channelParticipantsTable)
          .values(participantValues)
          .onConflictDoNothing();
      }

      return channelToInsert;
    }, 'MessagingStore.createChannel');
  }

  async getChannelsForMessageServer(messageServerId: UUID): Promise<Channel[]> {
    return this.ctx.withRetry(async () => {
      const results = await this.db
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
        metadata: r.metadata || undefined,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    }, 'MessagingStore.getChannelsForMessageServer');
  }

  async getChannelDetails(channelId: UUID): Promise<Channel | null> {
    return this.ctx.withRetry(async () => {
      const results = await this.db
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
            metadata: results[0].metadata || undefined,
            createdAt: results[0].createdAt,
            updatedAt: results[0].updatedAt,
          }
        : null;
    }, 'MessagingStore.getChannelDetails');
  }

  async updateChannel(
    channelId: UUID,
    updates: { name?: string; participantCentralUserIds?: UUID[]; metadata?: Metadata }
  ): Promise<Channel> {
    return this.ctx.withRetry(async () => {
      const now = new Date();

      // Wrap in transaction for atomicity (delete + insert participants must succeed together)
      await this.db.transaction(async (tx) => {
        // Update channel details
        const updateData: Record<string, unknown> = { updatedAt: now };
        if (updates.name !== undefined) updateData.name = updates.name;
        if (updates.metadata !== undefined) updateData.metadata = updates.metadata;

        await tx.update(channelTable).set(updateData).where(eq(channelTable.id, channelId));

        // Update participants if provided
        if (updates.participantCentralUserIds !== undefined) {
          // Remove existing participants
          await tx
            .delete(channelParticipantsTable)
            .where(eq(channelParticipantsTable.channelId, channelId));

          // Add new participants
          if (updates.participantCentralUserIds.length > 0) {
            const participantValues = updates.participantCentralUserIds.map((entityId) => ({
              channelId: channelId,
              entityId: entityId,
            }));
            await tx
              .insert(channelParticipantsTable)
              .values(participantValues)
              .onConflictDoNothing();
          }
        }
      });

      // Return updated channel details
      const updatedChannel = await this.getChannelDetails(channelId);
      if (!updatedChannel) {
        throw new Error(`Channel ${channelId} not found after update`);
      }
      return updatedChannel;
    }, 'MessagingStore.updateChannel');
  }

  async deleteChannel(channelId: UUID): Promise<void> {
    return this.ctx.withRetry(async () => {
      await this.db.transaction(async (tx) => {
        // Delete all messages in the channel
        await tx.delete(messageTable).where(eq(messageTable.channelId, channelId));

        // Delete all participants
        await tx
          .delete(channelParticipantsTable)
          .where(eq(channelParticipantsTable.channelId, channelId));

        // Delete the channel itself
        await tx.delete(channelTable).where(eq(channelTable.id, channelId));
      });
    }, 'MessagingStore.deleteChannel');
  }

  async findOrCreateDmChannel(
    user1Id: UUID,
    user2Id: UUID,
    messageServerId: UUID
  ): Promise<Channel> {
    return this.ctx.withRetry(async () => {
      const ids = [user1Id, user2Id].sort();
      const dmChannelName = `DM-${ids[0]}-${ids[1]}`;

      const existingChannels = await this.db
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

      if (existingChannels.length > 0) {
        return {
          id: existingChannels[0].id as UUID,
          messageServerId: existingChannels[0].messageServerId as UUID,
          name: existingChannels[0].name,
          type: existingChannels[0].type,
          sourceType: existingChannels[0].sourceType || undefined,
          sourceId: existingChannels[0].sourceId || undefined,
          topic: existingChannels[0].topic || undefined,
          metadata: existingChannels[0].metadata || undefined,
          createdAt: existingChannels[0].createdAt,
          updatedAt: existingChannels[0].updatedAt,
        };
      }

      // Create new DM channel
      return this.createChannel(
        {
          messageServerId,
          name: dmChannelName,
          type: ChannelType.DM,
          metadata: { user1: ids[0], user2: ids[1] },
        },
        ids
      );
    }, 'MessagingStore.findOrCreateDmChannel');
  }

  // ============================================
  // Channel Participant Operations
  // ============================================

  async addChannelParticipants(channelId: UUID, entityIds: UUID[]): Promise<void> {
    return this.ctx.withRetry(async () => {
      if (!entityIds || entityIds.length === 0) return;

      const participantValues = entityIds.map((entityId) => ({
        channelId: channelId,
        entityId: entityId,
      }));

      await this.db
        .insert(channelParticipantsTable)
        .values(participantValues)
        .onConflictDoNothing();
    }, 'MessagingStore.addChannelParticipants');
  }

  async getChannelParticipants(channelId: UUID): Promise<UUID[]> {
    return this.ctx.withRetry(async () => {
      const results = await this.db
        .select({ entityId: channelParticipantsTable.entityId })
        .from(channelParticipantsTable)
        .where(eq(channelParticipantsTable.channelId, channelId));

      return results.map((r) => r.entityId as UUID);
    }, 'MessagingStore.getChannelParticipants');
  }

  async isChannelParticipant(channelId: UUID, entityId: UUID): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      const result = await this.db
        .select()
        .from(channelParticipantsTable)
        .where(
          and(
            eq(channelParticipantsTable.channelId, channelId),
            eq(channelParticipantsTable.entityId, entityId)
          )
        )
        .limit(1);

      return result.length > 0;
    }, 'MessagingStore.isChannelParticipant');
  }

  // ============================================
  // Message Operations
  // ============================================

  async createMessage(data: {
    channelId: UUID;
    authorId: UUID;
    content: string;
    rawMessage?: Record<string, unknown>;
    sourceType?: string;
    sourceId?: string;
    metadata?: Metadata;
    inReplyToRootMessageId?: UUID;
    messageId?: UUID;
  }): Promise<Message> {
    return this.ctx.withRetry(async () => {
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

      await this.db.insert(messageTable).values(messageToInsert);
      return messageToInsert;
    }, 'MessagingStore.createMessage');
  }

  async getMessageById(id: UUID): Promise<Message | null> {
    return this.ctx.withRetry(async () => {
      const rows = await this.db
        .select()
        .from(messageTable)
        .where(eq(messageTable.id, id))
        .limit(1);
      if (!rows || rows.length === 0) return null;
      const r = rows[0];
      return {
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
      };
    }, 'MessagingStore.getMessageById');
  }

  async updateMessage(
    id: UUID,
    patch: {
      content?: string;
      rawMessage?: Record<string, unknown>;
      sourceType?: string;
      sourceId?: string;
      metadata?: Metadata;
      inReplyToRootMessageId?: UUID;
    }
  ): Promise<Message | null> {
    return this.ctx.withRetry(async () => {
      const existing = await this.getMessageById(id);
      if (!existing) return null;

      const updatedAt = new Date();
      const next = {
        content: patch.content ?? existing.content,
        rawMessage: patch.rawMessage ?? existing.rawMessage,
        sourceType: patch.sourceType ?? existing.sourceType,
        sourceId: patch.sourceId ?? existing.sourceId,
        metadata: patch.metadata ?? existing.metadata,
        inReplyToRootMessageId: patch.inReplyToRootMessageId ?? existing.inReplyToRootMessageId,
        updatedAt,
      };

      await this.db.update(messageTable).set(next).where(eq(messageTable.id, id));

      return {
        ...existing,
        ...next,
      };
    }, 'MessagingStore.updateMessage');
  }

  async getMessagesForChannel(
    channelId: UUID,
    limit: number = 50,
    beforeTimestamp?: Date
  ): Promise<Message[]> {
    return this.ctx.withRetry(async () => {
      const conditions = [eq(messageTable.channelId, channelId)];
      if (beforeTimestamp) {
        conditions.push(lt(messageTable.createdAt, beforeTimestamp));
      }

      const query = this.db
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
    }, 'MessagingStore.getMessagesForChannel');
  }

  async deleteMessage(messageId: UUID): Promise<void> {
    return this.ctx.withRetry(async () => {
      await this.db.delete(messageTable).where(eq(messageTable.id, messageId));
    }, 'MessagingStore.deleteMessage');
  }
}
