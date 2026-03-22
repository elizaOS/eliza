/**
 * PostgreSQL Memory Store - Batch-optimized CRUD operations for memories and embeddings
 * 
 * ARCHITECTURE:
 * - All operations are batch-first (accept arrays, not single items)
 * - Multi-row INSERT/UPDATE for performance (10-100x faster than loops)
 * - JSON containment operators (@>) for metadata filtering (GIN-indexed)
 * - Cosine distance for vector similarity search (indexed with HNSW)
 * 
 * WHY BATCH-FIRST:
 * Memory operations are inherently multi-item:
 * - Conversation import: 100s of messages at once
 * - Knowledge base seeding: 1000s of documents
 * - Context retrieval: Top-K relevant memories
 * Even single-message flows benefit: createMemory() wraps createMemories([memory]).
 * 
 * PERFORMANCE CHARACTERISTICS:
 * - getMemories with metadata: O(log N) with GIN index
 * - createMemories: O(N) with multi-row INSERT
 * - updateMemories: O(N) with CASE expression in single UPDATE
 * - searchMemories: O(log N) with vector index (HNSW/IVF)
 */
import {
  type Memory,
  type MemoryMetadata,
  type UUID,
  logger,
} from "@elizaos/core";
import { and, asc, cosineDistance, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { v4 } from "uuid";
import { embeddingTable, memoryTable, roomTable } from "../tables";
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from "../tables";
import type { DrizzleDatabase } from "../types";

/**
 * Retrieves memories from the database based on the provided parameters.
 * 
 * WHY: This is the primary query method for conversational history and knowledge retrieval.
 * Supports multiple filter dimensions (entity, room, world, time range, metadata) to enable:
 * - Context building for LLM prompts
 * - Knowledge base search
 * - Conversation history pagination
 * 
 * PERFORMANCE: Uses indexed lookups for all filter conditions. The metadata filter
 * uses PostgreSQL's GIN-indexed @> operator, enabling sub-100ms queries on millions of rows.
 * 
 * @param {DrizzleDatabase} db - The database instance (may be a transaction context).
 * @param {EmbeddingDimensionColumn} embeddingDimension - The embedding dimension column to use.
 * @param {Object} params - The parameters for retrieving memories.
 * @param {UUID} [params.entityId] - The entity ID to scope the query.
 * @param {UUID} [params.agentId] - The agent ID to filter by.
 * @param {number} [params.limit] - Max results to return (preferred over deprecated 'count').
 * @param {number} [params.count] - @deprecated Use 'limit' instead.
 * @param {number} [params.offset] - Skip first N results for pagination.
 * @param {boolean} [params.unique] - Whether to retrieve unique memories only.
 * @param {string} params.tableName - Memory type (messages, documents, etc.) - required.
 * @param {number} [params.start] - Start timestamp (milliseconds) for time range filter.
 * @param {number} [params.end] - End timestamp (milliseconds) for time range filter.
 * @param {UUID} [params.roomId] - The room ID to filter by.
 * @param {UUID} [params.worldId] - The world ID to filter by.
 * @param {Record<string, unknown>} [params.metadata] - Filter by metadata fields (JSON containment).
 * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
 */
export async function getMemories(
  db: DrizzleDatabase,
  embeddingDimension: EmbeddingDimensionColumn,
  params: {
    entityId?: UUID;
    agentId?: UUID;
    /** @deprecated use limit */
    count?: number;
    limit?: number;
    offset?: number;
    unique?: boolean;
    tableName: string;
    start?: number;
    end?: number;
    roomId?: UUID;
    worldId?: UUID;
    metadata?: Record<string, unknown>;
    orderBy?: 'createdAt';
    orderDirection?: 'asc' | 'desc';
  }
): Promise<Memory[]> {
  const { entityId, agentId, roomId, worldId, tableName, unique, start, end, offset, metadata, orderBy, orderDirection } = params;
  // WHY: Support both 'limit' (new, standard) and 'count' (deprecated) params
  // during migration. New code should use 'limit'.
  const effectiveLimit = params.limit ?? params.count;

  if (!tableName) throw new Error("tableName is required");
  if (offset !== undefined && offset < 0) {
    throw new Error("offset must be a non-negative number");
  }

  const conditions = [eq(memoryTable.type, tableName)];

  if (start) {
    conditions.push(gte(memoryTable.createdAt, new Date(start)));
  }

  // RLS handles access control - no explicit entityId filter needed

  if (roomId) {
    conditions.push(eq(memoryTable.roomId, roomId));
  }

  // Add worldId condition
  if (worldId) {
    conditions.push(eq(memoryTable.worldId, worldId));
  }

  if (end) {
    conditions.push(lte(memoryTable.createdAt, new Date(end)));
  }

  if (unique) {
    conditions.push(eq(memoryTable.unique, true));
  }

  if (agentId) {
    conditions.push(eq(memoryTable.agentId, agentId));
  }

  // WHY: PostgreSQL JSON containment (@>) allows filtering by metadata fields
  // without fetching 50K records and filtering in JS (seen in plugin-knowledge).
  // The metadata param is a partial object — PG checks if the stored metadata
  // JSON contains all key-value pairs specified in the filter.
  if (metadata) {
    conditions.push(sql`${memoryTable.metadata}::jsonb @> ${JSON.stringify(metadata)}::jsonb`);
  }

  const baseQuery = db
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
      embedding: embeddingTable[embeddingDimension],
    })
    .from(memoryTable)
    .leftJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
    .where(and(...conditions))
    .orderBy(
      // TRAP: Only allow 'createdAt' (whitelisted) to prevent SQL injection
      // Default: DESC (newest first) to maintain current behavior
      orderDirection === 'asc' 
        ? asc(memoryTable.createdAt)
        : desc(memoryTable.createdAt)
    );

  // Apply limit and offset for pagination
  // Build query conditionally to maintain proper types
  const rows = await (async () => {
    if (effectiveLimit && offset !== undefined && offset > 0) {
      return baseQuery.limit(effectiveLimit).offset(offset);
    } else if (effectiveLimit) {
      return baseQuery.limit(effectiveLimit);
    } else if (offset !== undefined && offset > 0) {
      return baseQuery.offset(offset);
    } else {
      return baseQuery;
    }
  })();

  return rows.map((row) => ({
    id: row.memory.id as UUID,
    type: row.memory.type,
    createdAt: row.memory.createdAt.getTime(),
    content:
      typeof row.memory.content === "string"
        ? JSON.parse(row.memory.content)
        : row.memory.content,
    entityId: row.memory.entityId as UUID,
    agentId: row.memory.agentId as UUID,
    roomId: row.memory.roomId as UUID,
    unique: row.memory.unique,
    metadata: row.memory.metadata as MemoryMetadata,
    embedding: row.embedding ? Array.from(row.embedding) : undefined,
  }));
}

