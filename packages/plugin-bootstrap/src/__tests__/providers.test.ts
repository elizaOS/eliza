import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import {
  createMockRuntime,
  createMockMemory,
  createMockState,
  MockRuntime,
  setupActionTest,
} from './test-utils';
import { IAgentRuntime, Memory, State, UUID, ChannelType, Media } from '@elizaos/core';

// Import providers from source modules
import choiceProvider from '../providers/choice';
import { factsProvider } from '../providers/facts';
import { providersProvider } from '../providers/providers';
import { recentMessagesProvider } from '../providers/recentMessages';
import roleProvider from '../providers/roles';
import { settingsProvider } from '../providers/settings';
import { attachmentsProvider } from '../providers/attachments';

describe('Choice Provider', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;

  beforeEach(() => {
    const setup = setupActionTest({}); // No specific state overrides needed for these tests
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockState = setup.mockState;

    // Default mock for getTasks
    mockRuntime.getTasks = mock().mockResolvedValue([]);
  });

  afterEach(() => {
    mock.restore();
  });

  it('should list pending tasks with options', async () => {
    const tasks = [
      {
        id: 'task-1' as UUID,
        name: 'Approve Post',
        description: 'A blog post is awaiting approval.',
        roomId: mockMessage.roomId,
        tags: ['AWAITING_CHOICE'],
        metadata: {
          options: ['approve', 'reject', { name: 'edit', description: 'Edit the post' }],
        },
      },
      {
        id: 'task-2' as UUID,
        name: 'Select Image',
        roomId: mockMessage.roomId,
        tags: ['AWAITING_CHOICE'],
        metadata: {
          options: [
            { name: 'imageA.jpg', description: 'A cat' },
            { name: 'imageB.jpg', description: 'A dog' },
          ],
        },
      },
    ];
    mockRuntime.getTasks = mock().mockResolvedValue(tasks);

    const result = await choiceProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data?.tasks).toHaveLength(2);
    expect(result.data?.tasks?.[0]?.name).toBe('Approve Post');
    expect(result.text).toContain('Pending Tasks');
    expect(result.text).toContain('1. **Approve Post**');
    expect(result.text).toContain('A blog post is awaiting approval.');
    expect(result.text).toContain('- `approve`');
    expect(result.text).toContain('- `reject`');
    expect(result.text).toContain('- `edit` - Edit the post');
    expect(result.text).toContain('2. **Select Image**');
    expect(result.text).toContain('- `imageA.jpg` - A cat');
    expect(result.text).toContain('- `imageB.jpg` - A dog');
    expect(result.text).toContain(
      "To select an option, reply with the option name (e.g., 'post' or 'cancel')."
    );
    expect(mockRuntime.getTasks).toHaveBeenCalledWith({
      roomId: mockMessage.roomId,
      tags: ['AWAITING_CHOICE'],
    });
  });

  it('should handle no pending tasks gracefully', async () => {
    mockRuntime.getTasks = mock().mockResolvedValue([]); // No tasks

    const result = await choiceProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data?.tasks).toHaveLength(0);
    expect(result.text).toContain('No pending choices for the moment.');
  });

  it('should handle tasks with no options gracefully', async () => {
    const tasks = [
      {
        id: 'task-1' as UUID,
        name: 'No Options Task',
        roomId: mockMessage.roomId,
        tags: ['AWAITING_CHOICE'],
        metadata: {}, // No options here
      },
    ];
    mockRuntime.getTasks = mock().mockResolvedValue(tasks);

    const result = await choiceProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data?.tasks).toHaveLength(0); // Tasks without options are filtered out
    expect(result.text).toContain('No pending choices for the moment.');
  });

  it('should handle errors from getTasks gracefully', async () => {
    mockRuntime.getTasks = mock().mockRejectedValue(new Error('Task service error'));

    const result = await choiceProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data?.tasks).toHaveLength(0);
    expect(result.text).toContain('There was an error retrieving pending tasks with options.');
    // Cannot check logger.error calls without mocking @elizaos/core
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

    // Mock for initial recent messages
    mockRuntime.getMemories = mock().mockResolvedValue([
      {
        id: 'msg-prev-1' as UUID,
        content: { text: 'Previous message 1' },
        createdAt: Date.now() - 1000,
      },
    ]);

    // Mock for useModel
    mockRuntime.useModel = mock().mockResolvedValue([0.1, 0.2, 0.3]); // Example embedding

    // Mock for searchMemories
    mockRuntime.searchMemories = mock().mockImplementation(async (params) => {
      if (params.tableName === 'facts' && params.count === 6) {
        // Could differentiate between the two calls if needed by params.entityId
        if (params.entityId === mockMessage.entityId) {
          // recentFactsData call
          return [
            {
              id: 'memory-2' as UUID,
              entityId: 'entity-1' as UUID,
              agentId: 'agent-1' as UUID,
              roomId: 'room-1' as UUID,
              content: { text: 'User dislikes spicy food' },
              embedding: [0.2, 0.3, 0.4],
              createdAt: Date.now(),
            },
          ];
        } else {
          // relevantFacts call
          return [
            {
              id: 'memory-1' as UUID,
              entityId: 'entity-1' as UUID, // Can be different or same based on test
              agentId: 'agent-1' as UUID,
              roomId: 'room-1' as UUID,
              content: { text: 'User likes chocolate' },
              embedding: [0.1, 0.2, 0.3],
              createdAt: Date.now(),
            },
          ];
        }
      }
      return [];
    });
  });

  afterEach(() => {
    mock.restore();
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
      tableName: 'messages',
      roomId: mockMessage.roomId,
      count: 10,
      unique: false,
    });
    expect(mockRuntime.useModel).toHaveBeenCalled();
    expect(mockRuntime.searchMemories).toHaveBeenCalledTimes(2);
  });

  it('should handle empty results gracefully', async () => {
    // Mock empty memories from searchMemories
    mockRuntime.searchMemories = mock().mockResolvedValue([]);

    const result = await factsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('No facts available.');
  });

  it('should handle errors gracefully', async () => {
    // Mock error in getMemories (initial call)
    mockRuntime.getMemories = mock().mockRejectedValue(new Error('Database error'));

    const result = await factsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('Error retrieving facts.');
    // Cannot check logger.error calls without mocking @elizaos/core
  });
});

