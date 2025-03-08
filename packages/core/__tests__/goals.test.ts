import { beforeEach, describe, expect, it, mock } from "bun:test";
import { CacheManager, MemoryCacheAdapter } from "../src/cache.ts";
import {
	createGoal,
	formatGoalsAsString,
	getGoals,
	updateGoal,
} from "../src/goals.ts";
import {
	type Action,
	type ChannelType,
	type Character,
	type Client,
	type Goal,
	GoalStatus,
	type HandlerCallback,
	type IAgentRuntime,
	type IMemoryManager,
	type Memory,
	type ModelClass,
	type Provider,
	type RoomData,
	type Service,
	type ServiceType,
	type State,
	type Task,
	type UUID,
	type WorldData,
} from "../src/types.ts";

// Mock the database adapter
export const mockDatabaseAdapter = {
	getGoals: mock(),
	updateGoal: mock(),
	createGoal: mock(),
};

const _services = new Map<ServiceType, Service>();

// Create memory managers first
/**
 * Object representing a message manager.
 * @type {IMemoryManager}
 * @property {any} runtime - Will be set after runtime creation.
 * @property {string} tableName - The name of the table for storing messages.
 * @property {Function} searchMemories - Asynchronous function to search memories.
 * @property {Function} addEmbeddingToMemory - Asynchronous function to add embedding to memory.
 * @property {Function} getMemories - Asynchronous function to get memories.
 * @property {Function} getCachedEmbeddings - Asynchronous function to get cached embeddings.
 * @property {Function} getMemoryById - Asynchronous function to get memory by ID.
 * @property {Function} getMemoriesByRoomIds - Asynchronous function to get memories by room IDs.
 * @property {Function} createMemory - Asynchronous function to create a memory.
 * @property {Function} removeMemory - Asynchronous function to remove a memory.
 * @property {Function} removeAllMemories - Asynchronous function to remove all memories.
 * @property {Function} countMemories - Asynchronous function to count memories.
 */

const messageManager: IMemoryManager = {
	runtime: undefined as any, // Will set after runtime creation
	tableName: "messages",
	searchMemories: async () => [],
	addEmbeddingToMemory: async (m) => m,
	getMemories: async () => [],
	getCachedEmbeddings: async () => [],
	getMemoryById: async () => null,
	getMemoriesByRoomIds: async () => [],
	createMemory: async () => {},
	removeMemory: async () => {},
	removeAllMemories: async () => {},
	countMemories: async () => 0,
};

/**
 * Interface for managing descriptions in memory.
 * @typedef {Object} IMemoryManager
 * @property {any} runtime - Runtime instance to be set after creation
 * @property {string} tableName - Name of the table for descriptions
 * @property {Function} searchMemories - Asynchronous function to search memories
 * @property {Function} addEmbeddingToMemory - Asynchronous function to add embedding to memory
 * @property {Function} getMemories - Asynchronous function to get memories
 * @property {Function} getCachedEmbeddings - Asynchronous function to get cached embeddings
 * @property {Function} getMemoryById - Asynchronous function to get a memory by ID
 * @property {Function} getMemoriesByRoomIds - Asynchronous function to get memories by room IDs
 * @property {Function} createMemory - Asynchronous function to create a memory
 * @property {Function} removeMemory - Asynchronous function to remove a memory
 * @property {Function} removeAllMemories - Asynchronous function to remove all memories
 * @property {Function} countMemories - Asynchronous function to count memories
 */

const descriptionManager: IMemoryManager = {
	runtime: undefined as any, // Will set after runtime creation
	tableName: "descriptions",
	searchMemories: async () => [],
	addEmbeddingToMemory: async (m) => m,
	getMemories: async () => [],
	getCachedEmbeddings: async () => [],
	getMemoryById: async () => null,
	getMemoriesByRoomIds: async () => [],
	createMemory: async () => {},
	removeMemory: async () => {},
	removeAllMemories: async () => {},
	countMemories: async () => 0,
};