/**
 * Retrieves memories from the database by room IDs.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent.
 * @param {Object} params - The parameters for retrieving memories.
 * @param {UUID[]} params.roomIds - The IDs of the rooms to retrieve memories for.
 * @param {string} params.tableName - The name of the table to retrieve memories from.
 * @param {number} [params.limit] - The maximum number of memories to retrieve.
 * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
 */
export async function getMemoriesByRoomIds(
  db: DrizzleDatabase,
  agentId: UUID,
  params: {
    roomIds: UUID[];
    tableName: string;
    limit?: number;
  }
): Promise<Memory[]> {
  if (params.roomIds.length === 0) return [];

  const conditions = [
    eq(memoryTable.type, params.tableName),
    inArray(memoryTable.roomId, params.roomIds),
  ];

  conditions.push(eq(memoryTable.agentId, agentId));

  const query = db
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
    .orderBy(desc(memoryTable.createdAt));

  const rows = params.limit ? await query.limit(params.limit) : await query;

  return rows.map((row) => ({
    id: row.id as UUID,
    createdAt: row.createdAt.getTime(),
    content: typeof row.content === "string" ? JSON.parse(row.content) : row.content,
    entityId: row.entityId as UUID,
    agentId: row.agentId as UUID,
    roomId: row.roomId as UUID,
    unique: row.unique,
    metadata: row.metadata,
  })) as Memory[];
}

/**
 * Retrieves a memory by its unique identifier.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {EmbeddingDimensionColumn} embeddingDimension - The embedding dimension column to use.
 * @param {UUID} id - The unique identifier of the memory to retrieve.
 * @returns {Promise<Memory | null>} A Promise that resolves to the memory if found, null otherwise.
 */
export async function getMemoryById(
  db: DrizzleDatabase,
  embeddingDimension: EmbeddingDimensionColumn,
  id: UUID
): Promise<Memory | null> {
  const result = await db
    .select({
      memory: memoryTable,
      embedding: embeddingTable[embeddingDimension],
    })
    .from(memoryTable)
    .leftJoin(embeddingTable, eq(memoryTable.id, embeddingTable.memoryId))
    .where(eq(memoryTable.id, id))
    .limit(1);

  if (result.length === 0) return null;

  const row = result[0];
  return {
    id: row.memory.id as UUID,
    createdAt: row.memory.createdAt.getTime(),
    content:
      typeof row.memory.content === "string"
        ? JSON.parse(row.memory.content)
        : row.memory.content,
    entityId: row.memory.entityId as UUID,
    agentId: row.memory.agentId as UUID,
    roomId: row.memory.roomId as UUID,
    unique: row.memory.unique,
    metadata: row.memory.metadata as MemoryMetadata,
    embedding: row.embedding ?? undefined,
  };
}

/**
 * Retrieves memories by their IDs.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {EmbeddingDimensionColumn} embeddingDimension - The embedding dimension column to use.
 * @param {UUID[]} memoryIds - The IDs of the memories to retrieve.
 * @param {string} [tableName] - The name of the table to retrieve memories from.
 * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
 */
export async function getMemoriesByIds(
  db: DrizzleDatabase,
  embeddingDimension: EmbeddingDimensionColumn,
  memoryIds: UUID[],
  tableName?: string
): Promise<Memory[]> {
  if (memoryIds.length === 0) return [];

  const conditions = [inArray(memoryTable.id, memoryIds)];

  if (tableName) {
    conditions.push(eq(memoryTable.type, tableName));
  }

  const rows = await db
    .select({
      memory: memoryTable,
      embedding: embeddingTable[embeddingDimension],
    })
    .from(memoryTable)
    .leftJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
    .where(and(...conditions))
    .orderBy(desc(memoryTable.createdAt));

  return rows.map((row) => ({
    id: row.memory.id as UUID,
    createdAt: row.memory.createdAt.getTime(),
    content:
      typeof row.memory.content === "string"
        ? JSON.parse(row.memory.content)
        : row.memory.content,
    entityId: row.memory.entityId as UUID,
    agentId: row.memory.agentId as UUID,
    roomId: row.memory.roomId as UUID,
    unique: row.memory.unique,
    metadata: row.memory.metadata as MemoryMetadata,
    embedding: row.embedding ?? undefined,
  }));
}

/**
 * Retrieves cached embeddings from the database using levenshtein distance.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {Object} opts - The parameters for retrieving cached embeddings.
 * @param {string} opts.query_table_name - The name of the table to retrieve embeddings from.
 * @param {number} opts.query_threshold - The threshold for the levenshtein distance.
 * @param {string} opts.query_input - The input string to search for.
 * @param {string} opts.query_field_name - The name of the field to retrieve embeddings from.
 * @param {string} opts.query_field_sub_name - The name of the sub-field to retrieve embeddings from.
 * @param {number} opts.query_match_count - The maximum number of matches to retrieve.
 * @returns {Promise<{ embedding: number[]; levenshtein_score: number }[]>} A Promise that resolves to an array of cached embeddings.
 */