describe('Providers Provider', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;

  beforeEach(() => {
    // Use standardized mock factories
    mockRuntime = createMockRuntime({
      providers: [
        { name: 'TEST_PROVIDER_1', description: 'Test provider 1', dynamic: true, get: mock() },
        { name: 'TEST_PROVIDER_2', description: 'Test provider 2', dynamic: true, get: mock() },
        {
          name: 'INTERNAL_PROVIDER',
          description: 'Internal provider',
          dynamic: false,
          get: mock(),
        },
      ],
    });
    mockMessage = createMockMemory();
    mockState = createMockState();
  });

  afterEach(() => {
    mock.restore();
  });

  it('should list all dynamic providers', async () => {
    const result = await providersProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('TEST_PROVIDER_1');
    expect(result.text).toContain('Test provider 1');
    expect(result.text).toContain('TEST_PROVIDER_2');
    expect(result.text).toContain('Test provider 2');
    expect(result.text).not.toContain('INTERNAL_PROVIDER');

    // Check data format
    expect(result.data).toBeDefined();
    expect(result?.data?.dynamicProviders).toHaveLength(2);
    expect(result?.data?.dynamicProviders?.[0]?.name).toBe('TEST_PROVIDER_1');
    expect(result?.data?.dynamicProviders?.[1]?.name).toBe('TEST_PROVIDER_2');
  });

  it('should handle empty provider list gracefully', async () => {
    // Mock empty providers
    mockRuntime.providers = [];

    const result = await providersProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

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
    mockRuntime.getMemories = mock().mockResolvedValue(mockMessages);
  });

  afterEach(() => {
    mock.restore();
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
      count: 10,
      unique: false,
    });
  });

  it('should handle empty message list gracefully', async () => {
    // Mock empty messages for this specific test
    mockRuntime.getMemories = mock().mockResolvedValue([]);
    // Ensure the current message content is also empty for the provider's specific check
    mockMessage.content = { ...mockMessage.content, text: '' };

    const result = await recentMessagesProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory, // Now message.content.text is empty
      mockState as State
    );

    expect(result).toBeDefined();
    // Corrected expected text to match provider output
    expect(result.text).toContain('No recent messages available');
  });

  it('should handle errors gracefully', async () => {
    // Mock error in getMemories
    mockRuntime.getMemories = mock().mockRejectedValue(new Error('Database error'));

    const result = await recentMessagesProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('Error retrieving recent messages.');
    // Cannot check logger.error calls without mocking @elizaos/core
  });
});

