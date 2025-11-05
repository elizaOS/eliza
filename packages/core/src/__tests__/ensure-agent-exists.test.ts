import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { AgentRuntime } from '../runtime';
import type { Character, IDatabaseAdapter, Agent, UUID } from '../types';
import { v4 as uuidv4 } from 'uuid';

describe('ensureAgentExists - Settings Persistence', () => {
  let runtime: AgentRuntime;
  let mockAdapter: IDatabaseAdapter;
  let testCharacter: Character;
  let agentId: UUID;

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
    mockAdapter = {
      init: mock(async () => {}),
      close: mock(async () => {}),
      isReady: mock(async () => true),
      getConnection: mock(async () => ({})),
      getAgent: mock(async () => null),
      getAgents: mock(async () => []),
      createAgent: mock(async () => true),
      updateAgent: mock(async () => true),
      deleteAgent: mock(async () => true),
      ensureEmbeddingDimension: mock(async () => {}),
      log: mock(async () => {}),
      runPluginMigrations: mock(async () => {}),
      // Add minimal mocks for other required methods
      getEntitiesByIds: mock(async () => []),
      getRoomsByIds: mock(async () => []),
      getParticipantsForRoom: mock(async () => []),
      createEntities: mock(async () => true),
      addParticipantsRoom: mock(async () => true),
      createRooms: mock(async () => []),
    } as unknown as IDatabaseAdapter;

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

    (mockAdapter.getAgent as any).mockResolvedValueOnce(existingAgentInDB);
    (mockAdapter.getAgent as any).mockResolvedValueOnce({
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
    const updateCall = (mockAdapter.updateAgent as any).mock.calls[0];
    const updatedAgent = updateCall[1];

    // Check that DB settings were preserved
    expect(updatedAgent.settings.SOLANA_PUBLIC_KEY).toBe(
      'CioDPgLA1o8cuuhXZ7M3Fi1Lzqo2Cr8VudjY6ErtvYp4'
    );
    expect(updatedAgent.settings.OLD_SETTING).toBe('should_be_kept');

    // Check that character.json settings were applied
    expect(updatedAgent.settings.MODEL).toBe('gpt-4');
    expect(updatedAgent.settings.TEMPERATURE).toBe('0.7');

    // Check that secrets were preserved
    expect(updatedAgent.settings.secrets.SOLANA_PRIVATE_KEY).toBe(
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
    } as unknown as Agent;

    (mockAdapter.getAgent as any).mockResolvedValueOnce(existingAgentInDB);
    (mockAdapter.getAgent as any).mockResolvedValueOnce({
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

    const updateCall = (mockAdapter.updateAgent as any).mock.calls[0];
    const updatedAgent = updateCall[1];

    // MODEL should be overridden by character.json
    expect(updatedAgent.settings.MODEL).toBe('gpt-4');

    // But SOLANA_PUBLIC_KEY should be preserved from DB
    expect(updatedAgent.settings.SOLANA_PUBLIC_KEY).toBe('wallet123');
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

    (mockAdapter.getAgent as any).mockResolvedValueOnce(existingAgentInDB);
    (mockAdapter.getAgent as any).mockResolvedValueOnce({
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

    const updateCall = (mockAdapter.updateAgent as any).mock.calls[0];
    const updatedAgent = updateCall[1];

    // Both DB and character secrets should be present
    expect(updatedAgent.settings.secrets.RUNTIME_SECRET).toBe('from_db');
    expect(updatedAgent.settings.secrets.WALLET_KEY).toBe('wallet_key_from_db');
    expect(updatedAgent.settings.secrets.API_KEY).toBe('from_character');
  });

  it('should handle agent with no settings in DB', async () => {
    const existingAgentInDB: Agent = {
      id: agentId,
      name: 'TestAgent',
      // No settings field
    } as Agent;

    (mockAdapter.getAgent as any).mockResolvedValueOnce(existingAgentInDB);
    (mockAdapter.getAgent as any).mockResolvedValueOnce({
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

    const updateCall = (mockAdapter.updateAgent as any).mock.calls[0];
    const updatedAgent = updateCall[1];

    // Should have character settings even though DB had none
    expect(updatedAgent.settings.MODEL).toBe('gpt-4');
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

    (mockAdapter.getAgent as any).mockResolvedValueOnce(existingAgentInDB);
    (mockAdapter.getAgent as any).mockResolvedValueOnce(existingAgentInDB);

    const characterAgent: Partial<Agent> = {
      id: agentId,
      name: 'TestAgent',
      // No settings
    };

    await runtime.ensureAgentExists(characterAgent);

    const updateCall = (mockAdapter.updateAgent as any).mock.calls[0];
    const updatedAgent = updateCall[1];

    // Should preserve DB settings
    expect(updatedAgent.settings.DB_SETTING).toBe('value');
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
      (mockAdapter.getAgent as any).mockResolvedValueOnce(dbAgent).mockResolvedValueOnce({
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
      (mockAdapter.getEntitiesByIds as any).mockResolvedValue([
        { id: agentId, names: ['TestAgent'], metadata: {}, agentId },
      ]);
      (mockAdapter.getRoomsByIds as any).mockResolvedValue([]);
      (mockAdapter.getParticipantsForRoom as any).mockResolvedValue([]);
      (mockAdapter.createEntities as any).mockResolvedValue(true);
      (mockAdapter.createRooms as any).mockResolvedValue([agentId]);
      (mockAdapter.addParticipantsRoom as any).mockResolvedValue(true);

      // Initialize runtime (should load DB settings into character)
      await testRuntime.initialize();

      // After initialize, character should have BOTH DB and file settings
      expect(testRuntime.character.settings?.SOLANA_PUBLIC_KEY).toBe('wallet_from_db');
      expect(testRuntime.character.settings?.RUNTIME_SETTING).toBe('from_previous_run');
      expect(testRuntime.character.settings?.MODEL).toBe('gpt-4'); // Character file wins
      expect((testRuntime.character.settings?.secrets as any)?.SOLANA_PRIVATE_KEY).toBe(
        'secret_from_db'
      );

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

      (mockAdapter.getAgent as any).mockResolvedValueOnce(dbAgent).mockResolvedValueOnce({
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

      (mockAdapter.getEntitiesByIds as any).mockResolvedValue([
        { id: agentId, names: ['TestAgent'], metadata: {}, agentId },
      ]);
      (mockAdapter.getRoomsByIds as any).mockResolvedValue([]);
      (mockAdapter.getParticipantsForRoom as any).mockResolvedValue([]);
      (mockAdapter.createEntities as any).mockResolvedValue(true);
      (mockAdapter.createRooms as any).mockResolvedValue([agentId]);
      (mockAdapter.addParticipantsRoom as any).mockResolvedValue(true);

      await testRuntime.initialize();

      // Character file value should override DB
      expect(testRuntime.getSetting('MODEL')).toBe('gpt-4');
      // DB-only setting should be preserved
      expect(testRuntime.getSetting('DB_ONLY_SETTING')).toBe('keep_me');
    });
  });
});
