import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
    type Memory,
    type Goal,
    type Relationship,
    type Actor,
    type GoalStatus,
    type Account,
    type UUID,
    type Participant,
    type Room,
    type RAGKnowledgeItem,
    elizaLogger,
    type PaginationParams,
    type PaginationResult,
} from "@elizaos/core";
import { DatabaseAdapter } from "@elizaos/core";
import { v4 as uuid } from "uuid";

export class SupabaseDatabaseAdapter extends DatabaseAdapter {
    async getRoom(roomId: UUID): Promise<UUID | null> {
        const { data, error } = await this.supabase
            .from("rooms")
            .select("id")
            .eq("id", roomId)
            .maybeSingle();

        if (error) {
            elizaLogger.error(`Error getting room: ${error.message}`);
            return null;
        }
        return data ? (data.id as UUID) : null;
    }

    async getParticipantsForAccount(userId: UUID): Promise<Participant[]> {
        const { data, error } = await this.supabase
            .from("participants")
            .select("*")
            .eq("userId", userId);

        if (error) {
            throw new Error(
                `Error getting participants for account: ${error.message}`
            );
        }

        return data as Participant[];
    }

    async getParticipantUserState(
        roomId: UUID,
        userId: UUID
    ): Promise<"FOLLOWED" | "MUTED" | null> {
        const { data, error } = await this.supabase
            .from("participants")
            .select("userState")
            .eq("roomId", roomId)
            .eq("userId", userId)
            .single();

        if (error) {
            elizaLogger.error("Error getting participant user state:", error);
            return null;
        }

        return data?.userState as "FOLLOWED" | "MUTED" | null;
    }

    async setParticipantUserState(
        roomId: UUID,
        userId: UUID,
        state: "FOLLOWED" | "MUTED" | null
    ): Promise<void> {
        const { error } = await this.supabase
            .from("participants")
            .update({ userState: state })
            .eq("roomId", roomId)
            .eq("userId", userId);

        if (error) {
            elizaLogger.error("Error setting participant user state:", error);
            throw new Error("Failed to set participant user state");
        }
    }

    async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
        const { data, error } = await this.supabase
            .from("participants")
            .select("userId")
            .eq("roomId", roomId);

        if (error) {
            throw new Error(
                `Error getting participants for room: ${error.message}`
            );
        }

