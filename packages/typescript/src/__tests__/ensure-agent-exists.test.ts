import { v4 as uuidv4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Agent, Character, IDatabaseAdapter, UUID } from "../types";

// Helper type for vitest mocks with additional methods
interface VitestMockFunction<T extends (...args: never[]) => unknown> {
  (...args: Parameters<T>): ReturnType<T>;
  mockResolvedValueOnce: (
    value: Awaited<ReturnType<T>>,
  ) => VitestMockFunction<T>;
  mockResolvedValue: (value: Awaited<ReturnType<T>>) => VitestMockFunction<T>;
  mock: {
    calls: Parameters<T>[][];
    results: ReturnType<T>[];
  };
}

describe("ensureAgentExists - Settings Persistence", () => {
  let runtime: AgentRuntime;
  let mockAdapter: IDatabaseAdapter;
  let testCharacter: Character;
  let agentId: UUID;
  let getAgentMock: IDatabaseAdapter["getAgent"];
  let updateAgentMock: IDatabaseAdapter["updateAgent"];
  let getEntitiesByIdsMock: IDatabaseAdapter["getEntitiesByIds"];
  let getRoomsByIdsMock: IDatabaseAdapter["getRoomsByIds"];
  let getParticipantsForRoomMock: IDatabaseAdapter["getParticipantsForRoom"];
  let createEntitiesMock: IDatabaseAdapter["createEntities"];
  let createRoomsMock: IDatabaseAdapter["createRooms"];
  let addParticipantsRoomMock: IDatabaseAdapter["addParticipantsRoom"];

  beforeEach(() => {
    agentId = uuidv4() as UUID;

    testCharacter = {
      id: agentId,
      name: "TestAgent",
      username: "testagent",
      bio: [],
      templates: {},
      messageExamples: [],
      postExamples: [],
      topics: [],
      style: { all: [], chat: [], post: [] },
      adjectives: [],
      knowledge: [],
      plugins: [],
      secrets: {},
      settings: {
        MODEL: "gpt-4",
        TEMPERATURE: "0.7",
      },
    };

    // Create mock adapter with proper types using vi.fn()
    getAgentMock = vi.fn(async () => null) as IDatabaseAdapter["getAgent"];
    updateAgentMock = vi.fn(
      async () => true,
    ) as IDatabaseAdapter["updateAgent"];
    getEntitiesByIdsMock = vi.fn(
      async () => [],
    ) as IDatabaseAdapter["getEntitiesByIds"];
    getRoomsByIdsMock = vi.fn(
      async () => [],
    ) as IDatabaseAdapter["getRoomsByIds"];
    getParticipantsForRoomMock = vi.fn(
      async () => [],
    ) as IDatabaseAdapter["getParticipantsForRoom"];
    createEntitiesMock = vi.fn(
      async () => true,
    ) as IDatabaseAdapter["createEntities"];
    createRoomsMock = vi.fn(async () => []) as IDatabaseAdapter["createRooms"];
    addParticipantsRoomMock = vi.fn(
      async () => true,
    ) as IDatabaseAdapter["addParticipantsRoom"];

    mockAdapter = {
      db: {},
      init: vi.fn(async () => {}),
      initialize: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      isReady: vi.fn(async () => true),
      getConnection: vi.fn(async () => ({})),
      getAgent: getAgentMock,
      getAgents: vi.fn(async () => []),
      createAgent: vi.fn(async () => true),
      updateAgent: updateAgentMock,
      deleteAgent: vi.fn(async () => true),
      ensureEmbeddingDimension: vi.fn(async () => {}),
      log: vi.fn(async () => {}),
      runPluginMigrations: vi.fn(async () => {}),
      getEntitiesByIds: getEntitiesByIdsMock,
      getRoomsByIds: getRoomsByIdsMock,
      getParticipantsForRoom: getParticipantsForRoomMock,
      createEntities: createEntitiesMock,
      addParticipantsRoom: addParticipantsRoomMock,
      createRooms: createRoomsMock,
      // Add other required methods with minimal implementations
      getEntitiesForRoom: vi.fn(async () => []),
      updateEntity: vi.fn(async () => {}),
      getComponent: vi.fn(async () => null),
      getComponents: vi.fn(async () => []),
      createComponent: vi.fn(async () => true),
      updateComponent: vi.fn(async () => {}),
      deleteComponent: vi.fn(async () => {}),
      getMemories: vi.fn(async () => []),
      getMemoryById: vi.fn(async () => null),
      getMemoriesByIds: vi.fn(async () => []),
      getMemoriesByRoomIds: vi.fn(async () => []),
      getCachedEmbeddings: vi.fn(async () => []),
      getLogs: vi.fn(async () => []),
      deleteLog: vi.fn(async () => {}),
      searchMemories: vi.fn(async () => []),
      createMemory: vi.fn(async () => "memory-id" as UUID),
      updateMemory: vi.fn(async () => true),
      deleteMemory: vi.fn(async () => {}),
      deleteManyMemories: vi.fn(async () => {}),
      deleteAllMemories: vi.fn(async () => {}),
      countMemories: vi.fn(async () => 0),
      createWorld: vi.fn(async () => "world-id" as UUID),
      getWorld: vi.fn(async () => null),
      getAllWorlds: vi.fn(async () => []),
      updateWorld: vi.fn(async () => {}),
      removeWorld: vi.fn(async () => {}),
      getRoomsByWorld: vi.fn(async () => []),
      updateRoom: vi.fn(async () => {}),
      deleteRoom: vi.fn(async () => {}),
      deleteRoomsByWorldId: vi.fn(async () => {}),
      getRoomsForParticipant: vi.fn(async () => []),
      getRoomsForParticipants: vi.fn(async () => []),
      removeParticipant: vi.fn(async () => true),
      getParticipantsForEntity: vi.fn(async () => []),
      isRoomParticipant: vi.fn(async () => false),
      getParticipantUserState: vi.fn(async () => null),
      setParticipantUserState: vi.fn(async () => {}),
      createRelationship: vi.fn(async () => true),
      getRelationship: vi.fn(async () => null),
      getRelationships: vi.fn(async () => []),
      updateRelationship: vi.fn(async () => {}),
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(async () => true),
      deleteCache: vi.fn(async () => true),
      createTask: vi.fn(async () => "task-id" as UUID),
      getTasks: vi.fn(async () => []),
      getTask: vi.fn(async () => null),
      getTasksByName: vi.fn(async () => []),
      updateTask: vi.fn(async () => {}),
      deleteTask: vi.fn(async () => {}),
      getMemoriesByWorldId: vi.fn(async () => []),
    } as IDatabaseAdapter;

    runtime = new AgentRuntime({
      character: testCharacter,
      adapter: mockAdapter,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should create a new agent when none exists in DB", async () => {
    const agent: Partial<Agent> = {
      id: agentId,
      name: "TestAgent",
      settings: {
        MODEL: "gpt-4",
      },
    };

    const result = await runtime.ensureAgentExists(agent);

    expect(mockAdapter.getAgent).toHaveBeenCalledWith(agentId);
    expect(mockAdapter.createAgent).toHaveBeenCalled();
    expect(result.id).toBe(agentId);
  });

  it("should merge DB settings with character.json settings on restart", async () => {
    // Simulate DB state with persisted runtime secrets
    const existingAgentInDB: Agent = {
      id: agentId,
      name: "TestAgent",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bio: [],
      settings: {
        SOLANA_PUBLIC_KEY: "CioDPgLA1o8cuuhXZ7M3Fi1Lzqo2Cr8VudjY6ErtvYp4",
        secrets: {
          SOLANA_PRIVATE_KEY: "4zkwqei5hFqtHvqGTMFC6FDCBSPoJqTqN3v7pNDYrqFY...",
        },
        OLD_SETTING: "should_be_kept",
      },
    } as Agent;

    (
      getAgentMock as VitestMockFunction<IDatabaseAdapter["getAgent"]>
    ).mockResolvedValueOnce(existingAgentInDB);
    (
      getAgentMock as VitestMockFunction<IDatabaseAdapter["getAgent"]>
    ).mockResolvedValueOnce({
      ...existingAgentInDB,
      settings: {
        SOLANA_PUBLIC_KEY: "CioDPgLA1o8cuuhXZ7M3Fi1Lzqo2Cr8VudjY6ErtvYp4",
        MODEL: "gpt-4",
        TEMPERATURE: "0.7",
        secrets: {
          SOLANA_PRIVATE_KEY: "4zkwqei5hFqtHvqGTMFC6FDCBSPoJqTqN3v7pNDYrqFY...",
        },
        OLD_SETTING: "should_be_kept",
      },
    });

    // Character file has new settings but no wallet keys
    const characterAgent: Partial<Agent> = {
      id: agentId,
      name: "TestAgent",
      settings: {
        MODEL: "gpt-4",
        TEMPERATURE: "0.7",
      },
    };

    const _result = await runtime.ensureAgentExists(characterAgent);

    // Verify updateAgent was called with merged settings
    expect(mockAdapter.updateAgent).toHaveBeenCalled();
    const updateCall = (
      updateAgentMock as VitestMockFunction<IDatabaseAdapter["updateAgent"]>
    ).mock.calls[0];
    // updateAgent signature: (agentId: UUID, agent: Partial<Agent>) => Promise<boolean>
    // So updateCall[1] is Partial<Agent>
    const updatedAgent = updateCall[1] as Partial<Agent>;

    // Check that DB settings were preserved
    expect(updatedAgent.settings?.SOLANA_PUBLIC_KEY).toBe(
      "CioDPgLA1o8cuuhXZ7M3Fi1Lzqo2Cr8VudjY6ErtvYp4",
    );
    expect(updatedAgent.settings?.OLD_SETTING).toBe("should_be_kept");

    // Check that character.json settings were applied
    expect(updatedAgent.settings?.MODEL).toBe("gpt-4");
    expect(updatedAgent.settings?.TEMPERATURE).toBe("0.7");

    // Check that secrets were preserved
    const updatedAgentSettingsSecrets =
      updatedAgent.settings &&
      (updatedAgent.settings.secrets as Record<string, string> | undefined);
    expect(updatedAgentSettingsSecrets?.SOLANA_PRIVATE_KEY).toBe(
      "4zkwqei5hFqtHvqGTMFC6FDCBSPoJqTqN3v7pNDYrqFY...",
    );
  });

  it("should allow character.json to override DB settings", async () => {
    // DB has old MODEL value
    const existingAgentInDB: Agent = {
      id: agentId,
      name: "TestAgent",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bio: [],
      settings: {
        MODEL: "gpt-3.5-turbo",
        SOLANA_PUBLIC_KEY: "wallet123",
        secrets: {
          SOLANA_PRIVATE_KEY: "4zkwqei5hFqtHvqGTMFC6FDCBSPoJqTqN3v7pNDYrqFY...",
        },
      },
    } as Agent;

    (
      getAgentMock as VitestMockFunction<IDatabaseAdapter["getAgent"]>
    ).mockResolvedValueOnce(existingAgentInDB);
    (
      getAgentMock as VitestMockFunction<IDatabaseAdapter["getAgent"]>
    ).mockResolvedValueOnce({
      ...existingAgentInDB,
      settings: {
        MODEL: "gpt-4", // Updated by character.json
        SOLANA_PUBLIC_KEY: "wallet123", // Preserved from DB
        secrets: {
          SOLANA_PRIVATE_KEY: "4zkwqei5hFqtHvqGTMFC6FDCBSPoJqTqN3v7pNDYrqFY...",
        },
      },
    });

    // Character file has new MODEL value
    const characterAgent: Partial<Agent> = {
      id: agentId,
      name: "TestAgent",
      settings: {
        MODEL: "gpt-4", // This should override DB value
      },
    };

    await runtime.ensureAgentExists(characterAgent);

    const updateCall = (
      updateAgentMock as VitestMockFunction<IDatabaseAdapter["updateAgent"]>
    ).mock.calls[0];
    const updatedAgent = updateCall[1] as Partial<Agent>;

    // MODEL should be overridden by character.json
    expect(updatedAgent.settings?.MODEL).toBe("gpt-4");

    // But SOLANA_PUBLIC_KEY should be preserved from DB
    expect(updatedAgent.settings?.SOLANA_PUBLIC_KEY).toBe("wallet123");
  });

  it("should deep merge secrets from both DB and character.json", async () => {
    const existingAgentInDB: Agent = {
      id: agentId,
      name: "TestAgent",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bio: [],
      settings: {
        secrets: {
          RUNTIME_SECRET: "from_db",
          WALLET_KEY: "wallet_key_from_db",
        },
      },
    } as Agent;

    (
      getAgentMock as VitestMockFunction<IDatabaseAdapter["getAgent"]>
    ).mockResolvedValueOnce(existingAgentInDB);
    (
      getAgentMock as VitestMockFunction<IDatabaseAdapter["getAgent"]>
    ).mockResolvedValueOnce({
      ...existingAgentInDB,
      settings: {
        secrets: {
          RUNTIME_SECRET: "from_db",
          WALLET_KEY: "wallet_key_from_db",
          API_KEY: "from_character",
        },
      },
    });

    const characterAgent: Partial<Agent> = {
      id: agentId,
      name: "TestAgent",
      settings: {
        secrets: {
          API_KEY: "from_character",
        },
      },
    };

    await runtime.ensureAgentExists(characterAgent);

    const updateCall = (
      updateAgentMock as VitestMockFunction<IDatabaseAdapter["updateAgent"]>
    ).mock.calls[0];
    const updatedAgent = updateCall[1] as Partial<Agent>;

    // Both DB and character secrets should be present
    const updatedAgentSettings = updatedAgent.settings;
    const secrets =
      updatedAgentSettings &&
      (updatedAgentSettings.secrets as Record<string, string> | undefined);
    expect(secrets?.RUNTIME_SECRET).toBe("from_db");
    expect(secrets?.WALLET_KEY).toBe("wallet_key_from_db");
    expect(secrets?.API_KEY).toBe("from_character");
  });

  it("should handle agent with no settings in DB", async () => {
    const existingAgentInDB: Agent = {
      id: agentId,
      name: "TestAgent",
      // No settings field
    } as Agent;

    (
      getAgentMock as VitestMockFunction<IDatabaseAdapter["getAgent"]>
    ).mockResolvedValueOnce(existingAgentInDB);
    (
      getAgentMock as VitestMockFunction<IDatabaseAdapter["getAgent"]>
    ).mockResolvedValueOnce({
      ...existingAgentInDB,
      settings: {
        MODEL: "gpt-4",
      },
    });

    const characterAgent: Partial<Agent> = {
      id: agentId,
      name: "TestAgent",
      settings: {
        MODEL: "gpt-4",
      },
    };

    await runtime.ensureAgentExists(characterAgent);

    const updateCall = (
      updateAgentMock as VitestMockFunction<IDatabaseAdapter["updateAgent"]>
    ).mock.calls[0];
    const updatedAgent = updateCall[1] as Partial<Agent>;

    // Should have character settings even though DB had none
    expect(updatedAgent.settings?.MODEL).toBe("gpt-4");
  });

  it("should handle character with no settings", async () => {
    const existingAgentInDB: Agent = {
      id: agentId,
      name: "TestAgent",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bio: [],
      settings: {
        DB_SETTING: "value",
      },
    } as Agent;

    (
      getAgentMock as VitestMockFunction<IDatabaseAdapter["getAgent"]>
    ).mockResolvedValueOnce(existingAgentInDB);
    (
      getAgentMock as VitestMockFunction<IDatabaseAdapter["getAgent"]>
    ).mockResolvedValueOnce(existingAgentInDB);

    const characterAgent: Partial<Agent> = {
      id: agentId,
      name: "TestAgent",
      // No settings
    };

    await runtime.ensureAgentExists(characterAgent);

    const updateCall = (
      updateAgentMock as VitestMockFunction<IDatabaseAdapter["updateAgent"]>
    ).mock.calls[0];
    const updatedAgent = updateCall[1] as Partial<Agent>;

    // Should preserve DB settings
    expect(updatedAgent.settings?.DB_SETTING).toBe("value");
  });

  it("should throw error if agent id is not provided", async () => {
    const agent: Partial<Agent> = {
      name: "TestAgent",
    };

    await expect(runtime.ensureAgentExists(agent)).rejects.toThrow(
      "Agent id is required",
    );
  });

  describe("runtime.initialize() integration", () => {
    it("should load DB-persisted settings into runtime.character after initialization", async () => {
      // Simulate DB with persisted wallet keys
      const dbAgent = {
        id: agentId,
        name: "TestAgent",
        bio: [],
        templates: {},
        messageExamples: [],
        postExamples: [],
        topics: [],
        adjectives: [],
        knowledge: [],
        plugins: [],
        secrets: {
          SOLANA_PRIVATE_KEY: "secret_from_db",
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        settings: {
          SOLANA_PUBLIC_KEY: "wallet_from_db",
          RUNTIME_SETTING: "from_previous_run",
        },
      } as Agent;

      // Mock getAgent to return DB agent on first call (ensureAgentExists)
      // and updated agent on second call (after update)
      (getAgentMock as VitestMockFunction<IDatabaseAdapter["getAgent"]>)
        .mockResolvedValueOnce(dbAgent)
        .mockResolvedValueOnce({
          ...dbAgent,
          settings: {
            ...dbAgent.settings,
            MODEL: "gpt-4", // Added from character file
          },
        });

      // Character file has different settings
      const character: Character = {
        id: agentId,
        name: "TestAgent",
        username: "test",
        bio: [],
        templates: {},
        messageExamples: [],
        postExamples: [],
        topics: [],
        style: { all: [], chat: [], post: [] },
        adjectives: [],
        knowledge: [],
        plugins: [],
        secrets: {},
        settings: {
          MODEL: "gpt-4", // New setting from character file
        },
      };

      // Create new runtime with character file settings
      const testRuntime = new AgentRuntime({
        character,
        adapter: mockAdapter,
      });

      // Before initialize, character should only have file settings
      expect(testRuntime.character.settings?.SOLANA_PUBLIC_KEY).toBeUndefined();
      expect(testRuntime.character.settings?.MODEL).toBe("gpt-4");

      // Mock the services that initialize() expects
      (
        getEntitiesByIdsMock as VitestMockFunction<
          IDatabaseAdapter["getEntitiesByIds"]
        >
      ).mockResolvedValue([
        { id: agentId, names: ["TestAgent"], metadata: {}, agentId },
      ]);
      (
        getRoomsByIdsMock as VitestMockFunction<
          IDatabaseAdapter["getRoomsByIds"]
        >
      ).mockResolvedValue([]);
      (
        getParticipantsForRoomMock as VitestMockFunction<
          IDatabaseAdapter["getParticipantsForRoom"]
        >
      ).mockResolvedValue([]);
      (
        createEntitiesMock as VitestMockFunction<
          IDatabaseAdapter["createEntities"]
        >
      ).mockResolvedValue(true);
      (
        createRoomsMock as VitestMockFunction<IDatabaseAdapter["createRooms"]>
      ).mockResolvedValue([agentId]);
      (
        addParticipantsRoomMock as VitestMockFunction<
          IDatabaseAdapter["addParticipantsRoom"]
        >
      ).mockResolvedValue(true);

      // Initialize runtime (should load DB settings into character)
      await testRuntime.initialize();

      // After initialize, character should have BOTH DB and file settings
      const testRuntimeCharacterSettings = testRuntime.character.settings;
      expect(testRuntimeCharacterSettings?.SOLANA_PUBLIC_KEY).toBe(
        "wallet_from_db",
      );
      expect(testRuntimeCharacterSettings?.RUNTIME_SETTING).toBe(
        "from_previous_run",
      );
      expect(testRuntimeCharacterSettings?.MODEL).toBe("gpt-4"); // Character file wins
      expect(testRuntime.character.secrets?.SOLANA_PRIVATE_KEY).toBe(
        "secret_from_db",
      );

      // Verify getSetting() can now access DB settings
      expect(testRuntime.getSetting("SOLANA_PUBLIC_KEY")).toBe(
        "wallet_from_db",
      );
      expect(testRuntime.getSetting("SOLANA_PRIVATE_KEY")).toBe(
        "secret_from_db",
      );
      expect(testRuntime.getSetting("RUNTIME_SETTING")).toBe(
        "from_previous_run",
      );
    });

    it("should preserve character file settings when merging with DB", async () => {
      const dbAgent: Agent = {
        id: agentId,
        name: "TestAgent",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        bio: [],
        settings: {
          MODEL: "gpt-3.5-turbo", // Old value in DB
          DB_ONLY_SETTING: "keep_me",
        },
      } as Agent;

      (getAgentMock as VitestMockFunction<IDatabaseAdapter["getAgent"]>)
        .mockResolvedValueOnce(dbAgent)
        .mockResolvedValueOnce({
          ...dbAgent,
          settings: {
            MODEL: "gpt-4", // Updated by character file
            DB_ONLY_SETTING: "keep_me",
          },
        });

      const character: Character = {
        id: agentId,
        name: "TestAgent",
        username: "test",
        bio: [],
        messageExamples: [],
        postExamples: [],
        topics: [],
        style: { all: [], chat: [], post: [] },
        adjectives: [],
        settings: {
          MODEL: "gpt-4", // New value in character file
        },
      };

      const testRuntime = new AgentRuntime({
        character,
        adapter: mockAdapter,
      });

      (
        getEntitiesByIdsMock as VitestMockFunction<
          IDatabaseAdapter["getEntitiesByIds"]
        >
      ).mockResolvedValue([
        { id: agentId, names: ["TestAgent"], metadata: {}, agentId },
      ]);
      (
        getRoomsByIdsMock as VitestMockFunction<
          IDatabaseAdapter["getRoomsByIds"]
        >
      ).mockResolvedValue([]);
      (
        getParticipantsForRoomMock as VitestMockFunction<
          IDatabaseAdapter["getParticipantsForRoom"]
        >
      ).mockResolvedValue([]);
      (
        createEntitiesMock as VitestMockFunction<
          IDatabaseAdapter["createEntities"]
        >
      ).mockResolvedValue(true);
      (
        createRoomsMock as VitestMockFunction<IDatabaseAdapter["createRooms"]>
      ).mockResolvedValue([agentId]);
      (
        addParticipantsRoomMock as VitestMockFunction<
          IDatabaseAdapter["addParticipantsRoom"]
        >
      ).mockResolvedValue(true);

      await testRuntime.initialize();

      // Character file value should override DB
      expect(testRuntime.getSetting("MODEL")).toBe("gpt-4");
      // DB-only setting should be preserved
      expect(testRuntime.getSetting("DB_ONLY_SETTING")).toBe("keep_me");
    });
  });
});