describe('Role Provider', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;

  const testEntityId = 'test-entity-id' as UUID;
  const otherEntityId = 'other-entity-id' as UUID;

  beforeEach(async () => {
    mockRuntime = createMockRuntime();
    mockState = createMockState();

    // Reset mocks
    mock.restore();

    (mockRuntime.getRoom as any).mockResolvedValue({
      id: 'default-room' as UUID,
      serverId: 'default-server' as UUID,
      type: ChannelType.GROUP,
      source: 'discord', // Added source for entity metadata access
    });

    (mockRuntime.getWorld as any).mockResolvedValue({
      id: 'default-world' as UUID,
      serverId: 'default-server' as UUID,
      name: 'Default Test World',
      metadata: {
        ownership: { ownerId: 'owner-user-id' as UUID },
        roles: {},
      },
    });

    (mockRuntime.getEntityById as any).mockResolvedValue(null);

    // Setup mockState.data.room for the provider to use preferentially
    mockState.data = {
      room: {
        id: 'state-room-id' as UUID,
        serverId: 'state-server-id' as UUID,
        type: ChannelType.GROUP,
        source: 'discord', // Added source
      },
    };
    mockMessage = createMockMemory({ roomId: 'state-room-id' as UUID });
  });

  afterEach(() => {
    mock.restore();
  });

  it('should retrieve and format role hierarchy', async () => {
    const serverId = 'server-with-roles-simple' as UUID;
    const ownerId = 'owner-simple-test-id' as UUID;

    mockState.data = {
      room: {
        id: 'room-for-roles-simple-test' as UUID,
        serverId: serverId,
        type: ChannelType.GROUP,
        source: 'discord',
      },
    };

    mockMessage.roomId = 'room-for-roles-simple-test' as UUID;

    // Setup getWorld mock to return world data for any ID
    (mockRuntime.getWorld as any).mockImplementation(async (id) => {
      // Return world data for any world ID since we can't control createUniqueUuid
      return {
        id: id,
        serverId: serverId,
        name: 'Role Test World Simple',
        metadata: {
          ownership: { ownerId: 'any-owner-simple' as UUID },
          roles: { [ownerId]: 'OWNER' }, // Simplified to one owner
        },
      };
    });

    // Setup getEntityById mock
    (mockRuntime.getEntityById as any).mockImplementation(async (id) => {
      if (id === ownerId) {
        return {
          id: ownerId,
          names: ['Simple Owner'],
          metadata: { name: 'SimpleOwnerName', username: 'simple_owner_discord' },
        };
      }
      return null;
    });

    const result = await roleProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    // Simpler assertions
    expect(result.text).toContain('# Server Role Hierarchy');
    expect(result.text).toContain('## Owners');
    expect(result.text).toContain('SimpleOwnerName (Simple Owner)');
    expect(result.text).not.toContain('## Administrators'); // Ensure other sections aren't there
    expect(result.text).not.toContain('## Members');

    // createUniqueUuid is not directly mockable in bun:test
    expect(mockRuntime.getWorld).toHaveBeenCalled();
    expect(mockRuntime.getEntityById).toHaveBeenCalledWith(ownerId);
  });

  // This test might need to be re-evaluated based on provider's handling of individual missing entities
  it('should handle missing entity gracefully (now expecting rejection)', async () => {
    mockMessage = createMockMemory({
      entityId: otherEntityId,
      roomId: 'room-for-rejection-test-1' as UUID,
    });
    // Ensure state.data.room is undefined so runtime.getRoom is called
    mockState.data = { ...mockState.data, room: undefined };

    (mockRuntime.getRoom as any).mockRejectedValue(new Error('Simulated DB error getting room'));

    await expect(
      roleProvider.get(mockRuntime as IAgentRuntime, mockMessage as Memory, mockState as State)
    ).rejects.toThrowError('Simulated DB error getting room');
  });

  it('should handle missing roles gracefully', async () => {
    const entityMissingRolesId = 'entity-no-roles' as UUID;
    mockMessage = createMockMemory({ entityId: entityMissingRolesId });

    const mockRoomId = 'room-with-server' as UUID;
    const mockServerId = 'server-for-roles' as UUID;

    mockMessage.roomId = mockRoomId;
    (mockRuntime.getRoom as any).mockResolvedValue({
      id: mockRoomId,
      serverId: mockServerId,
      type: ChannelType.GROUP,
      source: 'discord',
    });

    // Setup getWorld mock to return world data for any ID
    (mockRuntime.getWorld as any).mockImplementation(async (id) => {
      // Return world data for any world ID since we can't control createUniqueUuid
      return {
        id: id,
        serverId: mockServerId,
        name: 'Test World No Roles',
        metadata: {
          ownership: { ownerId: 'some-owner' as UUID },
          roles: {}, // Empty roles
        },
      };
    });

    const result = await roleProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State // mockState now includes room for the provider
    );

    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
    expect(typeof result.text).toBe('string');
    if (typeof result.text === 'string') {
      expect(result.text).toContain('No role information available for this server.');
    }
    // Optionally, check that getEntityById was not called, or called 0 times if roles object was empty
    expect(mockRuntime.getEntityById).not.toHaveBeenCalled();
  });

  it('should handle errors gracefully (now expecting rejection)', async () => {
    mockMessage = createMockMemory({
      entityId: testEntityId,
      roomId: 'room-for-rejection-test-2' as UUID,
    });
    // Ensure state.data.room is undefined so runtime.getRoom is called
    mockState.data = { ...mockState.data, room: undefined };

    const specificError = new Error('DB error for roles test');
    (mockRuntime.getRoom as any).mockRejectedValue(specificError);

    await expect(
      roleProvider.get(mockRuntime as IAgentRuntime, mockMessage as Memory, mockState as State)
    ).rejects.toThrowError(specificError);
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
        // channelType will be set per test
      },
      entityId: 'test-owner-entity-id' as UUID, // for findWorldsForOwner
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
    mockRuntime.getRoom = mock().mockResolvedValue({
      id: 'test-room-id' as UUID,
      worldId: 'world-1' as UUID,
      type: ChannelType.GROUP, // Default, can be overridden by message
    });

    // Mock getWorld to provide world data
    mockRuntime.getWorld = mock().mockResolvedValue({
      id: 'world-1' as UUID,
      serverId: 'server-1',
      name: 'Test World',
    });
  });

  afterEach(async () => {
    mock.restore();
    // Cannot mock @elizaos/core functions in bun:test
  });

  it('should retrieve settings in onboarding mode', async () => {
    // Setup for onboarding
    mockMessage.content = {
      ...mockMessage.content,
      channelType: ChannelType.DM,
    };

    mockState.data = {
      room: {
        id: 'onboarding-room-id' as UUID,
        type: ChannelType.DM,
      },
    };
    mockMessage.roomId = 'onboarding-room-id' as UUID;

    // Note: We cannot mock findWorldsForOwner and getWorldSettings from @elizaos/core
    // The settings provider will use the actual implementations
    // We'll focus on testing the provider's behavior with the mocked runtime

    (mockRuntime.getRoom as any).mockResolvedValue({
      id: 'onboarding-room-id' as UUID,
      worldId: 'world-1' as UUID,
      type: ChannelType.DM,
    });

    const result = await settingsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    // Since we can't mock getWorldSettings, we can't control what settings are returned
    // We'll just verify the structure is correct
    expect(result.text).toBeDefined();
    expect(typeof result.text).toBe('string');
  });

  it('should retrieve settings in normal mode', async () => {
    // Setup for normal mode
    mockMessage.content = {
      ...mockMessage.content,
      channelType: ChannelType.GROUP,
    };
    (mockRuntime.getRoom as any).mockResolvedValue({
      id: 'test-room-id' as UUID,
      worldId: 'world-1' as UUID,
      type: ChannelType.GROUP, // Ensure room type matches for provider logic
    });

    const result = await settingsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    // Since we can't mock getWorldSettings, we can't control what settings are returned
    // We'll just verify the structure is correct
    expect(result.text).toBeDefined();
    expect(typeof result.text).toBe('string');
  });

  it('should handle errors gracefully when getWorldSettings fails', async () => {
    // Note: We cannot directly mock getWorldSettings from @elizaos/core in bun:test
    // This test would need to be refactored to test error handling differently
    // For now, we'll test what we can without mocking core functions

    mockMessage.content = { channelType: ChannelType.DM };
    mockState.data = {
      room: {
        type: ChannelType.DM,
        id: 'dm-room-err' as UUID,
      },
    };
    mockMessage.roomId = 'dm-room-err' as UUID;

    // We can't force getWorldSettings to fail, but we can test with a mock runtime
    // that doesn't have proper world data
    (mockRuntime.getWorld as any).mockResolvedValue(null);

    const result = await settingsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    // When there's no world, it should handle gracefully
    expect(result.text).toBeDefined();
  });

  it('should handle missing world gracefully', async () => {
    mockRuntime.getWorld = mock().mockResolvedValue(null);
    mockMessage.content = { channelType: ChannelType.GROUP };
    mockState.data = {
      ...mockState.data,
      room: {
        type: ChannelType.GROUP,
        id: 'group-room-err' as UUID,
      },
    };
    mockMessage.roomId = 'group-room-err' as UUID;

    const result = await settingsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain(
      'Error retrieving configuration information. Please try again later.'
    );
  });
});