export async function getCachedEmbeddings(
  db: DrizzleDatabase,
  opts: {
    query_table_name: string;
    query_threshold: number;
    query_input: string;
    query_field_name: string;
    query_field_sub_name: string;
    query_match_count: number;
  }
): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
  try {
    // Drizzle database has execute method for raw SQL
    interface DrizzleDatabaseWithExecute {
      execute: (query: ReturnType<typeof sql>) => Promise<{ rows: Record<string, unknown>[] }>;
    }
    const results = await (db as DrizzleDatabaseWithExecute).execute(sql`
      WITH content_text AS (
        SELECT
          m.id,
          COALESCE(
            m.content->>${opts.query_field_sub_name},
            ''
          ) as content_text
        FROM memories m
        WHERE m.type = ${opts.query_table_name}
          AND m.content->>${opts.query_field_sub_name} IS NOT NULL
      ),
      embedded_text AS (
        SELECT
          ct.content_text,
          COALESCE(
            e.dim_384,
            e.dim_512,
            e.dim_768,
            e.dim_1024,
            e.dim_1536,
            e.dim_3072
          ) as embedding
        FROM content_text ct
        LEFT JOIN embeddings e ON e.memory_id = ct.id
        WHERE e.memory_id IS NOT NULL
      )
      -- WHY extra CTE: levenshtein() is O(n*m) CPU. The old code called it
      -- twice per row (once in SELECT, once in WHERE). Compute once in a CTE.
      , scored AS (
        SELECT
          embedding,
          levenshtein(${opts.query_input}, content_text) as levenshtein_score
        FROM embedded_text
      )
      SELECT embedding, levenshtein_score
      FROM scored
      WHERE levenshtein_score <= ${opts.query_threshold}
      ORDER BY levenshtein_score
      LIMIT ${opts.query_match_count}
    `);

    return results.rows
      .map((row) => ({
        embedding: Array.isArray(row.embedding)
          ? row.embedding
          : typeof row.embedding === "string"
            ? JSON.parse(row.embedding)
            : [],
        levenshtein_score: Number(row.levenshtein_score),
      }))
      .filter((row) => Array.isArray(row.embedding));
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        tableName: opts.query_table_name,
        fieldName: opts.query_field_name,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to get cached embeddings"
    );
    if (
      error instanceof Error &&
      error.message === "levenshtein argument exceeds maximum length of 255 characters"
    ) {
      return [];
    }
    throw error;
  }
}

/**
 * Searches for memories by delegating to searchMemoriesByEmbedding.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent.
 * @param {EmbeddingDimensionColumn} embeddingDimension - The embedding dimension column to use.
 * @param {Object} params - The search parameters.
 * @param {string} params.tableName - The name of the table to search.
 * @param {number[]} params.embedding - The embedding vector to search with.
 * @param {number} [params.match_threshold] - The cosine similarity threshold.
 * @param {number} [params.count] - The maximum number of results.
 * @param {boolean} [params.unique] - Whether to search unique memories only.
 * @param {string} [params.query] - An optional query string.
 * @param {UUID} [params.roomId] - Optional room ID to filter by.
 * @param {UUID} [params.worldId] - Optional world ID to filter by.
 * @param {UUID} [params.entityId] - Optional entity ID to filter by.
 * @returns {Promise<Memory[]>} A Promise that resolves to an array of matching memories.
 */
export async function searchMemories(
  db: DrizzleDatabase,
  agentId: UUID,
  embeddingDimension: EmbeddingDimensionColumn,
  params: {
    tableName: string;
    embedding: number[];
    match_threshold?: number;
    /** @deprecated use limit */
    count?: number;
    limit?: number;
    unique?: boolean;
    query?: string;
    roomId?: UUID;
    worldId?: UUID;
    entityId?: UUID;
  }
): Promise<Memory[]> {
  const effectiveLimit = params.limit ?? params.count;
  return await searchMemoriesByEmbedding(db, agentId, embeddingDimension, params.embedding, {
    match_threshold: params.match_threshold,
    count: effectiveLimit,
    // Pass direct scope fields down
    roomId: params.roomId,
    worldId: params.worldId,
    entityId: params.entityId,
    unique: params.unique,
    tableName: params.tableName,
  });
}

/**
 * Searches for memories by embedding vector using cosine distance.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent.
 * @param {EmbeddingDimensionColumn} embeddingDimension - The embedding dimension column to use.
 * @param {number[]} embedding - The embedding vector to search with.
 * @param {Object} params - The search parameters.
 * @param {number} [params.match_threshold] - The threshold for the cosine distance.
 * @param {number} [params.count] - The maximum number of memories to retrieve.
 * @param {UUID} [params.roomId] - Optional room ID to filter by.
 * @param {UUID} [params.worldId] - Optional world ID to filter by.
 * @param {UUID} [params.entityId] - Optional entity ID to filter by.
 * @param {boolean} [params.unique] - Whether to retrieve unique memories only.
 * @param {string} params.tableName - The name of the table to search for memories in.
 * @returns {Promise<Memory[]>} A Promise that resolves to an array of memories.
 */
