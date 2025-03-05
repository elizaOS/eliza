import {
    type Agent,
    type Component,
    DatabaseAdapter,
    type Entity,
    type Goal,
    type GoalStatus,
    logger,
    type Memory,
    type Participant,
    type Relationship,
    type Room,
    type Task,
    type UUID,
    type World
} from "@elizaos/core";
import {
    and,
    cosineDistance,
    count,
    desc,
    eq,
    gte,
    inArray,
    lte,
    sql
} from "drizzle-orm";
import { v4 } from "uuid";
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from "./schema/embedding";
import {
    agentTable,
    cacheTable,
    componentTable,
    embeddingTable,
    entityTable,
    goalTable,
    logTable,
    memoryTable,
    participantTable,
    relationshipTable,
    roomTable,
    taskTable,
    worldTable
} from "./schema/index";
import type { DrizzleOperations } from "./types";

// Define the metadata type inline since we can't import it
type MemoryMetadata = {
    type: string;
    source?: string;
    sourceId?: UUID;
    scope?: string;
    timestamp?: number;
    tags?: string[];
    documentId?: UUID;
    position?: number;
};

export abstract class BaseDrizzleAdapter<TDatabase extends DrizzleOperations> 
    extends DatabaseAdapter<TDatabase>
{
    protected readonly maxRetries: number = 3;
    protected readonly baseDelay: number = 1000;
    protected readonly maxDelay: number = 10000;
    protected readonly jitterMax: number = 1000;
    protected embeddingDimension: EmbeddingDimensionColumn = DIMENSION_MAP[384];

    protected abstract withDatabase<T>(operation: () => Promise<T>): Promise<T>;
    public abstract init(): Promise<void>;
    public abstract close(): Promise<void>;

    protected agentId: UUID;

    constructor(agentId: UUID) {
        super();
        this.agentId = agentId;
    }

    protected async withRetry<T>(operation: () => Promise<T>): Promise<T> {
        let lastError: Error = new Error("Unknown error");

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error as Error;

                if (attempt < this.maxRetries) {
                    const backoffDelay = Math.min(
                        this.baseDelay * 2 ** (attempt - 1),
                        this.maxDelay
                    );

                    const jitter = Math.random() * this.jitterMax;
                    const delay = backoffDelay + jitter;

                    logger.warn(
                        `Database operation failed (attempt ${attempt}/${this.maxRetries}):`,
                        {
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                            nextRetryIn: `${(delay / 1000).toFixed(1)}s`,
                        }
                    );

                    console.trace("****** Database operation failure source");

                    await new Promise((resolve) => setTimeout(resolve, delay));
                } else {
                    logger.error("Max retry attempts reached:", {
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                        totalAttempts: attempt,
                    });
                    throw error instanceof Error
                        ? error
                        : new Error(String(error));
                }
            }
        }

        throw lastError;
    }

    async ensureAgentExists(agent: Partial<Agent>): Promise<void> {
        if (!agent.name) {
            throw new Error("Agent name is required");
        }

        const agents = await this.getAgents();
        const existingAgent = agents.find((a: Partial<Agent & { status: string }>) => a.name === agent.name);

        if (!existingAgent) {
            await this.createAgent(agent);
        }
    }
    
    async ensureEmbeddingDimension(dimension: number) {
        const existingMemory = await this.db
            .select({
                embedding: embeddingTable,
            })
            .from(memoryTable)
            .innerJoin(
                embeddingTable,
                eq(embeddingTable.memoryId, memoryTable.id)
            )
            .where(eq(memoryTable.agentId, this.agentId))
            .limit(1);

        if (existingMemory.length > 0) {
            const usedDimension = Object.entries(DIMENSION_MAP).find(
                ([_, colName]) => existingMemory[0].embedding[colName] !== null
            );

            if (
                usedDimension &&
                usedDimension[1] !== DIMENSION_MAP[dimension]
            ) {
                throw new Error("Cannot change embedding dimension for agent");
            }
        }

        this.embeddingDimension = DIMENSION_MAP[dimension];
    }

    async getAgent(agentId: UUID): Promise<Agent | null> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select()
                .from(agentTable)
                .where(eq(agentTable.id, agentId))
                .limit(1);

            if (result.length === 0) return null;
            return result[0];
        });
    }

    async getAgents(): Promise<Agent[]> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select()
                .from(agentTable);
            
            return result;
        });
    }

    async createAgent(agent: Partial<Agent>): Promise<boolean> {
        return this.withDatabase(async () => {
            try {
                await this.db.transaction(async (tx) => {
                    await tx.insert(agentTable).values({
                       ...agent,
                    });
                });
                
                logger.debug("Agent created successfully:", {
                    agentId: agent.id
                });
                return true;
            } catch (error) {
                logger.error("Error creating agent:", {
                    error: error instanceof Error ? error.message : String(error),
                    agentId: agent.id,
                    agent
                });
                return false;
            }
        });
    }

    async updateAgent(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
        return this.withDatabase(async () => {
            try {
                if (!agent.id) {
                    throw new Error("Agent ID is required for update");
                }
                
                await this.db.transaction(async (tx) => {
                    await tx
                        .update(agentTable)
                        .set({
                            ...agent,
                            updatedAt: Date.now(),
                        })
                        .where(eq(agentTable.id, agentId));
                });
                
                logger.debug("Agent updated successfully:", {
                    agentId
                });
                return true;
            } catch (error) {
                logger.error("Error updating agent:", {
                    error: error instanceof Error ? error.message : String(error),
                    agentId,
                    agent
                });
                return false;
            }
        });
    }

    async deleteAgent(agentId: UUID): Promise<boolean> {
        // casacade delete all related for the agent
        return this.withDatabase(async () => {
            await this.db.transaction(async (tx) => {
                await tx.delete(agentTable).where(eq(agentTable.id, agentId));
            });
            return true;
        });
    }

    /**
     * Count all agents in the database
     * Used primarily for maintenance and cleanup operations
     */
    async countAgents(): Promise<number> {
        return this.withDatabase(async () => {
            try {
                const result = await this.db
                    .select({ count: count() })
                    .from(agentTable);
                
                return result[0]?.count || 0;
            } catch (error) {
                logger.error("Error counting agents:", {
                    error: error instanceof Error ? error.message : String(error)
                });
                return 0;
            }
        });
    }

    /**
     * Clean up the agents table by removing all agents
     * This is used during server startup to ensure no orphaned agents exist
     * from previous crashes or improper shutdowns
     */
    async cleanupAgents(): Promise<void> {
        return this.withDatabase(async () => {
            try {
                await this.db.delete(agentTable);
                logger.success("Successfully cleaned up agent table");
            } catch (error) {
                logger.error("Error cleaning up agent table:", {
                    error: error instanceof Error ? error.message : String(error)
                });
                throw error;
            }
        });
    }

    async getEntityById(entityId: UUID): Promise<Entity | null> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select({
                    entity: entityTable,
                    components: componentTable
                })
                .from(entityTable)
                .leftJoin(
                    componentTable,
                    eq(componentTable.entityId, entityTable.id)
                )
                .where(
                    and(
                        eq(entityTable.id, entityId),
                        eq(entityTable.agentId, this.agentId)
                    )
                );

            if (result.length === 0) return null;

            // Group components by entity
            const entity = result[0].entity;
            entity.components = result
                .filter(row => row.components)
                .map(row => row.components);

            return entity;
        });
    }

    async getEntitiesForRoom(roomId: UUID, includeComponents?: boolean): Promise<Entity[]> {
        return this.withDatabase(async () => {
            const query = this.db
                .select({
                    entity: entityTable,
                    ...(includeComponents && { components: componentTable })
                })
                .from(participantTable)
                .leftJoin(
                    entityTable,
                    and(
                        eq(participantTable.entityId, entityTable.id),
                        eq(entityTable.agentId, this.agentId)
                    )
                );

            if (includeComponents) {
                query.leftJoin(
                    componentTable,
                    eq(componentTable.entityId, entityTable.id)
                );
            }

            const result = await query.where(eq(participantTable.roomId, roomId));

            // Group components by entity if includeComponents is true
            const entitiesByIdMap = new Map<UUID, Entity>();
            
            for (const row of result) {
                if (!row.entity) continue;
                
                const entityId = row.entity.id as UUID;
                if (!entitiesByIdMap.has(entityId)) {
                    const entity: Entity = {
                        ...row.entity,
                        components: includeComponents ? [] : undefined
                    };
                    entitiesByIdMap.set(entityId, entity);
                }

                if (includeComponents && row.components) {
                    const entity = entitiesByIdMap.get(entityId);
                    if (entity) {
                        if (!entity.components) {
                            entity.components = [];
                        }
                        entity.components.push(row.components);
                    }
                }
            }

            return Array.from(entitiesByIdMap.values());
        });
    }

    async createEntity(entity: Entity): Promise<boolean> {
        return this.withDatabase(async () => {
            try {
                return await this.db.transaction(async (tx) => {
                    await tx.insert(entityTable).values(entity);
    
                    logger.debug("Entity created successfully:", {
                        entity,
                    });
    
                    return true;
                });
            } catch (error) {
                logger.error("Error creating account:", {
                    error: error instanceof Error ? error.message : String(error),
                    entityId: entity.id,
                    name: entity.metadata?.name,
                });
                return false;
            }
        });
    }

    /**
     * Ensures an entity exists, creating it if it doesn't
     * @param entity The entity to ensure exists
     * @returns Promise resolving to boolean indicating success
     */
    protected async ensureEntityExists(entity: Entity): Promise<boolean> {
        if (!entity.id) {
            logger.error("Entity ID is required for ensureEntityExists");
            return false;
        }

        try {
            const existingEntity = await this.getEntityById(entity.id);
            
            if (!existingEntity) {
                return await this.createEntity(entity);
            }
            
            return true;
        } catch (error) {
            logger.error("Error ensuring entity exists:", {
                error: error instanceof Error ? error.message : String(error),
                entityId: entity.id,
            });
            return false;
        }
    }

    async updateEntity(entity: Entity): Promise<void> {
        return this.withDatabase(async () => {
            await this.db.update(entityTable).set(entity)
            .where(and(eq(entityTable.id, entity.id as UUID),
             eq(entityTable.agentId, entity.agentId)));
        });
    }

    async getComponent(entityId: UUID, type: string, worldId?: UUID, sourceEntityId?: UUID): Promise<Component | null> {
        return this.withDatabase(async () => {
            const conditions = [
                eq(componentTable.entityId, entityId),
                eq(componentTable.type, type)
            ];

            if (worldId) {
                conditions.push(eq(componentTable.worldId, worldId));
            }

            if (sourceEntityId) {
                conditions.push(eq(componentTable.sourceEntityId, sourceEntityId));
            }

            const result = await this.db
                .select()
                .from(componentTable)
                .where(and(...conditions));
            return result.length > 0 ? result[0] : null;
        });
    }

    async getComponents(entityId: UUID, worldId?: UUID, sourceEntityId?: UUID): Promise<Component[]> {
        return this.withDatabase(async () => {
            const conditions = [
                eq(componentTable.entityId, entityId)
            ];

            if (worldId) {
                conditions.push(eq(componentTable.worldId, worldId));
            }

            if (sourceEntityId) {
                conditions.push(eq(componentTable.sourceEntityId, sourceEntityId));
            }

            const result = await this.db
                .select({
                    id: componentTable.id,
                    entityId: componentTable.entityId,
                    type: componentTable.type,
                    data: componentTable.data,
                    worldId: componentTable.worldId,
                    sourceEntityId: componentTable.sourceEntityId,
                    createdAt: componentTable.createdAt,
                })
                .from(componentTable)
                .where(and(...conditions));
            return result;
        });
    }

    async createComponent(component: Component): Promise<boolean> {
        return this.withDatabase(async () => {
            await this.db.insert(componentTable).values(component);
            return true;
        });
    }

    async updateComponent(component: Component): Promise<void> {
        return this.withDatabase(async () => {
            await this.db.update(componentTable).set(component).where(eq(componentTable.id, component.id));
        });
    }

    async deleteComponent(componentId: UUID): Promise<void> {
        return this.withDatabase(async () => {
            await this.db.delete(componentTable).where(eq(componentTable.id, componentId));
        });
    }

    async getMemories(params: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        tableName: string;
        start?: number;
        end?: number;
    }): Promise<Memory[]> {
        if (!params.tableName) throw new Error("tableName is required");
        if (!params.roomId) throw new Error("roomId is required");

        return this.withDatabase(async () => {
            const conditions = [
                eq(memoryTable.type, params.tableName),
                eq(memoryTable.roomId, params.roomId),
            ];

            if (params.start) {
                conditions.push(gte(memoryTable.createdAt, params.start));
            }

            if (params.end) {
                conditions.push(lte(memoryTable.createdAt, params.end));
            }

            if (params.unique) {
                conditions.push(eq(memoryTable.unique, true));
            }

            conditions.push(eq(memoryTable.agentId, this.agentId));

            const query = this.db
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
                    },
                    embedding: embeddingTable[this.embeddingDimension],
                })
                .from(memoryTable)
                .leftJoin(
                    embeddingTable,
                    eq(embeddingTable.memoryId, memoryTable.id)
                )
                .where(and(...conditions))
                .orderBy(desc(memoryTable.createdAt));

            const rows = params.count
                ? await query.limit(params.count)
                : await query;

            return rows.map((row) => ({
                id: row.memory.id as UUID,
                type: row.memory.type,
                createdAt: row.memory.createdAt,
                content:
                    typeof row.memory.content === "string"
                        ? JSON.parse(row.memory.content)
                        : row.memory.content,
                entityId: row.memory.entityId as UUID,
                agentId: row.memory.agentId as UUID,
                roomId: row.memory.roomId as UUID,
                unique: row.memory.unique,
                embedding: row.embedding
                    ? Array.from(row.embedding)
                    : undefined,
            }));
        });
    }

    async getMemoriesByRoomIds(params: {
        roomIds: UUID[];
        tableName: string;
        limit?: number;
    }): Promise<Memory[]> {
        return this.withDatabase(async () => {
            if (params.roomIds.length === 0) return [];

            const conditions = [
                eq(memoryTable.type, params.tableName),
                inArray(memoryTable.roomId, params.roomIds),
            ];

            conditions.push(eq(memoryTable.agentId, this.agentId));

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
                })
                .from(memoryTable)
                .where(and(...conditions))
                .orderBy(desc(memoryTable.createdAt));

            const rows = params.limit
                ? await query.limit(params.limit)
                : await query;

            return rows.map((row) => ({
                id: row.id as UUID,
                createdAt: row.createdAt,
                content:
                    typeof row.content === "string"
                        ? JSON.parse(row.content)
                        : row.content,
                entityId: row.entityId as UUID,
                agentId: row.agentId as UUID,
                roomId: row.roomId as UUID,
                unique: row.unique,
            })) as Memory[];
        });
    }

    async getMemoryById(id: UUID): Promise<Memory | null> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select({
                    memory: memoryTable,
                    embedding: embeddingTable[this.embeddingDimension],
                })
                .from(memoryTable)
                .leftJoin(
                    embeddingTable,
                    eq(memoryTable.id, embeddingTable.memoryId)
                )
                .where(eq(memoryTable.id, id))
                .limit(1);

            if (result.length === 0) return null;

            const row = result[0];
            return {
                id: row.memory.id as UUID,
                createdAt: row.memory.createdAt,
                content:
                    typeof row.memory.content === "string"
                        ? JSON.parse(row.memory.content)
                        : row.memory.content,
                entityId: row.memory.entityId as UUID,
                agentId: row.memory.agentId as UUID,
                roomId: row.memory.roomId as UUID,
                unique: row.memory.unique,
                embedding: row.embedding ?? undefined,
            };
        });
    }

    async getMemoriesByIds(
        memoryIds: UUID[],
        tableName?: string
    ): Promise<Memory[]> {
        return this.withDatabase(async () => {
            if (memoryIds.length === 0) return [];

            const conditions = [inArray(memoryTable.id, memoryIds)];

            if (tableName) {
                conditions.push(eq(memoryTable.type, tableName));
            }

            const rows = await this.db
                .select({
                    memory: memoryTable,
                    embedding: embeddingTable[this.embeddingDimension],
                })
                .from(memoryTable)
                .leftJoin(
                    embeddingTable,
                    eq(embeddingTable.memoryId, memoryTable.id)
                )
                .where(and(...conditions))
                .orderBy(desc(memoryTable.createdAt));

            return rows.map((row) => ({
                id: row.memory.id as UUID,
                createdAt: row.memory.createdAt,
                content:
                    typeof row.memory.content === "string"
                        ? JSON.parse(row.memory.content)
                        : row.memory.content,
                entityId: row.memory.entityId as UUID,
                agentId: row.memory.agentId as UUID,
                roomId: row.memory.roomId as UUID,
                unique: row.memory.unique,
                embedding: row.embedding ?? undefined,
            }));
        });
    }

    async getCachedEmbeddings(opts: {
        query_table_name: string;
        query_threshold: number;
        query_input: string;
        query_field_name: string;
        query_field_sub_name: string;
        query_match_count: number;
    }): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
        return this.withDatabase(async () => {
            try {
                const results = await this.db.execute<{
                    embedding: number[];
                    levenshtein_score: number;
                }>(sql`
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
                    SELECT
                        embedding,
                        levenshtein(${opts.query_input}, content_text) as levenshtein_score
                    FROM embedded_text
                    WHERE levenshtein(${opts.query_input}, content_text) <= ${opts.query_threshold}
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
                logger.error("Error in getCachedEmbeddings:", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    tableName: opts.query_table_name,
                    fieldName: opts.query_field_name,
                });
                if (
                    error instanceof Error &&
                    error.message ===
                        "levenshtein argument exceeds maximum length of 255 characters"
                ) {
                    return [];
                }
                throw error;
            }
        });
    }

    async log(params: {
        body: { [key: string]: unknown };
        entityId: UUID;
        roomId: UUID;
        type: string;
    }): Promise<void> {
        return this.withDatabase(async () => {
            try {
                await this.db.transaction(async (tx) => {
                    await tx.insert(logTable).values({
                        body: sql`${params.body}::jsonb`,
                        entityId: params.entityId,
                        roomId: params.roomId,
                        type: params.type,
                    });
                });
            } catch (error) {
                logger.error("Failed to create log entry:", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    type: params.type,
                    roomId: params.roomId,
                    entityId: params.entityId,
                });
                throw error;
            }
        });
    }

    async searchMemories(params: {
        tableName: string;
        roomId: UUID;
        embedding: number[];
        match_threshold: number;
        count: number;
        unique: boolean;
    }): Promise<Memory[]> {
        return await this.searchMemoriesByEmbedding(params.embedding, {
            match_threshold: params.match_threshold,
            count: params.count,
            roomId: params.roomId,
            unique: params.unique,
            tableName: params.tableName,
        });
    }

    async updateGoalStatus(params: {
        goalId: UUID;
        status: GoalStatus;
    }): Promise<void> {
        return this.withDatabase(async () => {
            try {
                await this.db.transaction(async (tx) => {
                    await tx
                        .update(goalTable)
                        .set({
                            status: params.status as string,
                        })
                        .where(eq(goalTable.id, params.goalId));
                });
            } catch (error) {
                logger.error("Failed to update goal status:", {
                    goalId: params.goalId,
                    status: params.status,
                    error: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        });
    }

    async searchMemoriesByEmbedding(
        embedding: number[],
        params: {
            match_threshold?: number;
            count?: number;
            roomId?: UUID;
            unique?: boolean;
            tableName: string;
        }
    ): Promise<Memory[]> {
        return this.withDatabase(async () => {
            const cleanVector = embedding.map((n) =>
                Number.isFinite(n) ? Number(n.toFixed(6)) : 0
            );

            const similarity = sql<number>`1 - (${cosineDistance(
                embeddingTable[this.embeddingDimension],
                cleanVector
            )})`;

            const conditions = [eq(memoryTable.type, params.tableName)];

            if (params.unique) {
                conditions.push(eq(memoryTable.unique, true));
            }
            
            conditions.push(eq(memoryTable.agentId, this.agentId));
            
            if (params.roomId) {
                conditions.push(eq(memoryTable.roomId, params.roomId));
            }

            if (params.match_threshold) {
                conditions.push(gte(similarity, params.match_threshold));
            }

            const results = await this.db
                .select({
                    memory: memoryTable,
                    similarity,
                    embedding: embeddingTable[this.embeddingDimension],
                })
                .from(embeddingTable)
                .innerJoin(
                    memoryTable,
                    eq(memoryTable.id, embeddingTable.memoryId)
                )
                .where(and(...conditions))
                .orderBy(desc(similarity))
                .limit(params.count ?? 10);

            return results.map((row) => ({
                id: row.memory.id as UUID,
                type: row.memory.type,
                createdAt: row.memory.createdAt,
                content:
                    typeof row.memory.content === "string"
                        ? JSON.parse(row.memory.content)
                        : row.memory.content,
                entityId: row.memory.entityId as UUID,
                agentId: row.memory.agentId as UUID,
                roomId: row.memory.roomId as UUID,
                unique: row.memory.unique,
                embedding: row.embedding ?? undefined,
                similarity: row.similarity,
            }));
        });
    }

    async createMemory(memory: Memory & { metadata?: MemoryMetadata }, tableName: string): Promise<UUID> {
        logger.debug("DrizzleAdapter createMemory:", {
            memoryId: memory.id,
            embeddingLength: memory.embedding?.length,
            contentLength: memory.content?.text?.length,
        });

        let isUnique = true;
        if (memory.embedding && Array.isArray(memory.embedding)) {
            const similarMemories = await this.searchMemoriesByEmbedding(
                memory.embedding,
                {
                    tableName,
                    roomId: memory.roomId,
                    match_threshold: 0.95,
                    count: 1,
                }
            );
            isUnique = similarMemories.length === 0;
        }

        const contentToInsert =
            typeof memory.content === "string"
                ? JSON.parse(memory.content)
                : memory.content;

        const memoryId = memory.id ?? v4() as UUID;

        await this.db.transaction(async (tx) => {
            await tx.insert(memoryTable).values([{
                id: memoryId,
                type: tableName,
                content: sql`${contentToInsert}::jsonb`,
                metadata: sql`${memory.metadata || {}}::jsonb`,
                entityId: memory.entityId,
                roomId: memory.roomId,
                agentId: memory.agentId,
                unique: memory.unique ?? isUnique,
                createdAt: memory.createdAt,
            }]);

            if (memory.embedding && Array.isArray(memory.embedding)) {
                const embeddingValues: Record<string, unknown> = {
                    id: v4(),
                    memoryId: memoryId,
                    createdAt: memory.createdAt,
                };

                const cleanVector = memory.embedding.map((n) =>
                    Number.isFinite(n) ? Number(n.toFixed(6)) : 0
                );

                embeddingValues[this.embeddingDimension] = cleanVector;

                await tx.insert(embeddingTable).values([embeddingValues]);
            }
        });

        return memoryId;
    }

    async removeMemory(memoryId: UUID, tableName: string): Promise<void> {
        return this.withDatabase(async () => {
            await this.db.transaction(async (tx) => {
                await tx
                    .delete(embeddingTable)
                    .where(eq(embeddingTable.memoryId, memoryId));

                await tx
                    .delete(memoryTable)
                    .where(
                        and(
                            eq(memoryTable.id, memoryId),
                            eq(memoryTable.type, tableName)
                        )
                    );
            });

            logger.debug("Memory removed successfully:", {
                memoryId,
                tableName,
            });
        });
    }

    async removeAllMemories(roomId: UUID, tableName: string): Promise<void> {
        return this.withDatabase(async () => {
            await this.db.transaction(async (tx) => {
                const memoryIds = await tx
                    .select({ id: memoryTable.id })
                    .from(memoryTable)
                    .where(
                        and(
                            eq(memoryTable.roomId, roomId),
                            eq(memoryTable.type, tableName)
                        )
                    );

                if (memoryIds.length > 0) {
                    await tx.delete(embeddingTable).where(
                        inArray(
                            embeddingTable.memoryId,
                            memoryIds.map((m) => m.id)
                        )
                    );

                    await tx
                        .delete(memoryTable)
                        .where(
                            and(
                                eq(memoryTable.roomId, roomId),
                                eq(memoryTable.type, tableName)
                            )
                        );
                }
            });

            logger.debug("All memories removed successfully:", {
                roomId,
                tableName,
            });
        });
    }

    async countMemories(
        roomId: UUID,
        unique = true,
        tableName = ""
    ): Promise<number> {
        if (!tableName) throw new Error("tableName is required");

        return this.withDatabase(async () => {
            const conditions = [
                eq(memoryTable.roomId, roomId),
                eq(memoryTable.type, tableName),
            ];

            if (unique) {
                conditions.push(eq(memoryTable.unique, true));
            }

            const result = await this.db
                .select({ count: sql<number>`count(*)` })
                .from(memoryTable)
                .where(and(...conditions));

            return Number(result[0]?.count ?? 0);
        });
    }

    async getGoals(params: {
        roomId: UUID;
        entityId?: UUID | null;
        onlyInProgress?: boolean;
        count?: number;
    }): Promise<Goal[]> {
        return this.withDatabase(async () => {
            const conditions = [eq(goalTable.roomId, params.roomId)];

            if (params.entityId) {
                conditions.push(eq(goalTable.entityId, params.entityId));
            }

            if (params.onlyInProgress) {
                conditions.push(
                    eq(goalTable.status, "IN_PROGRESS" as GoalStatus)
                );
            }

            const query = this.db
                .select()
                .from(goalTable)
                .where(and(...conditions))
                .orderBy(desc(goalTable.createdAt));

            const result = await (params.count
                ? query.limit(params.count)
                : query);

            return result.map((row) => ({
                id: row.id as UUID,
                roomId: row.roomId as UUID,
                entityId: row.entityId as UUID,
                name: row.name ?? "",
                status: (row.status ?? "NOT_STARTED") as GoalStatus,
                description: row.description ?? "",
                objectives: row.objectives as unknown[],
                createdAt: row.createdAt,
            }));
        });
    }

    async updateGoal(goal: Goal): Promise<void> {
        return this.withDatabase(async () => {
            try {
                await this.db.transaction(async (tx) => {
                    await tx
                        .update(goalTable)
                        .set({
                            name: goal.name,
                            status: goal.status,
                            objectives: goal.objectives,
                        })
                        .where(eq(goalTable.id, goal.id as string));
                });
            } catch (error) {
                logger.error("Failed to update goal:", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    goalId: goal.id,
                    status: goal.status,
                });
                throw error;
            }
        });
    }

    async createGoal(goal: Goal): Promise<void> {
        return this.withDatabase(async () => {
            try {
                await this.db.transaction(async (tx) => {
                    await tx.insert(goalTable).values({
                        id: goal.id ?? v4(),
                        roomId: goal.roomId,
                        entityId: goal.entityId,
                        name: goal.name,
                        status: goal.status,
                        objectives: sql`${goal.objectives}::jsonb`,
                    });
                });
            } catch (error) {
                logger.error("Failed to update goal:", {
                    goalId: goal.id,
                    error: error instanceof Error ? error.message : String(error),
                    status: goal.status,
                });
                throw error;
            }
        });
    }

    async removeGoal(goalId: UUID): Promise<void> {
        if (!goalId) throw new Error("Goal ID is required");
    
        return this.withDatabase(async () => {
            try {
                await this.db.transaction(async (tx) => {
                    await tx.delete(goalTable).where(eq(goalTable.id, goalId));
                });
    
                logger.debug("Goal removal attempt:", {
                    goalId,
                    removed: true,
                });
            } catch (error) {
                logger.error("Failed to remove goal:", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    goalId,
                });
                throw error;
            }
        });
    }

    async removeAllGoals(roomId: UUID): Promise<void> {
        return this.withDatabase(async () => {
            await this.db.transaction(async (tx) => {
                await tx.delete(goalTable).where(eq(goalTable.roomId, roomId));
            });
        });
    }

    async getRoom(roomId: UUID): Promise<Room | null> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select({
                    id: roomTable.id,
                    channelId: roomTable.channelId,
                    agentId: roomTable.agentId,
                    serverId: roomTable.serverId,
                    worldId: roomTable.worldId,
                    type: roomTable.type,
                    source: roomTable.source,
                })
                .from(roomTable)
                .where(and(eq(roomTable.id, roomId), eq(roomTable.agentId, this.agentId)))
                .limit(1);
            if (result.length === 0) return null;
            return result[0]
        });
    }

    async getRooms(worldId: UUID): Promise<Room[]> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select()
                .from(roomTable)
                .where(eq(roomTable.worldId, worldId));
            return result;
        });
    }

    async updateRoom(room: Room): Promise<void> {
        return this.withDatabase(async () => {
            await this.db.update(roomTable).set({ ...room, agentId: this.agentId }).where(eq(roomTable.id, room.id));
        });
    }

    async createRoom({id, name, source, type, channelId, serverId, worldId}: Room): Promise<UUID> {
        return this.withDatabase(async () => {
            const newRoomId = id || v4();
            await this.db.insert(roomTable).values({
                id: newRoomId,
                name,
                agentId: this.agentId,
                source,
                type,
                channelId,
                serverId,
                worldId,
            })
            .onConflictDoNothing({ target: roomTable.id });
            return newRoomId as UUID;
        });
    }

    async deleteRoom(roomId: UUID): Promise<void> {
        if (!roomId) throw new Error("Room ID is required");
        return this.withDatabase(async () => {
            await this.db.transaction(async (tx) => {
                await tx.delete(roomTable).where(eq(roomTable.id, roomId));
            });
        });
    }

    async getRoomsForParticipant(entityId: UUID): Promise<UUID[]> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select({ roomId: participantTable.roomId })
                .from(participantTable)
                .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
                .where(
                    and(
                        eq(participantTable.entityId, entityId),
                        eq(roomTable.agentId, this.agentId)
                    )
                );

            return result.map((row) => row.roomId as UUID);
        });
    }

    async getRoomsForParticipants(entityIds: UUID[]): Promise<UUID[]> {
        return this.withDatabase(async () => {
            const result = await this.db
                .selectDistinct({ roomId: participantTable.roomId })
                .from(participantTable)
                .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
                .where(
                    and(
                        inArray(participantTable.entityId, entityIds),
                        eq(roomTable.agentId, this.agentId)
                    )
                );

            return result.map((row) => row.roomId as UUID);
        });
    }

    async addParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
        return this.withDatabase(async () => {
            try {
                await this.db.insert(participantTable).values({
                    entityId,
                    roomId,
                    agentId: this.agentId,
                })
                .onConflictDoNothing();
                return true;
            } catch (error) {
                logger.error("Error adding participant", {
                    error:
                        error instanceof Error ? error.message : String(error),
                        entityId,
                    roomId,
                    agentId: this.agentId,
                });
                return false;
            }
        });
    }

    async removeParticipant(entityId: UUID, roomId: UUID): Promise<boolean> {
        return this.withDatabase(async () => {
            try {
                const result = await this.db.transaction(async (tx) => {
                    return await tx
                        .delete(participantTable)
                        .where(
                            and(
                                eq(participantTable.entityId, entityId),
                                eq(participantTable.roomId, roomId)
                            )
                        ).returning();
                });
                
                const removed = result.length > 0;
                logger.debug(`Participant ${removed ? 'removed' : 'not found'}:`, {
                    entityId,
                    roomId,
                    removed,
                });
                
                return removed;
            } catch (error) {
                logger.error("Failed to remove participant:", {
                    error:
                        error instanceof Error ? error.message : String(error),
                        entityId,
                    roomId,
                });
                return false;
            }
        });
    }

    async getParticipantsForEntity(entityId: UUID): Promise<Participant[]> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select({
                    id: participantTable.id,
                    entityId: participantTable.entityId,
                    roomId: participantTable.roomId,
                })
                .from(participantTable)
                .where(eq(participantTable.entityId, entityId));

            const entity = await this.getEntityById(entityId);

            if (!entity) {
                return [];
            }

            return result.map((row) => ({
                id: row.id as UUID,
                entity: entity,
            }));
        });
    }

    async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select({ entityId: participantTable.entityId })
                .from(participantTable)
                .where(
                    and(
                        eq(participantTable.roomId, roomId),
                        eq(participantTable.agentId, this.agentId)
                    )
                );

            return result.map((row) => row.entityId as UUID);
        });
    }

    async getParticipantUserState(
        roomId: UUID,
        entityId: UUID,
    ): Promise<"FOLLOWED" | "MUTED" | null> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select({ roomState: participantTable.roomState })
                .from(participantTable)
                .where(
                    and(
                        eq(participantTable.roomId, roomId),
                        eq(participantTable.entityId, entityId),
                        eq(participantTable.agentId, this.agentId)
                    )
                )
                .limit(1);

            return (
                (result[0]?.roomState as "FOLLOWED" | "MUTED" | null) ?? null
            );
        });
    }

    async setParticipantUserState(
        roomId: UUID,
        entityId: UUID,
        state: "FOLLOWED" | "MUTED" | null
    ): Promise<void> {
        return this.withDatabase(async () => {
            try {
                await this.db.transaction(async (tx) => {
                    await tx
                        .update(participantTable)
                        .set({ roomState: state })
                        .where(
                            and(
                                eq(participantTable.roomId, roomId),
                                eq(participantTable.entityId, entityId),
                                eq(participantTable.agentId, this.agentId)
                            )
                        );
                });
            } catch (error) {
                logger.error("Failed to set participant user state:", {
                    roomId,
                    entityId,
                    state,
                    error: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        });
    }

    async createRelationship(params: {
        sourceEntityId: UUID;
        targetEntityId: UUID;
        tags?: string[];
        metadata?: { [key: string]: unknown };
    }): Promise<boolean> {
        return this.withDatabase(async () => {const id = v4();
            const saveParams = {
                id,
                sourceEntityId: params.sourceEntityId,
                targetEntityId: params.targetEntityId,
                agentId: this.agentId,
                tags: params.tags || [],
                metadata: params.metadata || {},
            }
            try {
                await this.db.insert(relationshipTable).values(saveParams);
                return true;
            } catch (error) {
                logger.error("Error creating relationship:", {
                    error: error instanceof Error ? error.message : String(error),
                    saveParams,
                });
                return false;
            }
        });
    }

    async updateRelationship(relationship: Relationship): Promise<void> {
        return this.withDatabase(async () => {
            try {
                await this.db.update(relationshipTable)
                    .set({
                        tags: relationship.tags || [],
                        metadata: relationship.metadata || {},
                    })
                    .where(eq(relationshipTable.id, relationship.id));
            } catch (error) {
                logger.error("Error updating relationship:", {
                    error: error instanceof Error ? error.message : String(error),
                    relationship,
                });
                throw error;
            }
        });
    }

    async getRelationship(params: {
        sourceEntityId: UUID;
        targetEntityId: UUID;
    }): Promise<Relationship | null> {
        return this.withDatabase(async () => {
            try {
                const result = await this.db
                    .select()
                    .from(relationshipTable)
                    .where(
                        and(
                            eq(relationshipTable.sourceEntityId, params.sourceEntityId),
                            eq(relationshipTable.targetEntityId, params.targetEntityId),
                            eq(relationshipTable.agentId, this.agentId)
                        )
                    )
                    .limit(1);

                if (result.length === 0) {
                    return null;
                }

                return {
                    id: result[0].id,
                    sourceEntityId: result[0].sourceEntityId,
                    targetEntityId: result[0].targetEntityId,
                    agentId: result[0].agentId,
                    tags: result[0].tags || [],
                    metadata: result[0].metadata || {},
                    createdAt: result[0].createdAt?.toString()
                };
            } catch (error) {
                logger.error("Error getting relationship:", {
                    error: error instanceof Error ? error.message : String(error),
                    params,
                });
                return null;
            }
        });
    }

    async getRelationships(params: { 
        entityId: UUID;
        tags?: string[];
    }): Promise<Relationship[]> {
        return this.withDatabase(async () => {
            try {
                let query = this.db
                    .select()
                    .from(relationshipTable)
                    .where(
                        and(
                            eq(relationshipTable.sourceEntityId, params.entityId),
                            eq(relationshipTable.agentId, this.agentId)
                        )
                    );

                // Filter by tags if provided
                if (params.tags && params.tags.length > 0) {
                    // Filter by tags - find tasks that have ALL of the specified tags
                    // Using @> operator which checks if left array contains all elements from right array
                    const tagParams = params.tags.map(tag => `'${tag.replace(/'/g, "''")}'`).join(', ');
                    query = query.where(
                        sql`${relationshipTable.tags} @> ARRAY[${sql.raw(tagParams)}]::text[]`
                    );
                }

                const results = await query;

                return results.map(result => ({
                    id: result.id,
                    sourceEntityId: result.sourceEntityId,
                    targetEntityId: result.targetEntityId,
                    agentId: result.agentId,
                    tags: result.tags || [],
                    metadata: result.metadata || {},
                    createdAt: result.createdAt?.toString()
                }));
            } catch (error) {
                logger.error("Error getting relationships:", {
                    error: error instanceof Error ? error.message : String(error),
                    params,
                });
                return [];
            }
        });
    }

    async getCache<T>(key: string): Promise<T | undefined> {
        return this.withDatabase(async () => {
            try {
                const result = await this.db
                    .select()
                    .from(cacheTable)
                    .where(
                        and(
                            eq(cacheTable.agentId, this.agentId),
                            eq(cacheTable.key, key)
                        )
                    );

                return result[0]?.value as T | undefined;
            } catch (error) {
                logger.error("Error fetching cache", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    key: key,
                    agentId: this.agentId,
                });
                return undefined;
            }
        });
    }

    async setCache<T>(key: string, value: T): Promise<boolean> {
        return this.withDatabase(async () => {
            try {
                await this.db.transaction(async (tx) => {
                    await tx
                        .insert(cacheTable)
                        .values({
                            key: key,
                            agentId: this.agentId,
                            value: value,
                        })
                        .onConflictDoUpdate({
                            target: [cacheTable.key, cacheTable.agentId],
                            set: {
                                value: value,
                            },
                        });
                });
                return true;
            } catch (error) {
                logger.error("Error setting cache", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    key: key,
                    agentId: this.agentId,
                });
                return false;
            }
        });
    }

    async deleteCache(key: string): Promise<boolean> {
        return this.withDatabase(async () => {
            try {
                await this.db.transaction(async (tx) => {
                    await tx
                        .delete(cacheTable)
                        .where(
                            and(
                                eq(cacheTable.agentId, this.agentId),
                                eq(cacheTable.key, key)
                            )
                        );
                });
                return true;
            } catch (error) {
                logger.error("Error deleting cache", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    key: key,
                    agentId: this.agentId,
                });
                return false;
            }
        });
    }


    async createWorld(world: World): Promise<UUID> {
        return this.withDatabase(async () => {
            const newWorldId = world.id || v4();
            await this.db.insert(worldTable).values({
                ...world,
                id: newWorldId,
            });
            return newWorldId;
        });
    }
    
    async getWorld(id: UUID): Promise<World | null> {
        return this.withDatabase(async () => {
            const result = await this.db.select().from(worldTable).where(eq(worldTable.id, id));
            return result[0] as World | null;
        });
    }

    async getAllWorlds(): Promise<World[]> {
        return this.withDatabase(async () => {
            const result = await this.db.select().from(worldTable).where(eq(worldTable.agentId, this.agentId));
            return result as World[];
        });
    }

    async updateWorld(world: World): Promise<void> {
        return this.withDatabase(async () => {
            await this.db.update(worldTable).set(world).where(eq(worldTable.id, world.id));
        });
    }

    async removeWorld(id: UUID): Promise<void> {
        return this.withDatabase(async () => {
            await this.db.delete(worldTable).where(eq(worldTable.id, id));
        });
    }

    /**
     * Creates a new task in the database.
     * @param task The task object to create
     * @returns Promise resolving to the UUID of the created task
     */
    async createTask(task: Task): Promise<UUID> {
        return this.withRetry(async () => {
            return this.withDatabase(async () => {
                const now = new Date();
                const metadata = task.metadata || {};
                
                const values = {
                    id: task.id as UUID,
                    name: task.name,
                    description: task.description,
                    roomId: task.roomId,
                    worldId: task.worldId,
                    tags: task.tags,
                    metadata: metadata,
                    createdAt: now,
                    updatedAt: now,
                    agentId: this.agentId
                }
                const result = await this.db.insert(taskTable)
                    .values(values)
                    .returning({ id: taskTable.id });
                
                return result[0].id;
            });
        });
    }

    /**
     * Retrieves tasks based on specified parameters.
     * @param params Object containing optional roomId and tags to filter tasks
     * @returns Promise resolving to an array of Task objects
     */
    async getTasks(params: { roomId?: UUID; tags?: string[]; }): Promise<Task[]> {
        return this.withRetry(async () => {
            return this.withDatabase(async () => {
                let query = this.db.select()
                    .from(taskTable)
                    .where(eq(taskTable.agentId, this.agentId));
                
                // Apply filters if provided
                if (params.roomId) {
                    query = query.where(eq(taskTable.roomId, params.roomId));
                }
                
                if (params.tags && params.tags.length > 0) {
                    // Filter by tags - find tasks that have ALL of the specified tags
                    // Using @> operator which checks if left array contains all elements from right array
                    const tagParams = params.tags.map(tag => `'${tag.replace(/'/g, "''")}'`).join(', ');
                    query = query.where(
                        sql`${taskTable.tags} @> ARRAY[${sql.raw(tagParams)}]::text[]`
                    );
                }
                
                const result = await query;
                
                return result.map(row => ({
                    id: row.id,
                    name: row.name,
                    description: row.description,
                    roomId: row.roomId,
                    worldId: row.worldId,
                    tags: row.tags,
                    metadata: row.metadata
                }));
            });
        });
    }

    /**
     * Retrieves a specific task by its name.
     * @param name The name of the task to retrieve
     * @returns Promise resolving to the Task object if found, null otherwise
     */
    async getTasksByName(name: string): Promise<Task[]> {
        return this.withRetry(async () => {
            return this.withDatabase(async () => {
                const result = await this.db.select()
                    .from(taskTable)
                    .where(
                        and(
                            eq(taskTable.name, name),
                            eq(taskTable.agentId, this.agentId)
                        )
                    )
                
                return result.map(row => ({
                    id: row.id,
                    name: row.name,
                    description: row.description,
                    roomId: row.roomId,
                    worldId: row.worldId,
                    tags: row.tags || [],
                    metadata: row.metadata || {}
                }));
            });
        });
    }
    

    /**
     * Retrieves a specific task by its ID.
     * @param id The UUID of the task to retrieve
     * @returns Promise resolving to the Task object if found, null otherwise
     */
    async getTask(id: UUID): Promise<Task | null> {
        return this.withRetry(async () => {
            return this.withDatabase(async () => {
                const result = await this.db.select()
                    .from(taskTable)
                    .where(
                        and(
                            eq(taskTable.id, id),
                            eq(taskTable.agentId, this.agentId)
                        )
                    )
                    .limit(1);
                
                if (result.length === 0) {
                    return null;
                }
                
                const row = result[0];
                return {
                    id: row.id,
                    name: row.name,
                    description: row.description,
                    roomId: row.roomId,
                    worldId: row.worldId,
                    tags: row.tags || [],
                    metadata: row.metadata || {}
                };
            });
        });
    }

    /**
     * Updates an existing task in the database.
     * @param id The UUID of the task to update
     * @param task Partial Task object containing the fields to update
     * @returns Promise resolving when the update is complete
     */
    async updateTask(id: UUID, task: Partial<Task>): Promise<void> {
        await this.withRetry(async () => {
            await this.withDatabase(async () => {
                const updateValues: Partial<Task> = {};
                
                // Add fields to update if they exist in the partial task object
                if (task.name !== undefined) updateValues.name = task.name;
                if (task.description !== undefined) updateValues.description = task.description;
                if (task.roomId !== undefined) updateValues.roomId = task.roomId;
                if (task.worldId !== undefined) updateValues.worldId = task.worldId;
                if (task.tags !== undefined) updateValues.tags = task.tags;

                task.updatedAt = Date.now();
                
                // Handle metadata updates
                if (task.metadata) {
                    // Get current task to merge metadata
                    const currentTask = await this.getTask(id);
                    if (currentTask) {
                        const currentMetadata = currentTask.metadata || {};
                        const newMetadata = {
                            ...currentMetadata,
                            ...task.metadata,
                        };
                        updateValues.metadata = newMetadata;
                    } else {
                        updateValues.metadata = {
                            ...task.metadata,
                        };
                    }
                }
                
                await this.db.update(taskTable)
                    .set(updateValues)
                    .where(
                        and(
                            eq(taskTable.id, id),
                            eq(taskTable.agentId, this.agentId)
                        )
                    );
            });
        });
    }

    /**
     * Deletes a task from the database.
     * @param id The UUID of the task to delete
     * @returns Promise resolving when the deletion is complete
     */
    async deleteTask(id: UUID): Promise<void> {
        await this.withRetry(async () => {
            await this.withDatabase(async () => {
                await this.db.delete(taskTable)
                    .where(
                        and(
                            eq(taskTable.id, id),
                            eq(taskTable.agentId, this.agentId)
                        )
                    );
            });
        });
    }
}
