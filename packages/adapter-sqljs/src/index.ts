export * from "./sqliteTables.ts";
export * from "./types.ts";

import {
    type Account,
    type Actor,
    DatabaseAdapter,
    type GoalStatus,
    type IDatabaseCacheAdapter,
    type Participant,
    type Goal,
    type Memory,
    type Relationship,
    type UUID,
    type RAGKnowledgeItem,
    elizaLogger,
    type PaginationParams,
    type PaginationResult,
} from "@elizaos/core";
import { v4 } from "uuid";
import { sqliteTables } from "./sqliteTables.ts";
import type { Database } from "./types.ts";

export class SqlJsDatabaseAdapter
    extends DatabaseAdapter<Database>
    implements IDatabaseCacheAdapter
{
    constructor(db: Database) {
        super();
        this.db = db;
    }

    async init() {
        this.db.exec(sqliteTables);
    }

    async close() {
        this.db.close();
    }

    async getRoom(roomId: UUID): Promise<UUID | null> {
        const sql = "SELECT id FROM rooms WHERE id = ?";
        const stmt = this.db.prepare(sql);
        stmt.bind([roomId]);
        const room = stmt.getAsObject() as { id: string } | undefined;
        stmt.free();
        return room ? (room.id as UUID) : null;
    }

    async getParticipantsForAccount(userId: UUID): Promise<Participant[]> {
        const sql = `
      SELECT p.id, p.userId, p.roomId, p.last_message_read
      FROM participants p
      WHERE p.userId = ?
    `;
        const stmt = this.db.prepare(sql);
        stmt.bind([userId]);
        const participants: Participant[] = [];
        while (stmt.step()) {
            const participant = stmt.getAsObject() as unknown as Participant;
            participants.push(participant);
        }
        stmt.free();
        return participants;
    }

    async getParticipantUserState(
        roomId: UUID,
        userId: UUID
    ): Promise<"FOLLOWED" | "MUTED" | null> {
        const sql =
            "SELECT userState FROM participants WHERE roomId = ? AND userId = ?";
        const stmt = this.db.prepare(sql);
        stmt.bind([roomId, userId]);
        const result = stmt.getAsObject() as {
            userState: "FOLLOWED" | "MUTED" | null;
        };
        stmt.free();
        return result.userState ?? null;
    }

    async getMemoriesByRoomIds(params: {
        agentId: UUID;
        roomIds: UUID[];
        tableName: string;
        limit?: number;
    }): Promise<Memory[]> {
        const placeholders = params.roomIds.map(() => "?").join(", ");
        let sql = `SELECT * FROM memories WHERE 'type' = ? AND agentId = ? AND roomId IN (${placeholders})`;

        const queryParams = [
            params.tableName,
            params.agentId,
            ...params.roomIds,
        ];

        // Add ordering and limit
        sql += ` ORDER BY createdAt DESC`;
        if (params.limit) {
            sql += ` LIMIT ?`;
            queryParams.push(params.limit.toString());
        }

        const stmt = this.db.prepare(sql);

        elizaLogger.log({ queryParams });
        stmt.bind(queryParams);
        elizaLogger.log({ queryParams });

        const memories: Memory[] = [];
        while (stmt.step()) {
            const memory = stmt.getAsObject() as unknown as Memory;
            memories.push({
                ...memory,
                content: JSON.parse(memory.content as unknown as string),
            });
        }
        stmt.free();
        return memories;
    }

    async setParticipantUserState(
        roomId: UUID,
        userId: UUID,
        state: "FOLLOWED" | "MUTED" | null
    ): Promise<void> {
        const sql =
            "UPDATE participants SET userState = ? WHERE roomId = ? AND userId = ?";
        const stmt = this.db.prepare(sql);
        stmt.bind([state, roomId, userId]);
        stmt.step();
        stmt.free();
    }

    async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
        const sql = "SELECT userId FROM participants WHERE roomId = ?";
        const stmt = this.db.prepare(sql);
        stmt.bind([roomId]);
        const userIds: UUID[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as { userId: string };
            userIds.push(row.userId as UUID);
        }
        stmt.free();
        return userIds;
    }

    async getAccountById(userId: UUID): Promise<Account | null> {
        const sql = "SELECT * FROM accounts WHERE id = ?";
        const stmt = this.db.prepare(sql);
        stmt.bind([userId]);
        const account = stmt.getAsObject() as unknown as Account | undefined;

        if (account && typeof account.details === "string") {
            account.details = JSON.parse(account.details);
        }

        stmt.free();
        return account || null;
    }

    async createAccount(account: Account): Promise<boolean> {
        try {
            const sql = `
      INSERT INTO accounts (id, name, username, email, avatarUrl, details, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
            const stmt = this.db.prepare(sql);
            stmt.run([
                account.id ?? v4(),
                account.name,
                account.username || "",
                account.email || "",
                account.avatarUrl || "",
                JSON.stringify(account.details),
                account.status || "paused",
            ]);
            stmt.free();
            return true;
        } catch (error) {
            elizaLogger.error("Error creating account", error);
            return false;
        }
    }

    async updateAccount(account: Account): Promise<void> {
        const sql = "UPDATE accounts SET name = ?, username = ?, email = ?, avatarUrl = ?, status = ?, details = ? WHERE id = ?";
        const stmt = this.db.prepare(sql);
        stmt.run([
            account.name ?? "",
            account.username ?? "",
            account.email ?? "",
            account.avatarUrl ?? "",
            account.status ?? "paused",
            JSON.stringify(account.details ?? {}),
            account.id ?? "",
        ]);
        stmt.free();
    }

    async getActorById(params: { roomId: UUID }): Promise<Actor[]> {
        const sql = `
      SELECT a.id, a.name, a.username, a.details
      FROM participants p
      LEFT JOIN accounts a ON p.userId = a.id
      WHERE p.roomId = ?
    `;
        const stmt = this.db.prepare(sql);
        stmt.bind([params.roomId]);
        const rows: Actor[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as unknown as Actor;
            rows.push({
                ...row,
                details:
                    typeof row.details === "string"
                        ? JSON.parse(row.details)
                        : row.details,
            });
        }
        stmt.free();
        return rows;
    }

    async getActorDetails(params: { roomId: UUID }): Promise<Actor[]> {
        const sql = `
      SELECT a.id, a.name, a.username, a.details
      FROM participants p
      LEFT JOIN accounts a ON p.userId = a.id
      WHERE p.roomId = ?
    `;
        const stmt = this.db.prepare(sql);
        stmt.bind([params.roomId]);
        const rows: Actor[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as unknown as Actor;
            rows.push({
                ...row,
                details:
                    typeof row.details === "string"
                        ? JSON.parse(row.details)
                        : row.details,
            });
        }
        stmt.free();
        return rows;
    }

    async getMemoryById(id: UUID): Promise<Memory | null> {
        const sql = "SELECT * FROM memories WHERE id = ?";
        const stmt = this.db.prepare(sql);
        stmt.bind([id]);
        const memory = stmt.getAsObject() as unknown as Memory | undefined;
        stmt.free();
        return memory || null;
    }

    async getMemoriesByIds(
        memoryIds: UUID[],
        tableName?: string
    ): Promise<Memory[]> {
        if (memoryIds.length === 0) return [];
        const placeholders = memoryIds.map(() => "?").join(",");
        let sql = `SELECT * FROM memories WHERE id IN (${placeholders})`;
        const queryParams: any[] = [...memoryIds];

        if (tableName) {
            sql += ` AND type = ?`;
            queryParams.push(tableName);
        }

        const stmt = this.db.prepare(sql);
        stmt.bind(queryParams);

        const memories: Memory[] = [];
        while (stmt.step()) {
            const memory = stmt.getAsObject() as unknown as Memory;
            memories.push({
                ...memory,
                content: JSON.parse(memory.content as unknown as string),
            });
        }
        stmt.free();
        return memories;
    }

    async createMemory(memory: Memory, tableName: string): Promise<void> {
        let isUnique = true;
        if (memory.embedding) {
            // Check if a similar memory already exists
            const similarMemories = await this.searchMemoriesByEmbedding(
                memory.embedding,
                {
                    agentId: memory.agentId,
                    tableName,
                    roomId: memory.roomId,
                    match_threshold: 0.95, // 5% similarity threshold
                    count: 1,
                }
            );

            isUnique = similarMemories.length === 0;
        }

        // Insert the memory with the appropriate 'unique' value
        const sql = `INSERT INTO memories (id, type, content, embedding, userId, roomId, agentId, \`unique\`, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const stmt = this.db.prepare(sql);

        const createdAt = memory.createdAt ?? Date.now();

        stmt.run([
            memory.id ?? v4(),
            tableName,
            JSON.stringify(memory.content),
            JSON.stringify(memory.embedding),
            memory.userId,
            memory.roomId,
            memory.agentId,
            isUnique ? 1 : 0,
            createdAt,
        ]);
        stmt.free();
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
        let sql =
            `
  SELECT *` +
            // TODO: Uncomment when we compile sql.js with vss
            // `, (1 - vss_distance_l2(embedding, ?)) AS similarity` +
            ` FROM memories
  WHERE type = ? AND agentId = ?
  AND roomId = ?`;

        if (params.unique) {
            sql += " AND `unique` = 1";
        }
        // TODO: Uncomment when we compile sql.js with vss
        // sql += ` ORDER BY similarity DESC LIMIT ?`;
        const stmt = this.db.prepare(sql);
        stmt.bind([
            // JSON.stringify(params.embedding),
            params.tableName,
            params.agentId,
            params.roomId,
            // params.match_count,
        ]);
        const memories: (Memory & { similarity: number })[] = [];
        while (stmt.step()) {
            const memory = stmt.getAsObject() as unknown as Memory & {
                similarity: number;
            };
            memories.push({
                ...memory,
                content: JSON.parse(memory.content as unknown as string),
            });
        }
        stmt.free();
        return memories;
    }

    async searchMemoriesByEmbedding(
        _embedding: number[],
        params: {
            agentId: UUID;
            match_threshold?: number;
            count?: number;
            roomId?: UUID;
            unique?: boolean;
            tableName: string;
        }
    ): Promise<Memory[]> {
        let sql =
            `SELECT *` +
            // TODO: Uncomment when we compile sql.js with vss
            // `, (1 - vss_distance_l2(embedding, ?)) AS similarity`+
            ` FROM memories
        WHERE type = ? AND agentId = ?`;

        if (params.unique) {
            sql += " AND `unique` = 1";
        }
        if (params.roomId) {
            sql += " AND roomId = ?";
        }
        // TODO: Test this
        if (params.agentId) {
            sql += " AND userId = ?";
        }
        // TODO: Uncomment when we compile sql.js with vss
        // sql += ` ORDER BY similarity DESC`;

        if (params.count) {
            sql += " LIMIT ?";
        }

        const stmt = this.db.prepare(sql);
        const bindings = [
            // JSON.stringify(embedding),
            params.tableName,
            params.agentId,
        ];
        if (params.roomId) {
            bindings.push(params.roomId);
        }
        if (params.count) {
            bindings.push(params.count.toString());
        }

        stmt.bind(bindings);
        const memories: (Memory & { similarity: number })[] = [];
        while (stmt.step()) {
            const memory = stmt.getAsObject() as unknown as Memory & {
                similarity: number;
            };
            memories.push({
                ...memory,
                content: JSON.parse(memory.content as unknown as string),
            });
        }
        stmt.free();
        return memories;
    }

    async getCachedEmbeddings(opts: {
        query_table_name: string;
        query_threshold: number;
        query_input: string;
        query_field_name: string;
        query_field_sub_name: string;
        query_match_count: number;
    }): Promise<
        {
            embedding: number[];
            levenshtein_score: number;
        }[]
    > {
        const sql =
            `
        SELECT *
        FROM memories
        WHERE type = ?` +
            // `AND vss_search(${opts.query_field_name}, ?)
            // ORDER BY vss_search(${opts.query_field_name}, ?) DESC` +
            ` LIMIT ?
      `;
        const stmt = this.db.prepare(sql);
        stmt.bind([
            opts.query_table_name,
            // opts.query_input,
            // opts.query_input,
            opts.query_match_count,
        ]);
        const memories: Memory[] = [];
        while (stmt.step()) {
            const memory = stmt.getAsObject() as unknown as Memory;
            memories.push(memory);
        }
        stmt.free();

        return memories.map((memory) => ({
            ...memory,
            createdAt: memory.createdAt ?? Date.now(),
            embedding: JSON.parse(memory.embedding as unknown as string),
            levenshtein_score: 0,
        }));
    }

    async updateGoalStatus(params: {
        goalId: UUID;
        status: GoalStatus;
    }): Promise<void> {
        const sql = "UPDATE goals SET status = ? WHERE id = ?";
        const stmt = this.db.prepare(sql);
        stmt.run([params.status, params.goalId]);
        stmt.free();
    }

    async log(params: {
        body: { [key: string]: unknown };
        userId: UUID;
        roomId: UUID;
        type: string;
    }): Promise<void> {
        const sql =
            "INSERT INTO logs (body, userId, roomId, type) VALUES (?, ?, ?, ?)";
        const stmt = this.db.prepare(sql);
        stmt.run([
            JSON.stringify(params.body),
            params.userId,
            params.roomId,
            params.type,
        ]);
        stmt.free();
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
        if (!params.tableName) {
            throw new Error("tableName is required");
        }
        if (!params.roomId) {
            throw new Error("roomId is required");
        }
        let sql = `SELECT * FROM memories WHERE type = ? AND roomId = ?`;

        if (params.start) {
            sql += ` AND createdAt >= ?`;
        }

        if (params.end) {
            sql += ` AND createdAt <= ?`;
        }

        if (params.unique) {
            sql += " AND `unique` = 1";
        }

        if (params.agentId) {
            sql += " AND agentId = ?";
        }

        sql += " ORDER BY createdAt DESC";

        if (params.count) {
            sql += " LIMIT ?";
        }

        const stmt = this.db.prepare(sql);
        stmt.bind([
            params.tableName,
            params.roomId,
            ...(params.start ? [params.start] : []),
            ...(params.end ? [params.end] : []),
            ...(params.agentId ? [params.agentId] : []),
            ...(params.count ? [params.count] : []),
        ]);
        const memories: Memory[] = [];
        while (stmt.step()) {
            const memory = stmt.getAsObject() as unknown as Memory;
            memories.push({
                ...memory,
                content: JSON.parse(memory.content as unknown as string),
            });
        }
        stmt.free();
        return memories;
    }

    async removeMemory(memoryId: UUID, tableName: string): Promise<void> {
        const sql = `DELETE FROM memories WHERE type = ? AND id = ?`;
        const stmt = this.db.prepare(sql);
        stmt.run([tableName, memoryId]);
        stmt.free();
    }

    async removeAllMemories(roomId: UUID, tableName: string): Promise<void> {
        const sql = `DELETE FROM memories WHERE type = ? AND roomId = ?`;
        const stmt = this.db.prepare(sql);
        stmt.run([tableName, roomId]);
        stmt.free();
    }

    async countMemories(
        roomId: UUID,
        unique = true,
        tableName = ""
    ): Promise<number> {
        if (!tableName) {
            throw new Error("tableName is required");
        }

        let sql = `SELECT COUNT(*) as count FROM memories WHERE type = ? AND roomId = ?`;
        if (unique) {
            sql += " AND `unique` = 1";
        }

        const stmt = this.db.prepare(sql);
        stmt.bind([tableName, roomId]);

        let count = 0;
        if (stmt.step()) {
            const result = stmt.getAsObject() as { count: number };
            count = result.count;
        }

        stmt.free();
        return count;
    }

    async getGoals(params: {
        roomId: UUID;
        userId?: UUID | null;
        onlyInProgress?: boolean;
        count?: number;
    }): Promise<Goal[]> {
        let sql = "SELECT * FROM goals WHERE roomId = ?";
        const bindings: (string | number)[] = [params.roomId];

        if (params.userId) {
            sql += " AND userId = ?";
            bindings.push(params.userId);
        }

        if (params.onlyInProgress) {
            sql += " AND status = 'IN_PROGRESS'";
        }

        if (params.count) {
            sql += " LIMIT ?";
            bindings.push(params.count.toString());
        }

        const stmt = this.db.prepare(sql);
        stmt.bind(bindings);
        const goals: Goal[] = [];
        while (stmt.step()) {
            const goal = stmt.getAsObject() as unknown as Goal;
            goals.push({
                ...goal,
                objectives:
                    typeof goal.objectives === "string"
                        ? JSON.parse(goal.objectives)
                        : goal.objectives,
            });
        }
        stmt.free();
        return goals;
    }

    async updateGoal(goal: Goal): Promise<void> {
        const sql =
            "UPDATE goals SET name = ?, status = ?, objectives = ? WHERE id = ?";
        const stmt = this.db.prepare(sql);
        stmt.run([
            goal.name,
            goal.status,
            JSON.stringify(goal.objectives),
            goal.id as string,
        ]);
        stmt.free();
    }

    async createGoal(goal: Goal): Promise<void> {
        const sql =
            "INSERT INTO goals (id, roomId, userId, name, status, objectives) VALUES (?, ?, ?, ?, ?, ?)";
        const stmt = this.db.prepare(sql);
        stmt.run([
            goal.id ?? v4(),
            goal.roomId,
            goal.userId,
            goal.name,
            goal.status,
            JSON.stringify(goal.objectives),
        ]);
        stmt.free();
    }

    async removeGoal(goalId: UUID): Promise<void> {
        const sql = "DELETE FROM goals WHERE id = ?";
        const stmt = this.db.prepare(sql);
        stmt.run([goalId]);
        stmt.free();
    }

    async removeAllGoals(roomId: UUID): Promise<void> {
        const sql = "DELETE FROM goals WHERE roomId = ?";
        const stmt = this.db.prepare(sql);
        stmt.run([roomId]);
        stmt.free();
    }

    async createRoom(roomId?: UUID): Promise<UUID> {
        roomId = roomId || (v4() as UUID);
        try {
            const sql = "INSERT INTO rooms (id) VALUES (?)";
            const stmt = this.db.prepare(sql);
            stmt.run([roomId ?? (v4() as UUID)]);
            stmt.free();
        } catch (error) {
            elizaLogger.error("Error creating room", error);
        }
        return roomId as UUID;
    }

    async removeRoom(roomId: UUID): Promise<void> {
        const sql = "DELETE FROM rooms WHERE id = ?";
        const stmt = this.db.prepare(sql);
        stmt.run([roomId]);
        stmt.free();
    }

    async getRoomsForParticipant(userId: UUID): Promise<UUID[]> {
        const sql = "SELECT roomId FROM participants WHERE userId = ?";
        const stmt = this.db.prepare(sql);
        stmt.bind([userId]);
        const rows: { roomId: string }[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as unknown as { roomId: string };
            rows.push(row);
        }
        stmt.free();
        return rows.map((row) => row.roomId as UUID);
    }

    async getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]> {
        // Assuming userIds is an array of UUID strings, prepare a list of placeholders
        const placeholders = userIds.map(() => "?").join(", ");
        // Construct the SQL query with the correct number of placeholders
        const sql = `SELECT roomId FROM participants WHERE userId IN (${placeholders})`;
        const stmt = this.db.prepare(sql);
        // Execute the query with the userIds array spread into arguments
        stmt.bind(userIds);
        const rows: { roomId: string }[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as unknown as { roomId: string };
            rows.push(row);
        }
        stmt.free();
        // Map and return the roomId values as UUIDs
        return rows.map((row) => row.roomId as UUID);
    }

    async addParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
        try {
            const sql =
                "INSERT INTO participants (id, userId, roomId) VALUES (?, ?, ?)";
            const stmt = this.db.prepare(sql);
            stmt.run([v4(), userId, roomId]);
            stmt.free();
            return true;
        } catch (error) {
            elizaLogger.error("Error adding participant", error);
            return false;
        }
    }

    async removeParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
        try {
            const sql =
                "DELETE FROM participants WHERE userId = ? AND roomId = ?";
            const stmt = this.db.prepare(sql);
            stmt.run([userId, roomId]);
            stmt.free();
            return true;
        } catch (error) {
            elizaLogger.error("Error removing participant", error);
            return false;
        }
    }

    async createRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<boolean> {
        if (!params.userA || !params.userB) {
            throw new Error("userA and userB are required");
        }
        const sql =
            "INSERT INTO relationships (id, userA, userB, userId) VALUES (?, ?, ?, ?)";
        const stmt = this.db.prepare(sql);
        stmt.run([v4(), params.userA, params.userB, params.userA]);
        stmt.free();
        return true;
    }

    async getRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<Relationship | null> {
        let relationship: Relationship | null = null;
        try {
            const sql =
                "SELECT * FROM relationships WHERE (userA = ? AND userB = ?) OR (userA = ? AND userB = ?)";
            const stmt = this.db.prepare(sql);
            stmt.bind([params.userA, params.userB, params.userB, params.userA]);

            if (stmt.step()) {
                relationship = stmt.getAsObject() as unknown as Relationship;
            }
            stmt.free();
        } catch (error) {
            elizaLogger.error("Error fetching relationship", error);
        }
        return relationship;
    }

    async getRelationships(params: { userId: UUID }): Promise<Relationship[]> {
        const sql =
            "SELECT * FROM relationships WHERE (userA = ? OR userB = ?)";
        const stmt = this.db.prepare(sql);
        stmt.bind([params.userId, params.userId]);
        const relationships: Relationship[] = [];
        while (stmt.step()) {
            const relationship = stmt.getAsObject() as unknown as Relationship;
            relationships.push(relationship);
        }
        stmt.free();
        return relationships;
    }

    async getCache(params: {
        key: string;
        agentId: UUID;
    }): Promise<string | undefined> {
        const sql = "SELECT value FROM cache WHERE (key = ? AND agentId = ?)";
        const stmt = this.db.prepare(sql);

        stmt.bind([params.key, params.agentId]);

        let cached: { value: string } | undefined = undefined;
        if (stmt.step()) {
            cached = stmt.getAsObject() as unknown as { value: string };
        }
        stmt.free();

        return cached?.value ?? undefined;
    }

    async setCache(params: {
        key: string;
        agentId: UUID;
        value: string;
    }): Promise<boolean> {
        const sql =
            "INSERT OR REPLACE INTO cache (key, agentId, value, createdAt) VALUES (?, ?, ?, CURRENT_TIMESTAMP)";
        const stmt = this.db.prepare(sql);

        stmt.run([params.key, params.agentId, params.value]);
        stmt.free();

        return true;
    }

    async deleteCache(params: {
        key: string;
        agentId: UUID;
    }): Promise<boolean> {
        try {
            const sql = "DELETE FROM cache WHERE key = ? AND agentId = ?";
            const stmt = this.db.prepare(sql);
            stmt.run([params.key, params.agentId]);
            stmt.free();
            return true;
        } catch (error) {
            elizaLogger.error("Error removing cache", error);
            return false;
        }
    }

    async getKnowledge(params: {
        id?: UUID;
        agentId: UUID;
        limit?: number;
        query?: string;
    }): Promise<RAGKnowledgeItem[]> {
        let sql = `SELECT * FROM knowledge WHERE ("agentId" = ? OR "isShared" = 1)`;
        const queryParams: any[] = [params.agentId];

        if (params.id) {
            sql += ` AND id = ?`;
            queryParams.push(params.id);
        }

        if (params.limit) {
            sql += ` LIMIT ?`;
            queryParams.push(params.limit);
        }

        const stmt = this.db.prepare(sql);
        stmt.bind(queryParams);
        const results: RAGKnowledgeItem[] = [];

        while (stmt.step()) {
            const row = stmt.getAsObject() as any;
            results.push({
                id: row.id,
                agentId: row.agentId,
                content: JSON.parse(row.content),
                embedding: row.embedding
                    ? new Float32Array(row.embedding)
                    : undefined, // Convert Uint8Array back to Float32Array
                createdAt: row.createdAt,
            });
        }
        stmt.free();
        return results;
    }

    async searchKnowledge(params: {
        agentId: UUID;
        embedding: Float32Array;
        match_threshold: number;
        match_count: number;
        searchText?: string;
    }): Promise<RAGKnowledgeItem[]> {
        const cacheKey = `embedding_${params.agentId}_${params.searchText}`;
        const cachedResult = await this.getCache({
            key: cacheKey,
            agentId: params.agentId,
        });

        if (cachedResult) {
            return JSON.parse(cachedResult);
        }

        const sql = `
            WITH vector_scores AS (
                SELECT id,
                        1 / (1 + vec_distance_L2(embedding, ?)) as vector_score
                FROM knowledge
                WHERE ("agentId" IS NULL AND "isShared" = 1) OR "agentId" = ?
                AND embedding IS NOT NULL
            ),
            keyword_matches AS (
                SELECT id,
                CASE
                    WHEN json_extract(content, '$.text') LIKE ? THEN 3.0
                    ELSE 1.0
                END *
                CASE
                    WHEN json_extract(content, '$.metadata.isChunk') = 1 THEN 1.5
                    WHEN json_extract(content, '$.metadata.isMain') = 1 THEN 1.2
                    ELSE 1.0
                END as keyword_score
                FROM knowledge
                WHERE ("agentId" IS NULL AND "isShared" = 1) OR "agentId" = ?
            )
            SELECT k.*,
                v.vector_score,
                kw.keyword_score,
                (v.vector_score * kw.keyword_score) as combined_score
            FROM knowledge k
            JOIN vector_scores v ON k.id = v.id
            LEFT JOIN keyword_matches kw ON k.id = kw.id
            WHERE (k.agentId IS NULL AND k.isShared = 1) OR k.agentId = ?
            AND (
                v.vector_score >= ?  -- Using match_threshold parameter
                OR (kw.keyword_score > 1.0 AND v.vector_score >= 0.3)
            )
            ORDER BY combined_score DESC
            LIMIT ?
        `;

        const stmt = this.db.prepare(sql);
        stmt.bind([
            new Uint8Array(params.embedding.buffer),
            params.agentId,
            `%${params.searchText || ""}%`,
            params.agentId,
            params.agentId,
            params.match_threshold,
            params.match_count,
        ]);

        const results: RAGKnowledgeItem[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as any;
            results.push({
                id: row.id,
                agentId: row.agentId,
                content: JSON.parse(row.content),
                embedding: row.embedding
                    ? new Float32Array(row.embedding)
                    : undefined,
                createdAt: row.createdAt,
                similarity: row.keyword_score,
            });
        }
        stmt.free();

        await this.setCache({
            key: cacheKey,
            agentId: params.agentId,
            value: JSON.stringify(results),
        });

        return results;
    }

    async createKnowledge(knowledge: RAGKnowledgeItem): Promise<void> {
        try {
            const sql = `
                INSERT INTO knowledge (
                    id, "agentId", content, embedding, "createdAt",
                    "isMain", "originalId", "chunkIndex", "isShared"
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            const stmt = this.db.prepare(sql);
            const metadata = knowledge.content.metadata || {};

            stmt.run([
                knowledge.id,
                metadata.isShared ? null : knowledge.agentId,
                JSON.stringify(knowledge.content),
                knowledge.embedding
                    ? new Uint8Array(knowledge.embedding.buffer)
                    : null,
                knowledge.createdAt || Date.now(),
                metadata.isMain ? 1 : 0,
                metadata.originalId || null,
                metadata.chunkIndex || null,
                metadata.isShared ? 1 : 0,
            ]);
            stmt.free();
        } catch (error: any) {
            const isShared = knowledge.content.metadata?.isShared;
            const isPrimaryKeyError =
                error?.code === "SQLITE_CONSTRAINT_PRIMARYKEY";

            if (isShared && isPrimaryKeyError) {
                elizaLogger.info(
                    `Shared knowledge ${knowledge.id} already exists, skipping`
                );
                return;
            } else if (
                !isShared &&
                !error.message?.includes("SQLITE_CONSTRAINT_PRIMARYKEY")
            ) {
                elizaLogger.error(`Error creating knowledge ${knowledge.id}:`, {
                    error,
                    embeddingLength: knowledge.embedding?.length,
                    content: knowledge.content,
                });
                throw error;
            }

            elizaLogger.debug(
                `Knowledge ${knowledge.id} already exists, skipping`
            );
        }
    }

    async removeKnowledge(id: UUID): Promise<void> {
        const sql = `DELETE FROM knowledge WHERE id = ?`;
        const stmt = this.db.prepare(sql);
        stmt.run([id]);
        stmt.free();
    }

    async clearKnowledge(agentId: UUID, shared?: boolean): Promise<void> {
        const sql = shared
            ? `DELETE FROM knowledge WHERE ("agentId" = ? OR "isShared" = 1)`
            : `DELETE FROM knowledge WHERE "agentId" = ?`;

        const stmt = this.db.prepare(sql);
        stmt.run([agentId]);
        stmt.free();
    }

    async paginate(table: string, params: PaginationParams): Promise<PaginationResult> {
        const {
            page = 1,
            pageSize = 10,
            where = {},
            order = { createdAt: 'DESC' }
        } = params;

        const offset = (page - 1) * pageSize;
        const whereClause: string[] = [];
        const queryParams: any[] = [];

        // Build where clause and params
        // biome-ignore lint/complexity/noForEach: <explanation>
        Object.entries(where).forEach(([key, value]) => {
            if (value === null || value === undefined) return;

            if (typeof value === 'object') {
                if (key === 'createdAt') {
                    if (value.gte) {
                        whereClause.push(`${key} >= ?`);
                        queryParams.push(value.gte);
                    }
                    if (value.lte) {
                        whereClause.push(`${key} <= ?`);
                        queryParams.push(value.lte);
                    }
                }
            } else {
                whereClause.push(`${key} = ?`);
                queryParams.push(value);
            }
        });

        const orderClause = Object.entries(order)
            .map(([key, direction]) => `${key} ${direction}`)
            .join(', ');

        const whereStr = whereClause.length > 0
            ? `WHERE ${whereClause.join(' AND ')}`
            : '';

        // Count total records
        const countQuery = `
            SELECT COUNT(*) as total 
            FROM ${table} 
            ${whereStr}
        `;
        const countStmt = this.db.prepare(countQuery);
        countStmt.bind(queryParams);
        let total = 0;
        if (countStmt.step()) {
            const result = countStmt.getAsObject() as { total: number };
            total = result.total;
        }
        countStmt.free();

        // Get paginated data
        const dataQuery = `
            SELECT * 
            FROM ${table} 
            ${whereStr}
            ORDER BY ${orderClause}
            LIMIT ? OFFSET ?
        `;
        const dataStmt = this.db.prepare(dataQuery);
        dataStmt.bind([...queryParams, pageSize, offset]);
        
        const list: any[] = [];
        while (dataStmt.step()) {
            list.push(dataStmt.getAsObject());
        }
        dataStmt.free();

        return {
            list,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        };
    }
}
