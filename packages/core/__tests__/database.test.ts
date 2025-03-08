/* eslint-disable no-dupe-class-members */
import { DatabaseAdapter } from "../src/database.ts";
import {
	type Memory,
	type Actor,
	type Entity,
	type Goal,
	GoalStatus,
	type Participant,
	type Relationship,
	type UUID,
	type ChannelType,
	type RoomData,
} from "../src/types.ts";

/**
 * MockDatabaseAdapter class extends DatabaseAdapter class and provides mock implementations for various database operations.
 * @extends {DatabaseAdapter}
 */
class MockDatabaseAdapter extends DatabaseAdapter {
	/**
	 * Asynchronous function to retrieve a Memory object by its unique ID.
	 *
	 * @param {UUID} _id - The unique identifier of the Memory object to retrieve.
	 * @returns {Promise<Memory | null>} - A Promise that resolves to the retrieved Memory object, or null if not found.
	 * @throws {Error} - If the method is not implemented.
	 */

	getMemoryById(_id: UUID): Promise<Memory | null> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Retrieve memories by their IDs.
	 *
	 * @param {UUID[]} memoryIds - An array of memory IDs to fetch.
	 * @param {string} [_tableName] - Optional table name parameter.
	 * @returns {Promise<Memory[]>} - A Promise that resolves to an array of Memory objects.
	 */
	async getMemoriesByIds(
		memoryIds: UUID[],
		_tableName?: string,
	): Promise<Memory[]> {
		return memoryIds.map((id) => ({
			id: id,
			content: { text: "Test Memory" },
			roomId: "room-id" as UUID,
			userId: "user-id" as UUID,
			agentId: "agent-id" as UUID,
		})) as Memory[];
	}
	/**
	 * Logs an event for a specific user in a specific room.
	 *
	 * @param {object} _params - The parameters for the log function.
	 * @param {object} _params.body - The data object containing the event details.
	 * @param {string} _params.userId - The unique identifier of the user performing the event.
	 * @param {string} _params.roomId - The unique identifier of the room where the event occurred.
	 * @param {string} _params.type - The type of event being logged.
	 * @returns {Promise<void>}
	 */
	log(_params: {
		body: { [key: string]: unknown };
		userId: UUID;
		roomId: UUID;
		type: string;
	}): Promise<void> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Retrieve details of actors in a specific room.
	 *
	 * @param {Object} _params - The parameters for the method.
	 * @param {UUID} _params.roomId - The UUID of the room to retrieve actor details from.
	 * @returns {Promise<Actor[]>} - A promise that resolves to an array of Actor objects representing the details of actors in the specified room.
	 * @throws {Error} - If the method is not implemented.
	 */
	getActorDetails(_params: { roomId: UUID }): Promise<Actor[]> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Creates a new memory in the specified table.
	 * @param _memory The memory object to be created.
	 * @param _tableName The name of the table where the memory should be created.
	 * @param _unique Optional parameter to specify if the memory should be unique within the table.
	 * @returns A Promise that resolves when the memory is successfully created.
	 */
	createMemory(
		_memory: Memory,
		_tableName: string,
		_unique?: boolean,
	): Promise<void> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Removes a memory from a specific table.
	 *
	 * @param {UUID} _memoryId - The ID of the memory to be removed.
	 * @param {string} _tableName - The name of the table from which the memory will be removed.
	 * @returns {Promise<void>} A promise that resolves when the memory is successfully removed.
	 */
	removeMemory(_memoryId: UUID, _tableName: string): Promise<void> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Remove all memories associated with a specific room and table.
	 *
	 * @param {UUID} _roomId - The unique identifier of the room.
	 * @param {string} _tableName - The name of the table containing the memories.
	 * @returns {Promise<void>} A promise that resolves when all memories are successfully removed.
	 */
	removeAllMemories(_roomId: UUID, _tableName: string): Promise<void> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Count the number of memories for a specific room.
	 *
	 * @param {UUID} _roomId - The ID of the room to count memories for.
	 * @param {boolean} [_unique] - Flag to indicate if only unique memories should be counted.
	 * @param {string} [_tableName] - The name of the table to count memories from.
	 * @return {Promise<number>} - A Promise that resolves to the number of memories.
	 */
	countMemories(
		_roomId: UUID,
		_unique?: boolean,
		_tableName?: string,
	): Promise<number> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Retrieves goals based on specified parameters.
	 *
	 * @param {Object} _params - The parameters for filtering goals.
	 * @param {UUID} _params.roomId - The ID of the room to get goals from.
	 * @param {UUID} [_params.userId] - Optional. The ID of the user to filter goals by.
	 * @param {boolean} [_params.onlyInProgress] - Optional. If true, only goals that are in progress will be returned.
	 * @param {number} [_params.count] - Optional. The maximum number of goals to return.
	 * @returns {Promise<Goal[]>} - A Promise that resolves to an array of Goal objects.
	 */
	getGoals(_params: {
		roomId: UUID;
		userId?: UUID | null;
		onlyInProgress?: boolean;
		count?: number;
	}): Promise<Goal[]> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Updates a goal.
	 *
	 * @param _goal The goal to update.
	 * @returns A Promise that resolves when the goal has been updated.
	 */
	updateGoal(_goal: Goal): Promise<void> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Creates a new goal.
	 *
	 * @param {Goal} _goal - The goal object to be created.
	 * @returns {Promise<void>} - A Promise that resolves when the goal is created.
	 */
	createGoal(_goal: Goal): Promise<void> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Removes a goal with the specified ID.
	 *
	 * @param {UUID} _goalId - The ID of the goal to remove.
	 * @returns {Promise<void>} A promise that resolves when the goal is successfully removed.
	 */
	removeGoal(_goalId: UUID): Promise<void> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Removes all goals associated with a specific room.
	 *
	 * @param {UUID} _roomId - The unique identifier of the room to remove goals from.
	 * @returns {Promise<void>} A promise that resolves when all goals are successfully removed.
	 */
	removeAllGoals(_roomId: UUID): Promise<void> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Retrieve the room data for a specific room and agent.
	 *
	 * @param {_roomId} UUID - The unique identifier of the room.
	 * @param {_agentId} UUID - The unique identifier of the agent.
	 * @returns {Promise<RoomData | null>} - The room data if found, otherwise null.
	 */
	getRoom(_roomId: UUID, _agentId: UUID): Promise<RoomData | null> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Creates a room with the given parameters.
	 *
	 * @param {Object} _params - The parameters for creating the room.
	 * @param {UUID} _params.id - The ID of the room.
	 * @param {UUID} _params.agentId - The ID of the agent associated with the room.
	 * @param {string} _params.source - The source of the room.
	 * @param {ChannelType} _params.type - The type of channel.
	 * @param {string} [_params.channelId] - Optional channel ID.
	 * @param {string} [_params.serverId] - Optional server ID.
	 * @param {UUID} [_params.worldId] - Optional world ID.
	 * @returns {Promise<UUID>} - A promise that resolves with the ID of the created room.
	 */
	createRoom(_params: {
		id: UUID;
		agentId: UUID;
		source: string;
		type: ChannelType;
		channelId?: string;
		serverId?: string;
		worldId?: UUID;
	}): Promise<UUID> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Removes a room with the given ID.
	 *
	 * @param {_roomId: UUID} _roomId - The ID of the room to remove.
	 * @returns {Promise<void>} - A promise that resolves when the room is successfully removed.
	 */
	removeRoom(_roomId: UUID): Promise<void> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Retrieve a list of room IDs for a given participant.
	 * @param {UUID} _userId - The ID of the participant
	 * @returns {Promise<UUID[]>} - A promise that resolves with an array of room IDs
	 */
	getRoomsForParticipant(_userId: UUID): Promise<UUID[]> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Retrieves the rooms for the specified participants.
	 *
	 * @param {UUID[]} _userIds - An array of UUIDs representing the participants whose rooms need to be retrieved.
	 * @returns {Promise<UUID[]>} - A promise that resolves to an array of UUIDs representing the rooms for the specified participants.
	 * @throws {Error} - If the method is not implemented.
	 */
	getRoomsForParticipants(_userIds: UUID[]): Promise<UUID[]> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Add a participant to a room.
	 *
	 * @param {UUID} _userId - The ID of the user to add to the room.
	 * @param {UUID} _roomId - The ID of the room to add the user to.
	 * @returns {Promise<boolean>} - A promise that resolves to true if the user was successfully added to the room, otherwise false.
	 */
	addParticipant(_userId: UUID, _roomId: UUID): Promise<boolean> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Remove a participant from a room.
	 *
	 * @param {_userId} UUID - The ID of the user to remove from the room.
	 * @param {_roomId} UUID - The ID of the room from which to remove the participant.
	 * @returns {Promise<boolean>} A promise that resolves to true if the participant was successfully removed, otherwise false.
	 */
	removeParticipant(_userId: UUID, _roomId: UUID): Promise<boolean> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Retrieve a list of participants associated with the specified account user ID.
	 *
	 * @param {UUID} userId - The unique identifier of the account user.
	 * @returns {Promise<Participant[]>} - A promise that resolves to an array of Participant objects.
	 */
	getParticipantsForAccount(userId: UUID): Promise<Participant[]>;
	/**
	 * Retrieves the participants associated with a specific user account.
	 *
	 * @param {unknown} _userId - The ID of the user account to retrieve participants for.
	 * @returns {Promise<import("../src/types.ts").Participant[]>} A Promise that resolves to an array of participants.
	 */
	getParticipantsForAccount(
		_userId: unknown,
	): Promise<import("../src/types.ts").Participant[]> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Get the list of participants for a specific room.
	 *
	 * @param {_roomId} UUID - The UUID of the room for which participants need to be retrieved.
	 * @returns {Promise<UUID[]>} - A Promise that resolves to an array of UUIDs representing the participants of the room.
	 * @throws {Error} - If the method is not implemented.
	 */
	getParticipantsForRoom(_roomId: UUID): Promise<UUID[]> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Get the state of a participant user in a specific room.
	 * @param {UUID} _roomId - The ID of the room.
	 * @param {UUID} _userId - The ID of the user.
	 * @returns {Promise<"FOLLOWED" | "MUTED" | null>} The state of the participant user (FOLLOWED, MUTED, or null).
	 */
	getParticipantUserState(
		_roomId: UUID,
		_userId: UUID,
	): Promise<"FOLLOWED" | "MUTED" | null> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Set the state of a participant in a room.
	 *
	 * @param {UUID} _roomId - The unique identifier of the room.
	 * @param {UUID} _userId - The unique identifier of the user.
	 * @param {UUID} _agentId - The unique identifier of the agent.
	 * @param {"FOLLOWED" | "MUTED" | null} _state - The state to set for the participant (FOLLOWED, MUTED, or null).
	 * @returns {Promise<void>} - A promise that resolves when the state is set.
	 */
	setParticipantUserState(
		_roomId: UUID,
		_userId: UUID,
		_agentId: UUID,
		_state: "FOLLOWED" | "MUTED" | null,
	): Promise<void> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Creates a relationship between two users.
	 *
	 * @param {Object} _params - The parameters for creating the relationship.
	 * @param {UUID} _params.userA - The UUID of the first user.
	 * @param {UUID} _params.userB - The UUID of the second user.
	 * @returns {Promise<boolean>} - A promise that resolves to true if the relationship was successfully created.
	 */
	createRelationship(_params: {
		userA: UUID;
		userB: UUID;
	}): Promise<boolean> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Retrieves the relationship between two users.
	 * @param {object} _params The parameters for which relationship to get.
	 * @param {UUID} _params.userA The UUID of the first user.
	 * @param {UUID} _params.userB The UUID of the second user.
	 * @returns {Promise<Relationship | null>} A Promise that resolves with the relationship between the two users, or null if no relationship exists.
	 */
	getRelationship(_params: {
		userA: UUID;
		userB: UUID;
	}): Promise<Relationship | null> {
		throw new Error("Method not implemented.");
	}
	/**
	 * Retrieves relationships for a specific user based on the provided user ID.
	 * @param {Object} _params - The parameters object containing the user ID.
	 * @param {string} _params.userId - The unique identifier for the user to retrieve relationships for.
	 * @returns {Promise<Relationship[]>} - A promise that resolves to an array of Relationship objects.
	 */
	getRelationships(_params: { userId: UUID }): Promise<Relationship[]> {
		throw new Error("Method not implemented.");
	}
	db: Record<string, unknown> = {};

