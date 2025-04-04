import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createMockRuntime, createMockMemory, createMockState, MockRuntime, setupActionTest } from './test-utils';
import { IAgentRuntime, Memory, Provider, State, UUID, logger, ChannelType } from '@elizaos/core';

// Import providers from source modules
import choiceProvider from '../src/providers/choice';
import { factsProvider } from '../src/providers/facts';
import { providersProvider } from '../src/providers/providers';
import { recentMessagesProvider } from '../src/providers/recentMessages';
import roleProvider from '../src/providers/roles';
import { settingsProvider } from '../src/providers/settings';

// Mock external dependencies
vi.mock('@elizaos/core', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getWorldSettings: vi.fn().mockResolvedValue([
      { name: 'setting1', value: 'value1', description: 'Description 1' },
      { name: 'setting2', value: 'value2', description: 'Description 2', secret: true },
    ]),
    findWorldsForOwner: vi.fn().mockResolvedValue([
      {
        id: 'world-1' as UUID,
        name: 'Test World',
        serverId: 'server-1',
        metadata: { settings: true },
      },
    ]),
    logger: {
      ...actual.logger,
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
});

describe('Choice Provider', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;

  beforeEach(() => {
    // Use setupActionTest for consistent test setup
    const setup = setupActionTest({
      stateOverrides: {
        values: {
          choices: 'Option A|Option B|Option C',
        },
      }
    });
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockState = setup.mockState;
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should parse choices from state values', async () => {
    const result = await choiceProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data.choices).toHaveLength(3);
    expect(result.data.choices).toContain('Option A');
    expect(result.data.choices).toContain('Option B');
    expect(result.data.choices).toContain('Option C');
    expect(result.text).toContain('Option A');
    expect(result.text).toContain('Option B');
    expect(result.text).toContain('Option C');
  });

  it('should handle empty choices gracefully', async () => {
    // Create state with empty choices
    const emptyState = createMockState({
      values: {
        choices: '',
      },
    });

    const result = await choiceProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      emptyState as State
    );

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data.choices).toHaveLength(0);
    expect(result.text).toContain('No choices available');
  });

  it('should handle missing state values gracefully', async () => {
    // Create state without choices
    const noChoicesState = createMockState({
      values: {},
    });

    const result = await choiceProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      noChoicesState as State
    );

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data.choices).toHaveLength(0);
    expect(result.text).toContain('No choices available');
  });

  it('should handle custom delimiter in choices', async () => {
    // Create state with custom delimiter
    const customDelimiterState = createMockState({
      values: {
        choices: 'Choice 1;Choice 2;Choice 3',
        choiceDelimiter: ';',
      },
    });

    const result = await choiceProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      customDelimiterState as State
    );

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data.choices).toHaveLength(3);
    expect(result.data.choices).toContain('Choice 1');
    expect(result.data.choices).toContain('Choice 2');
    expect(result.data.choices).toContain('Choice 3');
  });
});