export async function searchMemoriesByEmbedding(
  db: DrizzleDatabase,
  agentId: UUID,
  embeddingDimension: EmbeddingDimensionColumn,
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
  const cleanVector = embedding.map((n) => (Number.isFinite(n) ? Number(n.toFixed(6)) : 0));

  const similarity = sql<number>`1 - (${cosineDistance(
    embeddingTable[embeddingDimension],
    cleanVector
  )})`;

  const conditions = [eq(memoryTable.type, params.tableName)];

  if (params.unique) {
    conditions.push(eq(memoryTable.unique, true));
  }

  conditions.push(eq(memoryTable.agentId, agentId));

  // Add filters based on direct params
  if (params.roomId) {
    conditions.push(eq(memoryTable.roomId, params.roomId));
  }
  if (params.worldId) {
    conditions.push(eq(memoryTable.worldId, params.worldId));
  }
  if (params.entityId) {
    conditions.push(eq(memoryTable.entityId, params.entityId));
  }

  if (params.match_threshold) {
    conditions.push(gte(similarity, params.match_threshold));
  }

  const results = await db
    .select({
      memory: memoryTable,
      similarity,
      embedding: embeddingTable[embeddingDimension],
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
      typeof row.memory.content === "string"
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
}

/**
 * Creates a new memory in the database.
 * Handles duplicate checking, uniqueness via embedding similarity, and embedding storage.
 * @param {DrizzleDatabase} db - The database instance (may be a transaction context).
 * @param {UUID} agentId - The ID of the agent.
 * @param {EmbeddingDimensionColumn} embeddingDimension - The embedding dimension column to use.
 * @param {Memory & { metadata?: MemoryMetadata }} memory - The memory object to create.
 * @param {string} tableName - The name of the table to create the memory in.
 * @returns {Promise<UUID>} A Promise that resolves to the ID of the created memory.
 */
export async function createMemory(
  db: DrizzleDatabase,
  agentId: UUID,
  embeddingDimension: EmbeddingDimensionColumn,
  memory: Memory & { metadata?: MemoryMetadata },
  tableName: string
): Promise<UUID> {
  const memoryId = memory.id ?? (v4() as UUID);

  // WHY SELECT 1 instead of getMemoryById: we only need to check existence.
  // The old code fetched the full row with a LEFT JOIN on embeddings just to
  // discard it. SELECT 1 LIMIT 1 touches only the primary key index.
  const existCheck = await db
    .select({ _: sql`1` })
    .from(memoryTable)
    .where(eq(memoryTable.id, memoryId))
    .limit(1);
  if (existCheck.length > 0) {
    return memoryId;
  }

  // only do costly check if we need to
  if (memory.unique === undefined) {
    memory.unique = true; // set default
    if (memory.embedding && Array.isArray(memory.embedding)) {
      const similarMemories = await searchMemoriesByEmbedding(
        db,
        agentId,
        embeddingDimension,
        memory.embedding,
        {
          tableName,
          // Use the scope fields from the memory object for similarity check
          roomId: memory.roomId,
          worldId: memory.worldId,
          entityId: memory.entityId,
          match_threshold: 0.95,
          count: 1,
        }
      );
      memory.unique = similarMemories.length === 0;
    }
  }

  // Ensure we always pass a JSON string to the SQL placeholder – if we pass an
  // object directly PG sees `[object Object]` and fails the `::jsonb` cast.
  const contentToInsert =
    typeof memory.content === "string" ? memory.content : JSON.stringify(memory.content ?? {});

  const metadataToInsert =
    typeof memory.metadata === "string" ? memory.metadata : JSON.stringify(memory.metadata ?? {});

  await db.insert(memoryTable).values([
    {
      id: memoryId,
      type: tableName,
      content: sql`${contentToInsert}::jsonb`,
      metadata: sql`${metadataToInsert}::jsonb`,
      entityId: memory.entityId,
      roomId: memory.roomId,
      worldId: memory.worldId,
      agentId: memory.agentId || agentId,
      unique: memory.unique,
      createdAt: memory.createdAt ? new Date(memory.createdAt) : new Date(),
    },
  ]);

  if (memory.embedding && Array.isArray(memory.embedding)) {
    const embeddingValues: Record<string, unknown> = {
      id: v4(),
      memoryId: memoryId,
      createdAt: memory.createdAt ? new Date(memory.createdAt) : new Date(),
    };

    const cleanVector = memory.embedding.map((n) =>
      Number.isFinite(n) ? Number(n.toFixed(6)) : 0
    );

    embeddingValues[embeddingDimension] = cleanVector;

    await db.insert(embeddingTable).values([embeddingValues]);
  }

  return memoryId;
}

/**
 * Updates an existing memory in the database.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {EmbeddingDimensionColumn} embeddingDimension - The embedding dimension column to use.
 * @param {Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }} memory - The memory with updated fields.
 * @returns {Promise<boolean>} A Promise resolving to boolean indicating success.
 */
export async function updateMemory(
  db: DrizzleDatabase,
  embeddingDimension: EmbeddingDimensionColumn,
  memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }
): Promise<boolean> {
  try {
    await db.transaction(async (tx) => {
      // Update memory content if provided
      if (memory.content) {
        const contentToUpdate =
          typeof memory.content === "string"
            ? memory.content
            : JSON.stringify(memory.content ?? {});

        const metadataToUpdate =
          typeof memory.metadata === "string"
            ? memory.metadata
            : JSON.stringify(memory.metadata ?? {});

        await tx
          .update(memoryTable)
          .set({
            content: sql`${contentToUpdate}::jsonb`,
            ...(memory.metadata && {
              metadata: sql`${metadataToUpdate}::jsonb`,
            }),
          })
          .where(eq(memoryTable.id, memory.id));
      } else if (memory.metadata) {
        // Update only metadata if content is not provided
        const metadataToUpdate =
          typeof memory.metadata === "string"
            ? memory.metadata
            : JSON.stringify(memory.metadata ?? {});

        await tx
          .update(memoryTable)
          .set({
            metadata: sql`${metadataToUpdate}::jsonb`,
          })
          .where(eq(memoryTable.id, memory.id));
      }

      // Upsert embedding if provided.
      // WHY ON CONFLICT: eliminates the SELECT-before-INSERT/UPDATE pattern.
      // Old: 1 SELECT + 1 INSERT-or-UPDATE = 2 queries per memory.
      // New: 1 INSERT ... ON CONFLICT DO UPDATE = 1 query per memory.
      if (memory.embedding && Array.isArray(memory.embedding)) {
        const cleanVector = memory.embedding.map((n) =>
          Number.isFinite(n) ? Number(n.toFixed(6)) : 0
        );

        const embeddingValues: Record<string, unknown> = {
          id: v4(),
          memoryId: memory.id,
        };
        embeddingValues[embeddingDimension] = cleanVector;

        const updateValues: Record<string, unknown> = {};
        updateValues[embeddingDimension] = cleanVector;

        await tx
          .insert(embeddingTable)
          .values([embeddingValues] as unknown as (typeof embeddingTable.$inferInsert)[])
          .onConflictDoUpdate({
            target: embeddingTable.memoryId,
            set: updateValues,
          });
      }
    });

    return true;
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        memoryId: memory.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to update memory"
    );
    return false;
  }
}