// Then create runtime
/**
 * Mock runtime object implementing the IAgentRuntime interface.
 * This object is used for testing purposes.
 */
export const mockRuntime: IAgentRuntime = {
	databaseAdapter: mockDatabaseAdapter as any,
	cacheManager: new CacheManager(new MemoryCacheAdapter()),
	agentId: "qweqew-qweqwe-qweqwe-qweqwe-qweeqw",
	messageManager,
	descriptionManager,
	ensureRoomExists: async () => {},
	composeState: async () => ({}) as State,
	updateRecentMessageState: async (s) => s,
	getService: () => null,
	plugins: [],
	initialize: async () => {},
	adapters: [],
	character: {
		name: "test",
		bio: "test bio",
		style: {},
	} as Character,
	providers: [],
	useModel: async () => [],
	knowledgeManager: messageManager,
	documentsManager: descriptionManager,
	actions: [],
	evaluators: [],
	routes: [],
	getClient: () => null,
	getAllClients: () => new Map(),
	registerClient: async () => {},
	unregisterClient: async () => {},
	registerMemoryManager: () => {},
	getMemoryManager: () => null,
	getModel: () => undefined,
	events: new Map(),
	registerClientInterface: (_name: string, _client: Client): void => {
		throw new Error("Function not implemented.");
	},
	transformUserId: (_userId: UUID): UUID => {
		throw new Error("Function not implemented.");
	},
	registerService: (_service: Service): void => {
		throw new Error("Function not implemented.");
	},
	setSetting: (
		_key: string,
		_value: string | boolean | null | any,
		_secret: boolean,
	): void => {
		throw new Error("Function not implemented.");
	},
	getSetting: (_key: string) => {
		throw new Error("Function not implemented.");
	},
	getConversationLength: (): number => {
		throw new Error("Function not implemented.");
	},
	processActions: (
		_message: Memory,
		_responses: Memory[],
		_state?: State,
		_callback?: HandlerCallback,
	): Promise<void> => {
		throw new Error("Function not implemented.");
	},
	evaluate: (
		_message: Memory,
		_state?: State,
		_didRespond?: boolean,
		_callback?: HandlerCallback,
	): Promise<string[] | null> => {
		throw new Error("Function not implemented.");
	},
	getOrCreateUser: (
		_userId: UUID,
		_userName: string | null,
		_name: string | null,
		_source: string | null,
	): Promise<UUID> => {
		throw new Error("Function not implemented.");
	},
	registerProvider: (_provider: Provider): void => {
		throw new Error("Function not implemented.");
	},
	registerAction: (_action: Action): void => {
		throw new Error("Function not implemented.");
	},
	ensureConnection: ({
		userId,
		roomId,
		userName,
		userScreenName,
		source,
		channelId,
		serverId,
		type,
	}: {
		userId: UUID;
		roomId: UUID;
		userName?: string;
		userScreenName?: string;
		source?: string;
		channelId?: string;
		serverId?: string;
		type: ChannelType;
	}): Promise<void> => {
		throw new Error("Function not implemented.");
	},
	ensureParticipantInRoom: (_userId: UUID, _roomId: UUID): Promise<void> => {
		throw new Error("Function not implemented.");
	},
	getWorld: (_worldId: UUID): Promise<WorldData | null> => {
		throw new Error("Function not implemented.");
	},
	ensureWorldExists: ({ id, name, serverId }: WorldData): Promise<void> => {
		throw new Error("Function not implemented.");
	},
	getRoom: (_roomId: UUID): Promise<RoomData | null> => {
		throw new Error("Function not implemented.");
	},
	registerModel: (
		_modelClass: ModelClass,
		_handler: (params: any) => Promise<any>,
	): void => {
		throw new Error("Function not implemented.");
	},
	registerEvent: (_event: string, _handler: (params: any) => void): void => {
		throw new Error("Function not implemented.");
	},
	getEvent: (_event: string): ((params: any) => void)[] | undefined => {
		throw new Error("Function not implemented.");
	},
	emitEvent: (_event: string | string[], _params: any): void => {
		throw new Error("Function not implemented.");
	},
	registerTask: (_task: Task): UUID => {
		throw new Error("Function not implemented.");
	},
	getTasks: ({
		roomId,
		tags,
	}: { roomId?: UUID; tags?: string[] }): Task[] | undefined => {
		throw new Error("Function not implemented.");
	},
	getTask: (_id: UUID): Task | undefined => {
		throw new Error("Function not implemented.");
	},
	updateTask: (_id: UUID, _task: Task): void => {
		throw new Error("Function not implemented.");
	},
	deleteTask: (_id: UUID): void => {
		throw new Error("Function not implemented.");
	},
	stop: (): Promise<void> => {
		throw new Error("Function not implemented.");
	},
	ensureAgentExists: (): Promise<void> => {
		throw new Error("Function not implemented.");
	},
	ensureEmbeddingDimension: (): Promise<void> => {
		throw new Error("Function not implemented.");
	},
	ensureCharacterExists: (_character: Character): Promise<void> => {
		throw new Error("Function not implemented.");
	},
};

