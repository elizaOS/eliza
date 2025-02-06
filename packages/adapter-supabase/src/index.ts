import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
    type Memory,
    type Goal,
    type Relationship,
    Actor,
    GoalStatus,
    Account,
    type UUID,
    Participant,
    Room,
    RAGKnowledgeItem,
    elizaLogger,
    DatabaseAdapter,
    getEmbeddingConfig,
    ModelClass,
    ModelProviderName,
    getEmbeddingModelSettings,
    models
} from "@elizaos/core";
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
        try {
            const { data, error } = await this.supabase
                .from("participants")
                .select("userState")
                .eq("roomId", roomId)
                .eq("userId", userId)
                .maybeSingle();

            if (error) {
                elizaLogger.error("Error getting participant user state:", error);
                return null;
            }

            return data?.userState as "FOLLOWED" | "MUTED" | null;
        } catch (error) {
            elizaLogger.error("Unexpected error in getParticipantUserState:", error);
            return null;
        }
    }

    async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
        try {
            const { data, error } = await this.supabase
                .from("participants")
                .select("userId")
                .eq("roomId", roomId);

            if (error) {
                elizaLogger.error("Error getting participants for room:", error);
                throw new Error(`Error getting participants for room: ${error.message}`);
            }

            return data.map((row) => row.userId as UUID);
        } catch (error) {
            elizaLogger.error("Unexpected error in getParticipantsForRoom:", error);
            throw error;
        }
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

    supabase: SupabaseClient;

    constructor(supabaseUrl: string, supabaseKey: string) {
        super();
        this.supabase = createClient(supabaseUrl, supabaseKey);
    }

    async init() {
        // Test connection first
        try {
            const { data, error } = await this.supabase
                .from('app_config')
                .select('key')
                .limit(1);

            if (error) {
                elizaLogger.error("Failed to connect to Supabase:", error);
                throw new Error("Database connection failed");
            }

            elizaLogger.debug("Successfully connected to Supabase");

            // Now check vector extension
            const vectorExt = await this.supabase.rpc('check_vector_extension');
            if (!vectorExt.data) {
                elizaLogger.error("Vector extension not found in database");
                throw new Error("Vector extension required");
            }

            // Set embedding configuration based on provider and model
            const embeddingConfig = getEmbeddingConfig();
            const configQueries = [];

            // Set provider-specific configuration
            const providerValue = embeddingConfig.provider.toLowerCase();
            configQueries.push(
                this.supabase.rpc('set_config', {
                    key: 'app.embedding_provider',
                    value: providerValue
                })
            );

            // Set embedding dimensions based on provider
            const dimensions = this.getEmbeddingDimensions(embeddingConfig.provider, embeddingConfig.model);
            configQueries.push(
                this.supabase.rpc('set_config', {
                    key: 'app.embedding_dimensions',
                    value: dimensions.toString()
                })
            );

            // Execute all configuration queries
            await Promise.all(configQueries);
        } catch (error) {
            elizaLogger.error("Database initialization failed:", error);
            throw error;
        }
    }

    private getEmbeddingDimensions(provider: string, modelName: string): number {
        // Handle BGE separately since it's not in models.ts
        if (provider.toUpperCase() === 'BGE') {
            if (modelName.includes('large')) return 1024;
            if (modelName.includes('base')) return 768;
            if (modelName.includes('small')) return 384;
            // Default BGE size
            return 1024;
        }

        // For other providers, try to get from models.ts first
        try {
            const modelProvider = ModelProviderName[provider.toUpperCase() as keyof typeof ModelProviderName];
            const modelSettings = getEmbeddingModelSettings(modelProvider);
            if (modelSettings?.dimensions) {
                return modelSettings.dimensions;
            }
        } catch (e) {
            elizaLogger.warn(`Provider ${provider} not found in ModelProviderName, using fallback logic`);
        }

        // Fallback logic for known models
        if (modelName === 'text-embedding-3-small') return 384;
        if (modelName === 'text-embedding-3-large') return 1024;
        if (modelName === 'text-embedding-ada-002') return 1536;

        // Default fallback
        elizaLogger.warn(`Unknown embedding dimensions for provider ${provider} and model ${modelName}, using default 384`);
        return 384;
    }

    async close() {
        // noop
    }

    async getMemoriesByRoomIds(params: {
        roomIds: UUID[];
        agentId?: UUID;
        tableName: string;
    }): Promise<Memory[]> {
        // Get embedding size from the actual embedding config
        const embeddingConfig = getEmbeddingConfig();
        const modelSettings = getEmbeddingModelSettings(ModelProviderName[embeddingConfig.provider.toUpperCase() as keyof typeof ModelProviderName]);
        const embeddingSize = modelSettings?.dimensions || 1024; // Default to 1024 if not specified

        const actualTableName = `memories_${embeddingSize}`;

        elizaLogger.debug(`getMemoriesByRoomIds: Using table ${actualTableName}`, {
            roomIds: params.roomIds,
            agentId: params.agentId,
            embeddingSize,
            provider: embeddingConfig.provider
        });

        let query = this.supabase
            .from(actualTableName)
            .select("*")
            .in("roomId", params.roomIds);

        if (params.agentId) {
            query = query.eq("agentId", params.agentId);
        }

        const { data, error } = await query;

        if (error) {
            elizaLogger.error(`Error in getMemoriesByRoomIds for table ${actualTableName}:`, error);
            return [];
        }

        if (!data || data.length === 0) {
            elizaLogger.debug(`No memories found in ${actualTableName} for rooms:`, params.roomIds);
            return [];
        }

        elizaLogger.debug(`Found ${data.length} memories in ${actualTableName}`);

        // map createdAt to Date
        const memories = data.map((memory) => ({
            ...memory,
            createdAt: memory.createdAt ? new Date(memory.createdAt).getTime() : undefined
        }));

        return memories as Memory[];
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

    async getAccountById(userId: UUID): Promise<Account | null> {
            const { data, error } = await this.supabase
                .from("accounts")
                .select("*")
                .eq("id", userId);

            if (error) {
                elizaLogger.error(error.message);
                throw error;
            }
            return (data?.[0] as Account) || null;

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
                .map((room) =>
                    room.participants.map((participant) => {
                        const user = participant.account as unknown as Actor;
                        return {
                            name: user?.name,
                            details: user?.details,
                            id: user?.id,
                            username: user?.username,
                        };
                    })
                )
                .flat();
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
        const actualTableName = this.getMemoryTableName(params.embedding);
        // Validate embedding
        if (!params.embedding || !Array.isArray(params.embedding)) {
            elizaLogger.error("Invalid embedding array provided to searchMemories", {
                embedding: params.embedding,
                type: typeof params.embedding
            });
            return [];
        }

        if (params.embedding.length === 0) {
            elizaLogger.error("Empty embedding array provided to searchMemories", {
                roomId: params.roomId,
                tableName: params.tableName
            });
            return [];
        }

        elizaLogger.debug(`Searching memories in ${actualTableName}`, {
            roomId: params.roomId,
            embeddingSize: params.embedding.length,
            threshold: params.match_threshold,
            count: params.match_count,
            unique: params.unique
        });

        const result = await this.supabase.rpc("search_memories", {
            query_table_name: actualTableName,
            query_roomid: params.roomId,
            query_embedding: params.embedding,
            query_match_threshold: params.match_threshold,
            query_match_count: params.match_count,
            query_unique: params.unique,
        });

        if (result.error) {
            elizaLogger.error("Error in searchMemories:", {
                error: result.error,
                params: {
                    ...params,
                    embedding: `[${params.embedding.length} values]` // Don't log full embedding
                }
            });
            throw new Error(JSON.stringify(result.error));
        }

        return result.data;
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
        try {
            elizaLogger.debug("Attempting to insert log:", {
                type: params.type,
                userId: params.userId,
                roomId: params.roomId
            });

            const { error } = await this.supabase
                .from("logs")
                .insert({
                    id: uuid(),
                    body: params.body,
                    userId: params.userId,
                    roomId: params.roomId,
                    type: params.type,
                    createdAt: new Date().toISOString()
                });

            if (error) {
                elizaLogger.error("Error inserting log:", {
                    error,
                    params,
                    errorCode: error.code,
                    details: error.details
                });
                throw new Error(`Failed to insert log: ${error.message}`);
            }

            elizaLogger.debug("Successfully inserted log");
        } catch (error) {
            elizaLogger.error("Unexpected error in log function:", error);
            throw error;
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
        // Use our consistent table name getter
        const actualTableName = this.getMemoryTableName();
        elizaLogger.debug(`Querying memories from table: ${actualTableName}`);

        let query = this.supabase
            .from(actualTableName)
            .select("*")
            .eq("roomId", params.roomId);

        // Convert timestamps to ISO strings
        if (params.start) {
            query.gte("createdAt", new Date(params.start).toISOString());
        }

        if (params.end) {
            query.lte("createdAt", new Date(params.end).toISOString());
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

        // map createdAt to Date
        const memories = data.map((memory) => ({
            ...memory,
            createdAt: memory.createdAt ? new Date(memory.createdAt).getTime() : undefined
        }));

        return memories as Memory[];
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
        // Strict embedding validation
        if (!embedding || !Array.isArray(embedding)) {
            elizaLogger.error("Invalid embedding - must be an array", {
                type: typeof embedding,
                value: embedding
            });
            return [];
        }

        if (embedding.length === 0) {
            elizaLogger.error("Empty embedding array provided");
            return [];
        }

        if (!embedding.every(n => typeof n === 'number' && !Number.isNaN(n))) {
            elizaLogger.error("Invalid embedding values - must all be numbers", {
                invalidValues: embedding.filter(n => typeof n !== 'number' || Number.isNaN(n))
            });
            return [];
        }

        const embeddingSize = embedding.length;
        const validSizes = [384, 768, 1024, 1536];

        if (!validSizes.includes(embeddingSize)) {
            elizaLogger.error(`Invalid embedding size: ${embeddingSize}. Must be one of: ${validSizes.join(', ')}`);
            return [];
        }

        const actualTableName = `memories_${embeddingSize}`;

        elizaLogger.debug(`Searching memories in ${actualTableName}`, {
            roomId: params.roomId,
            embeddingSize,
            threshold: params.match_threshold || 0.8,
            count: params.count || 10,
            unique: params.unique || false
        });

        try {
            const result = await this.supabase.rpc("search_memories", {
                query_table_name: actualTableName,
                query_roomid: params.roomId,
                query_embedding: embedding,
                query_match_threshold: params.match_threshold || 0.8,
                query_match_count: params.count || 10,
                query_unique: params.unique || false
            });

            if (result.error) {
                elizaLogger.error("Memory search failed:", {
                    error: result.error,
                    table: actualTableName,
                    roomId: params.roomId
                });
                return [];
            }

            const memories = result.data || [];
            elizaLogger.debug(`Found ${memories.length} relevant memories in ${actualTableName}`);

            // Log similarity scores for debugging
            if (memories.length > 0) {
                elizaLogger.debug("Memory similarities:",
                    memories.map(m => ({
                        id: m.id,
                        similarity: m.similarity,
                        topic: m.topic
                    }))
                );
            }

            return memories;
        } catch (error) {
            elizaLogger.error("Error searching memories:", {
                error,
                table: actualTableName,
                roomId: params.roomId
            });
            return [];
        }
    }

    async getMemoryById(memoryId: UUID): Promise<Memory | null> {
        if (!memoryId) {
            elizaLogger.debug("getMemoryById skipped - no memoryId provided");
            return null;
        }

        // Try each memory table since we don't know which one contains the memory
        for (const size of [384, 768, 1024, 1536]) {
            try {
                const tableName = `memories_${size}`;
                elizaLogger.debug(`Checking ${tableName} for memory ${memoryId}`);

                const { data, error } = await this.supabase
                    .from(tableName)
                    .select('*')
                    .eq('id', memoryId)
                    .single();

                if (error) {
                    if (error.code === 'PGRST116') {
                        // Not found in this table, continue to next
                        continue;
                    }
                    elizaLogger.debug(`Error checking ${tableName}:`, error);
                    continue;
                }

                if (data) {
                    elizaLogger.debug(`Found memory ${memoryId} in ${tableName}`);
                    return {
                        ...data,
                        createdAt: data.createdAt ? new Date(data.createdAt).getTime() : undefined
                    } as Memory;
                }
            } catch (error) {
                elizaLogger.error(`Error checking memories_${size}:`, error);
                continue;
            }
        }

        elizaLogger.debug(`Memory not found with id: ${memoryId}`);
        return null;
    }

    private async initializeAgentKnowledge(userId: UUID): Promise<void> {
        try {
            // Get agent details
            const { data: agent } = await this.supabase
                .from("accounts")
                .select("*")
                .eq("id", userId)
                .single();

            if (!agent) return;

            // Create initial knowledge entries with proper embedding sizes
            const baseKnowledge = [
                {
                    id: uuid(),
                    agentId: userId,
                    content: {
                        text: agent.details?.summary || '',
                        type: 'summary'
                    },
                    embedding: [], // Will be generated by embedding service
                    createdAt: new Date().toISOString()
                }
            ];

            // Insert knowledge into appropriate tables based on embedding size
            for (const knowledge of baseKnowledge) {
                const embeddingSize = this.getEmbeddingSizeForModel(agent.details?.embeddingModel || 'default');
                const tableName = `memories_${embeddingSize}`;

                const { error: knowledgeError } = await this.supabase
                    .from(tableName)
                    .insert(knowledge);

                if (knowledgeError) {
                    elizaLogger.error("Error initializing knowledge:", knowledgeError);
                    throw knowledgeError;
                }
            }

            // Update account to mark as initialized
            await this.supabase
                .from("accounts")
                .update({
                    details: {
                        ...agent.details,
                        initialized: true
                    }
                })
                .eq("id", userId);

        } catch (error) {
            elizaLogger.error("Error in initializeAgentKnowledge:", error);
            throw error;
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
            query_roomid: roomId,
            query_unique: !!unique
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
        try {
            // First check if agent needs initialization
            if (params.userId) {
                const { data: agentData } = await this.supabase
                    .from("accounts")
                    .select("id, details")
                    .eq("id", params.userId)
                    .single();

                if (agentData && (!agentData.details || !agentData.details.initialized)) {
                    await this.initializeAgentKnowledge(params.userId);
                }
            }

            const opts = {
                only_in_progress: params.onlyInProgress || false,
                query_roomid: params.roomId,
                query_userid: params.userId || null,
                row_count: params.count || null
            };

            const { data: goals, error } = await this.supabase.rpc(
                "get_goals",
                opts
            );

            if (error) {
                elizaLogger.error("Error fetching goals:", error);
                throw new Error(error.message);
            }

            return goals || [];
        } catch (error) {
            elizaLogger.error("Unexpected error in getGoals:", error);
            throw error;
        }
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
        const { error } = await this.supabase
            .from("goals")
            .insert({ ...goal, id: goal.id || uuid() });
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
            .insert({
                id: uuid(), // Generate a new UUID for the participant
                userId: userId,
                roomId: roomId
            });

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
            // Create new room with UUID
            const newRoomId = uuid() as UUID;
            const { error: roomsError } = await this.supabase
                .from("rooms")
                .insert({ id: newRoomId });

            if (roomsError) {
                throw new Error("Room creation error: " + roomsError.message);
            }

            roomId = newRoomId;
        } else {
            roomId = allRoomData[0];
        }

        const { error: participantsError } = await this.supabase
            .from("participants")
            .insert([
                { id: uuid(), userId: params.userA, roomId },
                { id: uuid(), userId: params.userB, roomId },
            ]);

        if (participantsError) {
            throw new Error(
                "Participants creation error: " + participantsError.message
            );
        }

        // Create relationship with UUID
        const { error: relationshipError } = await this.supabase
            .from("relationships")
            .upsert({
                id: uuid(),
                userA: params.userA,
                userB: params.userB,
                userId: params.userA,
                status: "FRIENDS",
            });

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
            .from('cache')
            .select('value')
            .eq('key', params.key)
            .eq('agentId', params.agentId)
            .maybeSingle();

        if (error) {
            elizaLogger.error('Error fetching cache:', error);
            return undefined;
        }

        return data?.value;
    }

    async setCache(params: {
        key: string;
        agentId: UUID;
        value: string;
    }): Promise<boolean> {
        const { error } = await this.supabase
            .from('cache')
            .upsert({
                key: params.key,
                agentId: params.agentId,
                value: params.value,
                createdAt: new Date().toISOString()
            });

        if (error) {
            elizaLogger.error('Error setting cache:', error);
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
                .from('cache')
                .delete()
                .eq('key', params.key)
                .eq('agentId', params.agentId);

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
            .from('knowledge')
            .select('*')
            .or(`agentId.eq.${params.agentId},isShared.eq.true`);

        if (params.id) {
            query = query.eq('id', params.id);
        }

        if (params.limit) {
            query = query.limit(params.limit);
        }

        const { data, error } = await query;

        if (error) {
            elizaLogger.error("Error getting knowledge:", error);
            throw error;
        }

        return data.map(row => ({
            id: row.id,
            agentId: row.agentId,
            content: row.content,
            embedding: row.embedding ? new Float32Array(row.embedding) : undefined,
            createdAt: new Date(row.createdAt).getTime()
        }));
    }

    async searchKnowledge(params: {
        agentId: UUID;
        embedding: Float32Array;
        match_threshold: number;
        match_count: number;
        searchText?: string;
    }): Promise<RAGKnowledgeItem[]> {
        elizaLogger.debug(`Searching knowledge with embedding size ${params.embedding.length}`);

        const { data, error } = await this.supabase.rpc('search_knowledge', {
            query_embedding: Array.from(params.embedding),
            query_agent_id: params.agentId,
            match_threshold: params.match_threshold,
            match_count: params.match_count,
            search_text: params.searchText || ''
        });

        if (error) {
            elizaLogger.error(`Error searching knowledge:`, error);
            throw error;
        }

        return data.map(row => ({
            id: row.id,
            agentId: row.agentId,
            content: row.content,
            embedding: row.embedding ? new Float32Array(row.embedding) : undefined,
            createdAt: new Date(row.createdAt).getTime(),
            similarity: row.similarity
        }));
    }

    async createKnowledge(knowledge: RAGKnowledgeItem): Promise<void> {
        try {
            const tableName = this.getKnowledgeTableName(knowledge.embedding);
            elizaLogger.debug("SupabaseAdapter createKnowledge:", {
                knowledgeId: knowledge.id,
                agentId: knowledge.agentId,
                tableName,
                embeddingLength: knowledge.embedding?.length,
                content: knowledge.content
            });

            const { error } = await this.supabase
                .from(tableName)
                .insert({
                    // Generate new UUID if this is a chunk, otherwise use provided id
                    id: knowledge.content.metadata?.isChunk ? uuid() : knowledge.id,
                    agentId: knowledge.content.metadata?.isShared ? null : knowledge.agentId,
                    content: knowledge.content,
                    embedding: knowledge.embedding ? Array.from(knowledge.embedding) : null,
                    createdAt: typeof knowledge.createdAt === 'number'
                        ? new Date(knowledge.createdAt).toISOString()
                        : knowledge.createdAt || new Date().toISOString(),
                    isMain: knowledge.content.metadata?.isMain || false,
                    // Use the original ID from metadata if it exists
                    originalId: knowledge.content.metadata?.originalId || null,
                    chunkIndex: knowledge.content.metadata?.chunkIndex,
                    isShared: knowledge.content.metadata?.isShared || false
                });

            if (error) {
                if (error.code === '23505' && knowledge.content.metadata?.isShared) {
                    elizaLogger.debug(`Shared knowledge ${knowledge.id} already exists, skipping`);
                    return;
                }
                elizaLogger.error(`Error creating knowledge in ${tableName}:`, {
                    error,
                    embeddingLength: knowledge.embedding?.length,
                    content: knowledge.content
                });
                throw error;
            }
        } catch (error) {
            elizaLogger.error("Error in createKnowledge:", error);
            throw error;
        }
    }

    async removeKnowledge(id: UUID): Promise<void> {
        // Since we don't know which table the knowledge is in, try all tables
        const tables = ['knowledge_1536', 'knowledge_1024', 'knowledge_768', 'knowledge_384'];

        for (const table of tables) {
            const { error } = await this.supabase
                .from(table)
                .delete()
                .eq('id', id);

            if (error && error.code !== 'PGRST116') { // Ignore "not found" errors
                elizaLogger.error(`Error removing knowledge from ${table}:`, error);
                throw error;
            }
        }
    }

    async clearKnowledge(agentId: UUID, shared?: boolean): Promise<void> {
        const tables = ['knowledge_1536', 'knowledge_1024', 'knowledge_768', 'knowledge_384'];

        for (const table of tables) {
            let query = this.supabase
                .from(table)
                .delete()
                .eq('agentId', agentId);

            if (shared) {
                query = query.or('isShared.eq.true');
            }

            const { error } = await query;

            if (error) {
                elizaLogger.error(`Error clearing knowledge from ${table}:`, error);
                throw error;
            }
        }
    }

    private getEmbeddingSizeForModel(model: string): number {
        const modelSizes: { [key: string]: number } = {
            'text-embedding-ada-002': 1536,
            'text-embedding-3-small': 384,
            'text-embedding-3-large': 1024,
            'default': 384
        };
        return modelSizes[model] || 384;
    }

    async createKnowledgeChunk(params: {
        id: UUID;
        originalId: UUID;
        agentId: UUID | null;
        content: any;
        embedding: Float32Array | undefined | null;
        chunkIndex: number;
        isShared: boolean;
        createdAt: number;
    }): Promise<void> {
        const vectorArray = params.embedding ? Array.from(params.embedding) : null;

        // Determine correct table based on embedding size
        const embeddingSize = vectorArray?.length;
        if (!embeddingSize || ![384, 768, 1024, 1536].includes(embeddingSize)) {
            throw new Error(`Invalid embedding size: ${embeddingSize}`);
        }

        const tableName = `memories_${embeddingSize}`;

        // Store pattern ID in metadata
        const patternId = `${params.originalId}-chunk-${params.chunkIndex}`;
        const contentWithPatternId = {
            ...params.content,
            metadata: {
                ...params.content.metadata,
                patternId,
            },
        };

        const { error } = await this.supabase
            .from(tableName)
            .insert({
                id: uuid(),
                agentId: params.agentId,
                content: contentWithPatternId,
                embedding: vectorArray,
                createdAt: new Date(params.createdAt).toISOString(),
                isMain: false,
                originalId: params.originalId,
                chunkIndex: params.chunkIndex,
                isShared: params.isShared
            });

        if (error) {
            throw new Error(`Error creating knowledge chunk: ${error.message}`);
        }
    }

    private getMemoryTableName(embedding?: number[]): string {
        // If we have an embedding, use its actual size
        if (embedding && Array.isArray(embedding) && embedding.length > 0) {
            const tableName = `memories_${embedding.length}`;
            elizaLogger.debug(`getMemoryTableName: Using ${tableName} based on embedding length ${embedding.length}`);
            return tableName;
        }

        // Otherwise get from config
        const embeddingConfig = getEmbeddingConfig();
        elizaLogger.debug("Embedding config:", embeddingConfig); // Log the config
        const modelSettings = getEmbeddingModelSettings(ModelProviderName[embeddingConfig.provider.toUpperCase() as keyof typeof ModelProviderName]);
        elizaLogger.debug("Model settings:", modelSettings); // Log the settings
        const embeddingSize = modelSettings?.dimensions;

        if (!embeddingSize) {
            elizaLogger.warn('No embedding size found in config, using default 1024');
            return 'memories_1024';
        }

        const tableName = `memories_${embeddingSize}`;
        elizaLogger.debug(`getMemoryTableName: Using ${tableName} from config`);
        return tableName;
    }

    async createMemory(
        memory: Memory,
        tableName: string,
        unique = false
    ): Promise<void> {
        const actualTableName = this.getMemoryTableName();
        elizaLogger.debug("SupabaseAdapter createMemory called:", {
            memoryId: memory.id,
            originalTableName: tableName,
            actualTableName,
            isFactTable: tableName === 'facts',
            contentType: memory.content?.type,
            hasEmbedding: !!memory.embedding,
            embeddingLength: memory.embedding?.length,
            unique
        });

        try {
            // Skip if no content
            if (!memory.content?.text) {
                elizaLogger.debug("Skipping memory creation - no content");
                return;
            }

            // Convert from milliseconds to ISO string
            const createdAt = memory.createdAt
                ? new Date(memory.createdAt).toISOString()
                : new Date().toISOString();

            if (unique) {
                const opts = {
                    query_table_name: actualTableName,
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
                    elizaLogger.error("Error in check_similarity_and_insert:", result.error);
                    throw new Error(JSON.stringify(result.error));
                }
            } else {
                const result = await this.supabase
                    .from(actualTableName)
                    .insert({
                        ...memory,
                        id: memory.id || uuid(),
                        createdAt,
                        type: tableName
                    });

                if (result.error) {
                    elizaLogger.error("Error inserting memory:", {
                        error: result.error,
                        table: actualTableName
                    });
                    throw new Error(JSON.stringify(result.error));
                }
            }
        } catch (error) {
            elizaLogger.error("Error in createMemory:", {
                error,
                memoryId: memory.id,
                tableName,
                contentType: memory.content?.type
            });
            throw error;
        }
    }

    private getKnowledgeTableName(embedding?: Float32Array | number[]): string {
        // If we have an embedding, use its actual size
        if (embedding && (embedding instanceof Float32Array || Array.isArray(embedding))) {
            const tableName = `knowledge_${embedding.length}`;
            elizaLogger.debug(`getKnowledgeTableName: Using ${tableName} based on embedding length ${embedding.length}`);
            return tableName;
        }

        // Otherwise get from config
        const embeddingConfig = getEmbeddingConfig();
        const modelSettings = getEmbeddingModelSettings(ModelProviderName[embeddingConfig.provider.toUpperCase()]);
        const embeddingSize = modelSettings?.dimensions;

        if (!embeddingSize) {
            elizaLogger.warn('No embedding size found in config, using default 1024');
            return 'knowledge_1024';
        }

        const tableName = `knowledge_${embeddingSize}`;
        elizaLogger.debug(`getKnowledgeTableName: Using ${tableName} from config`);
        return tableName;
    }
}