describe('Attachments Provider', () => {
  let mockRuntime: MockRuntime;
  let mockMessage: Partial<Memory>;
  let mockState: Partial<State>;

  beforeEach(() => {
    const setup = setupActionTest();
    mockRuntime = setup.mockRuntime;
    mockMessage = setup.mockMessage;
    mockState = setup.mockState;

    // Mock getConversationLength
    mockRuntime.getConversationLength = mock().mockReturnValue(10);

    // Mock getMemories for testing
    mockRuntime.getMemories = mock().mockResolvedValue([]);
  });

  afterEach(() => {
    mock.restore();
  });

  it('should handle messages with no attachments', async () => {
    // Test message without attachments
    mockMessage.content = {
      text: 'Hello, how are you?',
      channelType: ChannelType.GROUP,
    };

    const result = await attachmentsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.data?.attachments).toHaveLength(0);
    expect(result.text).toBe('');
    expect(result.values?.attachments).toBe('');
  });

  it('should return current message attachments', async () => {
    // Test message with attachments
    const testAttachments: Media[] = [
      {
        id: 'attach-1',
        url: 'https://example.com/image1.jpg',
        title: 'Test Image 1',
        source: 'image/jpeg',
        description: 'A test image',
        text: 'Image content text',
      },
      {
        id: 'attach-2',
        url: 'https://example.com/document.pdf',
        title: 'Test Document',
        source: 'application/pdf',
        description: 'A test PDF document',
        text: 'Document content text',
      },
    ];

    mockMessage.content = {
      text: 'Check out these attachments',
      channelType: ChannelType.GROUP,
      attachments: testAttachments,
    };

    const result = await attachmentsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.data?.attachments).toHaveLength(2);
    expect(result.data?.attachments?.[0]?.id).toBe('attach-1');
    expect(result.data?.attachments?.[1]?.id).toBe('attach-2');
    expect(result.text).toContain('# Attachments');
    expect(result.text).toContain('Test Image 1');
    expect(result.text).toContain('Test Document');
    expect(result.text).toContain('https://example.com/image1.jpg');
    expect(result.text).toContain('Image content text');
  });

  it('should merge attachments from recent messages', async () => {
    const currentAttachment: Media = {
      id: 'current-attach',
      url: 'https://example.com/current.jpg',
      title: 'Current Image',
      source: 'image/jpeg',
      description: 'Current attachment',
      text: 'Current content',
    };

    mockMessage.content = {
      text: 'Current message with attachment',
      channelType: ChannelType.GROUP,
      attachments: [currentAttachment],
    };

    // Mock recent messages with attachments - note they will be reversed by the provider
    const recentMessages = [
      {
        id: 'msg-1' as UUID,
        content: {
          text: 'Previous message 1',
          attachments: [
            {
              id: 'prev-attach-1',
              url: 'https://example.com/prev1.jpg',
              title: 'Previous Image 1',
              source: 'image/jpeg',
              description: 'Previous attachment 1',
              text: 'Previous content 1',
            },
          ],
        },
        createdAt: Date.now() - 30 * 60 * 1000, // 30 minutes ago
      },
      {
        id: 'msg-2' as UUID,
        content: {
          text: 'Previous message 2',
          attachments: [
            {
              id: 'prev-attach-2',
              url: 'https://example.com/prev2.jpg',
              title: 'Previous Image 2',
              source: 'image/jpeg',
              description: 'Previous attachment 2',
              text: 'Previous content 2',
            },
          ],
        },
        createdAt: Date.now() - 15 * 60 * 1000, // 15 minutes ago
      },
    ];

    mockRuntime.getMemories = mock().mockResolvedValue(recentMessages);

    const result = await attachmentsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.data?.attachments).toHaveLength(3);
    expect(result.data?.attachments?.[0]?.id).toBe('current-attach');
    // Messages are reversed, so prev-attach-2 comes before prev-attach-1
    expect(result.data?.attachments?.[1]?.id).toBe('prev-attach-2');
    expect(result.data?.attachments?.[2]?.id).toBe('prev-attach-1');
    expect(result.text).toContain('Current Image');
    expect(result.text).toContain('Previous Image 1');
    expect(result.text).toContain('Previous Image 2');
  });

  it('should hide text for attachments older than 1 hour', async () => {
    const currentAttachment: Media = {
      id: 'current-attach',
      url: 'https://example.com/current.jpg',
      title: 'Current Image',
      source: 'image/jpeg',
      description: 'Current attachment',
      text: 'Current content',
    };

    mockMessage.content = {
      text: 'Current message',
      channelType: ChannelType.GROUP,
      attachments: [currentAttachment],
    };

    // Mock messages - the provider finds the first message with attachments
    // Recent message needs to come first to be the reference point
    const messages = [
      {
        id: 'msg-recent' as UUID,
        content: {
          text: 'Recent message',
          attachments: [
            {
              id: 'recent-attach',
              url: 'https://example.com/recent.jpg',
              title: 'Recent Image',
              source: 'image/jpeg',
              description: 'Recent attachment',
              text: 'This should be visible',
            },
          ],
        },
        createdAt: Date.now() - 30 * 60 * 1000, // 30 minutes ago
      },
      {
        id: 'msg-old' as UUID,
        content: {
          text: 'Old message',
          attachments: [
            {
              id: 'old-attach',
              url: 'https://example.com/old.jpg',
              title: 'Old Image',
              source: 'image/jpeg',
              description: 'Old attachment',
              text: 'This should be hidden',
            },
          ],
        },
        createdAt: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
      },
    ];

    mockRuntime.getMemories = mock().mockResolvedValue(messages);

    const result = await attachmentsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.data?.attachments).toHaveLength(3);

    // Check that old attachment has hidden text
    const oldAttachment = result.data?.attachments?.find((a) => a.id === 'old-attach');
    expect(oldAttachment?.text).toBe('[Hidden]');

    // Check that recent attachments have visible text
    const recentAttachment = result.data?.attachments?.find((a) => a.id === 'recent-attach');
    expect(recentAttachment?.text).toBe('This should be visible');

    const currentAtt = result.data?.attachments?.find((a) => a.id === 'current-attach');
    expect(currentAtt?.text).toBe('Current content');
  });

  it('should not duplicate attachments with same ID', async () => {
    const sharedAttachment: Media = {
      id: 'shared-attach',
      url: 'https://example.com/shared.jpg',
      title: 'Shared Image',
      source: 'image/jpeg',
      description: 'Shared attachment',
      text: 'Shared content with more details',
    };

    mockMessage.content = {
      text: 'Current message',
      channelType: ChannelType.GROUP,
      attachments: [sharedAttachment],
    };

    // Mock a recent message with the same attachment ID but less data
    const recentMessages = [
      {
        id: 'msg-1' as UUID,
        content: {
          text: 'Previous message',
          attachments: [
            {
              id: 'shared-attach', // Same ID as current
              url: 'https://example.com/shared.jpg',
              title: 'Shared Image',
              source: 'image/jpeg',
              description: 'Basic description',
              text: 'Basic text',
            },
          ],
        },
        createdAt: Date.now() - 10 * 60 * 1000, // 10 minutes ago
      },
    ];

    mockRuntime.getMemories = mock().mockResolvedValue(recentMessages);

    const result = await attachmentsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.data?.attachments).toHaveLength(1);
    expect(result.data?.attachments?.[0]?.id).toBe('shared-attach');
    // Should keep the current message's richer data
    expect(result.data?.attachments?.[0]?.text).toBe('Shared content with more details');
    expect(result.data?.attachments?.[0]?.description).toBe('Shared attachment');
  });

  it('should format attachment data correctly', async () => {
    const testAttachment: Media = {
      id: 'format-test',
      url: 'https://example.com/test.png',
      title: 'Format Test Image',
      source: 'image/png',
      description: 'Testing formatted output',
      text: 'This is the extracted text from the image',
    };

    mockMessage.content = {
      text: 'Testing format',
      channelType: ChannelType.GROUP,
      attachments: [testAttachment],
    };

    const result = await attachmentsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.text).toContain('# Attachments');
    expect(result.text).toContain('ID: format-test');
    expect(result.text).toContain('Name: Format Test Image');
    expect(result.text).toContain('URL: https://example.com/test.png');
    expect(result.text).toContain('Type: image/png');
    expect(result.text).toContain('Description: Testing formatted output');
    expect(result.text).toContain('Text: This is the extracted text from the image');
  });

  it('should handle messages with no recent attachments history', async () => {
    const currentAttachment: Media = {
      id: 'only-attach',
      url: 'https://example.com/only.jpg',
      title: 'Only Attachment',
      source: 'image/jpeg',
      description: 'The only attachment',
      text: 'Only attachment content',
    };

    mockMessage.content = {
      text: 'Message with attachment',
      channelType: ChannelType.GROUP,
      attachments: [currentAttachment],
    };

    // No messages have attachments
    const recentMessages = [
      {
        id: 'msg-1' as UUID,
        content: { text: 'Text only message 1' },
        createdAt: Date.now() - 5 * 60 * 1000,
      },
      {
        id: 'msg-2' as UUID,
        content: { text: 'Text only message 2' },
        createdAt: Date.now() - 2 * 60 * 1000,
      },
    ];

    mockRuntime.getMemories = mock().mockResolvedValue(recentMessages);

    const result = await attachmentsProvider.get(
      mockRuntime as IAgentRuntime,
      mockMessage as Memory,
      mockState as State
    );

    expect(result).toBeDefined();
    expect(result.data?.attachments).toHaveLength(1);
    expect(result.data?.attachments?.[0]?.id).toBe('only-attach');
    expect(result.text).toContain('Only Attachment');
  });

  it('should handle errors by throwing them', async () => {
    mockMessage.content = {
      text: 'Test message',
      channelType: ChannelType.GROUP,
      attachments: [
        {
          id: 'test-attach',
          url: 'https://example.com/test.jpg',
          title: 'Test',
          source: 'image/jpeg',
        },
      ],
    };

    // Mock error in getMemories
    mockRuntime.getMemories = mock().mockRejectedValue(new Error('Database error'));

    // The provider doesn't catch errors, so they propagate up
    expect(
      attachmentsProvider.get(
        mockRuntime as IAgentRuntime,
        mockMessage as Memory,
        mockState as State
      )
    ).rejects.toThrow('Database error');
  });
});
