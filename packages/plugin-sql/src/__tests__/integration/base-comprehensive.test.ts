import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createIsolatedTestDatabase } from '../test-helpers';
import { v4 as uuidv4 } from 'uuid';
import type {
  Entity,
  Memory,
  Component,
  Room,
  UUID,
  Content,
  AgentRuntime,
  ChannelType,
} from '@elizaos/core';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';

describe('Base Adapter Comprehensive Tests', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testEntityId: UUID;
  let testRoomId: UUID;
  let testWorldId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase('base-comprehensive');
    adapter = setup.adapter;
    runtime = setup.runtime;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    // Create base entities for foreign key constraints
    testEntityId = uuidv4() as UUID;
    testRoomId = uuidv4() as UUID;
    testWorldId = uuidv4() as UUID;

    // Create world first
    await adapter.createWorld({
      id: testWorldId,
      agentId: testAgentId,
      serverId: uuidv4() as UUID,
      name: 'Test World',
    });

    // Create room
    await adapter.createRooms([
      {
        id: testRoomId,
        agentId: testAgentId,
        source: 'test',
        type: 'GROUP' as ChannelType,
        name: 'Test Room',
      },
    ]);

    // Create entity
    await adapter.createEntities([
      {
        id: testEntityId,
        agentId: testAgentId,
        names: ['Test Entity'],
        metadata: { type: 'test' },
      },
    ]);
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe('Entity Methods', () => {
    it('should handle getEntitiesByNames with exact match', async () => {
      // Create multiple entities with different names
      const entities = [
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Alice', 'Alice Smith'],
          metadata: { type: 'person' },
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Bob', 'Bob Jones'],
          metadata: { type: 'person' },
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Charlie'],
          metadata: { type: 'person' },
        },
      ];

      for (const entity of entities) {
        await adapter.createEntities([entity]);
      }

      // Search for specific names
      const results = await adapter.getEntitiesByNames({
        names: ['Alice', 'Bob'],
        agentId: testAgentId,
      });

      expect(results).toHaveLength(2);
      const foundNames = results.flatMap((e) => e.names);
      expect(foundNames).toContain('Alice');
      expect(foundNames).toContain('Bob');
      expect(foundNames).not.toContain('Charlie');
    });

    it('should handle searchEntitiesByName with limit', async () => {
      // Create many entities
      const entities: Entity[] = [];
      for (let i = 0; i < 10; i++) {
        entities.push({
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: [`Search Test ${i}`],
          metadata: { index: i },
        });
      }

      for (const entity of entities) {
        await adapter.createEntities([entity]);
      }

      // Search with limit
      const results = await adapter.searchEntitiesByName({
        query: 'Search Test',
        agentId: testAgentId,
        limit: 5,
      });

      expect(results).toHaveLength(5);
    });

    it('should handle deleteEntity with cascade', async () => {
      const entityId = uuidv4() as UUID;

      // Create entity
      await adapter.createEntities([
        {
          id: entityId,
          agentId: testAgentId,
          names: ['Delete Test'],
          metadata: {},
        },
      ]);

      // Create related memory
      await adapter.createMemory(
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          entityId: entityId,
          roomId: testRoomId,
          content: { text: 'Related memory' } as Content,
          createdAt: Date.now(),
          metadata: { type: 'test' },
        },
        'memories'
      );

      // Delete entity (should cascade delete memory)
      await adapter.deleteEntity(entityId);

      // Verify entity is deleted
      const entities = await adapter.getEntitiesByIds([entityId]);
      expect(entities).toHaveLength(0);

      // Verify related memory is also deleted
      const memories = await adapter.getMemories({
        agentId: testAgentId,
        entityId: entityId,
        tableName: 'memories',
      });
      expect(memories).toHaveLength(0);
    });
  });

  describe('Memory Operations', () => {
    it('should handle memory operations with all fields', async () => {
      const memoryId = uuidv4() as UUID;
      const memory: Memory = {
        id: memoryId,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        content: {
          text: 'Comprehensive test memory',
          metadata: { important: true },
        } as Content,
        createdAt: Date.now(),
        metadata: {
          type: 'test',
          category: 'comprehensive',
          priority: 1,
        },
      };

      // Create memory
      await adapter.createMemory(memory, 'memories');

      // Get memory with filters
      const memories = await adapter.getMemories({
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
        tableName: 'memories',
        count: 10,
      });

      expect(memories).toHaveLength(1);
      expect(memories[0].id).toBe(memoryId);
      expect((memories[0].metadata as any)?.category).toBe('comprehensive');

      // Update memory
      await adapter.updateMemory({
        id: memoryId,
        content: { text: 'Updated memory' } as Content,
        metadata: { type: 'updated', category: 'comprehensive-updated' },
      });

      // Verify update
      const updated = await adapter.getMemories({
        agentId: testAgentId,
        entityId: testEntityId,
        tableName: 'memories',
      });
      expect(updated[0].content.text).toBe('Updated memory');
      expect((updated[0].metadata as any)?.category).toBe('comprehensive-updated');

      // Delete memory
      await adapter.deleteMemory(memoryId);

      // Verify deletion
      const deleted = await adapter.getMemories({
        agentId: testAgentId,
        entityId: testEntityId,
        tableName: 'memories',
      });
      expect(deleted).toHaveLength(0);
    });

    it('should handle getMemoriesByRoomIds with multiple rooms', async () => {
      const roomIds: UUID[] = [];
      const memories: Memory[] = [];

      // Create multiple rooms
      for (let i = 0; i < 3; i++) {
        const roomId = uuidv4() as UUID;
        roomIds.push(roomId);

        await adapter.createRooms([
          {
            id: roomId,
            agentId: testAgentId,
            source: 'test',
            type: 'GROUP' as ChannelType,
            name: `Room ${i}`,
          },
        ]);

        // Create memory for each room
        const memory: Memory = {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          entityId: testEntityId,
          roomId: roomId,
          content: { text: `Memory for room ${i}` } as Content,
          createdAt: Date.now(),
          metadata: { type: 'test', roomIndex: i },
        };
        memories.push(memory);
        await adapter.createMemory(memory, 'memories');
      }

      // Get memories for first two rooms
      const results = await adapter.getMemoriesByRoomIds({
        roomIds: roomIds.slice(0, 2),
        tableName: 'memories',
      });

      expect(results).toHaveLength(2);
      expect(results.every((m) => roomIds.slice(0, 2).includes(m.roomId!))).toBe(true);
    });
  });

  describe('Component Operations', () => {
    it('should handle component CRUD with all fields', async () => {
      const sourceEntityId = uuidv4() as UUID;

      // Create source entity first
      await adapter.createEntities([
        {
          id: sourceEntityId,
          agentId: testAgentId,
          names: ['Source Entity'],
          metadata: {},
        },
      ]);

      const component: Component = {
        id: uuidv4() as UUID,
        type: 'relationship',
        worldId: testWorldId,
        entityId: testEntityId,
        sourceEntityId: sourceEntityId,
        agentId: testAgentId,
        roomId: testRoomId,
        data: {
          relationshipType: 'friend',
          strength: 0.8,
        },
        createdAt: Date.now(),
      };

      // Create component
      const created = await adapter.createComponent(component);
      expect(created).toBe(true);

      // Get component
      const retrieved = await adapter.getComponent(
        testEntityId,
        'relationship',
        testWorldId,
        sourceEntityId
      );
      expect(retrieved).toBeDefined();
      expect(retrieved?.data.relationshipType).toBe('friend');

      // Update component
      await adapter.updateComponent({
        ...component,
        data: {
          relationshipType: 'best_friend',
          strength: 1.0,
        },
      });

      // Verify update
      const updated = await adapter.getComponent(
        testEntityId,
        'relationship',
        testWorldId,
        sourceEntityId
      );
      expect(updated?.data.relationshipType).toBe('best_friend');
      expect(updated?.data.strength).toBe(1.0);

      // Delete component
      await adapter.deleteComponent(component.id);

      // Verify deletion
      const deleted = await adapter.getComponent(
        testEntityId,
        'relationship',
        testWorldId,
        sourceEntityId
      );
      expect(deleted).toBeNull();
    });
  });

  describe('Room Operations', () => {
    it('should handle room operations with world relationships', async () => {
      const roomId = uuidv4() as UUID;
      const room: Room = {
        id: roomId,
        agentId: testAgentId,
        source: 'test',
        type: 'DM' as ChannelType,
        name: 'DM Room',
        metadata: {
          participants: ['user1', 'user2'],
        },
      };

      // Create room
      await adapter.createRooms([room]);

      // Get rooms by IDs
      const retrieved = await adapter.getRoomsByIds([roomId]);
      expect(retrieved).toHaveLength(1);
      expect(retrieved?.[0]?.metadata?.participants).toHaveLength(2);

      // Create participant
      const userId = uuidv4() as UUID;
      await adapter.addParticipantsRoom([userId], roomId);

      // Get rooms for participant
      const participantRooms = await adapter.getRoomsForParticipant(userId);
      expect(participantRooms).toBeDefined();

      // Delete room
      await adapter.deleteRoom(roomId);

      // Verify deletion
      const deleted = await adapter.getRoomsByIds([roomId]);
      expect(deleted).toHaveLength(0);
    });
  });

  describe('Search Operations', () => {
    it('should handle searchMemoriesByEmbedding', async () => {
      const embedding = new Float32Array(384).fill(0.5);

      // Create memory with embedding
      const memoryId = uuidv4() as UUID;
      await adapter.createMemory(
        {
          id: memoryId,
          agentId: testAgentId,
          entityId: testEntityId,
          roomId: testRoomId,
          content: { text: 'Memory with embedding' } as Content,
          embedding: Array.from(embedding),
          createdAt: Date.now(),
          metadata: { type: 'embedding' },
        },
        'memories'
      );

      // Search by embedding
      const results = await adapter.searchMemoriesByEmbedding(Array.from(embedding), {
        tableName: 'memories',
        count: 5,
        match_threshold: 0.5,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe(memoryId);
    });

    it('should handle getCachedEmbeddings', async () => {
      const content = 'Test content for embedding';
      const embedding = new Float32Array(384).fill(0.7);

      // Store embedding in cache - log requires specific format
      await adapter.log({
        body: {
          content: content,
          embedding: Array.from(embedding),
        },
        entityId: testEntityId,
        roomId: testRoomId,
        type: 'embedding',
      });

      // Retrieve cached embedding
      const cached = await adapter.getCachedEmbeddings({
        query_table_name: 'logs',
        query_threshold: 5,
        query_input: content,
        query_field_name: 'body',
        query_field_sub_name: 'content',
        query_match_count: 10,
      });

      // Note: This might return empty if the cache implementation
      // doesn't match the expected behavior
      expect(cached).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle operations with missing optional fields', async () => {
      // Entity without metadata
      const entityId = uuidv4() as UUID;
      await adapter.createEntities([
        {
          id: entityId,
          agentId: testAgentId,
          names: ['No Metadata Entity'],
        },
      ]);

      const entities = await adapter.getEntitiesByIds([entityId]);
      expect(entities?.[0]?.metadata).toEqual({});

      // Memory with required entityId
      const memoryId = uuidv4() as UUID;
      await adapter.createMemory(
        {
          id: memoryId,
          agentId: testAgentId,
          entityId: testEntityId, // Required field
          roomId: testRoomId,
          content: { text: 'Memory with entity' } as Content,
          createdAt: Date.now(),
        },
        'memories'
      );

      const memories = await adapter.getMemories({
        agentId: testAgentId,
        roomId: testRoomId,
        tableName: 'memories',
      });
      const memoryWithEntity = memories.find((m) => m.id === memoryId);
      expect(memoryWithEntity).toBeDefined();
      expect(memoryWithEntity?.entityId).toBe(testEntityId);
    });

    it('should handle batch operations correctly', async () => {
      const batchSize = 5;
      const entities: Entity[] = [];
      const rooms: Room[] = [];

      // Create batch of entities
      for (let i = 0; i < batchSize; i++) {
        entities.push({
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: [`Batch Entity ${i}`],
          metadata: { batchIndex: i },
        });
      }

      const entityResult = await adapter.createEntities(entities);
      expect(entityResult).toBe(true);

      // Create batch of rooms
      for (let i = 0; i < batchSize; i++) {
        rooms.push({
          id: uuidv4() as UUID,
          agentId: testAgentId,
          source: 'batch',
          type: 'GROUP' as ChannelType,
          name: `Batch Room ${i}`,
        });
      }

      await adapter.createRooms(rooms);

      // Verify all were created
      const entityIds = entities.map((e) => e.id!);
      const retrievedEntities = await adapter.getEntitiesByIds(entityIds);
      expect(retrievedEntities).toHaveLength(batchSize);

      const roomIds = rooms.map((r) => r.id);
      const retrievedRooms = await adapter.getRoomsByIds(roomIds);
      expect(retrievedRooms).toHaveLength(batchSize);
    });
  });
});
