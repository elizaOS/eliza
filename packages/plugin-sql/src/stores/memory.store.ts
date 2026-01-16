import { logger, type Memory, type MemoryMetadata, type UUID } from '@elizaos/core';
import { and, cosineDistance, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { v4 } from 'uuid';
import { embeddingTable, memoryTable } from '../schema/index';
import type { DrizzleDatabase } from '../types';
import type { Store, StoreContext } from './types';

export class MemoryStore implements Store {
  constructor(public readonly ctx: StoreContext) {}

  private get db(): DrizzleDatabase {
    return this.ctx.getDb();
  }

  async get(params: {
    entityId?: UUID;
    agentId?: UUID;
    count?: number;
    offset?: number;
    unique?: boolean;
    tableName: string;
    start?: number;
    end?: number;
    roomId?: UUID;
    worldId?: UUID;
  }): Promise<Memory[]> {
    const { entityId, agentId, roomId, worldId, tableName, unique, start, end, offset } = params;

    if (!tableName) throw new Error('tableName is required');
    if (offset !== undefined && offset < 0) {
      throw new Error('offset must be a non-negative number');
    }

    return this.ctx.withIsolationContext(entityId ?? null, async (tx) => {
      const conditions = [eq(memoryTable.type, tableName)];

      if (start) conditions.push(gte(memoryTable.createdAt, new Date(start)));
      if (roomId) conditions.push(eq(memoryTable.roomId, roomId));
      if (worldId) conditions.push(eq(memoryTable.worldId, worldId));
      if (end) conditions.push(lte(memoryTable.createdAt, new Date(end)));
      if (unique) conditions.push(eq(memoryTable.unique, true));
      if (agentId) conditions.push(eq(memoryTable.agentId, agentId));

      const baseQuery = tx
        .select({
          memory: {
            id: memoryTable.id,
            type: memoryTable.type,
            createdAt: memoryTable.createdAt,
            content: memoryTable.content,
            entityId: memoryTable.entityId,
            agentId: memoryTable.agentId,
            roomId: memoryTable.roomId,
            unique: memoryTable.unique,
            metadata: memoryTable.metadata,
          },
          embedding: embeddingTable[this.ctx.getEmbeddingDimension()],
        })
        .from(memoryTable)
        .leftJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
        .where(and(...conditions))
        .orderBy(desc(memoryTable.createdAt), desc(memoryTable.id));

      const rows = await (async () => {
        if (params.count && offset !== undefined && offset > 0) {
          return baseQuery.limit(params.count).offset(offset);
        } else if (params.count) {
          return baseQuery.limit(params.count);
        } else if (offset !== undefined && offset > 0) {
          return baseQuery.offset(offset);
        }
        return baseQuery;
      })();

      return rows.map((row) => ({
        id: row.memory.id as UUID,
        type: row.memory.type,
        createdAt: row.memory.createdAt.getTime(),
        content:
          typeof row.memory.content === 'string'
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        unique: row.memory.unique,
        metadata: row.memory.metadata as MemoryMetadata,
        embedding: row.embedding ? Array.from(row.embedding) : undefined,
      }));
    });
  }

  async getByRoomIds(params: {
    roomIds: UUID[];
    tableName: string;
    limit?: number;
  }): Promise<Memory[]> {
    return this.ctx.withRetry(async () => {
      if (params.roomIds.length === 0) return [];

      const conditions = [
        eq(memoryTable.type, params.tableName),
        inArray(memoryTable.roomId, params.roomIds),
        eq(memoryTable.agentId, this.ctx.agentId),
      ];

      const query = this.db
        .select({
          id: memoryTable.id,
          type: memoryTable.type,
          createdAt: memoryTable.createdAt,
          content: memoryTable.content,
          entityId: memoryTable.entityId,
          agentId: memoryTable.agentId,
          roomId: memoryTable.roomId,
          unique: memoryTable.unique,
          metadata: memoryTable.metadata,
        })
        .from(memoryTable)
        .where(and(...conditions))
        .orderBy(desc(memoryTable.createdAt), desc(memoryTable.id));

      const rows = params.limit ? await query.limit(params.limit) : await query;

      return rows.map((row) => ({
        id: row.id as UUID,
        createdAt: row.createdAt.getTime(),
        content: typeof row.content === 'string' ? JSON.parse(row.content) : row.content,
        entityId: row.entityId as UUID,
        agentId: row.agentId as UUID,
        roomId: row.roomId as UUID,
        unique: row.unique,
        metadata: row.metadata,
      })) as Memory[];
    }, 'MemoryStore.getByRoomIds');
  }

  async getById(id: UUID): Promise<Memory | null> {
    return this.ctx.withRetry(async () => {
      // Split query to avoid Drizzle ORM issue with leftJoin on dynamic vector columns
      const memoryResult = await this.db
        .select()
        .from(memoryTable)
        .where(eq(memoryTable.id, id))
        .limit(1);

      if (memoryResult.length === 0) return null;

      const memory = memoryResult[0];

      // Fetch embedding separately
      let embedding: number[] | undefined;
      try {
        const embeddingCol = this.ctx.getEmbeddingDimension();
        const embeddingResult = await this.db
          .select({ embedding: embeddingTable[embeddingCol] })
          .from(embeddingTable)
          .where(eq(embeddingTable.memoryId, id))
          .limit(1);

        embedding = embeddingResult[0]?.embedding ?? undefined;
      } catch {
        embedding = undefined;
      }

      return {
        id: memory.id as UUID,
        createdAt: memory.createdAt.getTime(),
        content: typeof memory.content === 'string' ? JSON.parse(memory.content) : memory.content,
        entityId: memory.entityId as UUID,
        agentId: memory.agentId as UUID,
        roomId: memory.roomId as UUID,
        unique: memory.unique,
        metadata: memory.metadata as MemoryMetadata,
        embedding,
      };
    }, 'MemoryStore.getById');
  }

  async getByIds(memoryIds: UUID[], tableName?: string): Promise<Memory[]> {
    return this.ctx.withRetry(async () => {
      if (memoryIds.length === 0) return [];

      const conditions = [inArray(memoryTable.id, memoryIds)];
      if (tableName) conditions.push(eq(memoryTable.type, tableName));

      const rows = await this.db
        .select({
          memory: memoryTable,
          embedding: embeddingTable[this.ctx.getEmbeddingDimension()],
        })
        .from(memoryTable)
        .leftJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
        .where(and(...conditions))
        .orderBy(desc(memoryTable.createdAt), desc(memoryTable.id));

      return rows.map((row) => ({
        id: row.memory.id as UUID,
        createdAt: row.memory.createdAt.getTime(),
        content:
          typeof row.memory.content === 'string'
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        unique: row.memory.unique,
        metadata: row.memory.metadata as MemoryMetadata,
        embedding: row.embedding ?? undefined,
      }));
    }, 'MemoryStore.getByIds');
  }

  async searchByEmbedding(
    embedding: number[],
    params: {
      match_threshold?: number;
      count?: number;
      roomId?: UUID;
      worldId?: UUID;
      entityId?: UUID;
      unique?: boolean;
      tableName: string;
    }
  ): Promise<Memory[]> {
    return this.ctx.withRetry(async () => {
      const cleanVector = embedding.map((n) => (Number.isFinite(n) ? Number(n.toFixed(6)) : 0));

      const similarity = sql<number>`1 - (${cosineDistance(
        embeddingTable[this.ctx.getEmbeddingDimension()],
        cleanVector
      )})`;

      const conditions = [
        eq(memoryTable.type, params.tableName),
        eq(memoryTable.agentId, this.ctx.agentId),
      ];

      if (params.unique) conditions.push(eq(memoryTable.unique, true));
      if (params.roomId) conditions.push(eq(memoryTable.roomId, params.roomId));
      if (params.worldId) conditions.push(eq(memoryTable.worldId, params.worldId));
      if (params.entityId) conditions.push(eq(memoryTable.entityId, params.entityId));
      if (params.match_threshold) conditions.push(gte(similarity, params.match_threshold));

      const results = await this.db
        .select({
          memory: memoryTable,
          similarity,
          embedding: embeddingTable[this.ctx.getEmbeddingDimension()],
        })
        .from(embeddingTable)
        .innerJoin(memoryTable, eq(memoryTable.id, embeddingTable.memoryId))
        .where(and(...conditions))
        .orderBy(desc(similarity))
        .limit(params.count ?? 10);

      return results.map((row) => ({
        id: row.memory.id as UUID,
        type: row.memory.type,
        createdAt: row.memory.createdAt.getTime(),
        content:
          typeof row.memory.content === 'string'
            ? JSON.parse(row.memory.content)
            : row.memory.content,
        entityId: row.memory.entityId as UUID,
        agentId: row.memory.agentId as UUID,
        roomId: row.memory.roomId as UUID,
        worldId: row.memory.worldId as UUID | undefined,
        unique: row.memory.unique,
        metadata: row.memory.metadata as MemoryMetadata,
        embedding: row.embedding ?? undefined,
        similarity: row.similarity,
      }));
    }, 'MemoryStore.searchByEmbedding');
  }

  async create(memory: Memory & { metadata?: MemoryMetadata }, tableName: string): Promise<UUID> {
    const memoryId = memory.id ?? (v4() as UUID);

    if (memory.unique === undefined) {
      memory.unique = true;
      if (memory.embedding && Array.isArray(memory.embedding)) {
        const similarMemories = await this.searchByEmbedding(memory.embedding, {
          tableName,
          roomId: memory.roomId,
          worldId: memory.worldId,
          entityId: memory.entityId,
          match_threshold: 0.95,
          count: 1,
        });
        memory.unique = similarMemories.length === 0;
      }
    }

    const contentToInsert =
      typeof memory.content === 'string' ? memory.content : JSON.stringify(memory.content ?? {});

    const metadataToInsert =
      typeof memory.metadata === 'string' ? memory.metadata : JSON.stringify(memory.metadata ?? {});

    await this.ctx.withIsolationContext(memory.entityId, async (tx) => {
      const inserted = await tx
        .insert(memoryTable)
        .values([
          {
            id: memoryId,
            type: tableName,
            content: sql`${contentToInsert}::jsonb`,
            metadata: sql`${metadataToInsert}::jsonb`,
            entityId: memory.entityId,
            roomId: memory.roomId,
            worldId: memory.worldId,
            agentId: memory.agentId || this.ctx.agentId,
            unique: memory.unique,
            createdAt: memory.createdAt ? new Date(memory.createdAt) : new Date(),
          },
        ])
        .onConflictDoNothing()
        .returning();

      if (inserted.length > 0 && memory.embedding && Array.isArray(memory.embedding)) {
        await this.upsertEmbedding(tx, memoryId, memory.embedding);
      }
    });

    return memoryId;
  }

  async update(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }
  ): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      try {
        await this.db.transaction(async (tx) => {
          if (memory.content) {
            const contentToUpdate =
              typeof memory.content === 'string'
                ? memory.content
                : JSON.stringify(memory.content ?? {});

            const metadataToUpdate =
              typeof memory.metadata === 'string'
                ? memory.metadata
                : JSON.stringify(memory.metadata ?? {});

            await tx
              .update(memoryTable)
              .set({
                content: sql`${contentToUpdate}::jsonb`,
                ...(memory.metadata && { metadata: sql`${metadataToUpdate}::jsonb` }),
              })
              .where(eq(memoryTable.id, memory.id));
          } else if (memory.metadata) {
            const metadataToUpdate =
              typeof memory.metadata === 'string'
                ? memory.metadata
                : JSON.stringify(memory.metadata ?? {});

            await tx
              .update(memoryTable)
              .set({ metadata: sql`${metadataToUpdate}::jsonb` })
              .where(eq(memoryTable.id, memory.id));
          }

          if (memory.embedding && Array.isArray(memory.embedding)) {
            await this.upsertEmbedding(tx, memory.id, memory.embedding);
          }
        });

        return true;
      } catch (error) {
        logger.error(
          {
            src: 'plugin:sql',
            memoryId: memory.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to update memory'
        );
        return false;
      }
    }, 'MemoryStore.update');
  }

  async delete(memoryId: UUID): Promise<void> {
    return this.ctx.withRetry(async () => {
      await this.db.transaction(async (tx) => {
        await this.deleteFragments(tx, memoryId);
        await tx.delete(embeddingTable).where(eq(embeddingTable.memoryId, memoryId));
        await tx.delete(memoryTable).where(eq(memoryTable.id, memoryId));
      });
    }, 'MemoryStore.delete');
  }

  async deleteMany(memoryIds: UUID[]): Promise<void> {
    if (memoryIds.length === 0) return;

    return this.ctx.withRetry(async () => {
      await this.db.transaction(async (tx) => {
        const BATCH_SIZE = 100;
        for (let i = 0; i < memoryIds.length; i += BATCH_SIZE) {
          const batch = memoryIds.slice(i, i + BATCH_SIZE);

          await Promise.all(batch.map((id) => this.deleteFragments(tx, id)));
          await tx.delete(embeddingTable).where(inArray(embeddingTable.memoryId, batch));
          await tx.delete(memoryTable).where(inArray(memoryTable.id, batch));
        }
      });
    }, 'MemoryStore.deleteMany');
  }

  async deleteAllByRoom(roomId: UUID, tableName: string): Promise<void> {
    return this.ctx.withRetry(async () => {
      await this.db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: memoryTable.id })
          .from(memoryTable)
          .where(and(eq(memoryTable.roomId, roomId), eq(memoryTable.type, tableName)));

        const ids = rows.map((r) => r.id);
        if (ids.length === 0) return;

        await Promise.all(
          ids.map(async (memoryId) => {
            await this.deleteFragments(tx, memoryId);
            await tx.delete(embeddingTable).where(eq(embeddingTable.memoryId, memoryId));
          })
        );

        await tx
          .delete(memoryTable)
          .where(and(eq(memoryTable.roomId, roomId), eq(memoryTable.type, tableName)));
      });
    }, 'MemoryStore.deleteAllByRoom');
  }

  async count(roomId: UUID, unique = true, tableName = ''): Promise<number> {
    if (!tableName) throw new Error('tableName is required');

    return this.ctx.withRetry(async () => {
      const conditions = [eq(memoryTable.roomId, roomId), eq(memoryTable.type, tableName)];
      if (unique) conditions.push(eq(memoryTable.unique, true));

      const result = await this.db
        .select({ count: sql<number>`count(*)` })
        .from(memoryTable)
        .where(and(...conditions));

      return Number(result[0]?.count ?? 0);
    }, 'MemoryStore.count');
  }

  private async upsertEmbedding(
    tx: DrizzleDatabase,
    memoryId: UUID,
    embedding: number[]
  ): Promise<void> {
    const cleanVector = embedding.map((n) => (Number.isFinite(n) ? Number(n.toFixed(6)) : 0));

    const existingEmbedding = await tx
      .select({ id: embeddingTable.id })
      .from(embeddingTable)
      .where(eq(embeddingTable.memoryId, memoryId))
      .limit(1);

    if (existingEmbedding.length > 0) {
      const updateValues: Record<string, unknown> = {};
      updateValues[this.ctx.getEmbeddingDimension()] = cleanVector;
      await tx
        .update(embeddingTable)
        .set(updateValues)
        .where(eq(embeddingTable.memoryId, memoryId));
    } else {
      const embeddingValues: Record<string, unknown> = { id: v4(), memoryId };
      embeddingValues[this.ctx.getEmbeddingDimension()] = cleanVector;
      await tx.insert(embeddingTable).values([embeddingValues]);
    }
  }

  private async deleteFragments(tx: DrizzleDatabase, documentId: UUID): Promise<void> {
    const fragments = await tx
      .select({ id: memoryTable.id })
      .from(memoryTable)
      .where(
        and(
          eq(memoryTable.agentId, this.ctx.agentId),
          sql`${memoryTable.metadata}->>'documentId' = ${documentId}`
        )
      );

    if (fragments.length > 0) {
      const fragmentIds = fragments.map((f) => f.id) as UUID[];
      await tx.delete(embeddingTable).where(inArray(embeddingTable.memoryId, fragmentIds));
      await tx.delete(memoryTable).where(inArray(memoryTable.id, fragmentIds));
    }
  }
}
