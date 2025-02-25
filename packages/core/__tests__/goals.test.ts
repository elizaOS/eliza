import { beforeEach, describe, expect, it, mock } from "bun:test";
import { CacheManager, MemoryCacheAdapter } from "../src/cache.ts";
import {
    createGoal,
    formatGoalsAsString,
    getGoals,
    updateGoal,
} from "../src/goals.ts";
import {
    Action,
    ChannelType,
    type Character,
    Client,
    type Goal,
    GoalStatus,
    HandlerCallback,
    type IAgentRuntime,
    type IMemoryManager,
    type Memory,
    ModelClass,
    Provider,
    RoomData,
    type Service,
    type ServiceType,
    type State,
    Task,
    type UUID,
    WorldData
} from "../src/types.ts";

// Mock the database adapter
export const mockDatabaseAdapter = {
    getGoals: mock(),
    updateGoal: mock(),
    createGoal: mock(),
};

const services = new Map<ServiceType, Service>();

// Create memory managers first
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
export const mockRuntime: IAgentRuntime = {
    databaseAdapter: mockDatabaseAdapter as any,
    cacheManager: new CacheManager(new MemoryCacheAdapter()),
    agentId: "qweqew-qweqwe-qweqwe-qweqwe-qweeqw",
    messageManager,
    descriptionManager,
    ensureRoomExists: async () => { },
    composeState: async () => ({} as State),
    updateRecentMessageState: async (s) => s,
    getService: () => null,
    plugins: [],
    initialize: async () => { },
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
    registerClient: async () => { },
    unregisterClient: async () => { },
    registerMemoryManager: () => { },
    getMemoryManager: () => null,
    getModel: () => undefined,
    events: new Map(),
    registerClientInterface: function (name: string, client: Client): void {
        throw new Error("Function not implemented.");
    },
    transformUserId: function (userId: UUID): UUID {
        throw new Error("Function not implemented.");
    },
    registerService: function (service: Service): void {
        throw new Error("Function not implemented.");
    },
    setSetting: function (key: string, value: string | boolean | null | any, secret: boolean): void {
        throw new Error("Function not implemented.");
    },
    getSetting: function (key: string) {
        throw new Error("Function not implemented.");
    },
    getConversationLength: function (): number {
        throw new Error("Function not implemented.");
    },
    processActions: function (message: Memory, responses: Memory[], state?: State, callback?: HandlerCallback): Promise<void> {
        throw new Error("Function not implemented.");
    },
    evaluate: function (message: Memory, state?: State, didRespond?: boolean, callback?: HandlerCallback): Promise<string[] | null> {
        throw new Error("Function not implemented.");
    },
    getOrCreateUser: function (userId: UUID, userName: string | null, name: string | null, source: string | null): Promise<UUID> {
        throw new Error("Function not implemented.");
    },
    registerProvider: function (provider: Provider): void {
        throw new Error("Function not implemented.");
    },
    registerAction: function (action: Action): void {
        throw new Error("Function not implemented.");
    },
    ensureConnection: function ({ userId, roomId, userName, userScreenName, source, channelId, serverId, type, }: { userId: UUID; roomId: UUID; userName?: string; userScreenName?: string; source?: string; channelId?: string; serverId?: string; type: ChannelType; }): Promise<void> {
        throw new Error("Function not implemented.");
    },
    ensureParticipantInRoom: function (userId: UUID, roomId: UUID): Promise<void> {
        throw new Error("Function not implemented.");
    },
    getWorld: function (worldId: UUID): Promise<WorldData | null> {
        throw new Error("Function not implemented.");
    },
    ensureWorldExists: function ({ id, name, serverId, }: WorldData): Promise<void> {
        throw new Error("Function not implemented.");
    },
    getRoom: function (roomId: UUID): Promise<RoomData | null> {
        throw new Error("Function not implemented.");
    },
    registerModel: function (modelClass: ModelClass, handler: (params: any) => Promise<any>): void {
        throw new Error("Function not implemented.");
    },
    registerEvent: function (event: string, handler: (params: any) => void): void {
        throw new Error("Function not implemented.");
    },
    getEvent: function (event: string): ((params: any) => void)[] | undefined {
        throw new Error("Function not implemented.");
    },
    emitEvent: function (event: string | string[], params: any): void {
        throw new Error("Function not implemented.");
    },
    registerTask: function (task: Task): UUID {
        throw new Error("Function not implemented.");
    },
    getTasks: function ({ roomId, tags, }: { roomId?: UUID; tags?: string[]; }): Task[] | undefined {
        throw new Error("Function not implemented.");
    },
    getTask: function (id: UUID): Task | undefined {
        throw new Error("Function not implemented.");
    },
    updateTask: function (id: UUID, task: Task): void {
        throw new Error("Function not implemented.");
    },
    deleteTask: function (id: UUID): void {
        throw new Error("Function not implemented.");
    },
    stop: function (): Promise<void> {
        throw new Error("Function not implemented.");
    },
    ensureAgentExists: function (): Promise<void> {
        throw new Error("Function not implemented.");
    },
    ensureEmbeddingDimension: function (): Promise<void> {
        throw new Error("Function not implemented.");
    },
    ensureCharacterExists: function (character: Character): Promise<void> {
        throw new Error("Function not implemented.");
    }
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
            new Error("Failed to retrieve goals")
        );

        await expect(
            getGoals({
                runtime: mockRuntime,
                roomId: "room-id" as UUID,
            })
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

        expect(mockRuntime.databaseAdapter.getGoals).toHaveBeenCalledWith({
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
            updateGoal({ runtime: mockRuntime, goal: sampleGoal })
        ).resolves.not.toThrow();

        expect(mockDatabaseAdapter.updateGoal).toHaveBeenCalledWith(sampleGoal);
    });

    it("handles errors when updating a goal", async () => {
        mockDatabaseAdapter.updateGoal.mockRejectedValue(
            new Error("Failed to update goal")
        );

        await expect(
            updateGoal({ runtime: mockRuntime, goal: sampleGoal })
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

        expect(mockRuntime.databaseAdapter.updateGoal).toHaveBeenCalledWith(
            updatedGoal
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

        expect(mockRuntime.databaseAdapter.updateGoal).toHaveBeenCalledWith(
            updatedGoal
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

        expect(mockRuntime.databaseAdapter.updateGoal).toHaveBeenCalledWith(
            updatedGoal
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

        expect(mockRuntime.databaseAdapter.updateGoal).toHaveBeenCalledWith(
            updatedGoal
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
            createGoal({ runtime: mockRuntime, goal: sampleGoal })
        ).resolves.not.toThrow();

        expect(mockDatabaseAdapter.createGoal).toHaveBeenCalledWith(sampleGoal);
    });

    it("handles errors when creating a goal", async () => {
        mockDatabaseAdapter.createGoal.mockRejectedValue(
            new Error("Failed to create goal")
        );

        await expect(
            createGoal({ runtime: mockRuntime, goal: sampleGoal })
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

        expect(mockRuntime.databaseAdapter.createGoal).toHaveBeenCalledWith(
            expect.objectContaining({
                name: "New Goal",
                roomId: "room-id",
                userId: "user-id",
                status: GoalStatus.IN_PROGRESS,
                objectives: [],
            })
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

        expect(mockRuntime.databaseAdapter.createGoal).toHaveBeenCalledWith(
            newGoal
        );
    });
});
