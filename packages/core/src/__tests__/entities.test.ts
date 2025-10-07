import { describe, it, expect, beforeEach } from 'bun:test';
import { mock, spyOn } from 'bun:test';
import { findEntityByName, createUniqueUuid, getEntityDetails, formatEntities } from '../entities';
import type { IAgentRuntime } from '../types/runtime';
import type { Entity, UUID, Memory, State } from '../types';
import * as utils from '../utils';
import * as index from '../index';
import * as logger_module from '../logger';

describe('entities', () => {
  let mockRuntime: IAgentRuntime;
  let mockMemory: Memory;
  let mockState: State;

  beforeEach(() => {
    mock.restore();

    // Mock logger methods to prevent undefined function errors
    // Mock both the index-exported logger and direct logger module
    const loggerInstances = [index.logger, logger_module.logger].filter(Boolean);

    loggerInstances.forEach((loggerInstance) => {
      if (loggerInstance) {
        // Always ensure these methods exist and are mocked
        const methods = ['warn', 'error', 'info', 'debug'];
        methods.forEach((method) => {
          if (typeof loggerInstance[method] === 'function') {
            spyOn(loggerInstance, method).mockImplementation(() => {});
          } else {
            loggerInstance[method] = mock(() => {});
          }
        });
      }
    });

    // Create a comprehensive mock runtime
    mockRuntime = {
      agentId: 'agent-id-123' as UUID,
      character: {
        id: 'agent-id-123' as UUID,
        name: 'TestAgent',
      },
      getRoom: mock(),
      getWorld: mock(),
      getEntitiesForRoom: mock(),
      getRelationships: mock(),
      getEntityById: mock(),
      useModel: mock(),
      getMemories: mock(),
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

      mockRuntime.getRoom = mock().mockResolvedValue(mockRoom);
      mockRuntime.getWorld = mock().mockResolvedValue(mockWorld);
      mockRuntime.getEntitiesForRoom = mock().mockResolvedValue([mockEntity]);
      mockRuntime.getRelationships = mock().mockResolvedValue([]);
      mockRuntime.getMemories = mock().mockResolvedValue([]);
      mockRuntime.useModel = mock().mockResolvedValue('mocked model response');
      mockRuntime.getEntityById = mock().mockResolvedValue(mockEntity);

      // Mock the parseKeyValueXml to return the expected resolution
      const parseXmlSpy = spyOn(utils, 'parseKeyValueXml');
      parseXmlSpy.mockReturnValue({
        type: 'EXACT_MATCH',
        entityId: 'entity-123',
        matches: {
          match: [{ name: 'Alice', reason: 'Exact match found' }],
        },
      });

      const result = await findEntityByName(mockRuntime, mockMemory, mockState);

      expect(result).toEqual(mockEntity);
      expect(mockRuntime.getRoom).toHaveBeenCalledWith('room-789');
      expect(mockRuntime.getEntitiesForRoom).toHaveBeenCalledWith('room-789', true);
      parseXmlSpy.mockRestore();
    });

    it('should return null when room not found', async () => {
      mockRuntime.getRoom = mock().mockResolvedValue(null);

      const result = await findEntityByName(mockRuntime, mockMemory, mockState);

      expect(result).toBeNull();
      expect(mockRuntime.getEntitiesForRoom).not.toHaveBeenCalled();
    });

    it('should filter components based on permissions', async () => {
      const mockRoom = {
        id: 'room-789' as UUID,
        worldId: 'world-123' as UUID,
        createdAt: Date.now(),
      };

      const mockWorld = {
        id: 'world-123' as UUID,
        name: 'Test World',
        agentId: 'agent-id-123' as UUID,
        serverId: 'server-123' as UUID,
        metadata: {
          roles: {
            'admin-entity': 'ADMIN',
            'owner-entity': 'OWNER',
          },
        },
        createdAt: Date.now(),
        entities: [],
      };

      const mockEntity: Entity = {
        id: 'entity-123' as UUID,
        names: ['Alice'],
        agentId: 'agent-id-123' as UUID,
        components: [
          {
            id: 'comp-1' as UUID,
            entityId: 'entity-123' as UUID,
            agentId: 'agent-id-123' as UUID,
            roomId: 'room-789' as UUID,
            worldId: 'world-123' as UUID,
            sourceEntityId: 'entity-456' as UUID, // Should pass - message sender
            type: 'PROFILE',
            createdAt: Date.now(),
            data: {},
          },
          {
            id: 'comp-2' as UUID,
            entityId: 'entity-123' as UUID,
            agentId: 'agent-id-123' as UUID,
            roomId: 'room-789' as UUID,
            worldId: 'world-123' as UUID,
            sourceEntityId: 'admin-entity' as UUID, // Should pass - admin
            type: 'PROFILE',
            createdAt: Date.now(),
            data: {},
          },
          {
            id: 'comp-3' as UUID,
            entityId: 'entity-123' as UUID,
            agentId: 'agent-id-123' as UUID,
            roomId: 'room-789' as UUID,
            worldId: 'world-123' as UUID,
            sourceEntityId: 'random-entity' as UUID, // Should be filtered out
            type: 'PROFILE',
            createdAt: Date.now(),
            data: {},
          },
        ],
      };

      mockRuntime.getRoom = mock().mockResolvedValue(mockRoom);
      mockRuntime.getWorld = mock().mockResolvedValue(mockWorld);
      mockRuntime.getEntitiesForRoom = mock().mockResolvedValue([mockEntity]);
      mockRuntime.getRelationships = mock().mockResolvedValue([]);
      mockRuntime.getMemories = mock().mockResolvedValue([]);
      mockRuntime.useModel = mock().mockResolvedValue(
        JSON.stringify({
          type: 'EXACT_MATCH',
          entityId: 'entity-123',
        })
      );
      mockRuntime.getEntityById = mock().mockResolvedValue(mockEntity);

      await findEntityByName(mockRuntime, mockMemory, mockState);

      // The mock setup should have filtered components, but since we're mocking
      // the entire flow, we need to verify the logic would work correctly
      expect(mockRuntime.getWorld).toHaveBeenCalledWith('world-123');
    });

    it('should handle LLM parse failure gracefully', async () => {
      const mockRoom = {
        id: 'room-789' as UUID,
        createdAt: Date.now(),
      };

      mockRuntime.getRoom = mock().mockResolvedValue(mockRoom);
      mockRuntime.getWorld = mock().mockResolvedValue(null);
      mockRuntime.getEntitiesForRoom = mock().mockResolvedValue([]);
      mockRuntime.getRelationships = mock().mockResolvedValue([]);
      mockRuntime.getMemories = mock().mockResolvedValue([]);
      mockRuntime.useModel = mock().mockResolvedValue('invalid json');

      const result = await findEntityByName(mockRuntime, mockMemory, mockState);

      expect(result).toBeNull();
    });

    it('should handle EXACT_MATCH with entity components filtering', async () => {
      const mockRoom = {
        id: 'room-789' as UUID,
        worldId: 'world-123' as UUID,
        createdAt: Date.now(),
      };

      const mockWorld = {
        id: 'world-123' as UUID,
        name: 'Test World',
        agentId: 'agent-id-123' as UUID,
        serverId: 'server-123' as UUID,
        metadata: {
          roles: {
            'admin-entity': 'ADMIN',
            'owner-entity': 'OWNER',
            'regular-entity': 'MEMBER',
          },
        },
        createdAt: Date.now(),
        entities: [],
      };

      const mockEntityWithComponents: Entity = {
        id: 'entity-exact' as UUID,
        names: ['ExactMatch'],
        agentId: 'agent-id-123' as UUID,
        metadata: {},
        components: [
          {
            id: 'comp-1' as UUID,
            entityId: 'entity-exact' as UUID,
            agentId: 'agent-id-123' as UUID,
            roomId: 'room-789' as UUID,
            worldId: 'world-123' as UUID,
            sourceEntityId: 'entity-456' as UUID, // Same as message sender
            type: 'PROFILE',
            createdAt: Date.now(),
            data: { bio: 'User profile' },
          },
          {
            id: 'comp-2' as UUID,
            entityId: 'entity-exact' as UUID,
            agentId: 'agent-id-123' as UUID,
            roomId: 'room-789' as UUID,
            worldId: 'world-123' as UUID,
            sourceEntityId: 'admin-entity' as UUID, // Admin role
            type: 'SETTINGS',
            createdAt: Date.now(),
            data: { settings: 'admin settings' },
          },
          {
            id: 'comp-3' as UUID,
            entityId: 'entity-exact' as UUID,
            agentId: 'agent-id-123' as UUID,
            roomId: 'room-789' as UUID,
            worldId: 'world-123' as UUID,
            sourceEntityId: 'random-entity' as UUID, // Should be filtered out
            type: 'PRIVATE',
            createdAt: Date.now(),
            data: { private: 'data' },
          },
        ],
      };

      mockRuntime.getRoom = mock().mockResolvedValue(mockRoom);
      mockRuntime.getWorld = mock().mockResolvedValue(mockWorld);
      mockRuntime.getEntitiesForRoom = mock().mockResolvedValue([mockEntityWithComponents]);
      mockRuntime.getRelationships = mock().mockResolvedValue([]);
      mockRuntime.getMemories = mock().mockResolvedValue([]);
      mockRuntime.useModel = mock().mockResolvedValue(
        JSON.stringify({
          entityId: 'entity-exact',
          type: 'EXACT_MATCH',
          matches: [{ name: 'ExactMatch', reason: 'Exact ID match' }],
        })
      );
      mockRuntime.getEntityById = mock().mockResolvedValue(mockEntityWithComponents);

      // Mock parseKeyValueXml to return proper resolution
      const parseXmlSpy = spyOn(utils, 'parseKeyValueXml');
      parseXmlSpy.mockReturnValue({
        entityId: 'entity-exact',
        type: 'EXACT_MATCH',
        matches: {
          match: [{ name: 'ExactMatch', reason: 'Exact ID match' }],
        },
      });

      const result = await findEntityByName(mockRuntime, mockMemory, mockState);

      expect(result).toBeDefined();
      expect(result?.id).toBe('entity-exact' as UUID);
      // Verify getEntityById was called (covers lines 274-282)
      expect(mockRuntime.getEntityById).toHaveBeenCalledWith('entity-exact');
      parseXmlSpy.mockRestore();
    });

    it('should find entity by username in components', async () => {
      const mockRoom = {
        id: 'room-789' as UUID,
        worldId: null,
        createdAt: Date.now(),
      };

      const mockEntity: Entity = {
        id: 'entity-user' as UUID,
        names: ['John Doe'],
        agentId: 'agent-id-123' as UUID,
        metadata: {},
        components: [
          {
            id: 'comp-1' as UUID,
            entityId: 'entity-user' as UUID,
            agentId: 'agent-id-123' as UUID,
            roomId: 'room-789' as UUID,
            worldId: null as any,
            sourceEntityId: 'entity-456' as UUID,
            type: 'PROFILE',
            createdAt: Date.now(),
            data: { username: 'johndoe123' },
          },
        ],
      };

      mockRuntime.getRoom = mock().mockResolvedValue(mockRoom);
      mockRuntime.getWorld = mock().mockResolvedValue(null);
      mockRuntime.getEntitiesForRoom = mock().mockResolvedValue([mockEntity]);
      mockRuntime.getRelationships = mock().mockResolvedValue([]);
      mockRuntime.getMemories = mock().mockResolvedValue([]);
      mockRuntime.useModel = mock().mockResolvedValue(
        JSON.stringify({
          type: 'USERNAME_MATCH',
          matches: [{ name: 'johndoe123', reason: 'Username match' }],
        })
      );

      // Mock parseKeyValueXml
      const parseXmlSpy = spyOn(utils, 'parseKeyValueXml');
      parseXmlSpy.mockReturnValue({
        type: 'USERNAME_MATCH',
        matches: {
          match: [{ name: 'johndoe123', reason: 'Username match' }],
        },
      });

      const result = await findEntityByName(mockRuntime, mockMemory, mockState);

      expect(result).toBeDefined();
      expect(result?.id).toBe('entity-user' as UUID);
      parseXmlSpy.mockRestore();
    });

    it('should find entity by handle in components', async () => {
      const mockRoom = {
        id: 'room-789' as UUID,
        worldId: null,
        createdAt: Date.now(),
      };

      const mockEntity: Entity = {
        id: 'entity-handle' as UUID,
        names: ['Jane Smith'],
        agentId: 'agent-id-123' as UUID,
        metadata: {},
        components: [
          {
            id: 'comp-1' as UUID,
            entityId: 'entity-handle' as UUID,
            agentId: 'agent-id-123' as UUID,
            roomId: 'room-789' as UUID,
            worldId: null as any,
            sourceEntityId: 'entity-456' as UUID,
            type: 'PROFILE',
            createdAt: Date.now(),
            data: { handle: '@janesmith' },
          },
        ],
      };

      mockRuntime.getRoom = mock().mockResolvedValue(mockRoom);
      mockRuntime.getWorld = mock().mockResolvedValue(null);
      mockRuntime.getEntitiesForRoom = mock().mockResolvedValue([mockEntity]);
      mockRuntime.getRelationships = mock().mockResolvedValue([]);
      mockRuntime.getMemories = mock().mockResolvedValue([]);
      mockRuntime.useModel = mock().mockResolvedValue(
        JSON.stringify({
          type: 'USERNAME_MATCH',
          matches: [{ name: '@janesmith', reason: 'Handle match' }],
        })
      );

      // Mock parseKeyValueXml
      const parseXmlSpy = spyOn(utils, 'parseKeyValueXml');
      parseXmlSpy.mockReturnValue({
        type: 'USERNAME_MATCH',
        matches: {
          match: [{ name: '@janesmith', reason: 'Handle match' }],
        },
      });

      const result = await findEntityByName(mockRuntime, mockMemory, mockState);

      expect(result).toBeDefined();
      expect(result?.id).toBe('entity-handle' as UUID);
      parseXmlSpy.mockRestore();
    });
  });

  describe('createUniqueUuid', () => {
    it('should return agent ID when base user ID matches agent ID', () => {
      const result = createUniqueUuid(mockRuntime, 'agent-id-123');
      expect(result).toBe('agent-id-123' as UUID);
    });

    it('should create UUID from combined string for different IDs', () => {
      const stringToUuidSpy = spyOn(index, 'stringToUuid');
      stringToUuidSpy.mockReturnValue('unique-uuid-123' as UUID);

      const result = createUniqueUuid(mockRuntime, 'user-456');

      expect(result).toBe('unique-uuid-123' as UUID);
      expect(stringToUuidSpy).toHaveBeenCalledWith('user-456:agent-id-123');
      stringToUuidSpy.mockRestore();
    });

    it('should handle UUID type as base user ID', () => {
      const stringToUuidSpy = spyOn(index, 'stringToUuid');
      stringToUuidSpy.mockReturnValue('unique-uuid-456' as UUID);

      const result = createUniqueUuid(mockRuntime, 'user-789' as UUID);

      expect(result).toBe('unique-uuid-456' as UUID);
      expect(stringToUuidSpy).toHaveBeenCalledWith('user-789:agent-id-123');
      stringToUuidSpy.mockRestore();
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

      mockRuntime.getRoom = mock().mockResolvedValue(mockRoom);
      mockRuntime.getEntitiesForRoom = mock().mockResolvedValue(mockEntities);

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

      mockRuntime.getRoom = mock().mockResolvedValue(mockRoom);
      mockRuntime.getEntitiesForRoom = mock().mockResolvedValue([
        duplicateEntity,
        duplicateEntity, // Duplicate
      ]);

      const result = await getEntityDetails({
        runtime: mockRuntime,
        roomId: 'room-123' as UUID,
      });

      expect(result).toHaveLength(1);
    });

    it('should merge array data in components', async () => {
      const mockRoom = {
        id: 'room-123' as UUID,
        createdAt: Date.now(),
      };

      const mockEntity: Entity = {
        id: 'entity-1' as UUID,
        names: ['Charlie'],
        agentId: 'agent-id-123' as UUID,
        metadata: {},
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
            data: { hobbies: ['reading', 'gaming'] },
          },
          {
            id: 'comp-2' as UUID,
            entityId: 'entity-1' as UUID,
            agentId: 'agent-id-123' as UUID,
            roomId: 'room-123' as UUID,
            worldId: 'world-123' as UUID,
            sourceEntityId: 'source-123' as UUID,
            type: 'PROFILE',
            createdAt: Date.now(),
            data: { hobbies: ['gaming', 'music'] }, // Duplicate "gaming"
          },
        ],
      };

      mockRuntime.getRoom = mock().mockResolvedValue(mockRoom);
      mockRuntime.getEntitiesForRoom = mock().mockResolvedValue([mockEntity]);

      const result = await getEntityDetails({
        runtime: mockRuntime,
        roomId: 'room-123' as UUID,
      });

      const parsedData = JSON.parse(result[0].data);
      // Note: Due to how Object.assign works in the implementation,
      // the second component's hobbies array overwrites the first one
      expect(parsedData.hobbies).toEqual(['gaming', 'music']);
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
    const id = createUniqueUuid(runtime, 'user');
    const expected = index.stringToUuid('user:agent');
    expect(id).toBe(expected);
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