/**
 * Deletes multiple memories from the database in a single batch operation.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent.
 * @param {UUID[]} memoryIds - An array of UUIDs of the memories to delete.
 * @returns {Promise<void>} A Promise that resolves when all memories are deleted.
 */
/**
 * WHY batch fragment deletion: the old code called deleteMemoryFragments() per
 * memory (1 SELECT + 2 DELETEs each = 3N queries). Now we find all fragments
 * for the entire batch in 1 query, then do 2 batch DELETEs = 3 queries total,
 * regardless of batch size.
 */
export async function deleteManyMemories(
  db: DrizzleDatabase,
  agentId: UUID,
  memoryIds: UUID[]
): Promise<void> {
  if (memoryIds.length === 0) {
    return;
  }

  await db.transaction(async (tx) => {
    const BATCH_SIZE = 100;
    for (let i = 0; i < memoryIds.length; i += BATCH_SIZE) {
      const batch = memoryIds.slice(i, i + BATCH_SIZE);

      // Batch fragment lookup: find all fragments referencing any memory in this batch
      const fragments = await tx
        .select({ id: memoryTable.id })
        .from(memoryTable)
        .where(
          and(
            eq(memoryTable.agentId, agentId),
            sql`${memoryTable.metadata}->>'documentId' = ANY(${sql`ARRAY[${sql.join(batch.map(id => sql`${id}`), sql`, `)}]::text[]`})`
          )
        );
      const fragmentIds = fragments.map((f) => f.id as UUID);

      // Delete fragment embeddings + fragments in batch
      if (fragmentIds.length > 0) {
        await tx.delete(embeddingTable).where(inArray(embeddingTable.memoryId, fragmentIds));
        await tx.delete(memoryTable).where(inArray(memoryTable.id, fragmentIds));
      }

      // Delete embeddings for the primary memories
      await tx.delete(embeddingTable).where(inArray(embeddingTable.memoryId, batch));

      // Delete the memories themselves
      await tx.delete(memoryTable).where(inArray(memoryTable.id, batch));
    }
  });
}

/**
 * Deletes all memory fragments that reference a specific document memory.
 * @param {DrizzleDatabase} db - The database instance (may be a transaction context).
 * @param {UUID} agentId - The ID of the agent.
 * @param {UUID} documentId - The UUID of the document memory whose fragments should be deleted.
 */
export async function deleteMemoryFragments(
  db: DrizzleDatabase,
  agentId: UUID,
  documentId: UUID
): Promise<void> {
  const fragmentsToDelete = await getMemoryFragments(db, agentId, documentId);

  if (fragmentsToDelete.length > 0) {
    const fragmentIds = fragmentsToDelete.map((f) => f.id) as UUID[];

    // Delete embeddings for fragments
    await db.delete(embeddingTable).where(inArray(embeddingTable.memoryId, fragmentIds));

    // Delete the fragments
    await db.delete(memoryTable).where(inArray(memoryTable.id, fragmentIds));
  }
}

/**
 * Retrieves all memory fragments that reference a specific document memory.
 * @param {DrizzleDatabase} db - The database instance (may be a transaction context).
 * @param {UUID} agentId - The ID of the agent.
 * @param {UUID} documentId - The UUID of the document memory whose fragments should be retrieved.
 * @returns {Promise<{ id: UUID }[]>} An array of memory fragments.
 */
export async function getMemoryFragments(
  db: DrizzleDatabase,
  agentId: UUID,
  documentId: UUID
): Promise<{ id: UUID }[]> {
  const fragments = await db
    .select({ id: memoryTable.id })
    .from(memoryTable)
    .where(
      and(
        eq(memoryTable.agentId, agentId),
        sql`${memoryTable.metadata}->>'documentId' = ${documentId}`
      )
    );

  return fragments.map((f) => ({ id: f.id as UUID }));
}

/**
 * Deletes all memories for a room and table type, including their fragments and embeddings.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent.
 * @param {UUID} roomId - The ID of the room to delete memories from.
 * @param {string} tableName - The name of the table to delete memories from.
 * @returns {Promise<void>} A Promise that resolves when the memories are deleted.
 */
/**
 * WHY batch approach: same rationale as deleteManyMemories -- batch fragment
 * lookup + batch embedding/memory deletes instead of per-memory loops.
 */
export async function deleteAllMemories(
  db: DrizzleDatabase,
  agentId: UUID,
  roomId: UUID,
  tableName: string
): Promise<void> {
  await db.transaction(async (tx) => {
    // 1) fetch all memory IDs for this room + table
    const rows = await tx
      .select({ id: memoryTable.id })
      .from(memoryTable)
      .where(and(eq(memoryTable.roomId, roomId), eq(memoryTable.type, tableName)));

    const ids = rows.map((r) => r.id as UUID);
    logger.debug(
      { src: "plugin:sql", roomId, tableName, memoryCount: ids.length },
      "Deleting all memories"
    );

    if (ids.length === 0) {
      return;
    }

    // 2) Batch fragment lookup for all memories at once
    const fragments = await tx
      .select({ id: memoryTable.id })
      .from(memoryTable)
      .where(
        and(
          eq(memoryTable.agentId, agentId),
          sql`${memoryTable.metadata}->>'documentId' = ANY(${sql`ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::text[]`})`
        )
      );
    const fragmentIds = fragments.map((f) => f.id as UUID);

    // 3) Delete fragment embeddings + fragments in batch
    if (fragmentIds.length > 0) {
      await tx.delete(embeddingTable).where(inArray(embeddingTable.memoryId, fragmentIds));
      await tx.delete(memoryTable).where(inArray(memoryTable.id, fragmentIds));
    }

    // 4) Delete embeddings for all primary memories in batch
    await tx.delete(embeddingTable).where(inArray(embeddingTable.memoryId, ids));

    // 5) Delete the memories themselves
    await tx
      .delete(memoryTable)
      .where(and(eq(memoryTable.roomId, roomId), eq(memoryTable.type, tableName)));
  });
}