// Set runtime references after creation
messageManager.runtime = mockRuntime;
descriptionManager.runtime = mockRuntime;

// Sample data
const sampleGoal: Goal = {
	id: "goal-id" as UUID,
	roomId: "room-id" as UUID,
	userId: "user-id" as UUID,
	name: "Test Goal",
	objectives: [
		{ description: "Objective 1", completed: false },
		{ description: "Objective 2", completed: true },
	],
	status: GoalStatus.IN_PROGRESS,
};

describe("getGoals", () => {
	let _runtime: IAgentRuntime;

	beforeEach(() => {
		_runtime = {
			agentId: "test-agent-id" as UUID,
			databaseAdapter: {
				getGoals: mock().mockResolvedValue([]),
			} as any,
		} as IAgentRuntime;
	});

	it("retrieves goals successfully", async () => {
		mockDatabaseAdapter.getGoals.mockResolvedValue([sampleGoal]);

		const result = await getGoals({
			runtime: mockRuntime,
			roomId: "room-id" as UUID,
		});

		expect(result).toEqual([sampleGoal]);
	});

	it("handles errors when retrieving goals", async () => {
		mockDatabaseAdapter.getGoals.mockRejectedValue(
			new Error("Failed to retrieve goals"),
		);

		await expect(
			getGoals({
				runtime: mockRuntime,
				roomId: "room-id" as UUID,
			}),
		).rejects.toThrow("Failed to retrieve goals");
	});

	it("should handle empty goals list", async () => {
		const mockRuntime = {
			agentId: "test-agent-id" as UUID,
			databaseAdapter: {
				getGoals: mock().mockResolvedValue([]),
			},
		} as unknown as IAgentRuntime;

		const roomId = "test-room" as UUID;

		await getGoals({ runtime: mockRuntime, roomId });

		expect(mockRuntime.getDatabaseAdapter().getGoals).toHaveBeenCalledWith({
			agentId: "test-agent-id",
			roomId,
			onlyInProgress: true,
			count: 5,
		});
	});
});

