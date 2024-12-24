import { MongoClient } from 'mongodb';
import {
    DatabaseAdapter,
    IDatabaseCacheAdapter,
    Account,
    Actor,
    GoalStatus,
    Participant,
    type Goal,
    type Memory,
    type Relationship,
    type UUID,
} from "@ai16z/eliza";
import { v4 } from "uuid";

export class MongoDBDatabaseAdapter
    extends DatabaseAdapter<MongoClient>
    implements IDatabaseCacheAdapter
{
    private database: any;
    private databaseName: string;
    private hasVectorSearch: boolean;

    constructor(client: MongoClient, databaseName: string) {
        super();
        this.db = client;
        this.databaseName = databaseName;
        this.hasVectorSearch = false;
    }

    async init() {
        await this.db.connect();
        this.database = this.db.db(this.databaseName);

        // Track whether vector search is available
        this.hasVectorSearch = false;

        // Create required indexes
        await Promise.all([
            // Try to create vector search index, but don't fail if unavailable
            (async () => {
                try {
                    await this.database.collection('memories').createIndex(
                        { embedding: "vectorSearch" },
                        {
                            name: "vector_index",
                            definition: {
                                vectorSearchConfig: {
                                    dimensions: 1536,
                                    similarity: "cosine",
                                    numLists: 100,
                                    efConstruction: 128
                                }
                            }
                        }
                    );
                    this.hasVectorSearch = true;
                    console.log("Vector search capabilities are available and enabled");
                } catch (error) {
                    console.log("Vector search not available, falling back to standard search", error);
                    // Create a standard index on embedding field instead
                    await this.database.collection('memories').createIndex(
                        { embedding: 1 }
                    );
                }
            })(),

            // Regular indexes that should always be created
            this.database.collection('memories').createIndex(
                { type: 1, roomId: 1, agentId: 1, createdAt: -1 }
            ),
            this.database.collection('participants').createIndex(
                { userId: 1, roomId: 1 },
                { unique: true }
            ),
            this.database.collection('memories').createIndex(
                { "content": "text" },
                { weights: { "content": 10 } }
            ),
            this.database.collection('cache').createIndex(
                { expiresAt: 1 },
                { expireAfterSeconds: 0 }
            )
        ]);

        try {
            // Enable sharding for better performance
            await this.database.command({
                enableSharding: this.database.databaseName
            });
            await this.database.command({
                shardCollection: `${this.database.databaseName}.memories`,
                key: { roomId: "hashed" }
            });
        } catch (error) {
            console.log("Sharding may already be enabled or insufficient permissions", error);
        }
    }

    async close() {
        await this.db.close();
    }

    // Rest of your methods, but replace this.db with this.database when accessing MongoDB collections
    async getRoom(roomId: UUID): Promise<UUID | null> {
        const room = await this.database.collection('rooms').findOne({ id: roomId });
        return room ? room.id : null;
    }

    async getParticipantsForAccount(userId: UUID): Promise<Participant[]> {
        return await this.database.collection('participants')
            .find({ userId })
            .toArray();
    }

    async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
        const participants = await this.database.collection('participants')
            .find({ roomId })
            .toArray();
        return participants.map(p => p.userId);
    }

    async getParticipantUserState(
        roomId: UUID,
        userId: UUID
    ): Promise<"FOLLOWED" | "MUTED" | null> {
        const participant = await this.database.collection('participants')
            .findOne({ roomId, userId });
        return participant?.userState ?? null;
    }

    async setParticipantUserState(
        roomId: UUID,
        userId: UUID,
        state: "FOLLOWED" | "MUTED" | null
    ): Promise<void> {
        await this.database.collection('participants').updateOne(
            { roomId, userId },
            { $set: { userState: state } }
        );
    }

    async getAccountById(userId: UUID): Promise<Account | null> {
        const account = await this.database.collection('accounts').findOne({ id: userId });
        if (!account) return null;
        return {
            ...account,
            details: typeof account.details === 'string' ?
                JSON.parse(account.details) : account.details
        };
    }

    async createAccount(account: Account): Promise<boolean> {
        try {
            await this.database.collection('accounts').insertOne({
                ...account,
                id: account.id ?? v4(),
                details: JSON.stringify(account.details),
                createdAt: new Date()
            });
            return true;
        } catch (error) {
            console.log("Error creating account", error);
            return false;
        }
    }

    async getActorDetails(params: { roomId: UUID }): Promise<Actor[]> {
        const actors = await this.database.collection('participants')
            .aggregate([
                { $match: { roomId: params.roomId } },
                {
                    $lookup: {
                        from: 'accounts',
                        localField: 'userId',
                        foreignField: 'id',
                        as: 'account'
                    }
                },
                { $unwind: '$account' },
                {
                    $project: {
                        id: '$account.id',
                        name: '$account.name',
                        username: '$account.username',
                        details: '$account.details'
                    }
                }
            ]).toArray();

        return actors
            .map(actor => ({
                ...actor,
                details: typeof actor.details === 'string' ?
                    JSON.parse(actor.details) : actor.details
            }))
            .filter((actor): actor is Actor => actor !== null);
    }

    async getMemoriesByRoomIds(params: {
        agentId: UUID;
        roomIds: UUID[];
        tableName: string;
    }): Promise<Memory[]> {
        if (!params.tableName) {
            params.tableName = "messages";
        }

        const memories = await this.database.collection('memories')
            .find({
                type: params.tableName,
                agentId: params.agentId,
                roomId: { $in: params.roomIds }
            })
            .toArray();

        return memories.map(memory => ({
            ...memory,
            content: typeof memory.content === 'string' ?
                JSON.parse(memory.content) : memory.content
        }));
    }

    async getMemoryById(memoryId: UUID): Promise<Memory | null> {
        const memory = await this.database.collection('memories').findOne({ id: memoryId });
        if (!memory) return null;

        return {
            ...memory,
            content: typeof memory.content === 'string' ?
                JSON.parse(memory.content) : memory.content
        };
    }

    async createMemory(memory: Memory, tableName: string): Promise<void> {
        let isUnique = true;

        if (memory.embedding) {
            const similarMemories = await this.searchMemoriesByEmbedding(
                memory.embedding,
                {
                    tableName,
                    agentId: memory.agentId,
                    roomId: memory.roomId,
                    match_threshold: 0.95,
                    count: 1
                }
            );
            isUnique = similarMemories.length === 0;
        }

        const content = JSON.stringify(memory.content);
        const createdAt = memory.createdAt ?? Date.now();

        await this.database.collection('memories').insertOne({
            id: memory.id ?? v4(),
            type: tableName,
            content,
            embedding: new Float32Array(memory.embedding!),
            userId: memory.userId,
            roomId: memory.roomId,
            agentId: memory.agentId,
            unique: isUnique,
            createdAt: new Date(createdAt)
        });
    }

    private async searchMemoriesFallback(params: {
        embedding: number[];
        query: any;
        limit?: number;
    }): Promise<Memory[]> {
        // Implement a basic similarity search using standard MongoDB operations
        const memories = await this.database.collection('memories')
            .find(params.query)
            .limit(params.limit || 10)
            .toArray();

        // Sort by cosine similarity computed in application
        return memories
            .map(memory => ({
                ...memory,
                similarity: this.cosineSimilarity(params.embedding, memory.embedding)
            }))
            .sort((a, b) => b.similarity - a.similarity)
            .map(memory => ({
                ...memory,
                createdAt: typeof memory.createdAt === "string" ?
                    Date.parse(memory.createdAt) : memory.createdAt,
                content: typeof memory.content === 'string' ?
                    JSON.parse(memory.content) : memory.content
            }));
    }

    private cosineSimilarity(a: number[], b: number[]): number {
        const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
        const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
        const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
        return dotProduct / (magnitudeA * magnitudeB);
    }

    async searchMemories(params: {
        tableName: string;
        roomId: UUID;
        agentId?: UUID;
        embedding: number[];
        match_threshold: number;
        match_count: number;
        unique: boolean;
    }): Promise<Memory[]> {
        const query = {
            type: params.tableName,
            roomId: params.roomId,
            ...(params.unique && { unique: true }),
            ...(params.agentId && { agentId: params.agentId })
        };

        if (this.hasVectorSearch) {
            const pipeline = [
                {
                    $search: {
                        vectorSearch: {
                            queryVector: new Float32Array(params.embedding),
                            path: "embedding",
                            numCandidates: params.match_count * 2,
                            limit: params.match_count,
                            index: "vector_index",
                        }
                    }
                },
                { $match: query }
            ];

            try {
                const memories = await this.database.collection('memories')
                    .aggregate(pipeline)
                    .toArray();

                return memories.map(memory => ({
                    ...memory,
                    createdAt: typeof memory.createdAt === "string" ?
                        Date.parse(memory.createdAt) : memory.createdAt,
                    content: typeof memory.content === 'string' ?
                        JSON.parse(memory.content) : memory.content
                }));
            } catch (error) {
                console.log("Vector search failed, falling back to standard search", error);
                return this.searchMemoriesFallback({
                    embedding: params.embedding,
                    query,
                    limit: params.match_count
                });
            }
        }

        return this.searchMemoriesFallback({
            embedding: params.embedding,
            query,
            limit: params.match_count
        });
    }

    async searchMemoriesByEmbedding(
        embedding: number[],
        params: {
            match_threshold?: number;
            count?: number;
            roomId?: UUID;
            agentId: UUID;
            unique?: boolean;
            tableName: string;
        }
    ): Promise<Memory[]> {
        const pipeline = [
            {
                $search: {
                    vectorSearch: {
                        queryVector: new Float32Array(embedding),
                        path: "embedding",
                        numCandidates: (params.count ?? 10) * 2,
                        limit: params.count,
                        index: "vector_index"
                    }
                }
            },
            {
                $match: {
                    type: params.tableName,
                    agentId: params.agentId,
                    ...(params.unique && { unique: true }),
                    ...(params.roomId && { roomId: params.roomId })
                }
            }
        ];

        const memories = await this.database.collection('memories')
            .aggregate(pipeline)
            .toArray();

        return memories.map(memory => ({
            ...memory,
            createdAt: typeof memory.createdAt === "string" ?
                Date.parse(memory.createdAt) : memory.createdAt,
            content: typeof memory.content === 'string' ?
                JSON.parse(memory.content) : memory.content
        }));
    }

    async getCachedEmbeddings(opts: {
        query_table_name: string;
        query_threshold: number;
        query_input: string;
        query_field_name: string;
        query_field_sub_name: string;
        query_match_count: number;
    }): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
        const BATCH_SIZE = 1000; // Process in chunks of 1000 documents
        let results: { embedding: number[]; levenshtein_score: number }[] = [];

        try {
            // Get total count for progress tracking
            const totalCount = await this.database.collection('memories').countDocuments({
                type: opts.query_table_name,
                [`content.${opts.query_field_name}.${opts.query_field_sub_name}`]: { $exists: true }
            });

            let processed = 0;

            while (processed < totalCount) {
                // Fetch batch of documents
                const memories = await this.database.collection('memories')
                    .find({
                        type: opts.query_table_name,
                        [`content.${opts.query_field_name}.${opts.query_field_sub_name}`]: { $exists: true }
                    })
                    .skip(processed)
                    .limit(BATCH_SIZE)
                    .toArray();

                // Process batch
                const batchResults = memories
                    .map(memory => {
                        try {
                            const content = memory.content[opts.query_field_name][opts.query_field_sub_name];
                            if (!content || typeof content !== 'string') {
                                return null;
                            }

                            return {
                                embedding: Array.from(memory.embedding),
                                levenshtein_score: this.calculateLevenshteinDistanceOptimized(
                                    content.toLowerCase(),
                                    opts.query_input.toLowerCase()
                                )
                            };
                        } catch (error) {
                            console.warn(`Error processing memory document: ${error}`);
                            return null;
                        }
                    })
                    .filter((result): result is { embedding: number[]; levenshtein_score: number } =>
                        result !== null);

                // Merge batch results
                results = this.mergeAndSortResults(results, batchResults, opts.query_match_count);
                processed += memories.length;

                // Log progress for long operations
                if (totalCount > BATCH_SIZE) {
                    console.log(`Processed ${processed}/${totalCount} documents`);
                }
            }

            return results;

        } catch (error) {
            console.error("Error in getCachedEmbeddings:", error);
            if (results.length > 0) {
                console.log("Returning partial results");
                return results;
            }
            return [];
        }
    }

    /**
     * Optimized Levenshtein distance calculation with early termination
     * and matrix reuse for better performance
     */
    private calculateLevenshteinDistanceOptimized(str1: string, str2: string): number {
        // Early termination for identical strings
        if (str1 === str2) return 0;

        // Early termination for empty strings
        if (str1.length === 0) return str2.length;
        if (str2.length === 0) return str1.length;

        // Use shorter string as inner loop for better performance
        if (str1.length > str2.length) {
            [str1, str2] = [str2, str1];
        }

        // Reuse matrix to avoid garbage collection
        const matrix = this.getLevenshteinMatrix(str1.length + 1, str2.length + 1);

        // Initialize first row and column
        for (let i = 0; i <= str1.length; i++) matrix[i][0] = i;
        for (let j = 0; j <= str2.length; j++) matrix[0][j] = j;

        // Calculate minimum edit distance
        for (let i = 1; i <= str1.length; i++) {
            for (let j = 1; j <= str2.length; j++) {
                if (str1[i-1] === str2[j-1]) {
                    matrix[i][j] = matrix[i-1][j-1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i-1][j-1] + 1,  // substitution
                        matrix[i][j-1] + 1,    // insertion
                        matrix[i-1][j] + 1     // deletion
                    );
                }
            }
        }

        return matrix[str1.length][str2.length];
    }