/**
 * Counts the number of memories matching criteria.
 * Supports both positional (deprecated) and object params signatures.
 * 
 * @param db The database instance
 * @param roomIdOrParams Either UUID (positional) or object params (new)
 * @param unique Positional param (deprecated) or undefined if using object params
 * @param tableName Positional param (deprecated) or undefined if using object params
 * @returns Promise resolving to memory count
 */
export async function countMemories(
  db: DrizzleDatabase,
  roomIdOrParams: UUID | { roomId?: UUID; unique?: boolean; tableName?: string; entityId?: UUID; agentId?: UUID; metadata?: Record<string, unknown> },
  unique?: boolean,
  tableName?: string
): Promise<number> {
  // Runtime type checking: detect which signature is being used
  // TRAP: If first arg is undefined with multiple args, treat as legacy positional call
  const isObjectParams = typeof roomIdOrParams === 'object' && roomIdOrParams !== null && !unique && !tableName;

  let conditions: SQL[] = [];

  if (isObjectParams) {
    // New object params signature
    const params = roomIdOrParams as { roomId?: UUID; unique?: boolean; tableName?: string; entityId?: UUID; agentId?: UUID; metadata?: Record<string, unknown> };
    
    if (!params.tableName) throw new Error("tableName is required");
    
    conditions.push(eq(memoryTable.type, params.tableName));
    
    if (params.roomId) {
      conditions.push(eq(memoryTable.roomId, params.roomId));
    }
    if (params.entityId) {
      conditions.push(eq(memoryTable.entityId, params.entityId));
    }
    if (params.agentId) {
      conditions.push(eq(memoryTable.agentId, params.agentId));
    }
    if (params.unique !== undefined) {
      conditions.push(eq(memoryTable.unique, params.unique));
    }
    if (params.metadata) {
      // JSONB containment (@>) - reuse pattern from getMemories
      conditions.push(sql`${memoryTable.metadata}::jsonb @> ${JSON.stringify(params.metadata)}::jsonb`);
    }
  } else {
    // Legacy positional signature
    const roomId = roomIdOrParams as UUID;
    const effectiveUnique = unique ?? true;
    const effectiveTableName = tableName ?? "";
    
    if (!effectiveTableName) throw new Error("tableName is required");
    
    conditions.push(eq(memoryTable.roomId, roomId));
    conditions.push(eq(memoryTable.type, effectiveTableName));
    
    if (effectiveUnique) {
      conditions.push(eq(memoryTable.unique, true));
    }
  }

  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(memoryTable)
    .where(and(...conditions));

  const result0 = result[0];
  return Number(result0?.count ?? 0);
}

/**
 * Gets memories for all rooms belonging to any of the given worlds.
 * Single query with WHERE room.world_id IN (...). Limit applies to total results.
 * For a single world, pass worldIds: [worldId].
 */
export async function getMemoriesByWorldIds(
  db: DrizzleDatabase,
  agentId: UUID,
  params: {
    worldIds: UUID[];
    tableName?: string;
    limit?: number;
  }
): Promise<Memory[]> {
  if (params.worldIds.length === 0) return [];
  const tableName = params.tableName || "messages";

  const query = db
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
    .innerJoin(roomTable, eq(roomTable.id, memoryTable.roomId))
    .where(
      and(
        inArray(roomTable.worldId, params.worldIds),
        eq(memoryTable.agentId, agentId),
        eq(memoryTable.type, tableName)
      )
    )
    .orderBy(desc(memoryTable.createdAt));

  const rows = params.limit ? await query.limit(params.limit) : await query;

  return rows.map((row) => ({
    id: row.id as UUID,
    createdAt: row.createdAt.getTime(),
    content: typeof row.content === "string" ? JSON.parse(row.content) : row.content,
    entityId: row.entityId as UUID,
    agentId: row.agentId as UUID,
    roomId: row.roomId as UUID,
    unique: row.unique,
    metadata: row.metadata,
  })) as Memory[];
}

// ── Batch memory operations ──────────────────────────────────────────
//
// WHY true batch instead of looping createMemory/updateMemory:
//   Old: N existence checks + N inserts + N embedding inserts = 3N queries
//   New: 1 batch existence check + 1 multi-row insert + 1 multi-row
//        embedding insert = 3 queries (plus any per-memory similarity
//        checks for uniqueness, which can't be batched).
//
// The similarity check (searchMemoriesByEmbedding) runs per-memory only
// when memory.unique === undefined AND the memory has an embedding.
// Most call sites set unique explicitly, so the common path is pure batch.

/**
 * Creates multiple memories in the database using multi-row INSERT.
 *
 * Three-phase approach:
 * 1. Batch existence check — one SELECT...IN instead of N individual lookups
 * 2. Per-memory uniqueness resolution — only for memories needing similarity check
 * 3. Batch INSERT — one multi-row INSERT for memories, one for embeddings
 */
