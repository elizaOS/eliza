import {
    type Account,
    type Actor,
    DatabaseAdapter,
    type GoalStatus,
    type Participant,
    logger,
    type Goal,
    type IDatabaseCacheAdapter,
    type Memory,
    type Relationship,
    type UUID,
} from "@elizaos/core";
import {
    and,
    eq,
    gte,
    lte,
    sql,
    desc,
    inArray,
    or,
    cosineDistance,
} from "drizzle-orm";
import {
    accountTable,
    goalTable,
    logTable,
    memoryTable,
    participantTable,
    relationshipTable,
    roomTable,
    knowledgeTable,
    cacheTable,
} from "./schema";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { v4 } from "uuid";
import { runMigrations } from "./migrations";
import pg, { type ConnectionConfig, type PoolConfig } from "pg";
type Pool = pg.Pool;

export class DrizzleDatabaseAdapter
    extends DatabaseAdapter<NodePgDatabase>
    implements IDatabaseCacheAdapter
{
    private pool: Pool;
    private readonly maxRetries: number = 3;
    private readonly baseDelay: number = 1000; // 1 second
    private readonly maxDelay: number = 10000; // 10 seconds
    private readonly jitterMax: number = 1000; // 1 second
    private readonly connectionTimeout: number = 5000; // 5 seconds

    constructor(
        connectionConfig: any,
    ) {
        super();
        const defaultConfig = {
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: this.connectionTimeout,
        };

        const { poolConfig } = this.parseConnectionConfig(
            connectionConfig,
            defaultConfig
        );
        this.pool = new pg.Pool(poolConfig);

        this.pool.on("error", (err) => {
            logger.error("Unexpected pool error", err);
            this.handlePoolError(err);
        });

        this.setupPoolErrorHandling();
        this.db = drizzle({ client: this.pool });
    }

    private setupPoolErrorHandling() {
        process.on("SIGINT", async () => {
            await this.cleanup();
            process.exit(0);
        });

        process.on("SIGTERM", async () => {
            await this.cleanup();
            process.exit(0);
        });

        process.on("beforeExit", async () => {
            await this.cleanup();
        });
    }

    private async handlePoolError(error: Error) {
        logger.error("Pool error occurred, attempting to reconnect", {
            error: error.message,
        });

        try {
            // Close existing pool
            await this.pool.end();

            // Create new pool
            this.pool = new pg.Pool({
                ...this.pool.options,
                connectionTimeoutMillis: this.connectionTimeout,
            });

            await this.testConnection();
            logger.success("Pool reconnection successful");
        } catch (reconnectError) {
            logger.error("Failed to reconnect pool", {
                error:
                    reconnectError instanceof Error
                        ? reconnectError.message
                        : String(reconnectError),
            });
            throw reconnectError;
        }
    }

    private async withDatabase<T>(
        operation: () => Promise<T>,
        context: string
    ): Promise<T> {
        return this.withRetry(operation);
    }

    private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
        let lastError: Error = new Error("Unknown error"); // Initialize with default

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error as Error;

                if (attempt < this.maxRetries) {
                    // Calculate delay with exponential backoff
                    const backoffDelay = Math.min(
                        this.baseDelay * (2 ** (attempt - 1)),
                        this.maxDelay
                    );

                    // Add jitter to prevent thundering herd
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

    async cleanup(): Promise<void> {
        try {
            await this.pool.end();
            logger.info("Database pool closed");
        } catch (error) {
            logger.error("Error closing database pool:", error);
        }
    }

    private parseConnectionConfig(
        config: ConnectionConfig,
        defaults: Partial<PoolConfig>
    ): { poolConfig: PoolConfig; databaseName: string } {
        if (typeof config === "string") {
            try {
                const url = new URL(config);
                const databaseName = url.pathname.split("/")[1] || "postgres";
                return {
                    poolConfig: { ...defaults, connectionString: config },
                    databaseName,
                };
            } catch (error) {
                throw new Error(
                    `Invalid connection string: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
            }
        } else {
            return {
                poolConfig: { ...defaults, ...config },
                databaseName: config.database || "postgres",
            };
        }
    }

    private async validateVectorSetup(): Promise<boolean> {
        try {
            const vectorExt = await this.db.execute(sql`
                SELECT * FROM pg_extension WHERE extname = 'vector'
            `);

            const hasVector = vectorExt?.rows.length > 0;

            if (!hasVector) {
                logger.warn("Vector extension not found");
                return false;
            }

            return true;
        } catch (error) {
            logger.error("Error validating vector setup:", error);
            return false;
        }
    }

    async init(): Promise<void> {
        try {
            // TODO: Get the null embedding from provider, if no provider is set for embeddings, throw an error
            // Store the embedding dimension on this class so we can use elsewhere

            const { rows } = await this.db.execute(sql`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'rooms'
                );
            `);

            if (!rows[0].exists || !(await this.validateVectorSetup())) {
                await runMigrations(this.pool);
            }
        } catch (error) {
            logger.error("Failed to initialize database:", error);
            throw error;
        }
    }

    async close(): Promise<void> {
        try {
            if (this.db && (this.db as any).client) {
                await (this.db as any).client.close();
            }
        } catch (error) {
            logger.error("Failed to close database connection:", {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    async testConnection(): Promise<boolean> {
        try {
            const result = await this.db.execute(sql`SELECT NOW()`);
            logger.success(
                "Database connection test successful:",
                result.rows[0]
            );
            return true;
        } catch (error) {
            logger.error("Database connection test failed:", error);
            throw new Error(
                `Failed to connect to database: ${(error as Error).message}`
            );
        }
    }

    async getAccountById(userId: UUID): Promise<Account | null> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select()
                .from(accountTable)
                .where(eq(accountTable.id, userId))
                .limit(1);

            if (result.length === 0) return null;

            const account = result[0];

            return {
                id: account.id as UUID,
                name: account.name ?? "",
                username: account.username ?? "",
                email: account.email ?? "",
                avatarUrl: account.avatarUrl ?? "",
                details: account.details ?? {},
            };
        }, "getAccountById");
    }

    async createAccount(account: Account): Promise<boolean> {
        return this.withDatabase(async () => {
            try {
                const accountId = account.id ?? v4();

                await this.db.insert(accountTable).values({
                    id: accountId,
                    name: account.name ?? null,
                    username: account.username ?? null,
                    email: account.email ?? "",
                    avatarUrl: account.avatarUrl ?? null,
                    details: sql`${account.details}::jsonb` || {},
                });

                logger.debug("Account created successfully:", {
                    accountId,
                });

                return true;
            } catch (error) {
                logger.error("Error creating account:", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    accountId: account.id,
                    name: account.name,
                });
                return false;
            }
        }, "createAccount");
    }

    async getMemories(params: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        tableName: string;
        agentId?: UUID;
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

            if (params.agentId) {
                conditions.push(eq(memoryTable.agentId, params.agentId));
            }

            const query = this.db
                .select()
                .from(memoryTable)
                .where(and(...conditions))
                .orderBy(desc(memoryTable.createdAt));

            const rows = params.count
                ? await query.limit(params.count)
                : await query;

            return rows.map((row) => ({
                id: row.id as UUID,
                type: row.type,
                createdAt: row.createdAt,
                content:
                    typeof row.content === "string"
                        ? JSON.parse(row.content)
                        : row.content,
                embedding: row.embedding ?? undefined,
                userId: row.userId as UUID,
                agentId: row.agentId as UUID,
                roomId: row.roomId as UUID,
                unique: row.unique,
            }));
        }, "getMemories");
    }

    async getMemoriesByRoomIds(params: {
        roomIds: UUID[];
        agentId?: UUID;
        tableName: string;
        limit?: number;
    }): Promise<Memory[]> {
        return this.withDatabase(async () => {
            if (params.roomIds.length === 0) return [];

            const conditions = [
                eq(memoryTable.type, params.tableName),
                inArray(memoryTable.roomId, params.roomIds),
            ];

            if (params.agentId) {
                conditions.push(eq(memoryTable.agentId, params.agentId));
            }

            const query = this.db
                .select()
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
                embedding: row.embedding,
                userId: row.userId as UUID,
                agentId: row.agentId as UUID,
                roomId: row.roomId as UUID,
                unique: row.unique,
            })) as Memory[];
        }, "getMemoriesByRoomIds");
    }

    async getMemoryById(id: UUID): Promise<Memory | null> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select()
                .from(memoryTable)
                .where(eq(memoryTable.id, id))
                .limit(1);

            if (result.length === 0) return null;

            const row = result[0];
            return {
                id: row.id as UUID,
                createdAt: row.createdAt,
                content:
                    typeof row.content === "string"
                        ? JSON.parse(row.content)
                        : row.content,
                embedding: row.embedding ?? undefined,
                userId: row.userId as UUID,
                agentId: row.agentId as UUID,
                roomId: row.roomId as UUID,
                unique: row.unique,
            };
        }, "getMemoryById");
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
                .select()
                .from(memoryTable)
                .where(and(...conditions))
                .orderBy(desc(memoryTable.createdAt));

            return rows.map((row) => ({
                id: row.id as UUID,
                createdAt: row.createdAt,
                content:
                    typeof row.content === "string"
                        ? JSON.parse(row.content)
                        : row.content,
                embedding: row.embedding ?? undefined,
                userId: row.userId as UUID,
                agentId: row.agentId as UUID,
                roomId: row.roomId as UUID,
                unique: row.unique,
            }));
        }, "getMemoriesByIds");
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
                            embedding,
                            COALESCE(
                                content->>${opts.query_field_sub_name},
                                ''
                            ) as content_text
                        FROM memories
                        WHERE type = ${opts.query_table_name}
                            AND content->>${opts.query_field_sub_name} IS NOT NULL
                    )
                    SELECT
                        embedding,
                        levenshtein(${opts.query_input}, content_text) as levenshtein_score
                    FROM content_text
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
        }, "getCachedEmbeddings");
    }

    async log(params: {
        body: { [key: string]: unknown };
        userId: UUID;
        roomId: UUID;
        type: string;
    }): Promise<void> {
        return this.withDatabase(async () => {
            try {
                await this.db.insert(logTable).values({
                    body: sql`${params.body}::jsonb`,
                    userId: params.userId,
                    roomId: params.roomId,
                    type: params.type,
                });
            } catch (error) {
                logger.error("Failed to create log entry:", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    type: params.type,
                    roomId: params.roomId,
                    userId: params.userId,
                });
                throw error;
            }
        }, "log");
    }

    async getActorDetails(params: { roomId: string }): Promise<Actor[]> {
        if (!params.roomId) {
            throw new Error("roomId is required");
        }

        return this.withDatabase(async () => {
            try {
                const result = await this.db
                    .select({
                        id: accountTable.id,
                        name: accountTable.name,
                        username: accountTable.username,
                        details: accountTable.details,
                    })
                    .from(participantTable)
                    .leftJoin(
                        accountTable,
                        eq(participantTable.userId, accountTable.id)
                    )
                    .where(eq(participantTable.roomId, params.roomId))
                    .orderBy(accountTable.name);

                logger.debug("Retrieved actor details:", {
                    roomId: params.roomId,
                    actorCount: result.length,
                });

                return result.map((row) => {
                    try {
                        const details =
                            typeof row.details === "string"
                                ? JSON.parse(row.details)
                                : row.details || {};

                        return {
                            id: row.id as UUID,
                            name: row.name ?? "",
                            username: row.username ?? "",
                            details: {
                                tagline: details.tagline ?? "",
                                summary: details.summary ?? "",
                                quote: details.quote ?? "",
                            },
                        };
                    } catch (error) {
                        logger.warn("Failed to parse actor details:", {
                            actorId: row.id,
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        });

                        return {
                            id: row.id as UUID,
                            name: row.name ?? "",
                            username: row.username ?? "",
                            details: {
                                tagline: "",
                                summary: "",
                                quote: "",
                            },
                        };
                    }
                });
            } catch (error) {
                logger.error("Failed to fetch actor details:", {
                    roomId: params.roomId,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
                throw new Error(
                    `Failed to fetch actor details: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
            }
        }, "getActorDetails");
    }

    async searchMemories(params: {
        tableName: string;
        agentId: UUID;
        roomId: UUID;
        embedding: number[];
        match_threshold: number;
        count: number;
        unique: boolean;
    }): Promise<Memory[]> {
        return await this.searchMemoriesByEmbedding(params.embedding, {
            match_threshold: params.match_threshold,
            count: params.count,
            agentId: params.agentId,
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
            await this.db
                .update(goalTable)
                .set({ status: params.status })
                .where(eq(goalTable.id, params.goalId));
        }, "updateGoalStatus");
    }

    async searchMemoriesByEmbedding(
        embedding: number[],
        params: {
            match_threshold?: number;
            count?: number;
            roomId?: UUID;
            agentId?: UUID;
            unique?: boolean;
            tableName: string;
        }
    ): Promise<Memory[]> {
        return this.withDatabase(async () => {
            const cleanVector = embedding.map((n) =>
                Number.isFinite(n) ? Number(n.toFixed(6)) : 0
            );

            const similarity = sql<number>`1 - (${cosineDistance(
                memoryTable.embedding,
                cleanVector
            )})`;

            const conditions = [eq(memoryTable.type, params.tableName)];

            if (params.unique) {
                conditions.push(eq(memoryTable.unique, true));
            }
            if (params.agentId) {
                conditions.push(eq(memoryTable.agentId, params.agentId));
            }
            if (params.roomId) {
                conditions.push(eq(memoryTable.roomId, params.roomId));
            }

            if (params.match_threshold) {
                conditions.push(gte(similarity, params.match_threshold));
            }

            const results = await this.db
                .select({
                    id: memoryTable.id,
                    type: memoryTable.type,
                    createdAt: memoryTable.createdAt,
                    content: memoryTable.content,
                    embedding: memoryTable.embedding,
                    userId: memoryTable.userId,
                    agentId: memoryTable.agentId,
                    roomId: memoryTable.roomId,
                    unique: memoryTable.unique,
                    similarity: similarity,
                })
                .from(memoryTable)
                .where(and(...conditions))
                .orderBy(desc(similarity))
                .limit(params.count ?? 10);

            return results.map((row) => ({
                id: row.id as UUID,
                type: row.type,
                createdAt: row.createdAt,
                content:
                    typeof row.content === "string"
                        ? JSON.parse(row.content)
                        : row.content,
                embedding: row.embedding ?? undefined,
                userId: row.userId as UUID,
                agentId: row.agentId as UUID,
                roomId: row.roomId as UUID,
                unique: row.unique,
                similarity: row.similarity,
            }));
        }, "searchMemoriesByEmbedding");
    }

    async createMemory(memory: Memory, tableName: string): Promise<void> {
        return this.withDatabase(async () => {
            logger.debug("DrizzleAdapter createMemory:", {
                memoryId: memory.id,
                embeddingLength: memory.embedding?.length,
                contentLength: memory.content?.text?.length,
            });

            let isUnique = true;
            if (memory.embedding) {
                logger.info("Searching for similar memories:");
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

            await this.db.insert(memoryTable).values([
                {
                    id: memory.id ?? v4(),
                    type: tableName,
                    content: sql`${contentToInsert}::jsonb`,
                    embedding: memory.embedding,
                    userId: memory.userId,
                    roomId: memory.roomId,
                    agentId: memory.agentId,
                    unique: memory.unique ?? isUnique,
                    createdAt: memory.createdAt,
                },
            ]);
        }, "createMemory");
    }

    async removeMemory(memoryId: UUID, tableName: string): Promise<void> {
        return this.withDatabase(async () => {
            await this.db
                .delete(memoryTable)
                .where(
                    and(
                        eq(memoryTable.id, memoryId),
                        eq(memoryTable.type, tableName)
                    )
                );
        }, "removeMemory");
    }

    async removeAllMemories(roomId: UUID, tableName: string): Promise<void> {
        return this.withDatabase(async () => {
            await this.db
                .delete(memoryTable)
                .where(
                    and(
                        eq(memoryTable.roomId, roomId),
                        eq(memoryTable.type, tableName)
                    )
                );

            logger.debug("All memories removed successfully:", {
                roomId,
                tableName,
            });
        }, "removeAllMemories");
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
        }, "countMemories");
    }

    async getGoals(params: {
        roomId: UUID;
        userId?: UUID | null;
        onlyInProgress?: boolean;
        count?: number;
    }): Promise<Goal[]> {
        return this.withDatabase(async () => {
            const conditions = [eq(goalTable.roomId, params.roomId)];

            if (params.userId) {
                conditions.push(eq(goalTable.userId, params.userId));
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
                userId: row.userId as UUID,
                name: row.name ?? "",
                status: (row.status ?? "NOT_STARTED") as GoalStatus,
                description: row.description ?? "",
                objectives: row.objectives as any[],
                createdAt: row.createdAt,
            }));
        }, "getGoals");
    }

    async updateGoal(goal: Goal): Promise<void> {
        return this.withDatabase(async () => {
            try {
                await this.db
                    .update(goalTable)
                    .set({
                        name: goal.name,
                        status: goal.status,
                        objectives: goal.objectives,
                    })
                    .where(eq(goalTable.id, goal.id as string));
            } catch (error) {
                logger.error("Failed to update goal:", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    goalId: goal.id,
                    status: goal.status,
                });
                throw error;
            }
        }, "updateGoal");
    }

    async createGoal(goal: Goal): Promise<void> {
        try {
            await this.db.insert(goalTable).values({
                id: goal.id ?? v4(),
                roomId: goal.roomId,
                userId: goal.userId,
                name: goal.name,
                status: goal.status,
                objectives: sql`${goal.objectives}::jsonb`,
            });
        } catch (error) {
            logger.error("Failed to update goal:", {
                goalId: goal.id,
                error: error instanceof Error ? error.message : String(error),
                status: goal.status,
            });
            throw error;
        }
    }

    async removeGoal(goalId: UUID): Promise<void> {
        if (!goalId) throw new Error("Goal ID is required");

        return this.withDatabase(async () => {
            try {
                await this.db.delete(goalTable).where(eq(goalTable.id, goalId));

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
        }, "removeGoal");
    }

    async removeAllGoals(roomId: UUID): Promise<void> {
        return this.withDatabase(async () => {
            await this.db.delete(goalTable).where(eq(goalTable.roomId, roomId));
        }, "removeAllGoals");
    }

    async getRoom(roomId: UUID): Promise<UUID | null> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select({
                    id: roomTable.id,
                })
                .from(roomTable)
                .where(eq(roomTable.id, roomId))
                .limit(1);

            return (result[0]?.id as UUID) ?? null;
        }, "getRoom");
    }

    async createRoom(roomId?: UUID): Promise<UUID> {
        return this.withDatabase(async () => {
            const newRoomId = roomId || v4();
            await this.db.insert(roomTable).values([
                {
                    id: newRoomId,
                },
            ]);
            return newRoomId as UUID;
        }, "createRoom");
    }

    async removeRoom(roomId: UUID): Promise<void> {
        if (!roomId) throw new Error("Room ID is required");
        return this.withDatabase(async () => {
            await this.db.delete(roomTable).where(eq(roomTable.id, roomId));
        }, "removeRoom");
    }

    async getRoomsForParticipant(userId: UUID): Promise<UUID[]> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select({ roomId: participantTable.roomId })
                .from(participantTable)
                .where(eq(participantTable.userId, userId));

            return result.map((row) => row.roomId as UUID);
        }, "getRoomsForParticipant");
    }

    async getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]> {
        return this.withDatabase(async () => {
            const result = await this.db
                .selectDistinct({ roomId: participantTable.roomId })
                .from(participantTable)
                .where(inArray(participantTable.userId, userIds));

            return result.map((row) => row.roomId as UUID);
        }, "getRoomsForParticipants");
    }

    async addParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
        return this.withDatabase(async () => {
            try {
                await this.db.insert(participantTable).values({
                    id: v4(),
                    userId,
                    roomId,
                });
                return true;
            } catch (error) {
                logger.error("Failed to add participant:", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    userId,
                    roomId,
                });
                return false;
            }
        }, "addParticipant");
    }

    async removeParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
        return this.withDatabase(async () => {
            try {
                const result = await this.db
                    .delete(participantTable)
                    .where(
                        and(
                            eq(participantTable.userId, userId),
                            eq(participantTable.roomId, roomId)
                        )
                    )
                    .returning();

                return result.length > 0;
            } catch (error) {
                logger.error("Failed to remove participant:", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    userId,
                    roomId,
                });
                return false;
            }
        }, "removeParticipant");
    }

    async getParticipantsForAccount(userId: UUID): Promise<Participant[]> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select({
                    id: participantTable.id,
                    userId: participantTable.userId,
                    roomId: participantTable.roomId,
                    lastMessageRead: participantTable.lastMessageRead,
                })
                .from(participantTable)
                .where(eq(participantTable.userId, userId));

            const account = await this.getAccountById(userId);

            return result.map((row) => ({
                id: row.id as UUID,
                account: account!,
            }));
        }, "getParticipantsForAccount");
    }

    async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select({ userId: participantTable.userId })
                .from(participantTable)
                .where(eq(participantTable.roomId, roomId));

            return result.map((row) => row.userId as UUID);
        }, "getParticipantsForRoom");
    }

    async getParticipantUserState(
        roomId: UUID,
        userId: UUID
    ): Promise<"FOLLOWED" | "MUTED" | null> {
        return this.withDatabase(async () => {
            const result = await this.db
                .select({ userState: participantTable.userState })
                .from(participantTable)
                .where(
                    and(
                        eq(participantTable.roomId, roomId),
                        eq(participantTable.userId, userId)
                    )
                )
                .limit(1);

            return (
                (result[0]?.userState as "FOLLOWED" | "MUTED" | null) ?? null
            );
        }, "getParticipantUserState");
    }

    async setParticipantUserState(
        roomId: UUID,
        userId: UUID,
        state: "FOLLOWED" | "MUTED" | null
    ): Promise<void> {
        return this.withDatabase(async () => {
            await this.db
                .update(participantTable)
                .set({ userState: state })
                .where(
                    and(
                        eq(participantTable.roomId, roomId),
                        eq(participantTable.userId, userId)
                    )
                );
        }, "setParticipantUserState");
    }

    async createRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<boolean> {
        // Input validation
        if (!params.userA || !params.userB) {
            throw new Error("userA and userB are required");
        }

        return this.withDatabase(async () => {
            try {
                const relationshipId = v4();
                await this.db.insert(relationshipTable).values({
                    id: relationshipId,
                    userA: params.userA,
                    userB: params.userB,
                    userId: params.userA,
                });

                logger.debug("Relationship created successfully:", {
                    relationshipId,
                    userA: params.userA,
                    userB: params.userB,
                });

                return true;
            } catch (error) {
                // Check for unique constraint violation or other specific errors
                if ((error as { code?: string }).code === "23505") {
                    // Unique violation
                    logger.warn("Relationship already exists:", {
                        userA: params.userA,
                        userB: params.userB,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                } else {
                    logger.error("Failed to create relationship:", {
                        userA: params.userA,
                        userB: params.userB,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                }
                return false;
            }
        }, "createRelationship");
    }

    async getRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<Relationship | null> {
        if (!params.userA || !params.userB) {
            throw new Error("userA and userB are required");
        }

        return this.withDatabase(async () => {
            try {
                const result = await this.db
                    .select()
                    .from(relationshipTable)
                    .where(
                        or(
                            and(
                                eq(relationshipTable.userA, params.userA),
                                eq(relationshipTable.userB, params.userB)
                            ),
                            and(
                                eq(relationshipTable.userA, params.userB),
                                eq(relationshipTable.userB, params.userA)
                            )
                        )
                    )
                    .limit(1);

                if (result.length > 0) {
                    return result[0] as unknown as Relationship;
                }

                logger.debug("No relationship found between users:", {
                    userA: params.userA,
                    userB: params.userB,
                });
                return null;
            } catch (error) {
                logger.error("Error fetching relationship:", {
                    userA: params.userA,
                    userB: params.userB,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        }, "getRelationship");
    }

    async getRelationships(params: { userId: UUID }): Promise<Relationship[]> {
        if (!params.userId) {
            throw new Error("userId is required");
        }
        return this.withDatabase(async () => {
            try {
                const result = await this.db
                    .select()
                    .from(relationshipTable)
                    .where(
                        or(
                            eq(relationshipTable.userA, params.userId),
                            eq(relationshipTable.userB, params.userId)
                        )
                    )
                    .orderBy(desc(relationshipTable.createdAt));

                logger.debug("Retrieved relationships:", {
                    userId: params.userId,
                    count: result.length,
                });

                return result as unknown as Relationship[];
            } catch (error) {
                logger.error("Failed to fetch relationships:", {
                    userId: params.userId,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        }, "getRelationships");
    }

    private async createKnowledgeChunk(
        params: {
            id: UUID;
            originalId: UUID;
            agentId: UUID | null;
            content: any;
            embedding: Float32Array | undefined | null;
            chunkIndex: number;
            isShared: boolean;
            createdAt: number;
        },
        tx: NodePgDatabase
    ): Promise<void> {
        const embedding = params.embedding
            ? Array.from(params.embedding)
            : null;

        const patternId = `${params.originalId}-chunk-${params.chunkIndex}`;
        const contentWithPatternId = {
            ...params.content,
            metadata: {
                ...params.content.metadata,
                patternId,
            },
        };

        await tx.insert(knowledgeTable).values({
            id: params.id,
            agentId: params.agentId,
            content: sql`${contentWithPatternId}::jsonb`,
            embedding: embedding,
            isMain: false,
            originalId: params.originalId,
            chunkIndex: params.chunkIndex,
            isShared: params.isShared,
            createdAt: params.createdAt,
        });
    }

    async removeKnowledge(id: UUID): Promise<void> {
        return this.withDatabase(async () => {
            try {
                await this.db
                    .delete(knowledgeTable)
                    .where(eq(knowledgeTable.id, id));
            } catch (error) {
                logger.error("Failed to remove knowledge:", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    id,
                });
                throw error;
            }
        }, "removeKnowledge");
    }

    async clearKnowledge(agentId: UUID, shared?: boolean): Promise<void> {
        return this.withDatabase(async () => {
            if (shared) {
                await this.db
                    .delete(knowledgeTable)
                    .where(
                        or(
                            eq(knowledgeTable.agentId, agentId),
                            eq(knowledgeTable.isShared, true)
                        )
                    );
            } else {
                await this.db
                    .delete(knowledgeTable)
                    .where(eq(knowledgeTable.agentId, agentId));
            }
        }, "clearKnowledge");
    }

    async getCache(params: {
        agentId: UUID;
        key: string;
    }): Promise<string | undefined> {
        return this.withDatabase(async () => {
            try {
                const result = await this.db
                    .select()
                    .from(cacheTable)
                    .where(
                        and(
                            eq(cacheTable.agentId, params.agentId),
                            eq(cacheTable.key, params.key)
                        )
                    );

                return result[0]?.value || undefined;
            } catch (error) {
                logger.error("Error fetching cache", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    key: params.key,
                    agentId: params.agentId,
                });
                return undefined;
            }
        }, "getCache");
    }

    async setCache(params: {
        agentId: UUID;
        key: string;
        value: string;
    }): Promise<boolean> {
        return this.withDatabase(async () => {
            try {
                await this.db
                    .insert(cacheTable)
                    .values({
                        key: params.key,
                        agentId: params.agentId,
                        value: sql`${params.value}::jsonb`,
                    })
                    .onConflictDoUpdate({
                        target: [cacheTable.key, cacheTable.agentId],
                        set: {
                            value: params.value,
                        },
                    });
                return true;
            } catch (error) {
                logger.error("Error setting cache", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    key: params.key,
                    agentId: params.agentId,
                });
                return false;
            }
        }, "setCache");
    }

    async deleteCache(params: {
        agentId: UUID;
        key: string;
    }): Promise<boolean> {
        return this.withDatabase(async () => {
            try {
                await this.db
                    .delete(cacheTable)
                    .where(
                        and(
                            eq(cacheTable.agentId, params.agentId),
                            eq(cacheTable.key, params.key)
                        )
                    );
                return true;
            } catch (error) {
                logger.error("Error deleting cache", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    key: params.key,
                    agentId: params.agentId,
                });
                return false;
            }
        }, "deleteCache");
    }
}