// Cache for reusing Levenshtein distance matrix
    private levenshteinMatrix: number[][] = [];
    private maxMatrixSize = 0;

    private getLevenshteinMatrix(rows: number, cols: number): number[][] {
        const size = rows * cols;
        if (size > this.maxMatrixSize) {
            this.levenshteinMatrix = Array(rows).fill(null)
                .map(() => Array(cols).fill(0));
            this.maxMatrixSize = size;
        }
        return this.levenshteinMatrix;
    }

    /**
     * Efficiently merge and sort two arrays of results while maintaining top K items
     */
    private mergeAndSortResults(
        existing: { embedding: number[]; levenshtein_score: number }[],
        newResults: { embedding: number[]; levenshtein_score: number }[],
        limit: number
    ): { embedding: number[]; levenshtein_score: number }[] {
        const merged = [...existing, ...newResults];

        // Use quick select algorithm if array is large
        if (merged.length > 1000) {
            return this.quickSelectTopK(merged, limit);
        }

        // Use simple sort for smaller arrays
        return merged
            .sort((a, b) => a.levenshtein_score - b.levenshtein_score)
            .slice(0, limit);
    }

    /**
     * Quick select algorithm to efficiently find top K items
     */
    private quickSelectTopK(
        arr: { embedding: number[]; levenshtein_score: number }[],
        k: number
    ): { embedding: number[]; levenshtein_score: number }[] {
        if (arr.length <= k) return arr.sort((a, b) => a.levenshtein_score - b.levenshtein_score);

        const pivot = arr[Math.floor(Math.random() * arr.length)].levenshtein_score;
        const left = arr.filter(x => x.levenshtein_score < pivot);
        const equal = arr.filter(x => x.levenshtein_score === pivot);
        const right = arr.filter(x => x.levenshtein_score > pivot);

        if (k <= left.length) {
            return this.quickSelectTopK(left, k);
        }
        if (k <= left.length + equal.length) {
            return [...left, ...equal.slice(0, k - left.length)]
                .sort((a, b) => a.levenshtein_score - b.levenshtein_score);
        }
        return [...left, ...equal, ...this.quickSelectTopK(right, k - left.length - equal.length)]
            .sort((a, b) => a.levenshtein_score - b.levenshtein_score);
    }

    async updateGoalStatus(params: {
        goalId: UUID;
        status: GoalStatus;
    }): Promise<void> {
        await this.database.collection('goals').updateOne(
            { id: params.goalId },
            { $set: { status: params.status } }
        );
    }

    async log(params: {
        body: { [key: string]: unknown };
        userId: UUID;
        roomId: UUID;
        type: string;
    }): Promise<void> {
        await this.database.collection('logs').insertOne({
            id: v4(),
            body: JSON.stringify(params.body),
            userId: params.userId,
            roomId: params.roomId,
            type: params.type,
            createdAt: new Date()
        });
    }

    async getMemories(params: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        tableName: string;
        agentId: UUID;
        start?: number;
        end?: number;
    }): Promise<Memory[]> {
        if (!params.tableName) {
            throw new Error("tableName is required");
        }
        if (!params.roomId) {
            throw new Error("roomId is required");
        }

        const query: any = {
            type: params.tableName,
            agentId: params.agentId,
            roomId: params.roomId
        };

        if (params.unique) {
            query.unique = true;
        }

        if (params.start || params.end) {
            query.createdAt = {};
            if (params.start) query.createdAt.$gte = new Date(params.start);
            if (params.end) query.createdAt.$lte = new Date(params.end);
        }

        const memories = await this.database.collection('memories')
            .find(query)
            .sort({ createdAt: -1 })
            .limit(params.count || 0)
            .toArray();

        return memories.map(memory => ({
            ...memory,
            createdAt: new Date(memory.createdAt).getTime(),
            content: typeof memory.content === 'string' ?
                JSON.parse(memory.content) : memory.content
        }));
    }

    async removeMemory(memoryId: UUID, tableName: string): Promise<void> {
        await this.database.collection('memories').deleteOne({
            id: memoryId,
            type: tableName
        });
    }

    async removeAllMemories(roomId: UUID, tableName: string): Promise<void> {
        await this.database.collection('memories').deleteMany({
            roomId,
            type: tableName
        });
    }

    async countMemories(
        roomId: UUID,
        unique = true,
        tableName = ""
    ): Promise<number> {
        if (!tableName) {
            throw new Error("tableName is required");
        }

        const query: any = {
            type: tableName,
            roomId
        };

        if (unique) {
            query.unique = true;
        }

        return await this.database.collection('memories').countDocuments(query);
    }

    async getGoals(params: {
        roomId: UUID;
        userId?: UUID | null;
        onlyInProgress?: boolean;
        count?: number;
    }): Promise<Goal[]> {
        const query: any = { roomId: params.roomId };

        if (params.userId) {
            query.userId = params.userId;
        }

        if (params.onlyInProgress) {
            query.status = 'IN_PROGRESS';
        }

        const goals = await this.database.collection('goals')
            .find(query)
            .limit(params.count || 0)
            .toArray();

        return goals.map(goal => ({
            ...goal,
            objectives: typeof goal.objectives === 'string' ?
                JSON.parse(goal.objectives) : goal.objectives
        }));
    }

    async updateGoal(goal: Goal): Promise<void> {
        await this.database.collection('goals').updateOne(
            { id: goal.id },
            {
                $set: {
                    name: goal.name,
                    status: goal.status,
                    objectives: JSON.stringify(goal.objectives)
                }
            }
        );
    }

    async createGoal(goal: Goal): Promise<void> {
        await this.database.collection('goals').insertOne({
            ...goal,
            id: goal.id ?? v4(),
            objectives: JSON.stringify(goal.objectives),
            createdAt: new Date()
        });
    }

    async removeGoal(goalId: UUID): Promise<void> {
        await this.database.collection('goals').deleteOne({ id: goalId });
    }

    async removeAllGoals(roomId: UUID): Promise<void> {
        await this.database.collection('goals').deleteMany({ roomId });
    }

    async createRoom(roomId?: UUID): Promise<UUID> {
        const newRoomId = roomId || v4() as UUID;
        try {
            await this.database.collection('rooms').insertOne({
                id: newRoomId,
                createdAt: new Date()
            });
        } catch (error) {
            console.log("Error creating room", error);
        }
        return newRoomId;
    }

    async removeRoom(roomId: UUID): Promise<void> {
        await this.database.collection('rooms').deleteOne({ id: roomId });
    }

    async getRoomsForParticipant(userId: UUID): Promise<UUID[]> {
        const rooms = await this.database.collection('participants')
            .find({ userId })
            .project({ roomId: 1 })
            .toArray();
        return rooms.map(r => r.roomId);
    }

    async getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]> {
        const rooms = await this.database.collection('participants')
            .distinct('roomId', { userId: { $in: userIds } });
        return rooms;
    }

    async addParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
        try {
            await this.database.collection('participants').insertOne({
                id: v4(),
                userId,
                roomId,
                createdAt: new Date()
            });
            return true;
        } catch (error) {
            console.log("Error adding participant", error);
            return false;
        }
    }

    async removeParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
        try {
            await this.database.collection('participants').deleteOne({
                userId,
                roomId
            });
            return true;
        } catch (error) {
            console.log("Error removing participant", error);
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

        try {
            await this.database.collection('relationships').insertOne({
                id: v4(),
                userA: params.userA,
                userB: params.userB,
                userId: params.userA,
                createdAt: new Date()
            });
            return true;
        } catch (error) {
            console.log("Error creating relationship", error);
            return false;
        }
    }

    async getRelationship(params: {
        userA: UUID;
        userB: UUID;
    }): Promise<Relationship | null> {
        return await this.database.collection('relationships').findOne({
            $or: [
                { userA: params.userA, userB: params.userB },
                { userA: params.userB, userB: params.userA }
            ]
        });
    }

    async getRelationships(params: { userId: UUID }): Promise<Relationship[]> {
        return await this.database.collection('relationships')
            .find({
                $or: [
                    { userA: params.userId },
                    { userB: params.userId }
                ]
            })
            .toArray();
    }

    async getCache(params: {
        key: string;
        agentId: UUID;
    }): Promise<string | undefined> {
        const cached = await this.database.collection('cache')
            .findOne({
                key: params.key,
                agentId: params.agentId,
                expiresAt: { $gt: new Date() }
            });
        return cached?.value;
    }

    async setCache(params: {
        key: string;
        agentId: UUID;
        value: string;
    }): Promise<boolean> {
        try {
            await this.database.collection('cache').updateOne(
                { key: params.key, agentId: params.agentId },
                {
                    $set: {
                        value: params.value,
                        createdAt: new Date(),
                        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours expiry
                    }
                },
                { upsert: true }
            );
            return true;
        } catch (error) {
            console.log("Error setting cache", error);
            return false;
        }
    }

    async deleteCache(params: {
        key: string;
        agentId: UUID;
    }): Promise<boolean> {
        try {
            await this.database.collection('cache').deleteOne({
                key: params.key,
                agentId: params.agentId
            });
            return true;
        } catch (error) {
            console.log("Error removing cache", error);
            return false;
        }
    }
}