export async function createMemories(
  db: DrizzleDatabase,
  agentId: UUID,
  embeddingDimension: EmbeddingDimensionColumn,
  memories: Array<{ memory: Memory & { metadata?: MemoryMetadata }; tableName: string; unique?: boolean }>
): Promise<UUID[]> {
  if (memories.length === 0) return [];

  // Assign IDs to any memories missing one
  const prepared = memories.map(({ memory, tableName }) => ({
    memory: { ...memory, id: (memory.id ?? v4()) as UUID },
    tableName,
  }));

  const allIds = prepared.map((p) => p.memory.id);

  // Phase 1: Batch existence check — one query instead of N
  const existingRows = await db
    .select({ id: memoryTable.id })
    .from(memoryTable)
    .where(inArray(memoryTable.id, allIds));
  const existingIds = new Set(existingRows.map((r) => r.id as string));

  const toCreate = prepared.filter((p) => !existingIds.has(p.memory.id as string));
  if (toCreate.length === 0) return allIds;

  // Phase 2: Uniqueness resolution (per-memory, can't batch similarity search)
  for (const item of toCreate) {
    const { memory, tableName } = item;
    if (memory.unique === undefined) {
      memory.unique = true;
      if (memory.embedding && Array.isArray(memory.embedding)) {
        const similar = await searchMemoriesByEmbedding(
          db,
          agentId,
          embeddingDimension,
          memory.embedding,
          {
            tableName,
            roomId: memory.roomId,
            worldId: memory.worldId,
            entityId: memory.entityId,
            match_threshold: 0.95,
            count: 1,
          }
        );
        memory.unique = similar.length === 0;
      }
    }
  }

  // Phase 3a: Batch INSERT memories — one multi-row insert
  const memoryValues = toCreate.map(({ memory, tableName }) => {
    const contentStr =
      typeof memory.content === "string"
        ? memory.content
        : JSON.stringify(memory.content ?? {});
    const metadataStr =
      typeof memory.metadata === "string"
        ? memory.metadata
        : JSON.stringify(memory.metadata ?? {});

    return {
      id: memory.id,
      type: tableName,
      content: sql`${contentStr}::jsonb`,
      metadata: sql`${metadataStr}::jsonb`,
      entityId: memory.entityId,
      roomId: memory.roomId,
      worldId: memory.worldId,
      agentId: memory.agentId || agentId,
      unique: memory.unique,
      createdAt: memory.createdAt ? new Date(memory.createdAt) : new Date(),
    };
  });

  await db.insert(memoryTable).values(memoryValues).onConflictDoNothing();

  // Phase 3b: Batch INSERT embeddings — one multi-row insert
  const embeddingRows: Record<string, unknown>[] = [];
  for (const { memory } of toCreate) {
    if (memory.embedding && Array.isArray(memory.embedding)) {
      const cleanVector = memory.embedding.map((n) =>
        Number.isFinite(n) ? Number(n.toFixed(6)) : 0
      );
      const vals: Record<string, unknown> = {
        id: v4(),
        memoryId: memory.id,
        createdAt: memory.createdAt ? new Date(memory.createdAt) : new Date(),
      };
      vals[embeddingDimension] = cleanVector;
      embeddingRows.push(vals);
    }
  }

  if (embeddingRows.length > 0) {
    await db.insert(embeddingTable).values(embeddingRows);
  }

  return allIds;
}

/**
 * Updates multiple memories in the database in a single transaction.
 *
 * WHY single transaction instead of per-memory transactions:
 *   Old: N separate transactions (each with open/commit overhead)
 *   New: 1 transaction wrapping all updates
 *
 * Uses CASE-based batch UPDATE for memory content/metadata and splits
 * embedding operations into batch INSERT (new) and batch UPDATE (existing).
 *
 * Total queries: 1 batch SELECT (embedding existence) + 1 CASE UPDATE
 * (memories) + 1 batch INSERT (new embeddings) + 1 CASE UPDATE (existing
 * embeddings) = 4 queries max, down from 3N.
 */
export async function updateMemories(
  db: DrizzleDatabase,
  embeddingDimension: EmbeddingDimensionColumn,
  memories: Array<Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }>
): Promise<void> {
  if (memories.length === 0) return;

  try {
    await db.transaction(async (tx) => {
      // ── 1. Batch UPDATE memory content/metadata via CASE ──────────────
      const contentMemories = memories.filter((m) => m.content != null || m.metadata != null);
      if (contentMemories.length > 0) {
        const memIds = contentMemories.map((m) => m.id);

        // Only set content for memories that provide content; others preserve existing (ELSE column).
        const contentCases = contentMemories
          .filter((m) => m.content != null)
          .map((m) => {
            const contentStr =
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content);
            return sql`WHEN ${memoryTable.id} = ${m.id} THEN ${contentStr}::jsonb`;
          });
        const metaCases = contentMemories
          .filter((m) => m.metadata != null)
          .map((m) => {
            const metaStr =
              typeof m.metadata === "string"
                ? m.metadata
                : JSON.stringify(m.metadata);
            return sql`WHEN ${memoryTable.id} = ${m.id} THEN ${metaStr}::jsonb`;
          });

        const setObj: Record<string, unknown> = {};
        if (contentCases.length > 0) {
          setObj.content = sql`CASE ${sql.join(contentCases, sql` `)} ELSE ${memoryTable.content} END`;
        }
        if (metaCases.length > 0) {
          setObj.metadata = sql`CASE ${sql.join(metaCases, sql` `)} ELSE ${memoryTable.metadata} END`;
        }
        if (Object.keys(setObj).length > 0) {
          await tx
            .update(memoryTable)
            .set(setObj)
            .where(inArray(memoryTable.id, memIds));
        }
      }

      // ── 2. Handle embeddings in batch ─────────────────────────────────
      const embMemories = memories.filter(
        (m) => m.embedding && Array.isArray(m.embedding)
      );
      if (embMemories.length > 0) {
        // Batch-check which memories already have embeddings (1 query)
        const embIds = embMemories.map((m) => m.id);
        const existingRows = await tx
          .select({ memoryId: embeddingTable.memoryId })
          .from(embeddingTable)
          .where(inArray(embeddingTable.memoryId, embIds));
        const existingSet = new Set(existingRows.map((r) => r.memoryId).filter(Boolean));

        const toInsert: Array<Record<string, unknown>> = [];
        const toUpdate: Array<{ memoryId: string; vector: number[] }> = [];

        for (const m of embMemories) {
          const cleanVector = m.embedding!.map((n: number) =>
            Number.isFinite(n) ? Number(n.toFixed(6)) : 0
          );
          if (existingSet.has(m.id)) {
            toUpdate.push({ memoryId: m.id, vector: cleanVector });
          } else {
            const row: Record<string, unknown> = {
              id: v4(),
              memoryId: m.id,
            };
            row[embeddingDimension] = cleanVector;
            toInsert.push(row);
          }
        }

        // Batch INSERT new embeddings (1 query)
        if (toInsert.length > 0) {
          await tx.insert(embeddingTable).values(toInsert);
        }

        // Batch UPDATE existing embeddings via CASE (1 query)
        if (toUpdate.length > 0) {
          const dimCol = embeddingTable[embeddingDimension];
          const dimCases = toUpdate.map(
            (u) =>
              sql`WHEN ${embeddingTable.memoryId} = ${u.memoryId}::uuid THEN ${JSON.stringify(u.vector)}::vector`
          );
          const updateIds = toUpdate.map((u) => u.memoryId);
          await tx
            .update(embeddingTable)
            .set({
              [embeddingDimension]: sql`CASE ${sql.join(dimCases, sql` `)} ELSE ${dimCol} END`,
            })
            .where(inArray(embeddingTable.memoryId, updateIds));
        }
      }
    });
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        count: memories.length,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to update memories batch"
    );
    throw error;
  }
}