describe('Facts Provider', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;

  beforeEach(() => {
    // Use setupActionTest for consistent test setup
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockState = setup.mockState;

    // Set up mock memories
    mockRuntime.getMemories = vi.fn().mockResolvedValue([
      {
        id: 'memory-1' as UUID,
        entityId: 'entity-1' as UUID,
        agentId: 'agent-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'User likes chocolate' },
        embedding: [0.1, 0.2, 0.3],
        createdAt: Date.now(),
      },
      {
        id: 'memory-2' as UUID,
        entityId: 'entity-1' as UUID,
        agentId: 'agent-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'User dislikes spicy food' },
        embedding: [0.2, 0.3, 0.4],
        createdAt: Date.now(),
      },
    ]);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should retrieve facts about a user', async () => {
    const result = await factsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('User likes chocolate');
    expect(result.text).toContain('User dislikes spicy food');
    expect(mockRuntime.getMemories).toHaveBeenCalledWith({
      tableName: 'facts',
      entityId: mockMessage.entityId,
      count: 100,
    });
  });

  it('should handle empty results gracefully', async () => {
    // Mock empty memories
    mockRuntime.getMemories = vi.fn().mockResolvedValue([]);

    const result = await factsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('No facts available');
  });

  it('should handle errors gracefully', async () => {
    // Mock error in getMemories
    mockRuntime.getMemories = vi.fn().mockRejectedValue(new Error('Database error'));

    const result = await factsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('No facts available');
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('Providers Provider', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;

  beforeEach(() => {
    // Use standardized mock factories
    mockRuntime = createMockRuntime({
      providers: [
        { name: 'TEST_PROVIDER_1', description: 'Test provider 1', dynamic: true, get: vi.fn() },
        { name: 'TEST_PROVIDER_2', description: 'Test provider 2', dynamic: true, get: vi.fn() },
        {
          name: 'INTERNAL_PROVIDER',
          description: 'Internal provider',
          dynamic: false,
          get: vi.fn(),
        },
      ],
    });
    mockMessage = createMockMemory();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should list all dynamic providers', async () => {
    const result = await providersProvider.get(mockRuntime as IAgentRuntime, mockMessage as Memory);

    expect(result).toBeDefined();
    expect(result.text).toContain('TEST_PROVIDER_1');
    expect(result.text).toContain('Test provider 1');
    expect(result.text).toContain('TEST_PROVIDER_2');
    expect(result.text).toContain('Test provider 2');
    expect(result.text).not.toContain('INTERNAL_PROVIDER');

    // Check data format
    expect(result.data).toBeDefined();
    expect(result.data.dynamicProviders).toHaveLength(2);
    expect(result.data.dynamicProviders[0].name).toBe('TEST_PROVIDER_1');
    expect(result.data.dynamicProviders[1].name).toBe('TEST_PROVIDER_2');
  });

  it('should handle empty provider list gracefully', async () => {
    // Mock empty providers
    mockRuntime.providers = [];

    const result = await providersProvider.get(mockRuntime as IAgentRuntime, mockMessage as Memory);

    expect(result).toBeDefined();
    expect(result.text).toContain('No dynamic providers are currently available');
    expect(result.data).toBeUndefined();
  });
});

describe('Recent Messages Provider', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;
  let mockMessages: Array<Partial<Memory>>;

  beforeEach(() => {
    // Create sample messages
    mockMessages = [
      createMockMemory({
        id: 'msg-1' as UUID,
        content: { text: 'Hello there!', channelType: ChannelType.GROUP },
        createdAt: Date.now() - 3000,
      }),
      createMockMemory({
        id: 'msg-2' as UUID,
        content: { text: 'How are you?', channelType: ChannelType.GROUP },
        createdAt: Date.now() - 2000,
      }),
      createMockMemory({
        id: 'msg-3' as UUID,
        content: { text: 'I am doing well.', channelType: ChannelType.GROUP },
        createdAt: Date.now() - 1000,
      }),
    ];

    // Use standardized mock factories
    mockRuntime = createMockRuntime();
    mockMessage = createMockMemory();
    mockState = createMockState();

    // Mock getMemories to return sample messages
    mockRuntime.getMemories = vi.fn().mockResolvedValue(mockMessages);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should retrieve recent messages', async () => {
    const result = await recentMessagesProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('Hello there!');
    expect(result.text).toContain('How are you?');
    expect(result.text).toContain('I am doing well.');
    expect(mockRuntime.getMemories).toHaveBeenCalledWith({
      tableName: 'messages',
      roomId: mockMessage.roomId,
      count: expect.any(Number),
    });
  });

  it('should handle empty message list gracefully', async () => {
    // Mock empty messages
    mockRuntime.getMemories = vi.fn().mockResolvedValue([]);

    const result = await recentMessagesProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('No recent messages available');
  });

  it('should handle errors gracefully', async () => {
    // Mock error in getMemories
    mockRuntime.getMemories = vi.fn().mockRejectedValue(new Error('Database error'));

    const result = await recentMessagesProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('No recent messages available');
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('Role Provider', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;

  beforeEach(() => {
    // Use standardized mock factories
    mockRuntime = createMockRuntime();
    mockMessage = createMockMemory();
    mockState = createMockState();

    // Mock the required entity data
    mockRuntime.getEntityById = vi.fn().mockImplementation((id) => {
      if (id === 'test-entity-id') {
        return Promise.resolve({
          id: 'test-entity-id' as UUID,
          name: 'Test User',
          metadata: {
            roles: ['ADMIN', 'MEMBER'],
          },
        });
      }
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should retrieve roles for an entity', async () => {
    const result = await roleProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('ADMIN');
    expect(result.text).toContain('MEMBER');
    expect(mockRuntime.getEntityById).toHaveBeenCalledWith(mockMessage.entityId);
  });

  it('should handle missing entity gracefully', async () => {
    // Mock getEntityById to return null
    mockRuntime.getEntityById = vi.fn().mockResolvedValue(null);

    const result = await roleProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('No roles information available');
  });

  it('should handle missing roles gracefully', async () => {
    // Mock entity without roles
    mockRuntime.getEntityById = vi.fn().mockResolvedValue({
      id: 'test-entity-id' as UUID,
      name: 'Test User',
      metadata: {},
    });

    const result = await roleProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('No roles information available');
  });

  it('should handle errors gracefully', async () => {
    // Mock error in getEntityById
    mockRuntime.getEntityById = vi.fn().mockRejectedValue(new Error('Database error'));

    const result = await roleProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('No roles information available');
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('Settings Provider', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;

  beforeEach(() => {
    // Use standardized mock factories
    mockRuntime = createMockRuntime();

    // Create mock message with appropriate channel type
    mockMessage = createMockMemory({
      content: {
        channelType: ChannelType.ONBOARDING,
      },
    });

    mockState = createMockState({
      data: {
        room: {
          id: 'test-room-id' as UUID,
          worldId: 'world-1' as UUID,
        },
      },
    });

    // Mock getRoom to provide room data
    mockRuntime.getRoom = vi.fn().mockResolvedValue({
      id: 'test-room-id' as UUID,
      worldId: 'world-1' as UUID,
    });

    // Mock getWorld to provide world data
    mockRuntime.getWorld = vi.fn().mockResolvedValue({
      id: 'world-1' as UUID,
      serverId: 'server-1',
      name: 'Test World',
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should retrieve settings in onboarding mode', async () => {
    // Setup for onboarding
    mockMessage.content = {
      ...mockMessage.content,
      channelType: ChannelType.ONBOARDING,
    };

    const result = await settingsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data.settings).toHaveLength(2);
    expect(result.text).toContain('setting1');
    expect(result.text).toContain('value1');
    expect(result.text).toContain('setting2');
    expect(result.text).toContain('value2'); // Secret is visible in onboarding
  });

  it('should retrieve settings in normal mode', async () => {
    // Setup for normal mode
    mockMessage.content = {
      ...mockMessage.content,
      channelType: ChannelType.GROUP,
    };

    const result = await settingsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data.settings).toHaveLength(2);
    expect(result.text).toContain('setting1');
    expect(result.text).toContain('value1');
    expect(result.text).toContain('setting2');
    expect(result.text).toContain('****************'); // Secret is masked in normal mode
  });

  it('should handle errors gracefully', async () => {
    // Mock error in getWorldSettings
    const { getWorldSettings } = await import('@elizaos/core');
    (getWorldSettings as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Failed to retrieve settings')
    );

    const result = await settingsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('Error retrieving configuration information');
    expect(logger.error).toHaveBeenCalled();
  });

  it('should handle missing world gracefully', async () => {
    // Mock getWorld to return null
    mockRuntime.getWorld = vi.fn().mockResolvedValue(null);

    const result = await settingsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('Error retrieving configuration information');
    expect(logger.error).toHaveBeenCalled();
  });
});
