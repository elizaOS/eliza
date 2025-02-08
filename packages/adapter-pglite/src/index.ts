import { v4 } from "uuid";

import {
    type Account,
    type Actor,
    type GoalStatus,
    type Goal,
    type Memory,
    type Relationship,
    type UUID,
    type IDatabaseCacheAdapter,
    type Participant,
    elizaLogger,
    getEmbeddingConfig,
    DatabaseAdapter,
    EmbeddingProvider,
    type RAGKnowledgeItem,
    type PaginationParams,
    type PaginationResult,
} from "@elizaos/core";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import {
    PGlite,
    type PGliteOptions,
    type Results,
    type Transaction,
} from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { fuzzystrmatch } from "@electric-sql/pglite/contrib/fuzzystrmatch";

const __filename = fileURLToPath(import.meta.url); // get the resolved path to the file
const __dirname = path.dirname(__filename); // get the name of the directory

export class PGLiteDatabaseAdapter
    extends DatabaseAdapter<PGlite>
    implements IDatabaseCacheAdapter
{
    constructor(options: PGliteOptions) {
        super();
        this.db = new PGlite({
            ...options,
            // Add the vector and fuzzystrmatch extensions
            extensions: {
                ...(options.extensions ?? {}),
                vector,
                fuzzystrmatch,
            },
        });
    }

    async init() {
        await this.db.waitReady;

        await this.withTransaction(async (tx) => {
            // Set application settings for embedding dimension
            const embeddingConfig = getEmbeddingConfig();
            if (embeddingConfig.provider === EmbeddingProvider.OpenAI) {
                await tx.query("SET app.use_openai_embedding = 'true'");
                await tx.query("SET app.use_ollama_embedding = 'false'");
                await tx.query("SET app.use_gaianet_embedding = 'false'");
            } else if (embeddingConfig.provider === EmbeddingProvider.Ollama) {
                await tx.query("SET app.use_openai_embedding = 'false'");
                await tx.query("SET app.use_ollama_embedding = 'true'");
                await tx.query("SET app.use_gaianet_embedding = 'false'");
            } else if (embeddingConfig.provider === EmbeddingProvider.GaiaNet) {
                await tx.query("SET app.use_openai_embedding = 'false'");
                await tx.query("SET app.use_ollama_embedding = 'false'");
                await tx.query("SET app.use_gaianet_embedding = 'true'");
            } else {
                await tx.query("SET app.use_openai_embedding = 'false'");
                await tx.query("SET app.use_ollama_embedding = 'false'");
                await tx.query("SET app.use_gaianet_embedding = 'false'");
            }

            const schema = fs.readFileSync(
                path.resolve(__dirname, "../schema.sql"),
                "utf8"
            );
            await tx.exec(schema);
        }, "init");
    }

    async close() {
        await this.db.close();
    }

    private async withDatabase<T>(
        operation: () => Promise<T>,
        context: string
    ): Promise<T> {
        return this.withCircuitBreaker(async () => {
            return operation();
        }, context);
    }

    private async withTransaction<T>(
        operation: (tx: Transaction) => Promise<T>,
        context: string
    ): Promise<T | undefined> {
        return this.withCircuitBreaker(async () => {
            return this.db.transaction(operation);
        }, context);
    }

    async query<R>(
        queryTextOrConfig: string,
        values?: unknown[]
    ): Promise<Results<R>> {
        return this.withDatabase(async () => {
            return await this.db.query<R>(queryTextOrConfig, values);
        }, "query");
    }

    async getRoom(roomId: UUID): Promise<UUID | null> {
        return this.withDatabase(async () => {
            const { rows } = await this.query<{ id: UUID }>(
                "SELECT id FROM rooms WHERE id = $1",
                [roomId]
            );
            return rows.length > 0 ? rows[0].id : null;
        }, "getRoom");
    }

    async getParticipantsForAccount(userId: UUID): Promise<Participant[]> {
        return this.withDatabase(async () => {
            const { rows } = await this.query<Participant>(
                `SELECT id, "userId", "roomId", "last_message_read"
                FROM participants
                WHERE "userId" = $1`,
                [userId]
            );
            return rows;
        }, "getParticipantsForAccount");
    }

    async getParticipantUserState(
        roomId: UUID,
        userId: UUID
    ): Promise<"FOLLOWED" | "MUTED" | null> {
        return this.withDatabase(async () => {
            const { rows } = await this.query<{
                userState: "FOLLOWED" | "MUTED";
            }>(
                `SELECT "userState" FROM participants WHERE "roomId" = $1 AND "userId" = $2`,
                [roomId, userId]
            );
            return rows.length > 0 ? rows[0].userState : null;
        }, "getParticipantUserState");
    }

    async getMemoriesByRoomIds(params: {
        roomIds: UUID[];
        agentId?: UUID;
        tableName: string;
        limit?: number;
    }): Promise<Memory[]> {
        return this.withDatabase(async () => {
            if (params.roomIds.length === 0) return [];
            const placeholders = params.roomIds
                .map((_, i) => `$${i + 2}`)
                .join(", ");

            let query = `SELECT * FROM memories WHERE type = $1 AND "roomId" IN (${placeholders})`;
            let queryParams = [params.tableName, ...params.roomIds];

            if (params.agentId) {
                query += ` AND "agentId" = $${params.roomIds.length + 2}`;
                queryParams = [...queryParams, params.agentId];
            }

            // Add ordering and limit
            query += ` ORDER BY "createdAt" DESC`;
            if (params.limit) {
                query += ` LIMIT $${queryParams.length + 1}`;
                queryParams.push(params.limit.toString());
            }

            const { rows } = await this.query<Memory>(query, queryParams);
            return rows.map((row) => ({
                ...row,
                content:
                    typeof row.content === "string"
                        ? JSON.parse(row.content)
                        : row.content,
            }));
        }, "getMemoriesByRoomIds");
    }

    async setParticipantUserState(
        roomId: UUID,
        userId: UUID,
        state: "FOLLOWED" | "MUTED" | null
    ): Promise<void> {
        return this.withDatabase(async () => {
            await this.query(
                `UPDATE participants SET "userState" = $1 WHERE "roomId" = $2 AND "userId" = $3`,
                [state, roomId, userId]
            );
        }, "setParticipantUserState");
    }

    async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
        return this.withDatabase(async () => {
            const { rows } = await this.query<{ userId: UUID }>(
                'SELECT "userId" FROM participants WHERE "roomId" = $1',
                [roomId]
            );
            return rows.map((row) => row.userId);
        }, "getParticipantsForRoom");
    }

    async getAccountById(userId: UUID): Promise<Account | null> {
        return this.withDatabase(async () => {
            const { rows } = await this.query<Account>(
                "SELECT * FROM accounts WHERE id = $1",
                [userId]
            );
            if (rows.length === 0) {
                elizaLogger.debug("Account not found:", { userId });
                return null;
            }

            const account = rows[0];
            // elizaLogger.debug("Account retrieved:", {
            //     userId,
            //     hasDetails: !!account.details,
            // });

            return {
                ...account,
                details:
                    typeof account.details === "string"
                        ? JSON.parse(account.details)
                        : account.details,
            };
        }, "getAccountById");
    }

    async createAccount(account: Account): Promise<boolean> {
        return this.withDatabase(async () => {
            try {
                const accountId = account.id ?? v4();
                await this.query(
                    `INSERT INTO accounts (id, name, username, email, "avatarUrl", details, status)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        accountId,
                        account.name,
                        account.username || "",
                        account.email || "",
                        account.avatarUrl || "",
                        JSON.stringify(account.details),
                        account.status || "paused",
                    ]
                );
                elizaLogger.debug("Account created successfully:", {
                    accountId,
                });
                return true;
            } catch (error) {
                elizaLogger.error("Error creating account:", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    accountId: account.id,
                    name: account.name, // Only log non-sensitive fields
                });
                return false; // Return false instead of throwing to maintain existing behavior
            }
        }, "createAccount");
    }

    async updateAccount(account: Account): Promise<void> {
        return this.withDatabase(async () => {
            try {
                await this.query(
                    `UPDATE accounts SET name = $1, username = $2, email = $3, "avatarUrl" = $4, status = $5, details = $6 WHERE id = $7`,
                    [
                        account.name,
                        account.username,
                        account.email,
                        account.avatarUrl,
                        account.status,
                        JSON.stringify(account.details),
                        account.id,
                    ]
                );
            } catch (error) {
                elizaLogger.error("Failed to update accounts:", {
                    account: account.id,
                    error:
                        error instanceof Error ? error.message : String(error),
                    status: account.status,
                });
                throw error;
            }
        }, "updateAccount");
    }

    async getActorById(params: { roomId: UUID }): Promise<Actor[]> {
        return this.withDatabase(async () => {
            const { rows } = await this.query<Actor>(
                `SELECT a.id, a.name, a.username, a.details
                FROM participants p
                LEFT JOIN accounts a ON p."userId" = a.id
                WHERE p."roomId" = $1`,
                [params.roomId]
            );

            elizaLogger.debug("Retrieved actors:", {
                roomId: params.roomId,
                actorCount: rows.length,
            });

            return rows.map((row) => {
                try {
                    return {
                        ...row,
                        details:
                            typeof row.details === "string"
                                ? JSON.parse(row.details)
                                : row.details,
                    };
                } catch (error) {
                    elizaLogger.warn("Failed to parse actor details:", {
                        actorId: row.id,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                    return {
                        ...row,
                        details: {}, // Provide default empty details on parse error
                    };
                }
            });
        }, "getActorById").catch((error) => {
            elizaLogger.error("Failed to get actors:", {
                roomId: params.roomId,
                error: error.message,
            });
            throw error; // Re-throw to let caller handle database errors
        });
    }

    async getMemoryById(id: UUID): Promise<Memory | null> {
        return this.withDatabase(async () => {
            const { rows } = await this.query<Memory>(
                "SELECT * FROM memories WHERE id = $1",
                [id]
            );
            if (rows.length === 0) return null;

            return {
                ...rows[0],
                content:
                    typeof rows[0].content === "string"
                        ? JSON.parse(rows[0].content)
                        : rows[0].content,
            };
        }, "getMemoryById");
    }

    async getMemoriesByIds(
        memoryIds: UUID[],
        tableName?: string
    ): Promise<Memory[]> {
        return this.withDatabase(async () => {
            if (memoryIds.length === 0) return [];
            const placeholders = memoryIds.map((_, i) => `$${i + 1}`).join(",");
            let sql = `SELECT * FROM memories WHERE id IN (${placeholders})`;
            const queryParams: any[] = [...memoryIds];

            if (tableName) {
                sql += ` AND type = $${memoryIds.length + 1}`;
                queryParams.push(tableName);
            }

            const { rows } = await this.query<Memory>(sql, queryParams);

            return rows.map((row) => ({
                ...row,
                content:
                    typeof row.content === "string"
                        ? JSON.parse(row.content)
                        : row.content,
            }));
        }, "getMemoriesByIds");
    }

    async createMemory(memory: Memory, tableName: string): Promise<void> {
        return this.withDatabase(async () => {
            elizaLogger.debug("PostgresAdapter createMemory:", {
                memoryId: memory.id,
                embeddingLength: memory.embedding?.length,
                contentLength: memory.content?.text?.length,
            });

            let isUnique = true;
            if (memory.embedding) {
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

            await this.query(
                `INSERT INTO memories (
                    id, type, content, embedding, "userId", "roomId", "agentId", "unique", "createdAt"
                ) VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8, to_timestamp($9/1000.0))`,
                [
                    memory.id ?? v4(),
                    tableName,
                    JSON.stringify(memory.content),
                    memory.embedding ? `[${memory.embedding.join(",")}]` : null,
                    memory.userId,
                    memory.roomId,
                    memory.agentId,
                    memory.unique ?? isUnique,
                    Date.now(),
                ]
            );
        }, "createMemory");
    }

    async searchMemories(params: {
        tableName: string;
        agentId: UUID;
        roomId: UUID;
        embedding: number[];
        match_threshold: number;
        match_count: number;
        unique: boolean;
    }): Promise<Memory[]> {
        return await this.searchMemoriesByEmbedding(params.embedding, {
            match_threshold: params.match_threshold,
            count: params.match_count,
            agentId: params.agentId,
            roomId: params.roomId,
            unique: params.unique,
            tableName: params.tableName,
        });
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
        // Parameter validation
        if (!params.tableName) throw new Error("tableName is required");
        if (!params.roomId) throw new Error("roomId is required");

        return this.withDatabase(async () => {
            // Build query
            let sql = `SELECT * FROM memories WHERE type = $1 AND "roomId" = $2`;
            const values: unknown[] = [params.tableName, params.roomId];
            let paramCount = 2;

            // Add time range filters
            if (params.start) {
                paramCount++;
                sql += ` AND "createdAt" >= to_timestamp($${paramCount})`;
                values.push(params.start / 1000);
            }

            if (params.end) {
                paramCount++;
                sql += ` AND "createdAt" <= to_timestamp($${paramCount})`;
                values.push(params.end / 1000);
            }

            // Add other filters
            if (params.unique) {
                sql += ` AND "unique" = true`;
            }

            if (params.agentId) {
                paramCount++;
                sql += ` AND "agentId" = $${paramCount}`;
                values.push(params.agentId);
            }

            // Add ordering and limit
            sql += ' ORDER BY "createdAt" DESC';

            if (params.count) {
                paramCount++;
                sql += ` LIMIT $${paramCount}`;
                values.push(params.count);
            }

            elizaLogger.debug("Fetching memories:", {
                roomId: params.roomId,
                tableName: params.tableName,
                unique: params.unique,
                agentId: params.agentId,
                timeRange:
                    params.start || params.end
                        ? {
                              start: params.start
                                  ? new Date(params.start).toISOString()
                                  : undefined,
                              end: params.end
                                  ? new Date(params.end).toISOString()
                                  : undefined,
                          }
                        : undefined,
                limit: params.count,
            });

            const { rows } = await this.query<Memory>(sql, values);
            return rows.map((row) => ({
                ...row,
                content:
                    typeof row.content === "string"
                        ? JSON.parse(row.content)
                        : row.content,
            }));
        }, "getMemories");
    }

    async getGoals(params: {
        roomId: UUID;
        userId?: UUID | null;
        onlyInProgress?: boolean;
        count?: number;
    }): Promise<Goal[]> {
        return this.withDatabase(async () => {
            let sql = `SELECT * FROM goals WHERE "roomId" = $1`;
            const values: unknown[] = [params.roomId];
            let paramCount = 1;

            if (params.userId) {
                paramCount++;
                sql += ` AND "userId" = $${paramCount}`;
                values.push(params.userId);
            }

            if (params.onlyInProgress) {
                sql += " AND status = 'IN_PROGRESS'";
            }

            if (params.count) {
                paramCount++;
                sql += ` LIMIT $${paramCount}`;
                values.push(params.count);
            }

            const { rows } = await this.query<Goal>(sql, values);
            return rows.map((row) => ({
                ...row,
                objectives:
                    typeof row.objectives === "string"
                        ? JSON.parse(row.objectives)
                        : row.objectives,
            }));
        }, "getGoals");
    }

    async updateGoal(goal: Goal): Promise<void> {
        return this.withDatabase(async () => {
            try {
                await this.query(
                    `UPDATE goals SET name = $1, status = $2, objectives = $3 WHERE id = $4`,
                    [
                        goal.name,
                        goal.status,
                        JSON.stringify(goal.objectives),
                        goal.id,
                    ]
                );
            } catch (error) {
                elizaLogger.error("Failed to update goal:", {
                    goalId: goal.id,
                    error:
                        error instanceof Error ? error.message : String(error),
                    status: goal.status,
                });
                throw error;
            }
        }, "updateGoal");
    }

    async createGoal(goal: Goal): Promise<void> {
        return this.withDatabase(async () => {
            await this.query(
                `INSERT INTO goals (id, "roomId", "userId", name, status, objectives)
                VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    goal.id ?? v4(),
                    goal.roomId,
                    goal.userId,
                    goal.name,
                    goal.status,
                    JSON.stringify(goal.objectives),
                ]
            );
        }, "createGoal");
    }

    async removeGoal(goalId: UUID): Promise<void> {
        if (!goalId) throw new Error("Goal ID is required");

        return this.withDatabase(async () => {
            try {
                const result = await this.query(
                    "DELETE FROM goals WHERE id = $1 RETURNING id",
                    [goalId]
                );

                elizaLogger.debug("Goal removal attempt:", {
                    goalId,
                    removed: result?.affectedRows ?? 0 > 0,
                });
            } catch (error) {
                elizaLogger.error("Failed to remove goal:", {
                    goalId,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        }, "removeGoal");
    }

    async createRoom(roomId?: UUID): Promise<UUID> {
        return this.withDatabase(async () => {
            const newRoomId = roomId || v4();
            await this.query("INSERT INTO rooms (id) VALUES ($1)", [newRoomId]);
            return newRoomId as UUID;
        }, "createRoom");
    }

    async removeRoom(roomId: UUID): Promise<void> {
        if (!roomId) throw new Error("Room ID is required");

        return this.withTransaction(async (tx) => {
            try {
                // First check if room exists
                const checkResult = await tx.query(
                    "SELECT id FROM rooms WHERE id = $1",
                    [roomId]
                );

                if (checkResult.rows.length === 0) {
                    elizaLogger.warn("No room found to remove:", {
                        roomId,
                    });
                    throw new Error(`Room not found: ${roomId}`);
                }

                // Remove related data first (if not using CASCADE)
                await tx.query('DELETE FROM memories WHERE "roomId" = $1', [
                    roomId,
                ]);
                await tx.query('DELETE FROM participants WHERE "roomId" = $1', [
                    roomId,
                ]);
                await tx.query('DELETE FROM goals WHERE "roomId" = $1', [
                    roomId,
                ]);

                // Finally remove the room
                const result = await tx.query(
                    "DELETE FROM rooms WHERE id = $1 RETURNING id",
                    [roomId]
                );

                elizaLogger.debug(
                    "Room and related data removed successfully:",
                    {
                        roomId,
                        removed: result?.affectedRows ?? 0 > 0,
                    }
                );
            } catch (error) {
                elizaLogger.error("Failed to remove room:", {
                    roomId,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        }, "removeRoom");
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
                await this.query(
                    `INSERT INTO relationships (id, "userA", "userB", "userId")
                    VALUES ($1, $2, $3, $4)
                    RETURNING id`,
                    [relationshipId, params.userA, params.userB, params.userA]
                );

                elizaLogger.debug("Relationship created successfully:", {
                    relationshipId,
                    userA: params.userA,
                    userB: params.userB,
                });

                return true;
            } catch (error) {
                // Check for unique constraint violation or other specific errors
                if ((error as { code?: string }).code === "23505") {
                    // Unique violation
                    elizaLogger.warn("Relationship already exists:", {
                        userA: params.userA,
                        userB: params.userB,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                } else {
                    elizaLogger.error("Failed to create relationship:", {
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
                const { rows } = await this.query<Relationship>(
                    `SELECT * FROM relationships
                    WHERE ("userA" = $1 AND "userB" = $2)
                    OR ("userA" = $2 AND "userB" = $1)`,
                    [params.userA, params.userB]
                );

                if (rows.length > 0) {
                    elizaLogger.debug("Relationship found:", {
                        relationshipId: rows[0].id,
                        userA: params.userA,
                        userB: params.userB,
                    });
                    return rows[0];
                }

                elizaLogger.debug("No relationship found between users:", {
                    userA: params.userA,
                    userB: params.userB,
                });
                return null;
            } catch (error) {
                elizaLogger.error("Error fetching relationship:", {
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
                const { rows } = await this.query<Relationship>(
                    `SELECT * FROM relationships
                    WHERE "userA" = $1 OR "userB" = $1
                    ORDER BY "createdAt" DESC`, // Add ordering if you have this field
                    [params.userId]
                );

                elizaLogger.debug("Retrieved relationships:", {
                    userId: params.userId,
                    count: rows.length,
                });

                return rows;
            } catch (error) {
                elizaLogger.error("Failed to fetch relationships:", {
                    userId: params.userId,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        }, "getRelationships");
    }

    async getCachedEmbeddings(opts: {
        query_table_name: string;
        query_threshold: number;
        query_input: string;
        query_field_name: string;
        query_field_sub_name: string;
        query_match_count: number;
    }): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
        // Input validation
        if (!opts.query_table_name)
            throw new Error("query_table_name is required");
        if (!opts.query_input) throw new Error("query_input is required");
        if (!opts.query_field_name)
            throw new Error("query_field_name is required");
        if (!opts.query_field_sub_name)
            throw new Error("query_field_sub_name is required");
        if (opts.query_match_count <= 0)
            throw new Error("query_match_count must be positive");

        return this.withDatabase(async () => {
            try {
                elizaLogger.debug("Fetching cached embeddings:", {
                    tableName: opts.query_table_name,
                    fieldName: opts.query_field_name,
                    subFieldName: opts.query_field_sub_name,
                    matchCount: opts.query_match_count,
                    inputLength: opts.query_input.length,
                });

                const sql = `
                    WITH content_text AS (
                        SELECT
                            embedding,
                            COALESCE(
                                content->>$2,
                                ''
                            ) as content_text
                        FROM memories
                        WHERE type = $3
                        AND content->>$2 IS NOT NULL
                    )
                    SELECT
                        embedding,
                        levenshtein(
                            $1,
                            content_text
                        ) as levenshtein_score
                    FROM content_text
                    WHERE levenshtein(
                        $1,
                        content_text
                    ) <= $5  -- Add threshold check
                    ORDER BY levenshtein_score
                    LIMIT $4
                `;

                const { rows } = await this.query<{
                    embedding: number[];
                    levenshtein_score: number;
                }>(sql, [
                    opts.query_input,
                    opts.query_field_sub_name,
                    opts.query_table_name,
                    opts.query_match_count,
                    opts.query_threshold,
                ]);

                elizaLogger.debug("Retrieved cached embeddings:", {
                    count: rows.length,
                    tableName: opts.query_table_name,
                    matchCount: opts.query_match_count,
                });

                return rows
                    .map(
                        (
                            row
                        ): {
                            embedding: number[];
                            levenshtein_score: number;
                        } | null => {
                            if (!Array.isArray(row.embedding)) return null;
                            return {
                                embedding: row.embedding,
                                levenshtein_score: Number(
                                    row.levenshtein_score
                                ),
                            };
                        }
                    )
                    .filter(
                        (
                            row
                        ): row is {
                            embedding: number[];
                            levenshtein_score: number;
                        } => row !== null
                    );
            } catch (error) {
                elizaLogger.error("Error in getCachedEmbeddings:", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    tableName: opts.query_table_name,
                    fieldName: opts.query_field_name,
                });
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
        // Input validation
        if (!params.userId) throw new Error("userId is required");
        if (!params.roomId) throw new Error("roomId is required");
        if (!params.type) throw new Error("type is required");
        if (!params.body || typeof params.body !== "object") {
            throw new Error("body must be a valid object");
        }

        return this.withDatabase(async () => {
            try {
                const logId = v4(); // Generate ID for tracking
                await this.query(
                    `INSERT INTO logs (
                        id,
                        body,
                        "userId",
                        "roomId",
                        type,
                        "createdAt"
                    ) VALUES ($1, $2, $3, $4, $5, NOW())
                    RETURNING id`,
                    [
                        logId,
                        JSON.stringify(params.body), // Ensure body is stringified
                        params.userId,
                        params.roomId,
                        params.type,
                    ]
                );

                elizaLogger.debug("Log entry created:", {
                    logId,
                    type: params.type,
                    roomId: params.roomId,
                    userId: params.userId,
                    bodyKeys: Object.keys(params.body),
                });
            } catch (error) {
                elizaLogger.error("Failed to create log entry:", {
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

    async searchMemoriesByEmbedding(
        embedding: number[],
        params: {
            match_threshold?: number;
            count?: number;
            agentId?: UUID;
            roomId?: UUID;
            unique?: boolean;
            tableName: string;
        }
    ): Promise<Memory[]> {
        return this.withDatabase(async () => {
            elizaLogger.debug("Incoming vector:", {
                length: embedding.length,
                sample: embedding.slice(0, 5),
                isArray: Array.isArray(embedding),
                allNumbers: embedding.every((n) => typeof n === "number"),
            });

            // Validate embedding dimension
            if (embedding.length !== getEmbeddingConfig().dimensions) {
                throw new Error(
                    `Invalid embedding dimension: expected ${getEmbeddingConfig().dimensions}, got ${embedding.length}`
                );
            }

            // Ensure vector is properly formatted
            const cleanVector = embedding.map((n) => {
                if (!Number.isFinite(n)) return 0;
                // Limit precision to avoid floating point issues
                return Number(n.toFixed(6));
            });

            // Format for Postgres pgvector
            const vectorStr = `[${cleanVector.join(",")}]`;

            elizaLogger.debug("Vector debug:", {
                originalLength: embedding.length,
                cleanLength: cleanVector.length,
                sampleStr: vectorStr.slice(0, 100),
            });

            let sql = `
                SELECT *,
                1 - (embedding <-> $1::vector(${getEmbeddingConfig().dimensions})) as similarity
                FROM memories
                WHERE type = $2
            `;

            const values: unknown[] = [vectorStr, params.tableName];

            // Log the query for debugging
            elizaLogger.debug("Query debug:", {
                sql: sql.slice(0, 200),
                paramTypes: values.map((v) => typeof v),
                vectorStrLength: vectorStr.length,
            });

            let paramCount = 2;

            if (params.unique) {
                sql += ` AND "unique" = true`;
            }

            if (params.agentId) {
                paramCount++;
                sql += ` AND "agentId" = $${paramCount}`;
                values.push(params.agentId);
            }

            if (params.roomId) {
                paramCount++;
                sql += ` AND "roomId" = $${paramCount}::uuid`;
                values.push(params.roomId);
            }

            if (params.match_threshold) {
                paramCount++;
                sql += ` AND 1 - (embedding <-> $1::vector) >= $${paramCount}`;
                values.push(params.match_threshold);
            }

            sql += ` ORDER BY embedding <-> $1::vector`;

            if (params.count) {
                paramCount++;
                sql += ` LIMIT $${paramCount}`;
                values.push(params.count);
            }

            const { rows } = await this.query<Memory>(sql, values);
            return rows.map((row) => ({
                ...row,
                content:
                    typeof row.content === "string"
                        ? JSON.parse(row.content)
                        : row.content,
                similarity: row.similarity,
            }));
        }, "searchMemoriesByEmbedding");
    }

    async addParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
        return this.withDatabase(async () => {
            try {
                await this.query(
                    `INSERT INTO participants (id, "userId", "roomId")
                    VALUES ($1, $2, $3)`,
                    [v4(), userId, roomId]
                );
                return true;
            } catch (error) {
                console.log("Error adding participant", error);
                return false;
            }
        }, "addParticpant");
    }

    async removeParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
        return this.withDatabase(async () => {
            try {
                await this.query(
                    `DELETE FROM participants WHERE "userId" = $1 AND "roomId" = $2`,
                    [userId, roomId]
                );
                return true;
            } catch (error) {
                console.log("Error removing participant", error);
                return false;
            }
        }, "removeParticipant");
    }

    async updateGoalStatus(params: {
        goalId: UUID;
        status: GoalStatus;
    }): Promise<void> {
        return this.withDatabase(async () => {
            await this.query("UPDATE goals SET status = $1 WHERE id = $2", [
                params.status,
                params.goalId,
            ]);
        }, "updateGoalStatus");
    }

    async removeMemory(memoryId: UUID, tableName: string): Promise<void> {
        return this.withDatabase(async () => {
            await this.query(
                "DELETE FROM memories WHERE type = $1 AND id = $2",
                [tableName, memoryId]
            );
        }, "removeMemory");
    }

    async removeAllMemories(roomId: UUID, tableName: string): Promise<void> {
        return this.withDatabase(async () => {
            await this.query(
                `DELETE FROM memories WHERE type = $1 AND "roomId" = $2`,
                [tableName, roomId]
            );
        }, "removeAllMemories");
    }

    async countMemories(
        roomId: UUID,
        unique = true,
        tableName = ""
    ): Promise<number> {
        if (!tableName) throw new Error("tableName is required");

        return this.withDatabase(async () => {
            let sql = `SELECT COUNT(*) as count FROM memories WHERE type = $1 AND "roomId" = $2`;
            if (unique) {
                sql += ` AND "unique" = true`;
            }

            const { rows } = await this.query<{ count: number }>(sql, [
                tableName,
                roomId,
            ]);
            return rows[0].count;
        }, "countMemories");
    }

    async removeAllGoals(roomId: UUID): Promise<void> {
        return this.withDatabase(async () => {
            await this.query(`DELETE FROM goals WHERE "roomId" = $1`, [roomId]);
        }, "removeAllGoals");
    }

    async getRoomsForParticipant(userId: UUID): Promise<UUID[]> {
        return this.withDatabase(async () => {
            const { rows } = await this.query<{ roomId: UUID }>(
                `SELECT "roomId" FROM participants WHERE "userId" = $1`,
                [userId]
            );
            return rows.map((row) => row.roomId);
        }, "getRoomsForParticipant");
    }

    async getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]> {
        return this.withDatabase(async () => {
            const placeholders = userIds.map((_, i) => `$${i + 1}`).join(", ");
            const { rows } = await this.query<{ roomId: UUID }>(
                `SELECT DISTINCT "roomId" FROM participants WHERE "userId" IN (${placeholders})`,
                userIds
            );
            return rows.map((row) => row.roomId);
        }, "getRoomsForParticipants");
    }

    async getActorDetails(params: { roomId: string }): Promise<Actor[]> {
        if (!params.roomId) {
            throw new Error("roomId is required");
        }

        return this.withDatabase(async () => {
            try {
                const sql = `
                    SELECT
                        a.id,
                        a.name,
                        a.username,
                        a."avatarUrl",
                        COALESCE(a.details::jsonb, '{}'::jsonb) as details
                    FROM participants p
                    LEFT JOIN accounts a ON p."userId" = a.id
                    WHERE p."roomId" = $1
                    ORDER BY a.name
                `;

                const result = await this.query<Actor>(sql, [params.roomId]);

                elizaLogger.debug("Retrieved actor details:", {
                    roomId: params.roomId,
                    actorCount: result.rows.length,
                });

                return result.rows.map((row) => {
                    try {
                        return {
                            ...row,
                            details:
                                typeof row.details === "string"
                                    ? JSON.parse(row.details)
                                    : row.details,
                        };
                    } catch (parseError) {
                        elizaLogger.warn("Failed to parse actor details:", {
                            actorId: row.id,
                            error:
                                parseError instanceof Error
                                    ? parseError.message
                                    : String(parseError),
                        });
                        return {
                            ...row,
                            details: {}, // Fallback to empty object if parsing fails
                        };
                    }
                });
            } catch (error) {
                elizaLogger.error("Failed to fetch actor details:", {
                    roomId: params.roomId,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
                throw new Error(
                    `Failed to fetch actor details: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }, "getActorDetails");
    }

    async getCache(params: {
        key: string;
        agentId: UUID;
    }): Promise<string | undefined> {
        return this.withDatabase(async () => {
            try {
                const sql = `SELECT "value"::TEXT FROM cache WHERE "key" = $1 AND "agentId" = $2`;
                const { rows } = await this.query<{ value: string }>(sql, [
                    params.key,
                    params.agentId,
                ]);
                return rows[0]?.value ?? undefined;
            } catch (error) {
                elizaLogger.error("Error fetching cache", {
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
        key: string;
        agentId: UUID;
        value: string;
    }): Promise<boolean> {
        return (
            (await this.withTransaction(async (tx) => {
                try {
                    await tx.query(
                        `INSERT INTO cache ("key", "agentId", "value", "createdAt")
                                 VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
                                 ON CONFLICT ("key", "agentId")
                                 DO UPDATE SET "value" = EXCLUDED.value, "createdAt" = CURRENT_TIMESTAMP`,
                        [params.key, params.agentId, params.value]
                    );
                    return true;
                } catch (error) {
                    await tx.rollback();
                    elizaLogger.error("Error setting cache", {
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                        key: params.key,
                        agentId: params.agentId,
                    });
                    return false;
                }
            }, "setCache")) ?? false
        );
    }

    async deleteCache(params: {
        key: string;
        agentId: UUID;
    }): Promise<boolean> {
        return (
            (await this.withTransaction(async (tx) => {
                try {
                    await tx.query(
                        `DELETE FROM cache WHERE "key" = $1 AND "agentId" = $2`,
                        [params.key, params.agentId]
                    );
                    return true;
                } catch (error) {
                    tx.rollback();
                    elizaLogger.error("Error deleting cache", {
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                        key: params.key,
                        agentId: params.agentId,
                    });
                    return false;
                }
            }, "deleteCache")) ?? false
        );
    }

    async getKnowledge(params: {
        id?: UUID;
        agentId: UUID;
        limit?: number;
        query?: string;
    }): Promise<RAGKnowledgeItem[]> {
        return this.withDatabase(async () => {
            try {
                let sql = `SELECT * FROM knowledge WHERE ("agentId" = $1 OR "isShared" = true)`;
                const queryParams: any[] = [params.agentId];
                let paramCount = 1;

                if (params.id) {
                    paramCount++;
                    sql += ` AND id = $${paramCount}`;
                    queryParams.push(params.id);
                }

                if (params.limit) {
                    paramCount++;
                    sql += ` LIMIT $${paramCount}`;
                    queryParams.push(params.limit);
                }

                const { rows } = await this.query<RAGKnowledgeItem>(
                    sql,
                    queryParams
                );

                return rows.map((row) => ({
                    id: row.id,
                    agentId: row.agentId,
                    content:
                        typeof row.content === "string"
                            ? JSON.parse(row.content)
                            : row.content,
                    embedding: row.embedding
                        ? new Float32Array(row.embedding)
                        : undefined,
                    createdAt: row.createdAt
                        ? new Date(row.createdAt).getTime()
                        : undefined,
                }));
            } catch (error) {
                elizaLogger.error("Error getting knowledge", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    id: params.id,
                    agentId: params.agentId,
                });
                throw new Error(
                    `Failed to getting knowledge: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }, "getKnowledge");
    }

    async searchKnowledge(params: {
        agentId: UUID;
        embedding: Float32Array;
        match_threshold: number;
        match_count: number;
        searchText?: string;
    }): Promise<RAGKnowledgeItem[]> {
        return this.withDatabase(async () => {
            interface KnowledgeSearchRow {
                id: UUID;
                agentId: UUID;
                content: string;
                embedding: Buffer | null;
                createdAt: string | number;
                vector_score: number;
                keyword_score: number;
                combined_score: number;
            }
            try {
                const cacheKey = `embedding_${params.agentId}_${params.searchText}`;
                const cachedResult = await this.getCache({
                    key: cacheKey,
                    agentId: params.agentId,
                });

                if (cachedResult) {
                    return JSON.parse(cachedResult);
                }

                const vectorStr = `[${Array.from(params.embedding).join(",")}]`;

                const sql = `
                WITH vector_scores AS (
                    SELECT id,
                        1 - (embedding <-> $1::vector) as vector_score
                    FROM knowledge
                    WHERE ("agentId" IS NULL AND "isShared" = true) OR "agentId" = $2
                    AND embedding IS NOT NULL
                ),
                keyword_matches AS (
                    SELECT id,
                    CASE
                        WHEN content->>'text' ILIKE $3 THEN 3.0
                        ELSE 1.0
                    END *
                    CASE
                        WHEN (content->'metadata'->>'isChunk')::boolean = true THEN 1.5
                        WHEN (content->'metadata'->>'isMain')::boolean = true THEN 1.2
                        ELSE 1.0
                    END as keyword_score
                    FROM knowledge
                    WHERE ("agentId" IS NULL AND "isShared" = true) OR "agentId" = $2
                )
                SELECT k.*,
                    v.vector_score,
                    kw.keyword_score,
                    (v.vector_score * kw.keyword_score) as combined_score
                FROM knowledge k
                JOIN vector_scores v ON k.id = v.id
                LEFT JOIN keyword_matches kw ON k.id = kw.id
                WHERE ("agentId" IS NULL AND "isShared" = true) OR k."agentId" = $2
                AND (
                    v.vector_score >= $4
                    OR (kw.keyword_score > 1.0 AND v.vector_score >= 0.3)
                )
                ORDER BY combined_score DESC
                LIMIT $5
            `;

                const { rows } = await this.query<KnowledgeSearchRow>(sql, [
                    vectorStr,
                    params.agentId,
                    `%${params.searchText || ""}%`,
                    params.match_threshold,
                    params.match_count,
                ]);

                const results = rows.map((row) => ({
                    id: row.id,
                    agentId: row.agentId,
                    content:
                        typeof row.content === "string"
                            ? JSON.parse(row.content)
                            : row.content,
                    embedding: row.embedding
                        ? new Float32Array(row.embedding)
                        : undefined,
                    createdAt: row.createdAt
                        ? new Date(row.createdAt).getTime()
                        : undefined,
                    similarity: row.combined_score,
                }));

                await this.setCache({
                    key: cacheKey,
                    agentId: params.agentId,
                    value: JSON.stringify(results),
                });

                return results;
            } catch (error) {
                elizaLogger.error("Error searching knowledge", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    searchText: params.searchText,
                    agentId: params.agentId,
                });
                throw new Error(
                    `Failed to search knowledge: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }, "searchKnowledge");
    }

    async createKnowledge(knowledge: RAGKnowledgeItem): Promise<void> {
        return this.withTransaction(async (tx) => {
            try {
                const sql = `
                    INSERT INTO knowledge (
                        id, "agentId", content, embedding, "createdAt",
                        "isMain", "originalId", "chunkIndex", "isShared"
                    ) VALUES ($1, $2, $3, $4, to_timestamp($5/1000.0), $6, $7, $8, $9)
                    ON CONFLICT (id) DO NOTHING
                `;

                const metadata = knowledge.content.metadata || {};
                const vectorStr = knowledge.embedding
                    ? `[${Array.from(knowledge.embedding).join(",")}]`
                    : null;

                await tx.query(sql, [
                    knowledge.id,
                    metadata.isShared ? null : knowledge.agentId,
                    knowledge.content,
                    vectorStr,
                    knowledge.createdAt || Date.now(),
                    metadata.isMain || false,
                    metadata.originalId || null,
                    metadata.chunkIndex || null,
                    metadata.isShared || false,
                ]);
            } catch (error) {
                elizaLogger.error("Failed to create knowledge:", {
                    error:
                        error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        }, "createKnowledge");
    }

    async removeKnowledge(id: UUID): Promise<void> {
        return await this.withTransaction(async (tx) => {
            try {
                await tx.query("DELETE FROM knowledge WHERE id = $1", [id]);
            } catch (error) {
                tx.rollback();
                elizaLogger.error("Error removing knowledge", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    id,
                });
            }
        }, "removeKnowledge");
    }

    async clearKnowledge(agentId: UUID, shared?: boolean): Promise<void> {
        return await this.withTransaction(async (tx) => {
            try {
                const sql = shared
                    ? 'DELETE FROM knowledge WHERE ("agentId" = $1 OR "isShared" = true)'
                    : 'DELETE FROM knowledge WHERE "agentId" = $1';
                await tx.query(sql, [agentId]);
            } catch (error) {
                tx.rollback();
                elizaLogger.error("Error clearing knowledge", {
                    error:
                        error instanceof Error ? error.message : String(error),
                    agentId,
                });
            }
        }, "clearKnowledge");
    }

    async paginate(table: string, params: PaginationParams): Promise<PaginationResult> {
        return this.withDatabase(async () => {
            const {
                page = 1,
                pageSize = 10,
                where = {},
                order = { createdAt: 'DESC' }
            } = params;

            const offset = (page - 1) * pageSize;
            const whereClause: string[] = [];
            const values: any[] = [];
            let paramCount = 0;

            // Build where clause with proper parameter indexing
            // biome-ignore lint/complexity/noForEach: <explanation>
            Object.entries(where).forEach(([key, value]) => {
                if (value === null || value === undefined) return;

                if (typeof value === 'object') {
                    if (key === 'createdAt') {
                        if (value.gte) {
                            paramCount++;
                            whereClause.push(`"${key}" >= $${paramCount}`);
                            values.push(value.gte);
                        }
                        if (value.lte) {
                            paramCount++;
                            whereClause.push(`"${key}" <= $${paramCount}`);
                            values.push(value.lte);
                        }
                    }
                } else {
                    paramCount++;
                    whereClause.push(`"${key}" = $${paramCount}`);
                    values.push(value);
                }
            });

            const whereStr = whereClause.length > 0
                ? `WHERE ${whereClause.join(' AND ')}`
                : '';

            const orderClause = Object.entries(order)
                .map(([key, direction]) => `"${key}" ${direction}`)
                .join(', ');

            // Count total records
            const countQuery = `
                SELECT COUNT(*) as total 
                FROM "${table}" 
                ${whereStr}
            `;

            const { rows: countRows } = await this.query<{ total: number }>(
                countQuery,
                values
            );
            const total = Number(countRows[0]?.total || 0);

            // Get paginated data
            paramCount++;
            const limitParam = `$${paramCount}`;
            paramCount++;
            const offsetParam = `$${paramCount}`;

            const dataQuery = `
                SELECT * 
                FROM "${table}" 
                ${whereStr}
                ORDER BY ${orderClause}
                LIMIT ${limitParam} OFFSET ${offsetParam}
            `;

            const { rows: list } = await this.query(
                dataQuery,
                [...values, pageSize, offset]
            );

            return {
                list,
                total,
                page,
                pageSize,
                totalPages: Math.ceil(total / pageSize),
            };
        }, "paginate");
    }
}

export default PGLiteDatabaseAdapter;
