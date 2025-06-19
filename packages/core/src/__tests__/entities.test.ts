import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { findEntityByName, createUniqueUuid, getEntityDetails, formatEntities } from '../entities';
import type { IAgentRuntime } from '../types/runtime';
import type { Entity, UUID, Memory, State } from '../types';

// We'll import and manually override the specific functions we need to mock
import * as utils from '../utils';
import * as indexExports from '../index';

// Create mock functions
const mockParseJSONObjectFromText = jest.fn();
const mockStringToUuid = jest.fn();

describe('entities', () => {
  let mockRuntime: IAgentRuntime;
  let mockMemory: Memory;
  let mockState: State;

  beforeEach(() => {
    // Use jest.spyOn to mock functions instead of direct assignment
    jest.spyOn(utils, 'parseJSONObjectFromText').mockImplementation(mockParseJSONObjectFromText);
    jest.spyOn(indexExports, 'stringToUuid').mockImplementation(mockStringToUuid);

    // Clear all mocks
    jest.clearAllMocks();

    // Create a comprehensive mock runtime
    mockRuntime = {
      agentId: 'agent-id-123' as UUID,
      character: {
        id: 'agent-id-123' as UUID,
        name: 'TestAgent',
      },
      getRoom: jest.fn(),
      getWorld: jest.fn(),
      getEntitiesForRoom: jest.fn(),
      getRelationships: jest.fn(),
      getEntityById: jest.fn(),
      useModel: jest.fn(),
      getMemories: jest.fn(),
    } as unknown as IAgentRuntime;

    // Create mock memory
    mockMemory = {
      id: 'memory-123' as UUID,
      entityId: 'entity-456' as UUID,
      roomId: 'room-789' as UUID,
      content: {},
    } as Memory;

    // Create mock state
    mockState = {
      data: {
        room: null,
      },
      values: {},
      text: '',
    };
  });

  afterEach(() => {
    // Restore all mocks
    jest.restoreAllMocks();
  });

  describe('findEntityByName', () => {
    it('should find entity by exact name match', async () => {
      const mockRoom = {
        id: 'room-789' as UUID,
        name: 'Test Room',
        worldId: 'world-123' as UUID,
        createdAt: Date.now(),
      };

      const mockWorld = {
        id: 'world-123' as UUID,
        name: 'Test World',
        agentId: 'agent-id-123' as UUID,
        serverId: 'server-123' as UUID,
        metadata: {
          roles: {},
        },
        createdAt: Date.now(),
        entities: [],
      };

      const mockEntity: Entity = {
        id: 'entity-123' as UUID,
        names: ['Alice', 'Alice Smith'],
        agentId: 'agent-id-123' as UUID,
        metadata: {},
        components: [],
      };

      (mockRuntime.getRoom as jest.Mock).mockResolvedValue(mockRoom);
      (mockRuntime.getWorld as jest.Mock).mockResolvedValue(mockWorld);
      (mockRuntime.getEntitiesForRoom as jest.Mock).mockResolvedValue([mockEntity]);
      (mockRuntime.getRelationships as jest.Mock).mockResolvedValue([]);
      (mockRuntime.getMemories as jest.Mock).mockResolvedValue([]);
      (mockRuntime.useModel as jest.Mock).mockResolvedValue('mocked model response');
      (mockRuntime.getEntityById as jest.Mock).mockResolvedValue(mockEntity);

      // Mock the parseJSONObjectFromText to return the expected resolution
      mockParseJSONObjectFromText.mockReturnValue({
        type: 'EXACT_MATCH',
        entityId: 'entity-123',
        matches: [{ name: 'Alice', reason: 'Exact match found' }],
      });

      const result = await findEntityByName(mockRuntime, mockMemory, mockState);

      expect(result).toEqual(mockEntity);
      expect(mockRuntime.getRoom).toHaveBeenCalledWith('room-789');
      expect(mockRuntime.getEntitiesForRoom).toHaveBeenCalledWith('room-789', true);
    });

    it('should return null when room not found', async () => {
      (mockRuntime.getRoom as jest.Mock).mockResolvedValue(null);

      const result = await findEntityByName(mockRuntime, mockMemory, mockState);

      expect(result).toBeNull();
      expect(mockRuntime.getEntitiesForRoom).not.toHaveBeenCalled();
    });

    it('should handle LLM parse failure gracefully', async () => {
      const mockRoom = {
        id: 'room-789' as UUID,
        createdAt: Date.now(),
      };

      (mockRuntime.getRoom as jest.Mock).mockResolvedValue(mockRoom);
      (mockRuntime.getWorld as jest.Mock).mockResolvedValue(null);
      (mockRuntime.getEntitiesForRoom as jest.Mock).mockResolvedValue([]);
      (mockRuntime.getRelationships as jest.Mock).mockResolvedValue([]);
      (mockRuntime.getMemories as jest.Mock).mockResolvedValue([]);
      (mockRuntime.useModel as jest.Mock).mockResolvedValue('invalid json');

      const result = await findEntityByName(mockRuntime, mockMemory, mockState);

      expect(result).toBeNull();
    });
  });

  describe('createUniqueUuid', () => {
    it('should return agent ID when base user ID matches agent ID', () => {
      const result = createUniqueUuid(mockRuntime, 'agent-id-123');

      expect(result).toBe('agent-id-123' as UUID);
      expect(mockStringToUuid).not.toHaveBeenCalled();
    });

    it('should create UUID from combined string for different IDs', () => {
      // Mock stringToUuid from utils module
      mockStringToUuid.mockReturnValue('unique-uuid-123' as UUID);

      const result = createUniqueUuid(mockRuntime, 'user-456');

      expect(result).toBe('unique-uuid-123' as UUID);
      expect(mockStringToUuid).toHaveBeenCalledWith('user-456:agent-id-123');
    });

    it('should handle UUID type as base user ID', () => {
      // Mock stringToUuid from utils module
      mockStringToUuid.mockReturnValue('unique-uuid-456' as UUID);

      const result = createUniqueUuid(mockRuntime, 'user-789' as UUID);

      expect(result).toBe('unique-uuid-456' as UUID);
      expect(mockStringToUuid).toHaveBeenCalledWith('user-789:agent-id-123');
    });
  });

  describe('getEntityDetails', () => {
    it('should retrieve and format entity details for a room', async () => {
      const mockRoom = {
        id: 'room-123' as UUID,
        source: 'discord',
        createdAt: Date.now(),
      };

      const mockEntities: Entity[] = [
        {
          id: 'entity-1' as UUID,
          names: ['Alice', 'Alice Smith'],
          agentId: 'agent-id-123' as UUID,
          metadata: {
            bio: 'Test bio',
            discord: { name: 'Alice#1234' },
          },
          components: [
            {
              id: 'comp-1' as UUID,
              entityId: 'entity-1' as UUID,
              agentId: 'agent-id-123' as UUID,
              roomId: 'room-123' as UUID,
              worldId: 'world-123' as UUID,
              sourceEntityId: 'source-123' as UUID,
              type: 'PROFILE',
              createdAt: Date.now(),
              data: { avatar: 'avatar.jpg' },
            },
            {
              id: 'comp-2' as UUID,
              entityId: 'entity-1' as UUID,
              agentId: 'agent-id-123' as UUID,
              roomId: 'room-123' as UUID,
              worldId: 'world-123' as UUID,
              sourceEntityId: 'source-123' as UUID,
              type: 'SETTINGS',
              createdAt: Date.now(),
              data: { theme: 'dark' },
            },
          ],
        },
        {
          id: 'entity-2' as UUID,
          names: ['Bob'],
          agentId: 'agent-id-123' as UUID,
          metadata: {},
          components: [],
        },
      ];

      (mockRuntime.getRoom as jest.Mock).mockResolvedValue(mockRoom);
      (mockRuntime.getEntitiesForRoom as jest.Mock).mockResolvedValue(mockEntities);

      const result = await getEntityDetails({
        runtime: mockRuntime,
        roomId: 'room-123' as UUID,
      });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 'entity-1',
        name: 'Alice#1234', // Uses discord name from metadata
        names: ['Alice', 'Alice Smith'],
        data: expect.stringContaining('avatar'),
      });
      expect(result[1]).toEqual({
        id: 'entity-2',
        name: 'Bob',
        names: ['Bob'],
        data: '{}',
      });
    });

    it('should handle deduplication of entities', async () => {
      const mockRoom = {
        id: 'room-123' as UUID,
        createdAt: Date.now(),
      };

      const duplicateEntity = {
        id: 'entity-1' as UUID,
        names: ['Alice'],
        agentId: 'agent-id-123' as UUID,
        metadata: {},
        components: [],
      };

      (mockRuntime.getRoom as jest.Mock).mockResolvedValue(mockRoom);
      (mockRuntime.getEntitiesForRoom as jest.Mock).mockResolvedValue([
        duplicateEntity,
        duplicateEntity, // Duplicate
      ]);

      const result = await getEntityDetails({
        runtime: mockRuntime,
        roomId: 'room-123' as UUID,
      });

      expect(result).toHaveLength(1);
    });
  });

  describe('formatEntities', () => {
    it('should format single entity with basic info', () => {
      const entities: Entity[] = [
        {
          id: 'entity-1' as UUID,
          names: ['Alice'],
          agentId: 'agent-id-123' as UUID,
          metadata: { bio: 'Test bio' },
        },
      ];

      const result = formatEntities({ entities });

      expect(result).toContain('"Alice"');
      expect(result).toContain('ID: entity-1');
      expect(result).toContain('Data: {"bio":"Test bio"}');
    });

    it('should format multiple entities', () => {
      const entities: Entity[] = [
        {
          id: 'entity-1' as UUID,
          names: ['Alice', 'Alice Smith'],
          agentId: 'agent-id-123' as UUID,
          metadata: { role: 'Developer' },
        },
        {
          id: 'entity-2' as UUID,
          names: ['Bob'],
          agentId: 'agent-id-123' as UUID,
          metadata: { role: 'Manager' },
        },
      ];

      const result = formatEntities({ entities });

      expect(result).toContain('"Alice" aka "Alice Smith"');
      expect(result).toContain('"Bob"');
      expect(result).toContain('ID: entity-1');
      expect(result).toContain('ID: entity-2');
      expect(result).toContain('{"role":"Developer"}');
      expect(result).toContain('{"role":"Manager"}');
    });

    it('should handle entities without metadata', () => {
      const entities: Entity[] = [
        {
          id: 'entity-1' as UUID,
          names: ['Charlie'],
          agentId: 'agent-id-123' as UUID,
        },
      ];

      const result = formatEntities({ entities });

      expect(result).toContain('"Charlie"');
      expect(result).toContain('ID: entity-1');
      expect(result).not.toContain('Data:');
    });

    it('should handle empty entities array', () => {
      const result = formatEntities({ entities: [] });
      expect(result).toBe('');
    });

    it('should handle entities with empty metadata', () => {
      const entities: Entity[] = [
        {
          id: 'entity-1' as UUID,
          names: ['David'],
          agentId: 'agent-id-123' as UUID,
          metadata: {},
        },
      ];

      const result = formatEntities({ entities });

      expect(result).toContain('"David"');
      expect(result).toContain('ID: entity-1');
      expect(result).not.toContain('Data:');
    });
  });

  it('createUniqueUuid combines user and agent ids', () => {
    const runtime = { agentId: 'agent' } as any;
    mockStringToUuid.mockReturnValue('expected-uuid' as UUID);
    const id = createUniqueUuid(runtime, 'user');
    expect(id).toBe('expected-uuid' as UUID);
    expect(mockStringToUuid).toHaveBeenCalledWith('user:agent');
  });

  it('formatEntities outputs joined string', () => {
    const entities = [
      { id: '1', names: ['A'], metadata: {} },
      { id: '2', names: ['B'], metadata: { extra: true } },
    ] as any;
    const text = formatEntities({ entities });
    expect(text).toContain('"A"');
    expect(text).toContain('ID: 1');
    expect(text).toContain('ID: 2');
  });
});