/**
 * Deletes multiple memories from the database.
 *
 * BUG FIX: the old code passed (db, memoryIds) to deleteManyMemories which
 * expects (db, agentId, memoryIds) -- memoryIds landed in the agentId slot.
 * Since this wrapper doesn't receive agentId, we skip fragment deletion and
 * directly delete embeddings + memories by ID. Fragment cleanup should be
 * handled by callers that have the agentId context.
 */
export async function deleteMemories(
  db: DrizzleDatabase,
  memoryIds: UUID[]
): Promise<void> {
  if (memoryIds.length === 0) return;

  await db.transaction(async (tx) => {
    const BATCH_SIZE = 100;
    for (let i = 0; i < memoryIds.length; i += BATCH_SIZE) {
      const batch = memoryIds.slice(i, i + BATCH_SIZE);
      await tx.delete(embeddingTable).where(inArray(embeddingTable.memoryId, batch));
      await tx.delete(memoryTable).where(inArray(memoryTable.id, batch));
    }
  });
}

/**
 * Upserts multiple memories by ID (insert or overwrite existing).
 * 
 * WHY: Unlike createMemories (ON CONFLICT DO NOTHING), this uses ON CONFLICT DO UPDATE
 * to overwrite existing memories. Used for bulk data refresh or re-import scenarios.
 * 
 * NO SIMILARITY CHECK: Does NOT run embedding similarity checks (unlike createMemories).
 * The caller is asserting "I know this memory's ID, insert or replace."
 * 
 * EMBEDDING HANDLING: If a memory includes an embedding, the embeddings table row
 * is also upserted to keep embeddings in sync with content.
 */
export async function upsertMemories(
  db: DrizzleDatabase,
  agentId: UUID,
  embeddingDimension: EmbeddingDimensionColumn,
  memories: Array<{ memory: Memory; tableName: string }>
): Promise<void> {
  if (memories.length === 0) return;

  try {
    // TRAP: Assign stable IDs ONCE before both loops. Create shallow copies
    // so we don't mutate the caller's input objects (consistent with createMemories).
    const prepared = memories.map(({ memory, tableName }) => ({
      memory: { ...memory, id: (memory.id ?? v4()) as UUID },
      tableName,
    }));

    await db.transaction(async (tx) => {
      // Prepare memory records
      const memoryValues = prepared.map(({ memory, tableName }) => {
        const contentStr =
          typeof memory.content === "string"
            ? memory.content
            : JSON.stringify(memory.content ?? {});
        const metadataStr =
          typeof memory.metadata === "string"
            ? memory.metadata
            : JSON.stringify(memory.metadata ?? {});

        return {
          id: memory.id!,
          type: tableName,
          content: sql`${contentStr}::jsonb`,
          metadata: sql`${metadataStr}::jsonb`,
          entityId: memory.entityId,
          roomId: memory.roomId,
          worldId: memory.worldId,
          agentId: memory.agentId || agentId,
          unique: memory.unique ?? true,
          createdAt: memory.createdAt ? new Date(memory.createdAt) : new Date(),
        };
      });

      // Upsert memories: update content/metadata/unique on conflict, preserve identity
      await tx.insert(memoryTable).values(memoryValues).onConflictDoUpdate({
        target: memoryTable.id,
        set: {
          content: sql`EXCLUDED.content`,
          metadata: sql`EXCLUDED.metadata`,
          unique: sql`EXCLUDED.unique`,
          // DO NOT update: id, type, entityId, roomId, worldId, agentId, createdAt
        },
      });

      // Upsert embeddings (reference the SAME memory.id from prepared copies)
      const embeddingRows: Record<string, unknown>[] = [];
      for (const { memory } of prepared) {
        if (memory.embedding && Array.isArray(memory.embedding)) {
          const cleanVector = memory.embedding.map((n) =>
            Number.isFinite(n) ? Number(n.toFixed(6)) : 0
          );

          const vals: Record<string, unknown> = {
            id: v4(),
            memoryId: memory.id!,
            createdAt: memory.createdAt ? new Date(memory.createdAt) : new Date(),
          };
          vals[embeddingDimension] = cleanVector;
          embeddingRows.push(vals);
        }
      }

      if (embeddingRows.length > 0) {
        // Upsert embeddings: update vector on conflict (by memoryId).
        // TRAP: embeddingDimension is a Drizzle property name (e.g. "dim384") but
        // the actual SQL column is snake_case (e.g. "dim_384"). Drizzle handles the
        // left side of SET via property→column mapping, but the EXCLUDED reference
        // is raw SQL and must use the actual column name.
        const sqlColumnName = embeddingDimension.replace(/(\d)/, '_$1');
        const updateSet: Record<string, unknown> = {};
        updateSet[embeddingDimension] = sql.raw(`EXCLUDED."${sqlColumnName}"`);

        await tx.insert(embeddingTable).values(embeddingRows).onConflictDoUpdate({
          target: embeddingTable.memoryId,
          set: updateSet,
        });
      }
    });
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        count: memories.length,
        error: error instanceof Error ? error.message : String(error),
      },
      "upsertMemories error"
    );
    throw error;
  }
}