	// Mock method for getting memories by room IDs
	/**
	 *
	 * Retrieves memories based on given roomIds and optional agentId.
	 *
	 * @param {Object} params - The parameters for fetching memories.
	 * @param {string[]} params.roomIds - An array of roomIds to filter memories by.
	 * @param {string} [params.agentId] - An optional agentId to further filter memories by.
	 * @param {string} params.tableName - The name of the table storing memories.
	 * @returns {Promise<Memory[]>} - The Promise that resolves to an array of Memory objects.
	 */
	async getMemoriesByRoomIds(params: {
		roomIds: `${string}-${string}-${string}-${string}-${string}`[];
		agentId?: `${string}-${string}-${string}-${string}-${string}`;
		tableName: string;
	}): Promise<Memory[]> {
		return [
			{
				id: "memory-id" as UUID,
				content: "Test Memory",
				roomId: params.roomIds[0],
				userId: "user-id" as UUID,
				agentId: params.agentId ?? ("agent-id" as UUID),
			},
		] as unknown as Memory[];
	}

	// Mock method for getting cached embeddings
	/**
	 * Fetch cached embeddings based on the query parameters.
	 *
	 * @param {Object} _params - The parameters used to query the cached embeddings.
	 * @param {string} _params.query_table_name - The name of the table used for the query.
	 * @param {number} _params.query_threshold - The threshold value for the query.
	 * @param {string} _params.query_input - The input string for the query.
	 * @param {string} _params.query_field_name - The name of the field used in the query.
	 * @param {string} _params.query_field_sub_name - The subfield name used in the query.
	 * @param {number} _params.query_match_count - The number of matches for the query.
	 * @return {Promise<{embedding: number[], levenshtein_score: number}[]>} The cached embeddings with their Levenshtein scores.
	 */

