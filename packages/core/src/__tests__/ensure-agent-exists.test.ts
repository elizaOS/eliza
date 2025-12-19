import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { AgentRuntime } from '../runtime';
import type { Character, IDatabaseAdapter, Agent, UUID } from '../types';
import { v4 as uuidv4 } from 'uuid';

// Helper type for bun:test mocks with additional methods
interface BunMockFunction<T extends (...args: never[]) => unknown> {
  (...args: Parameters<T>): ReturnType<T>;
  mockResolvedValueOnce: (value: Awaited<ReturnType<T>>) => BunMockFunction<T>;
  mockResolvedValue: (value: Awaited<ReturnType<T>>) => BunMockFunction<T>;
  mock: {
    calls: Parameters<T>[][];
    results: ReturnType<T>[];
  };
}

describe('ensureAgentExists - Settings Persistence', () => {
  let runtime: AgentRuntime;
  let mockAdapter: IDatabaseAdapter;
  let testCharacter: Character;
  let agentId: UUID;
  let getAgentMock: IDatabaseAdapter['getAgent'];
  let updateAgentMock: IDatabaseAdapter['updateAgent'];
  let getEntitiesByIdsMock: IDatabaseAdapter['getEntitiesByIds'];
  let getRoomsByIdsMock: IDatabaseAdapter['getRoomsByIds'];
  let getParticipantsForRoomMock: IDatabaseAdapter['getParticipantsForRoom'];
  let createEntitiesMock: IDatabaseAdapter['createEntities'];
  let createRoomsMock: IDatabaseAdapter['createRooms'];
  let addParticipantsRoomMock: IDatabaseAdapter['addParticipantsRoom'];

  beforeEach(() => {
    agentId = uuidv4() as UUID;

    testCharacter = {
      id: agentId,
      name: 'TestAgent',
      username: 'testagent',
      bio: [],
      messageExamples: [],
      postExamples: [],
      topics: [],
      style: { all: [], chat: [], post: [] },
      adjectives: [],
      settings: {
        MODEL: 'gpt-4',
        TEMPERATURE: '0.7',
      },
    };

    // Create mock adapter with proper types
    getAgentMock = mock<IDatabaseAdapter['getAgent']>(async () => null);
    updateAgentMock = mock<IDatabaseAdapter['updateAgent']>(async () => true);
    getEntitiesByIdsMock = mock<IDatabaseAdapter['getEntitiesByIds']>(async () => []);
    getRoomsByIdsMock = mock<IDatabaseAdapter['getRoomsByIds']>(async () => []);
    getParticipantsForRoomMock = mock<IDatabaseAdapter['getParticipantsForRoom']>(async () => []);
    createEntitiesMock = mock<IDatabaseAdapter['createEntities']>(async () => true);
    createRoomsMock = mock<IDatabaseAdapter['createRooms']>(async () => []);
    addParticipantsRoomMock = mock<IDatabaseAdapter['addParticipantsRoom']>(async () => true);

    mockAdapter = {
      db: {},
      init: mock(async () => {}),
      initialize: mock(async () => {}),
      close: mock(async () => {}),
      isReady: mock(async () => true),
      getConnection: mock(async () => ({})),
      getAgent: getAgentMock,
      getAgents: mock(async () => []),
      createAgent: mock(async () => true),
      updateAgent: updateAgentMock,
      deleteAgent: mock(async () => true),
      ensureEmbeddingDimension: mock(async () => {}),
      log: mock(async () => {}),
      runPluginMigrations: mock(async () => {}),
      getEntitiesByIds: getEntitiesByIdsMock,
      getRoomsByIds: getRoomsByIdsMock,
      getParticipantsForRoom: getParticipantsForRoomMock,
      createEntities: createEntitiesMock,
      addParticipantsRoom: addParticipantsRoomMock,
      createRooms: createRoomsMock,
      // Add other required methods with minimal implementations
      getEntitiesForRoom: mock(async () => []),
      updateEntity: mock(async () => {}),
      getComponent: mock(async () => null),
      getComponents: mock(async () => []),
      createComponent: mock(async () => true),
      updateComponent: mock(async () => {}),
      deleteComponent: mock(async () => {}),
      getMemories: mock(async () => []),
      getMemoryById: mock(async () => null),
      getMemoriesByIds: mock(async () => []),
      getMemoriesByRoomIds: mock(async () => []),
      getCachedEmbeddings: mock(async () => []),
      getLogs: mock(async () => []),
      deleteLog: mock(async () => {}),
      searchMemories: mock(async () => []),
      createMemory: mock(async () => 'memory-id' as UUID),
      updateMemory: mock(async () => true),
      deleteMemory: mock(async () => {}),
      deleteManyMemories: mock(async () => {}),
      deleteAllMemories: mock(async () => {}),
      countMemories: mock(async () => 0),
      createWorld: mock(async () => 'world-id' as UUID),
      getWorld: mock(async () => null),
      getAllWorlds: mock(async () => []),
      updateWorld: mock(async () => {}),
      removeWorld: mock(async () => {}),
      getRoomsByWorld: mock(async () => []),
      updateRoom: mock(async () => {}),
      deleteRoom: mock(async () => {}),
      deleteRoomsByWorldId: mock(async () => {}),
      getRoomsForParticipant: mock(async () => []),
      getRoomsForParticipants: mock(async () => []),
      removeParticipant: mock(async () => true),
      getParticipantsForEntity: mock(async () => []),
      isRoomParticipant: mock(async () => false),
      getParticipantUserState: mock(async () => null),
      setParticipantUserState: mock(async () => {}),
      createRelationship: mock(async () => true),
      getRelationship: mock(async () => null),
      getRelationships: mock(async () => []),
      updateRelationship: mock(async () => {}),
      getCache: mock(async () => undefined),
      setCache: mock(async () => true),
      deleteCache: mock(async () => true),
      createTask: mock(async () => 'task-id' as UUID),
      getTasks: mock(async () => []),
      getTask: mock(async () => null),
      getTasksByName: mock(async () => []),
      updateTask: mock(async () => {}),
      deleteTask: mock(async () => {}),
      getMemoriesByWorldId: mock(async () => []),
    } as IDatabaseAdapter;

    runtime = new AgentRuntime({
      character: testCharacter,
      adapter: mockAdapter,
    });
  });

  afterEach(() => {
    mock.restore();
  });

  it('should create a new agent when none exists in DB', async () => {
    const agent: Partial<Agent> = {
      id: agentId,
      name: 'TestAgent',
      settings: {
        MODEL: 'gpt-4',
      },
    };

    const result = await runtime.ensureAgentExists(agent);

    expect(mockAdapter.getAgent).toHaveBeenCalledWith(agentId);
    expect(mockAdapter.createAgent).toHaveBeenCalled();
    expect(result.id).toBe(agentId);
  });

  it('should merge DB settings with character.json settings on restart', async () => {
    // Simulate DB state with persisted runtime secrets
    const existingAgentInDB: Agent = {
      id: agentId,
      name: 'TestAgent',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bio: [],
      settings: {
        SOLANA_PUBLIC_KEY: 'CioDPgLA1o8cuuhXZ7M3Fi1Lzqo2Cr8VudjY6ErtvYp4',
        secrets: {
          SOLANA_PRIVATE_KEY: '4zkwqei5hFqtHvqGTMFC6FDCBSPoJqTqN3v7pNDYrqFY...',
        },
        OLD_SETTING: 'should_be_kept',
      },
    } as Agent;

    (getAgentMock as BunMockFunction<IDatabaseAdapter['getAgent']>).mockResolvedValueOnce(
      existingAgentInDB
    );
    (getAgentMock as BunMockFunction<IDatabaseAdapter['getAgent']>).mockResolvedValueOnce({
      ...existingAgentInDB,
      settings: {
        SOLANA_PUBLIC_KEY: 'CioDPgLA1o8cuuhXZ7M3Fi1Lzqo2Cr8VudjY6ErtvYp4',
        MODEL: 'gpt-4',
        TEMPERATURE: '0.7',
        secrets: {
          SOLANA_PRIVATE_KEY: '4zkwqei5hFqtHvqGTMFC6FDCBSPoJqTqN3v7pNDYrqFY...',
        },
        OLD_SETTING: 'should_be_kept',
      },
    });

    // Character file has new settings but no wallet keys
    const characterAgent: Partial<Agent> = {
      id: agentId,
      name: 'TestAgent',
      settings: {
        MODEL: 'gpt-4',
        TEMPERATURE: '0.7',
      },
    };

    const result = await runtime.ensureAgentExists(characterAgent);

    // Verify updateAgent was called with merged settings
    expect(mockAdapter.updateAgent).toHaveBeenCalled();
    const updateCall = (updateAgentMock as BunMockFunction<IDatabaseAdapter['updateAgent']>).mock
      .calls[0];
    // updateAgent signature: (agentId: UUID, agent: Partial<Agent>) => Promise<boolean>
    // So updateCall[1] is Partial<Agent>
    const updatedAgent = updateCall[1] as Partial<Agent>;

    // Check that DB settings were preserved
    expect(updatedAgent.settings?.SOLANA_PUBLIC_KEY).toBe(
      'CioDPgLA1o8cuuhXZ7M3Fi1Lzqo2Cr8VudjY6ErtvYp4'
    );
    expect(updatedAgent.settings?.OLD_SETTING).toBe('should_be_kept');

    // Check that character.json settings were applied
    expect(updatedAgent.settings?.MODEL).toBe('gpt-4');
    expect(updatedAgent.settings?.TEMPERATURE).toBe('0.7');

    // Check that secrets were preserved
    expect((updatedAgent.settings?.secrets as Record<string, string>)?.SOLANA_PRIVATE_KEY).toBe(
      '4zkwqei5hFqtHvqGTMFC6FDCBSPoJqTqN3v7pNDYrqFY...'
    );
  });

  it('should allow character.json to override DB settings', async () => {
    // DB has old MODEL value
    const existingAgentInDB: Agent = {
      id: agentId,
      name: 'TestAgent',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bio: [],
      settings: {
        MODEL: 'gpt-3.5-turbo',
        SOLANA_PUBLIC_KEY: 'wallet123',
        secrets: {
          SOLANA_PRIVATE_KEY: '4zkwqei5hFqtHvqGTMFC6FDCBSPoJqTqN3v7pNDYrqFY...',
        },
      },
    } as Agent;

    (getAgentMock as BunMockFunction<IDatabaseAdapter['getAgent']>).mockResolvedValueOnce(
      existingAgentInDB
    );
    (getAgentMock as BunMockFunction<IDatabaseAdapter['getAgent']>).mockResolvedValueOnce({
      ...existingAgentInDB,
      settings: {
        MODEL: 'gpt-4', // Updated by character.json
        SOLANA_PUBLIC_KEY: 'wallet123', // Preserved from DB
        secrets: {
          SOLANA_PRIVATE_KEY: '4zkwqei5hFqtHvqGTMFC6FDCBSPoJqTqN3v7pNDYrqFY...',
        },
      },
    });

    // Character file has new MODEL value
    const characterAgent: Partial<Agent> = {
      id: agentId,
      name: 'TestAgent',
      settings: {
        MODEL: 'gpt-4', // This should override DB value
      },
    };

    await runtime.ensureAgentExists(characterAgent);

    const updateCall = (updateAgentMock as BunMockFunction<IDatabaseAdapter['updateAgent']>).mock
      .calls[0];
    const updatedAgent = updateCall[1] as Partial<Agent>;

    // MODEL should be overridden by character.json
    expect(updatedAgent.settings?.MODEL).toBe('gpt-4');

    // But SOLANA_PUBLIC_KEY should be preserved from DB
    expect(updatedAgent.settings?.SOLANA_PUBLIC_KEY).toBe('wallet123');
  });

  it('should deep merge secrets from both DB and character.json', async () => {
    const existingAgentInDB: Agent = {
      id: agentId,
      name: 'TestAgent',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bio: [],
      settings: {
        secrets: {
          RUNTIME_SECRET: 'from_db',
          WALLET_KEY: 'wallet_key_from_db',
        },
      },
    } as Agent;

    (getAgentMock as BunMockFunction<IDatabaseAdapter['getAgent']>).mockResolvedValueOnce(
      existingAgentInDB
    );
    (getAgentMock as BunMockFunction<IDatabaseAdapter['getAgent']>).mockResolvedValueOnce({
      ...existingAgentInDB,
      settings: {
        secrets: {
          RUNTIME_SECRET: 'from_db',
          WALLET_KEY: 'wallet_key_from_db',
          API_KEY: 'from_character',
        },
      },
    });

    const characterAgent: Partial<Agent> = {
      id: agentId,
      name: 'TestAgent',
      settings: {
        secrets: {
          API_KEY: 'from_character',
        },
      },
    };

    await runtime.ensureAgentExists(characterAgent);

    const updateCall = (updateAgentMock as BunMockFunction<IDatabaseAdapter['updateAgent']>).mock
      .calls[0];
    const updatedAgent = updateCall[1] as Partial<Agent>;

    // Both DB and character secrets should be present
    const secrets = updatedAgent.settings?.secrets as Record<string, string> | undefined;
    expect(secrets?.RUNTIME_SECRET).toBe('from_db');
    expect(secrets?.WALLET_KEY).toBe('wallet_key_from_db');
    expect(secrets?.API_KEY).toBe('from_character');
  });

  it('should handle agent with no settings in DB', async () => {
    const existingAgentInDB: Agent = {
      id: agentId,
      name: 'TestAgent',
      // No settings field
    } as Agent;

    (getAgentMock as BunMockFunction<IDatabaseAdapter['getAgent']>).mockResolvedValueOnce(
      existingAgentInDB
    );
    (getAgentMock as BunMockFunction<IDatabaseAdapter['getAgent']>).mockResolvedValueOnce({
      ...existingAgentInDB,
      settings: {
        MODEL: 'gpt-4',
      },
    });

    const characterAgent: Partial<Agent> = {
      id: agentId,
      name: 'TestAgent',
      settings: {
        MODEL: 'gpt-4',
      },
    };

    await runtime.ensureAgentExists(characterAgent);

    const updateCall = (updateAgentMock as BunMockFunction<IDatabaseAdapter['updateAgent']>).mock
      .calls[0];
    const updatedAgent = updateCall[1] as Partial<Agent>;

    // Should have character settings even though DB had none
    expect(updatedAgent.settings?.MODEL).toBe('gpt-4');
  });

  it('should handle character with no settings', async () => {
    const existingAgentInDB: Agent = {
      id: agentId,
      name: 'TestAgent',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      bio: [],
      settings: {
        DB_SETTING: 'value',
      },
    } as Agent;

    (getAgentMock as BunMockFunction<IDatabaseAdapter['getAgent']>).mockResolvedValueOnce(
      existingAgentInDB
    );
    (getAgentMock as BunMockFunction<IDatabaseAdapter['getAgent']>).mockResolvedValueOnce(
      existingAgentInDB
    );

    const characterAgent: Partial<Agent> = {
      id: agentId,
      name: 'TestAgent',
      // No settings
    };

    await runtime.ensureAgentExists(characterAgent);

    const updateCall = (updateAgentMock as BunMockFunction<IDatabaseAdapter['updateAgent']>).mock
      .calls[0];
    const updatedAgent = updateCall[1] as Partial<Agent>;

    // Should preserve DB settings
    expect(updatedAgent.settings?.DB_SETTING).toBe('value');
  });

  it('should throw error if agent id is not provided', async () => {
    const agent: Partial<Agent> = {
      name: 'TestAgent',
    };

    await expect(runtime.ensureAgentExists(agent)).rejects.toThrow('Agent id is required');
  });

  describe('runtime.initialize() integration', () => {
    it('should load DB-persisted settings into runtime.character after initialization', async () => {
      // Simulate DB with persisted wallet keys
      const dbAgent = {
        id: agentId,
        name: 'TestAgent',
        bio: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        settings: {
          SOLANA_PUBLIC_KEY: 'wallet_from_db',
          RUNTIME_SETTING: 'from_previous_run',
          secrets: {
            SOLANA_PRIVATE_KEY: 'secret_from_db',
          },
        },
      } as Agent;

      // Mock getAgent to return DB agent on first call (ensureAgentExists)
      // and updated agent on second call (after update)
      (getAgentMock as BunMockFunction<IDatabaseAdapter['getAgent']>)
        .mockResolvedValueOnce(dbAgent)
        .mockResolvedValueOnce({
          ...dbAgent,
          settings: {
            ...dbAgent.settings,
            MODEL: 'gpt-4', // Added from character file
          },
        });

      // Character file has different settings
      const character: Character = {
        id: agentId,
        name: 'TestAgent',
        username: 'test',
        bio: [],
        messageExamples: [],
        postExamples: [],
        topics: [],
        style: { all: [], chat: [], post: [] },
        adjectives: [],
        settings: {
          MODEL: 'gpt-4', // New setting from character file
        },
      };

      // Create new runtime with character file settings
      const testRuntime = new AgentRuntime({
        character,
        adapter: mockAdapter,
      });

      // Before initialize, character should only have file settings
      expect(testRuntime.character.settings?.SOLANA_PUBLIC_KEY).toBeUndefined();
      expect(testRuntime.character.settings?.MODEL).toBe('gpt-4');

      // Mock the services that initialize() expects
      (
        getEntitiesByIdsMock as BunMockFunction<IDatabaseAdapter['getEntitiesByIds']>
      ).mockResolvedValue([{ id: agentId, names: ['TestAgent'], metadata: {}, agentId }]);
      (getRoomsByIdsMock as BunMockFunction<IDatabaseAdapter['getRoomsByIds']>).mockResolvedValue(
        []
      );
      (
        getParticipantsForRoomMock as BunMockFunction<IDatabaseAdapter['getParticipantsForRoom']>
      ).mockResolvedValue([]);
      (createEntitiesMock as BunMockFunction<IDatabaseAdapter['createEntities']>).mockResolvedValue(
        true
      );
      (createRoomsMock as BunMockFunction<IDatabaseAdapter['createRooms']>).mockResolvedValue([
        agentId,
      ]);
      (
        addParticipantsRoomMock as BunMockFunction<IDatabaseAdapter['addParticipantsRoom']>
      ).mockResolvedValue(true);

      // Initialize runtime (should load DB settings into character)
      await testRuntime.initialize();

      // After initialize, character should have BOTH DB and file settings
      expect(testRuntime.character.settings?.SOLANA_PUBLIC_KEY).toBe('wallet_from_db');
      expect(testRuntime.character.settings?.RUNTIME_SETTING).toBe('from_previous_run');
      expect(testRuntime.character.settings?.MODEL).toBe('gpt-4'); // Character file wins
      expect(
        (testRuntime.character.settings?.secrets as Record<string, string>)?.SOLANA_PRIVATE_KEY
      ).toBe('secret_from_db');

      // Verify getSetting() can now access DB settings
      expect(testRuntime.getSetting('SOLANA_PUBLIC_KEY')).toBe('wallet_from_db');
      expect(testRuntime.getSetting('SOLANA_PRIVATE_KEY')).toBe('secret_from_db');
      expect(testRuntime.getSetting('RUNTIME_SETTING')).toBe('from_previous_run');
    });

    it('should preserve character file settings when merging with DB', async () => {
      const dbAgent: Agent = {
        id: agentId,
        name: 'TestAgent',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        bio: [],
        settings: {
          MODEL: 'gpt-3.5-turbo', // Old value in DB
          DB_ONLY_SETTING: 'keep_me',
        },
      } as Agent;

      (getAgentMock as BunMockFunction<IDatabaseAdapter['getAgent']>)
        .mockResolvedValueOnce(dbAgent)
        .mockResolvedValueOnce({
          ...dbAgent,
          settings: {
            MODEL: 'gpt-4', // Updated by character file
            DB_ONLY_SETTING: 'keep_me',
          },
        });

      const character: Character = {
        id: agentId,
        name: 'TestAgent',
        username: 'test',
        bio: [],
        messageExamples: [],
        postExamples: [],
        topics: [],
        style: { all: [], chat: [], post: [] },
        adjectives: [],
        settings: {
          MODEL: 'gpt-4', // New value in character file
        },
      };

      const testRuntime = new AgentRuntime({
        character,
        adapter: mockAdapter,
      });

      (
        getEntitiesByIdsMock as BunMockFunction<IDatabaseAdapter['getEntitiesByIds']>
      ).mockResolvedValue([{ id: agentId, names: ['TestAgent'], metadata: {}, agentId }]);
      (getRoomsByIdsMock as BunMockFunction<IDatabaseAdapter['getRoomsByIds']>).mockResolvedValue(
        []
      );
      (
        getParticipantsForRoomMock as BunMockFunction<IDatabaseAdapter['getParticipantsForRoom']>
      ).mockResolvedValue([]);
      (createEntitiesMock as BunMockFunction<IDatabaseAdapter['createEntities']>).mockResolvedValue(
        true
      );
      (createRoomsMock as BunMockFunction<IDatabaseAdapter['createRooms']>).mockResolvedValue([
        agentId,
      ]);
      (
        addParticipantsRoomMock as BunMockFunction<IDatabaseAdapter['addParticipantsRoom']>
      ).mockResolvedValue(true);

      await testRuntime.initialize();

      // Character file value should override DB
      expect(testRuntime.getSetting('MODEL')).toBe('gpt-4');
      // DB-only setting should be preserved
      expect(testRuntime.getSetting('DB_ONLY_SETTING')).toBe('keep_me');
    });
  });
});