describe("formatGoalsAsString", () => {
	beforeEach(() => {
		mockDatabaseAdapter.getGoals.mockReset();
		mockDatabaseAdapter.updateGoal.mockReset();
		mockDatabaseAdapter.createGoal.mockReset();
	});

	it("formats goals correctly", () => {
		const formatted = formatGoalsAsString({ goals: [sampleGoal] });
		expect(formatted).toContain("Goal: Test Goal");
		expect(formatted).toContain("- [ ] Objective 1  (IN PROGRESS)");
		expect(formatted).toContain("- [x] Objective 2  (DONE)");
	});

	it("handles empty goals array", () => {
		const formatted = formatGoalsAsString({ goals: [] });
		expect(formatted).toBe("");
	});

	it("should format goals as string correctly", () => {
		const goals: Goal[] = [
			{
				id: "1" as UUID,
				name: "Goal 1",
				status: GoalStatus.IN_PROGRESS,
				objectives: [
					{
						id: "obj1" as UUID,
						description: "Objective 1",
						completed: true,
					},
					{
						id: "obj2" as UUID,
						description: "Objective 2",
						completed: false,
					},
				],
				roomId: "test-room" as UUID,
				userId: "test-user" as UUID,
			},
			{
				id: "2" as UUID,
				name: "Goal 2",
				status: GoalStatus.DONE,
				objectives: [
					{
						id: "obj3" as UUID,
						description: "Objective 3",
						completed: true,
					},
				],
				roomId: "test-room" as UUID,
				userId: "test-user" as UUID,
			},
		];

		const formattedGoals = formatGoalsAsString({ goals });
		expect(formattedGoals).toContain("Goal: Goal 1");
		expect(formattedGoals).toContain("id: 1");
		expect(formattedGoals).toContain("- [x] Objective 1  (DONE)");
		expect(formattedGoals).toContain("- [ ] Objective 2  (IN PROGRESS)");
		expect(formattedGoals).toContain("Goal: Goal 2");
		expect(formattedGoals).toContain("id: 2");
		expect(formattedGoals).toContain("- [x] Objective 3  (DONE)");
	});
});

describe("updateGoal", () => {
	beforeEach(() => {
		mockDatabaseAdapter.getGoals.mockReset();
		mockDatabaseAdapter.updateGoal.mockReset();
		mockDatabaseAdapter.createGoal.mockReset();
	});

	it("updates a goal successfully", async () => {
		mockDatabaseAdapter.updateGoal.mockResolvedValue(undefined);

		await expect(
			updateGoal({ runtime: mockRuntime, goal: sampleGoal }),
		).resolves.not.toThrow();

		expect(mockDatabaseAdapter.updateGoal).toHaveBeenCalledWith(sampleGoal);
	});

	it("handles errors when updating a goal", async () => {
		mockDatabaseAdapter.updateGoal.mockRejectedValue(
			new Error("Failed to update goal"),
		);

		await expect(
			updateGoal({ runtime: mockRuntime, goal: sampleGoal }),
		).rejects.toThrow("Failed to update goal");
	});

	it("should update goal status correctly", async () => {
		const goalId = "test-goal" as UUID;
		const mockRuntime = {
			databaseAdapter: { updateGoal: mock() },
			agentId: "test-agent-id" as UUID,
		} as unknown as IAgentRuntime;

		const updatedGoal: Goal = {
			id: goalId,
			name: "Test Goal",
			objectives: [
				{
					description: "Objective 1",
					completed: false,
				},
				{
					description: "Objective 2",
					completed: true,
				},
			],
			roomId: "room-id" as UUID,
			userId: "user-id" as UUID,
			status: GoalStatus.DONE,
		};

		await updateGoal({
			runtime: mockRuntime,
			goal: updatedGoal,
		});

		expect(mockRuntime.getDatabaseAdapter().updateGoal).toHaveBeenCalledWith(
			updatedGoal,
		);
	});

	it("should handle failed goal update", async () => {
		const goalId = "test-goal" as UUID;
		const mockRuntime = {
			databaseAdapter: { updateGoal: mock() },
			agentId: "test-agent-id" as UUID,
		} as unknown as IAgentRuntime;

		const updatedGoal: Goal = {
			id: goalId,
			name: "Test Goal",
			objectives: [
				{
					description: "Objective 1",
					completed: false,
				},
				{
					description: "Objective 2",
					completed: true,
				},
			],
			roomId: "room-id" as UUID,
			userId: "user-id" as UUID,
			status: GoalStatus.FAILED,
		};

		await updateGoal({
			runtime: mockRuntime,
			goal: updatedGoal,
		});

		expect(mockRuntime.getDatabaseAdapter().updateGoal).toHaveBeenCalledWith(
			updatedGoal,
		);
	});

	it("should handle in-progress goal update", async () => {
		const goalId = "test-goal" as UUID;
		const mockRuntime = {
			databaseAdapter: { updateGoal: mock() },
			agentId: "test-agent-id" as UUID,
		} as unknown as IAgentRuntime;

		const updatedGoal: Goal = {
			id: goalId,
			name: "Test Goal",
			objectives: [
				{
					description: "Objective 1",
					completed: false,
				},
				{
					description: "Objective 2",
					completed: true,
				},
			],
			roomId: "room-id" as UUID,
			userId: "user-id" as UUID,
			status: GoalStatus.IN_PROGRESS,
		};

		await updateGoal({
			runtime: mockRuntime,
			goal: updatedGoal,
		});

		expect(mockRuntime.getDatabaseAdapter().updateGoal).toHaveBeenCalledWith(
			updatedGoal,
		);
	});

	it("should handle goal priority updates", async () => {
		const goalId = "test-goal" as UUID;
		const mockRuntime = {
			databaseAdapter: { updateGoal: mock() },
			agentId: "test-agent-id" as UUID,
		} as unknown as IAgentRuntime;

		const updatedGoal: Goal = {
			id: goalId,
			name: "Test Goal",
			objectives: [
				{
					description: "Objective 1",
					completed: false,
				},
				{
					description: "Objective 2",
					completed: true,
				},
			],
			roomId: "room-id" as UUID,
			userId: "user-id" as UUID,
			status: GoalStatus.IN_PROGRESS,
		};

		await updateGoal({
			runtime: mockRuntime,
			goal: updatedGoal,
		});

		expect(mockRuntime.getDatabaseAdapter().updateGoal).toHaveBeenCalledWith(
			updatedGoal,
		);
	});
});