        return data.map((row) => row.userId as UUID);
    }

    supabase: SupabaseClient;

    constructor(supabaseUrl: string, supabaseKey: string) {
        super();
        this.supabase = createClient(supabaseUrl, supabaseKey);
    }

    async init() {
        // noop
    }

    async close() {
        // noop
    }

    async getMemoriesByRoomIds(params: {
        roomIds: UUID[];
        agentId?: UUID;
        tableName: string;
        limit?: number;
    }): Promise<Memory[]> {
        let query = this.supabase
            .from(params.tableName)
            .select("*")
            .in("roomId", params.roomIds)
            .order("createdAt", { ascending: false });

        if (params.agentId) {
            query = query.eq("agentId", params.agentId);
        }

        if (params.limit) {
            query = query.limit(params.limit);
        }

        const { data, error } = await query;

        if (error) {
            elizaLogger.error("Error retrieving memories by room IDs:", error);
            return [];
        }

        // map createdAt to Date
        const memories = data.map((memory) => ({
            ...memory,
        }));

        return memories as Memory[];
    }

    async getAccountById(userId: UUID): Promise<Account | null> {
        const { data, error } = await this.supabase
            .from("accounts")
            .select("*")
            .eq("id", userId);
        if (error) {
            throw new Error(error.message);
        }
        return (data?.[0] as Account) || null;
    }

    async createAccount(account: Account): Promise<boolean> {
        const { error } = await this.supabase
            .from("accounts")
            .upsert([account]);
        if (error) {
            elizaLogger.error(error.message);
            return false;
        }
        return true;
    }

    async updateAccount(account: Account): Promise<void> {
        await this.supabase
            .from("accounts")
            .update(account)
            .eq("id", account.id);
    }

    async getActorDetails(params: { roomId: UUID }): Promise<Actor[]> {
        try {
            const response = await this.supabase
                .from("rooms")
                .select(
                    `
          participants:participants(
            account:accounts(id, name, username, details)
          )
      `
                )
                .eq("id", params.roomId);

            if (response.error) {
                elizaLogger.error("Error!" + response.error);
                return [];
            }
            const { data } = response;

            return data
                .flatMap((room) =>
                    room.participants.map((participant) => {
                        const user = participant.account as unknown as Actor;
                        return {
                            name: user?.name,
                            details: user?.details,
                            id: user?.id,
                            username: user?.username,
                        };
                    })
                );
        } catch (error) {
            elizaLogger.error("error", error);
            throw error;
        }
    }

    async searchMemories(params: {
        tableName: string;
        roomId: UUID;
        embedding: number[];
        match_threshold: number;
        match_count: number;
        unique: boolean;
    }): Promise<Memory[]> {
        const result = await this.supabase.rpc("search_memories", {
            query_table_name: params.tableName,
            query_roomId: params.roomId,
            query_embedding: params.embedding,
            query_match_threshold: params.match_threshold,
            query_match_count: params.match_count,
            query_unique: params.unique,
        });
        if (result.error) {
            throw new Error(JSON.stringify(result.error));
        }
        return result.data.map((memory) => ({
            ...memory,
        }));
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
        const result = await this.supabase.rpc("get_embedding_list", opts);
        if (result.error) {
            throw new Error(JSON.stringify(result.error));
        }
        return result.data;
    }

    async updateGoalStatus(params: {
        goalId: UUID;
        status: GoalStatus;
    }): Promise<void> {
        await this.supabase
            .from("goals")
            .update({ status: params.status })
            .match({ id: params.goalId });
    }

    async log(params: {
        body: { [key: string]: unknown };
        userId: UUID;
        roomId: UUID;
        type: string;
    }): Promise<void> {
        const { error } = await this.supabase.from("logs").insert({
            body: params.body,
            userId: params.userId,
            roomId: params.roomId,
            type: params.type,
        });

        if (error) {
            elizaLogger.error("Error inserting log:", error);
            throw new Error(error.message);
        }
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
        const query = this.supabase
            .from(params.tableName)
            .select("*")
            .eq("roomId", params.roomId);

        if (params.start) {
            query.gte("createdAt", params.start);
        }

        if (params.end) {
            query.lte("createdAt", params.end);
        }

        if (params.unique) {
            query.eq("unique", true);
        }

        if (params.agentId) {
            query.eq("agentId", params.agentId);
        }

        query.order("createdAt", { ascending: false });

        if (params.count) {
            query.limit(params.count);
        }

        const { data, error } = await query;

        if (error) {
            throw new Error(`Error retrieving memories: ${error.message}`);
        }

        return data as Memory[];
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
        const queryParams = {
            query_table_name: params.tableName,
            query_roomId: params.roomId,
            query_embedding: embedding,
            query_match_threshold: params.match_threshold,
            query_match_count: params.count,
            query_unique: !!params.unique,
        };
        if (params.agentId) {
            (queryParams as any).query_agentId = params.agentId;
        }

        const result = await this.supabase.rpc("search_memories", queryParams);
        if (result.error) {
            throw new Error(JSON.stringify(result.error));
        }
        return result.data.map((memory) => ({
            ...memory,
        }));
    }

    async getMemoryById(memoryId: UUID): Promise<Memory | null> {
        const { data, error } = await this.supabase
            .from("memories")
            .select("*")
            .eq("id", memoryId)
            .single();

        if (error) {
            elizaLogger.error("Error retrieving memory by ID:", error);
            return null;
        }

        return data as Memory;
    }

    async getMemoriesByIds(
        memoryIds: UUID[],
        tableName?: string
    ): Promise<Memory[]> {
        if (memoryIds.length === 0) return [];

        let query = this.supabase
            .from("memories")
            .select("*")
            .in("id", memoryIds);

        if (tableName) {
            query = query.eq("type", tableName);
        }

        const { data, error } = await query;

        if (error) {
            console.error("Error retrieving memories by IDs:", error);
            return [];
        }

        return data as Memory[];
    }

    async createMemory(
        memory: Memory,
        tableName: string,
        unique = false
    ): Promise<void> {
        const createdAt = memory.createdAt ?? Date.now();
        if (unique) {
            const opts = {
                // TODO: Add ID option, optionally
                query_table_name: tableName,
                query_userId: memory.userId,
                query_content: memory.content.text,
                query_roomId: memory.roomId,
                query_embedding: memory.embedding,
                query_createdAt: createdAt,
                similarity_threshold: 0.95,
            };

            const result = await this.supabase.rpc(
                "check_similarity_and_insert",
                opts
            );

            if (result.error) {
                throw new Error(JSON.stringify(result.error));
            }
        } else {
            const result = await this.supabase
                .from("memories")
                .insert({ ...memory, createdAt, type: tableName });
            const { error } = result;
            if (error) {
                throw new Error(JSON.stringify(error));
            }
        }
    }

    async removeMemory(memoryId: UUID): Promise<void> {
        const result = await this.supabase
            .from("memories")
            .delete()
            .eq("id", memoryId);
        const { error } = result;
        if (error) {
            throw new Error(JSON.stringify(error));
        }
    }

    async removeAllMemories(roomId: UUID, tableName: string): Promise<void> {
        const result = await this.supabase.rpc("remove_memories", {
            query_table_name: tableName,
            query_roomId: roomId,
        });

        if (result.error) {
            throw new Error(JSON.stringify(result.error));
        }
    }

    async countMemories(
        roomId: UUID,
        unique = true,
        tableName: string
    ): Promise<number> {
        if (!tableName) {
            throw new Error("tableName is required");
        }
        const query = {
            query_table_name: tableName,
            query_roomId: roomId,
            query_unique: !!unique,
        };
        const result = await this.supabase.rpc("count_memories", query);

        if (result.error) {
            throw new Error(JSON.stringify(result.error));
        }

        return result.data;
    }

    async getGoals(params: {
        roomId: UUID;
        userId?: UUID | null;
        onlyInProgress?: boolean;
        count?: number;
    }): Promise<Goal[]> {
        const opts = {
            query_roomId: params.roomId,
            query_userId: params.userId,
            only_in_progress: params.onlyInProgress,
            row_count: params.count,
        };

        const { data: goals, error } = await this.supabase.rpc(
            "get_goals",
            opts
        );

        if (error) {
            throw new Error(error.message);
        }

        return goals;
    }

    async updateGoal(goal: Goal): Promise<void> {
        const { error } = await this.supabase
            .from("goals")
            .update(goal)
            .match({ id: goal.id });
        if (error) {
            throw new Error(`Error creating goal: ${error.message}`);
        }
    }

    async createGoal(goal: Goal): Promise<void> {
        const { error } = await this.supabase.from("goals").insert(goal);
        if (error) {
            throw new Error(`Error creating goal: ${error.message}`);
        }
    }

    async removeGoal(goalId: UUID): Promise<void> {
        const { error } = await this.supabase
            .from("goals")
            .delete()
            .eq("id", goalId);
        if (error) {
            throw new Error(`Error removing goal: ${error.message}`);
        }
    }

    async removeAllGoals(roomId: UUID): Promise<void> {
        const { error } = await this.supabase
            .from("goals")
            .delete()
            .eq("roomId", roomId);
        if (error) {
            throw new Error(`Error removing goals: ${error.message}`);
        }
    }

    async getRoomsForParticipant(userId: UUID): Promise<UUID[]> {
        const { data, error } = await this.supabase
            .from("participants")
            .select("roomId")
            .eq("userId", userId);

        if (error) {
            throw new Error(
                `Error getting rooms by participant: ${error.message}`
            );
        }

        return data.map((row) => row.roomId as UUID);
    }

    async getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]> {
        const { data, error } = await this.supabase
            .from("participants")
            .select("roomId")
            .in("userId", userIds);

        if (error) {
            throw new Error(
                `Error getting rooms by participants: ${error.message}`
            );
        }

        return [...new Set(data.map((row) => row.roomId as UUID))] as UUID[];
    }

    async createRoom(roomId?: UUID): Promise<UUID> {
        roomId = roomId ?? (uuid() as UUID);
        const { data, error } = await this.supabase.rpc("create_room", {
            roomId,
        });

        if (error) {
            throw new Error(`Error creating room: ${error.message}`);
        }

        if (!data || data.length === 0) {
            throw new Error("No data returned from room creation");
        }

        return data[0].id as UUID;
    }

    async removeRoom(roomId: UUID): Promise<void> {
        const { error } = await this.supabase
            .from("rooms")
            .delete()
            .eq("id", roomId);

        if (error) {
            throw new Error(`Error removing room: ${error.message}`);
        }
    }

    async addParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
        const { error } = await this.supabase
            .from("participants")
            .insert({ userId: userId, roomId: roomId });

        if (error) {
            elizaLogger.error(`Error adding participant: ${error.message}`);
            return false;
        }
        return true;
    }

    async removeParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
        const { error } = await this.supabase
            .from("participants")
            .delete()
            .eq("userId", userId)
            .eq("roomId", roomId);

        if (error) {
            elizaLogger.error(`Error removing participant: ${error.message}`);
            return false;
        }
        return true;
    }

    async createRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<boolean> {
        const allRoomData = await this.getRoomsForParticipants([
            params.userA,
            params.userB,
        ]);

        let roomId: UUID;

        if (!allRoomData || allRoomData.length === 0) {
            // If no existing room is found, create a new room
            const { data: newRoomData, error: roomsError } = await this.supabase
                .from("rooms")
                .insert({})
                .single();

            if (roomsError) {
                throw new Error("Room creation error: " + roomsError.message);
            }

            roomId = (newRoomData as Room)?.id as UUID;
        } else {
            // If an existing room is found, use the first room's ID
            roomId = allRoomData[0];
        }

        const { error: participantsError } = await this.supabase
            .from("participants")
            .insert([
                { userId: params.userA, roomId },
                { userId: params.userB, roomId },
            ]);

        if (participantsError) {
            throw new Error(
                "Participants creation error: " + participantsError.message
            );
        }

        // Create or update the relationship between the two users
        const { error: relationshipError } = await this.supabase
            .from("relationships")
            .upsert({
                userA: params.userA,
                userB: params.userB,
                userId: params.userA,
                status: "FRIENDS",
            })
            .eq("userA", params.userA)
            .eq("userB", params.userB);

        if (relationshipError) {
            throw new Error(
                "Relationship creation error: " + relationshipError.message
            );
        }

        return true;
    }

    async getRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<Relationship | null> {
        const { data, error } = await this.supabase.rpc("get_relationship", {
            usera: params.userA,
            userb: params.userB,
        });

        if (error) {
            throw new Error(error.message);
        }

        return data[0];
    }

    async getRelationships(params: { userId: UUID }): Promise<Relationship[]> {
        const { data, error } = await this.supabase
            .from("relationships")
            .select("*")
            .or(`userA.eq.${params.userId},userB.eq.${params.userId}`)
            .eq("status", "FRIENDS");

        if (error) {
            throw new Error(error.message);
        }

        return data as Relationship[];
    }

    async getCache(params: {
        key: string;
        agentId: UUID;
    }): Promise<string | undefined> {
        const { data, error } = await this.supabase
            .from("cache")
            .select("value")
            .eq("key", params.key)
            .eq("agentId", params.agentId)
            .single();

        if (error) {
            elizaLogger.error("Error fetching cache:", error);
            return undefined;
        }

        return data?.value;
    }

    async setCache(params: {
        key: string;
        agentId: UUID;
        value: string;
    }): Promise<boolean> {
        const { error } = await this.supabase.from("cache").upsert({
            key: params.key,
            agentId: params.agentId,
            value: params.value,
            createdAt: new Date(),
        });

        if (error) {
            elizaLogger.error("Error setting cache:", error);
            return false;
        }

        return true;
    }

    async deleteCache(params: {
        key: string;
        agentId: UUID;
    }): Promise<boolean> {
        try {
            const { error } = await this.supabase
                .from("cache")
                .delete()
                .eq("key", params.key)
                .eq("agentId", params.agentId);

            if (error) {
                elizaLogger.error("Error deleting cache", {
                    error: error.message,
                    key: params.key,
                    agentId: params.agentId,
                });
                return false;
            }
            return true;
        } catch (error) {
            elizaLogger.error(
                "Database connection error in deleteCache",
                error instanceof Error ? error.message : String(error)
            );
            return false;
        }
    }

    async getKnowledge(params: {
        id?: UUID;
        agentId: UUID;
        limit?: number;
        query?: string;
    }): Promise<RAGKnowledgeItem[]> {
        let query = this.supabase
            .from("knowledge")
            .select("*")
            .or(`agentId.eq.${params.agentId},isShared.eq.true`);

        if (params.id) {
            query = query.eq("id", params.id);
        }

        if (params.limit) {
            query = query.limit(params.limit);
        }

        const { data, error } = await query;

        if (error) {
            throw new Error(`Error getting knowledge: ${error.message}`);
        }

        return data.map((row) => ({
            id: row.id,
            agentId: row.agentId,
            content:
                typeof row.content === "string"
                    ? JSON.parse(row.content)
                    : row.content,
            embedding: row.embedding
                ? new Float32Array(row.embedding)
                : undefined,
            createdAt: new Date(row.createdAt).getTime(),
        }));
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

        // Convert Float32Array to array for Postgres vector
        const embedding = Array.from(params.embedding);

        const { data, error } = await this.supabase.rpc("search_knowledge", {
            query_embedding: embedding,
            query_agent_id: params.agentId,
            match_threshold: params.match_threshold,
            match_count: params.match_count,
            search_text: params.searchText || "",
        });

        if (error) {
            throw new Error(`Error searching knowledge: ${error.message}`);
        }

        const results = data.map((row) => ({
            id: row.id,
            agentId: row.agentId,
            content:
                typeof row.content === "string"
                    ? JSON.parse(row.content)
                    : row.content,
            embedding: row.embedding
                ? new Float32Array(row.embedding)
                : undefined,
            createdAt: new Date(row.createdAt).getTime(),
            similarity: row.similarity,
        }));

        await this.setCache({
            key: cacheKey,
            agentId: params.agentId,
            value: JSON.stringify(results),
        });

        return results;
    }

    async createKnowledge(knowledge: RAGKnowledgeItem): Promise<void> {
        try {
            const metadata = knowledge.content.metadata || {};

            const { error } = await this.supabase.from("knowledge").insert({
                id: knowledge.id,
                agentId: metadata.isShared ? null : knowledge.agentId,
                content: knowledge.content,
                embedding: knowledge.embedding
                    ? Array.from(knowledge.embedding)
                    : null,
                createdAt: knowledge.createdAt || new Date(),
                isMain: metadata.isMain || false,
                originalId: metadata.originalId || null,
                chunkIndex: metadata.chunkIndex || null,
                isShared: metadata.isShared || false,
            });

            if (error) {
                if (metadata.isShared && error.code === "23505") {
                    // Unique violation
                    elizaLogger.info(
                        `Shared knowledge ${knowledge.id} already exists, skipping`
                    );
                    return;
                }
                throw error;
            }
        } catch (error: any) {
            elizaLogger.error(`Error creating knowledge ${knowledge.id}:`, {
                error,
                embeddingLength: knowledge.embedding?.length,
                content: knowledge.content,
            });
            throw error;
        }
    }

    async removeKnowledge(id: UUID): Promise<void> {
        const { error } = await this.supabase
            .from("knowledge")
            .delete()
            .eq("id", id);

        if (error) {
            throw new Error(`Error removing knowledge: ${error.message}`);
        }
    }

    async clearKnowledge(agentId: UUID, shared?: boolean): Promise<void> {
        if (shared) {
            const { error } = await this.supabase
                .from("knowledge")
                .delete()
                .filter("agentId", "eq", agentId)
                .filter("isShared", "eq", true);

            if (error) {
                elizaLogger.error(
                    `Error clearing shared knowledge for agent ${agentId}:`,
                    error
                );
                throw error;
            }
        } else {
            const { error } = await this.supabase
                .from("knowledge")
                .delete()
                .eq("agentId", agentId);

            if (error) {
                elizaLogger.error(
                    `Error clearing knowledge for agent ${agentId}:`,
                    error
                );
                throw error;
            }
        }
    }

    async paginate(table: string, params: PaginationParams): Promise<PaginationResult> {
        const {
            page = 1,
            pageSize = 10,
            where = {},
            order = { createdAt: 'desc' }
        } = params;

        // Start building the query
        let query = this.supabase.from(table).select('*', { count: 'exact' });

        // Add where conditions
        // biome-ignore lint/complexity/noForEach: <explanation>
        Object.entries(where).forEach(([key, value]) => {
            if (value === null || value === undefined) return;

            if (typeof value === 'object') {
                if (key === 'createdAt') {
                    query = query.gte(key, value.gte);
                }
                if (value.lte) {
                    query = query.lte(key, value.lte);
                }
            } else {
                query = query.eq(key, value);
            }
        });

        // Add ordering
        // biome-ignore lint/complexity/noForEach: <explanation>
        Object.entries(order).forEach(([key, direction]) => {
            query = query.order(key, { ascending: direction.toLowerCase() === 'asc' });
        });

        // Add pagination
        const from = (page - 1) * pageSize;
        const to = from + pageSize - 1;
        query = query.range(from, to);

        // Execute query
        const { data, error, count } = await query;

        if (error) {
            throw new Error(`Error paginating ${table}: ${error.message}`);
        }

        return {
            list: data || [],
            total: count || 0,
            page,
            pageSize,
            totalPages: count ? Math.ceil(count / pageSize) : 0,
        };
    }
}