	async getCachedEmbeddings(_params: {
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
		return [
			{
				embedding: [0.1, 0.2, 0.3],
				levenshtein_score: 0.4,
			},
		];
	}

	// Mock method for searching memories
	/**
	 * Asynchronously searches for memories based on the provided parameters.
	 *
	 * @param {Object} params - The parameters for the memory search.
	 * @param {string} params.tableName - The name of the table to search memories in.
	 * @param {string} params.roomId - The room ID to search memories related to.
	 * @param {number[]} params.embedding - The memory embedding for similarity matching.
	 * @param {number} params.match_threshold - The threshold for match similarity.
	 * @param {number} params.count - The number of memories to retrieve.
	 * @param {boolean} params.unique - Flag to retrieve unique memories only.
	 * @returns {Promise<Array<Memory>>} The list of memories that match the search criteria.
	 */
	async searchMemories(params: {
		tableName: string;
		roomId: `${string}-${string}-${string}-${string}-${string}`;
		embedding: number[];
		match_threshold: number;
		count: number;
		unique: boolean;
	}): Promise<Memory[]> {
		return [
			{
				id: "memory-id" as UUID,
				content: "Test Memory",
				roomId: params.roomId,
				userId: "user-id" as UUID,
				agentId: "agent-id" as UUID,
			},
		] as unknown as Memory[];
	}

	// Mock method for getting account by ID
	/**
	 * Asynchronously retrieves an Entity by its unique ID.
	 *
	 * @param {UUID} userId - The unique identifier of the Entity to retrieve.
	 * @returns {Promise<Entity | null>} A Promise that resolves with the Entity object if found, otherwise null.
	 */
	async getEntityById(userId: UUID): Promise<Entity | null> {
		return {
			id: userId,
			metadata: {
				username: "testuser",
				name: "Test Entity",
			},
			agentId: "agent-id" as UUID,
		} as Entity;
	}

	// Other methods stay the same...
	/**
	 * Asynchronously creates a new entity for a given account.
	 *
	 * @param {Entity} _account - The account for which the entity is being created.
	 * @returns {Promise<boolean>} A Promise that resolves to true if entity creation is successful.
	 */
	async createEntity(_account: Entity): Promise<boolean> {
		return true;
	}

	/**
	 * Retrieves memories based on the specified parameters.
	 *
	 * @param {Object} params - The parameters for fetching memories.
	 * @param {UUID} params.roomId - The ID of the room to fetch memories from.
	 * @param {number} [params.count] - The number of memories to fetch.
	 * @param {boolean} [params.unique] - Whether to fetch unique memories.
	 * @param {string} params.tableName - The name of the table storing the memories.
	 * @returns {Promise<Memory[]>} - A Promise that resolves to an array of Memory objects.
	 */
	async getMemories(params: {
		roomId: UUID;
		count?: number;
		unique?: boolean;
		tableName: string;
	}): Promise<Memory[]> {
		return [
			{
				id: "memory-id" as UUID,
				content: "Test Memory",
				roomId: params.roomId,
				userId: "user-id" as UUID,
				agentId: "agent-id" as UUID,
			},
		] as unknown as Memory[];
	}

	/**
	 * Asynchronously retrieves a list of actors based on the provided roomId.
	 * @param {Object} _params - The parameters object.
	 * @param {UUID} _params.roomId - The roomId to filter actors by.
	 * @returns {Promise<Actor[]>} - A promise that resolves to an array of Actor objects.
	 */
	async getActors(_params: { roomId: UUID }): Promise<Actor[]> {
		return [
			{
				id: "actor-id" as UUID,
				name: "Test Actor",
				username: "testactor",
				roomId: "room-id" as UUID, // Ensure roomId is provided
			},
		] as unknown as Actor[];
	}

	/**
	 * Update the status of a goal.
	 *
	 * @param {object} _params - The parameters for updating the goal status.
	 * @param {string} _params.goalId - The ID of the goal to update.
	 * @param {string} _params.status - The new status of the goal.
	 * @returns {Promise<void>} A promise that resolves when the goal status is updated.
	 */
	async updateGoalStatus(_params: {
		goalId: UUID;
		status: GoalStatus;
	}): Promise<void> {
		return Promise.resolve();
	}

	/**
	 * Asynchronously retrieves a goal by its ID.
	 *
	 * @param {UUID} goalId - The ID of the goal to retrieve.
	 * @returns {Promise<Goal|null>} A Promise that resolves with the goal object if found, or null if not found.
	 */
	async getGoalById(goalId: UUID): Promise<Goal | null> {
		return {
			id: goalId,
			status: GoalStatus.IN_PROGRESS,
			roomId: "room-id" as UUID,
			userId: "user-id" as UUID,
			name: "Test Goal",
			objectives: [],
		} as Goal;
	}
}

// Now, let’s fix the test suite.

describe("DatabaseAdapter Tests", () => {
	let adapter: MockDatabaseAdapter;
	const roomId = "room-id" as UUID;

	beforeEach(() => {
		adapter = new MockDatabaseAdapter();
	});

	it("should return memories by room ID", async () => {
		const memories = await adapter.getMemoriesByRoomIds({
			roomIds: [
				"room-id" as `${string}-${string}-${string}-${string}-${string}`,
			],
			tableName: "test_table",
		});
		expect(memories).toHaveLength(1);
		expect(memories[0].roomId).toBe("room-id");
	});

	it("should return cached embeddings", async () => {
		const embeddings = await adapter.getCachedEmbeddings({
			query_table_name: "test_table",
			query_threshold: 0.5,
			query_input: "test query",
			query_field_name: "field",
			query_field_sub_name: "subfield",
			query_match_count: 5,
		});
		expect(embeddings).toHaveLength(1);
		expect(embeddings[0].embedding).toEqual([0.1, 0.2, 0.3]);
	});

	it("should search memories based on embedding", async () => {
		const memories = await adapter.searchMemories({
			tableName: "test_table",
			roomId: "room-id" as `${string}-${string}-${string}-${string}-${string}`,
			embedding: [0.1, 0.2, 0.3],
			match_threshold: 0.5,
			count: 3,
			unique: true,
		});
		expect(memories).toHaveLength(1);
		expect(memories[0].roomId).toBe("room-id");
	});

	it("should get an account by user ID", async () => {
		const account = await adapter.getEntityById("test-user-id" as UUID);
		expect(account).not.toBeNull();
		expect(account?.metadata?.username).toBe("testuser");
	});

	it("should create a new account", async () => {
		const newAccount: Entity = {
			id: "new-user-id" as UUID,
			metadata: {
				username: "newuser",
				name: "New Entity",
			},
			agentId: "agent-id" as UUID,
		};
		const result = await adapter.createEntity(newAccount);
		expect(result).toBe(true);
	});

	it("should update the goal status", async () => {
		const goalId = "goal-id" as UUID;
		await expect(
			adapter.updateGoalStatus({ goalId, status: GoalStatus.IN_PROGRESS }),
		).resolves.toBeUndefined();
	});

	it("should return actors by room ID", async () => {
		const actors = await adapter.getActors({ roomId });
		expect(actors).toHaveLength(1);
	});

	it("should get a goal by ID", async () => {
		const goalId = "goal-id" as UUID;
		const goal = await adapter.getGoalById(goalId);
		expect(goal).not.toBeNull();
		expect(goal?.status).toBe(GoalStatus.IN_PROGRESS);
	});
});