describe("createGoal", () => {
	beforeEach(() => {
		mockDatabaseAdapter.getGoals.mockReset();
		mockDatabaseAdapter.updateGoal.mockReset();
		mockDatabaseAdapter.createGoal.mockReset();
	});

	it("creates a goal successfully", async () => {
		mockDatabaseAdapter.createGoal.mockResolvedValue(undefined);

		await expect(
			createGoal({ runtime: mockRuntime, goal: sampleGoal }),
		).resolves.not.toThrow();

		expect(mockDatabaseAdapter.createGoal).toHaveBeenCalledWith(sampleGoal);
	});

	it("handles errors when creating a goal", async () => {
		mockDatabaseAdapter.createGoal.mockRejectedValue(
			new Error("Failed to create goal"),
		);

		await expect(
			createGoal({ runtime: mockRuntime, goal: sampleGoal }),
		).rejects.toThrow("Failed to create goal");
	});

	it("should create new goal with correct properties", async () => {
		const newGoal: Goal = {
			name: "New Goal",
			roomId: "room-id" as UUID,
			userId: "user-id" as UUID,
			status: GoalStatus.IN_PROGRESS,
			objectives: [],
		};

		const mockRuntime = {
			databaseAdapter: { createGoal: mock() },
			agentId: "test-agent-id" as UUID,
		} as unknown as IAgentRuntime;

		await createGoal({
			runtime: mockRuntime,
			goal: newGoal,
		});

		expect(mockRuntime.getDatabaseAdapter().createGoal).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "New Goal",
				roomId: "room-id",
				userId: "user-id",
				status: GoalStatus.IN_PROGRESS,
				objectives: [],
			}),
		);
	});

	it("should create a new goal", async () => {
		const mockRuntime = {
			databaseAdapter: { createGoal: mock() },
			agentId: "test-agent-id" as UUID,
		} as unknown as IAgentRuntime;

		const newGoal = {
			id: "new-goal" as UUID,
			name: "New Goal",
			objectives: [],
			roomId: "test-room" as UUID,
			userId: "test-user" as UUID,
			status: GoalStatus.IN_PROGRESS,
		};

		await createGoal({
			runtime: mockRuntime,
			goal: newGoal,
		});

		expect(mockRuntime.getDatabaseAdapter().createGoal).toHaveBeenCalledWith(
			newGoal,
		);
	});
});
