import {
    getGoals,
    formatGoalsAsString,
    updateGoal,
    createGoal,
} from "../src/goals.ts";
import {
    type Goal,
    GoalStatus,
    type IAgentRuntime,
    type Memory,
    type State,
    type UUID,
    type Service,
    type ServiceType,
} from "../src/types.ts";
import { CacheManager, MemoryCacheAdapter } from "../src/cache.ts";
import { describe, expect, vi, beforeEach } from "vitest";

// Mock the database adapter
export const mockDatabaseAdapter = {
    getGoals: vi.fn(),
    updateGoal: vi.fn(),
    createGoal: vi.fn(),
};

const services = new Map<ServiceType, Service>();

// Mock the runtime
export const mockRuntime: IAgentRuntime = {
    databaseAdapter: mockDatabaseAdapter as any,
    cacheManager: new CacheManager(new MemoryCacheAdapter()),
    agentId: "qweqew-qweqwe-qweqwe-qweqwe-qweeqw",
    messageManager: {
        addEmbeddingToMemory: (_memory: Memory): Promise<Memory> => {
            throw new Error("Function not implemented.");
        },
        getMemories: (_opts: {
            roomId: UUID;
            count?: number;
            unique?: boolean;
            agentId?: UUID;
            start?: number;
            end?: number;
        }): Promise<Memory[]> => {
            throw new Error("Function not implemented.");
        },
        getCachedEmbeddings: (
            _content: string
        ): Promise<{ embedding: number[]; levenshtein_score: number }[]> => {
            throw new Error("Function not implemented.");
        },
        getMemoryById: (_id: UUID): Promise<Memory | null> => {
            throw new Error("Function not implemented.");
        },
        getMemoriesByRoomIds: (_params: {
            roomIds: UUID[];
            agentId?: UUID;
        }): Promise<Memory[]> => {
            throw new Error("Function not implemented.");
        },
        createMemory: (
            _memory: Memory,
            _unique?: boolean
        ): Promise<void> => {
            throw new Error("Function not implemented.");
        },
        removeMemory: (_memoryId: UUID): Promise<void> => {
            throw new Error("Function not implemented.");
        },
        removeAllMemories: (_roomId: UUID): Promise<void> => {
            throw new Error("Function not implemented.");
        },
        countMemories: (
            _roomId: UUID,
            _unique?: boolean
        ): Promise<number> => {
            throw new Error("Function not implemented.");
        },
    },
    descriptionManager: {
        addEmbeddingToMemory: (_memory: Memory): Promise<Memory> => {
            throw new Error("Function not implemented.");
        },
        getMemories: (_opts: {
            roomId: UUID;
            count?: number;
            unique?: boolean;
            agentId?: UUID;
            start?: number;
            end?: number;
        }): Promise<Memory[]> => {
            throw new Error("Function not implemented.");
        },
        getCachedEmbeddings: (
            _content: string
        ): Promise<{ embedding: number[]; levenshtein_score: number }[]> => {
            throw new Error("Function not implemented.");
        },
        getMemoryById: (_id: UUID): Promise<Memory | null> => {
            throw new Error("Function not implemented.");
        },
        getMemoriesByRoomIds: (_params: {
            roomIds: UUID[];
            agentId?: UUID;
        }): Promise<Memory[]> => {
            throw new Error("Function not implemented.");
        },
        createMemory: (
            _memory: Memory,
            _unique?: boolean
        ): Promise<void> => {
            throw new Error("Function not implemented.");
        },
        removeMemory: (_memoryId: UUID): Promise<void> => {
            throw new Error("Function not implemented.");
        },
        removeAllMemories: (_roomId: UUID): Promise<void> => {
            throw new Error("Function not implemented.");
        },
        countMemories: (
            _roomId: UUID,
            _unique?: boolean
        ): Promise<number> => {
            throw new Error("Function not implemented.");
        },
    },
    loreManager: {
        addEmbeddingToMemory: (_memory: Memory): Promise<Memory> => {
            throw new Error("Function not implemented.");
        },
        getMemories: (_opts: {
            roomId: UUID;
            count?: number;
            unique?: boolean;
            agentId?: UUID;
            start?: number;
            end?: number;
        }): Promise<Memory[]> => {
            throw new Error("Function not implemented.");
        },
        getCachedEmbeddings: (
            _content: string
        ): Promise<{ embedding: number[]; levenshtein_score: number }[]> => {
            throw new Error("Function not implemented.");
        },
        getMemoryById: (_id: UUID): Promise<Memory | null> => {
            throw new Error("Function not implemented.");
        },
        getMemoriesByRoomIds: (_params: {
            roomIds: UUID[];
            agentId?: UUID;
        }): Promise<Memory[]> => {
            throw new Error("Function not implemented.");
        },
        createMemory: (
            _memory: Memory,
            _unique?: boolean
        ): Promise<void> => {
            throw new Error("Function not implemented.");
        },
        removeMemory: (_memoryId: UUID): Promise<void> => {
            throw new Error("Function not implemented.");
        },
        removeAllMemories: (_roomId: UUID): Promise<void> => {
            throw new Error("Function not implemented.");
        },
        countMemories: (
            _roomId: UUID,
            _unique?: boolean
        ): Promise<number> => {
            throw new Error("Function not implemented.");
        },
    },
    ensureRoomExists: (_roomId: UUID): Promise<void> => {
        throw new Error("Function not implemented.");
    },
    composeState: (
        _message: Memory,
        _additionalKeys?: { [key: string]: unknown }
    ): Promise<State> => {
        throw new Error("Function not implemented.");
    },
    updateRecentMessageState: (_state: State): Promise<State> => {
        throw new Error("Function not implemented.");
    },
    getService: <T extends Service>(
        serviceType: ServiceType
    ): T | null => (services.get(serviceType) as T) || null,
    plugins: [],
    initialize: (): Promise<void> => {
        throw new Error("Function not implemented.");
    },
};

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
    let runtime: IAgentRuntime;

    beforeEach(() => {
        runtime = {
            agentId: "test-agent-id" as UUID,
            databaseAdapter: {
                getGoals: vi.fn().mockResolvedValue([]),
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
                getGoals: vi.fn().mockResolvedValue([]),
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
        vi.clearAllMocks();
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
        vi.clearAllMocks();
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
            databaseAdapter: { updateGoal: vi.fn() },
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
            databaseAdapter: { updateGoal: vi.fn() },
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
            databaseAdapter: { updateGoal: vi.fn() },
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
            databaseAdapter: { updateGoal: vi.fn() },
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
        vi.clearAllMocks();
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
            databaseAdapter: { createGoal: vi.fn() },
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
            databaseAdapter: { createGoal: vi.fn() },
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
