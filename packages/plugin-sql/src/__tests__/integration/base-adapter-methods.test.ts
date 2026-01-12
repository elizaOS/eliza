import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createIsolatedTestDatabase } from '../test-helpers';
import { v4 as uuidv4 } from 'uuid';
import type { Entity, Memory, Component, Room, UUID, Content, ChannelType } from '@elizaos/core';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';

describe('Base Adapter Methods Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testEntityId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase('base-adapter-methods');
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    // Create a test entity for memories
    testEntityId = uuidv4() as UUID;
    await adapter.createEntities([
      {
        id: testEntityId,
        agentId: testAgentId,
        names: ['Test Entity for Memories'],
        metadata: { type: 'test' },
      },
    ]);
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe('CRUD Operations', () => {
    it('should handle getMemories with various filters', async () => {
      const agentId = testAgentId;
      const roomId = uuidv4() as UUID;
      const roomId2 = uuidv4() as UUID; // Different room for third memory

      // Create rooms first
      await adapter.createRooms([
        {
          id: roomId,
          agentId: testAgentId,
          source: 'test',
          type: 'GROUP' as ChannelType,
          name: 'Test Room',
        },
        {
          id: roomId2,
          agentId: testAgentId,
          source: 'test',
          type: 'GROUP' as ChannelType,
          name: 'Test Room 2',
        },
      ]);

      // Create test memories
      const memories: Memory[] = [
        {
          id: uuidv4() as UUID,
          agentId,
          entityId: testEntityId,
          roomId,
          content: { text: 'Test memory 1' } as Content,
          createdAt: Date.now() - 1000,
          metadata: { type: 'test' },
        },
        {
          id: uuidv4() as UUID,
          agentId,
          entityId: testEntityId,
          roomId,
          content: { text: 'Test memory 2' } as Content,
          createdAt: Date.now() - 500,
          metadata: { type: 'test' },
        },
        {
          id: uuidv4() as UUID,
          agentId,
          entityId: testEntityId,
          roomId: roomId2, // Different room
          content: { text: 'Test memory 3' } as Content,
          createdAt: Date.now(),
          metadata: { type: 'test' },
        },
      ];

      for (const memory of memories) {
        await adapter.createMemory(memory, 'memories');
      }

      // Test with room filter
      const roomMemories = await adapter.getMemories({
        roomId,
        tableName: 'memories',
        count: 10,
      });
      expect(roomMemories.length).toBe(2);

      // Test with count limit
      const limitedMemories = await adapter.getMemories({
        roomId,
        tableName: 'memories',
        count: 1,
      });
      expect(limitedMemories.length).toBe(1);
    });

    it('should handle getMemoriesByRoomIds', async () => {
      const agentId = testAgentId;
      const roomId1 = uuidv4() as UUID;
      const roomId2 = uuidv4() as UUID;

      // Create rooms
      await adapter.createRooms([
        {
          id: roomId1,
          agentId: testAgentId,
          source: 'test',
          type: 'GROUP' as ChannelType,
          name: 'Room 1',
        },
        {
          id: roomId2,
          agentId: testAgentId,
          source: 'test',
          type: 'GROUP' as ChannelType,
          name: 'Room 2',
        },
      ]);

      // Create memories in different rooms
      const memories: Memory[] = [
        {
          id: uuidv4() as UUID,
          agentId,
          entityId: testEntityId,
          roomId: roomId1,
          content: { text: 'Room 1 memory' } as Content,
          createdAt: Date.now(),
          metadata: { type: 'test' },
        },
        {
          id: uuidv4() as UUID,
          agentId,
          entityId: testEntityId,
          roomId: roomId2,
          content: { text: 'Room 2 memory' } as Content,
          createdAt: Date.now(),
          metadata: { type: 'test' },
        },
      ];

      for (const memory of memories) {
        await adapter.createMemory(memory, 'memories');
      }

      // Test getting memories from multiple rooms
      const retrievedMemories = await adapter.getMemoriesByRoomIds({
        roomIds: [roomId1, roomId2],
        tableName: 'memories',
      });

      expect(retrievedMemories.length).toBe(2);
    });

    it('should handle updateEntity', async () => {
      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['Test Entity'],
        metadata: {
          test: true,
          version: 1,
        },
      };

      // Create entity
      await adapter.createEntities([entity]);

      // Update entity
      const updatedEntity: Entity = {
        ...entity,
        names: ['Updated Entity'],
        metadata: {
          test: false,
          version: 2,
        },
      };

      await adapter.updateEntity(updatedEntity);

      // Verify update
      const retrieved = await adapter.getEntitiesByNames({
        names: ['Updated Entity'],
        agentId: testAgentId,
      });
      expect(retrieved.length).toBe(1);
      expect(retrieved[0]?.id).toBe(entity.id as UUID);
      expect(retrieved[0]?.metadata?.version).toBe(2);
    });

    it('should handle updateMemory', async () => {
      const roomId = uuidv4() as UUID;

      // Create room first
      await adapter.createRooms([
        {
          id: roomId,
          agentId: testAgentId,
          source: 'test',
          type: 'GROUP' as ChannelType,
          name: 'Test Room',
        },
      ]);

      const memoryId = uuidv4() as UUID;
      const memory: Memory = {
        id: memoryId,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: roomId,
        content: { text: 'Original content' } as Content,
        createdAt: Date.now(),
        metadata: { type: 'test' },
      };

      // Create memory
      await adapter.createMemory(memory, 'memories');

      // Update memory
      await adapter.updateMemory({
        id: memoryId,
        content: { text: 'Updated content' } as Content,
        metadata: { type: 'updated' },
      });

      // Verify update
      const retrieved = await adapter.getMemoryById(memoryId);
      expect((retrieved?.content as any).text).toBe('Updated content');
      expect(retrieved?.metadata?.type).toBe('updated');
    });

    it('should handle updateComponent', async () => {
      const worldId = uuidv4() as UUID;
      const sourceEntityId = uuidv4() as UUID;
      const roomId = uuidv4() as UUID;

      // Create world first
      await adapter.createWorld({
        id: worldId,
        agentId: testAgentId,
        serverId: uuidv4() as UUID,
        name: 'Test World',
      });

      // Create room
      await adapter.createRooms([
        {
          id: roomId,
          agentId: testAgentId,
          source: 'test',
          type: 'GROUP' as ChannelType,
          name: 'Test Room',
        },
      ]);

      // Create source entity
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
        worldId,
        entityId: testEntityId,
        sourceEntityId,
        agentId: testAgentId,
        roomId,
        data: {
          relationship: 'friend',
          trust: 0.5,
        },
        createdAt: new Date(),
      };

      // Create component
      await adapter.createComponent(component);

      // Update component
      await adapter.updateComponent({
        ...component,
        data: {
          relationship: 'best_friend',
          trust: 0.9,
        },
      });

      // Verify update
      const retrieved = await adapter.getComponent(
        testEntityId,
        'relationship',
        worldId,
        sourceEntityId
      );
      expect(retrieved?.data.relationship).toBe('best_friend');
      expect(retrieved?.data.trust).toBe(0.9);
    });

    it('should handle deleteComponent', async () => {
      const worldId = uuidv4() as UUID;
      const sourceEntityId = uuidv4() as UUID;
      const roomId = uuidv4() as UUID;

      // Create world first
      await adapter.createWorld({
        id: worldId,
        agentId: testAgentId,
        serverId: uuidv4() as UUID,
        name: 'Test World',
      });

      // Create room
      await adapter.createRooms([
        {
          id: roomId,
          agentId: testAgentId,
          source: 'test',
          type: 'GROUP' as ChannelType,
          name: 'Test Room',
        },
      ]);

      // Create source entity
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
        type: 'test',
        worldId,
        entityId: testEntityId,
        sourceEntityId,
        agentId: testAgentId,
        roomId,
        data: {},
        createdAt: new Date(),
      };

      // Create component
      await adapter.createComponent(component);

      // Delete component
      await adapter.deleteComponent(component.id);

      // Verify removal
      const retrieved = await adapter.getComponent(testEntityId, 'test', worldId, sourceEntityId);
      expect(retrieved).toBeNull();
    });

    it('should handle deleteEntity', async () => {
      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['Test Entity'],
        metadata: { type: 'test' },
      };

      // Create entity
      await adapter.createEntities([entity]);

      // Delete entity
      if (entity.id) {
        await adapter.deleteEntity(entity.id);
      }

      // Verify removal
      const retrieved = await adapter.getEntitiesByNames({
        names: entity.names,
        agentId: testAgentId,
      });
      expect(retrieved.length).toBe(0);
    });

    it('should handle removeMemory using deleteMemory', async () => {
      const roomId = uuidv4() as UUID;

      // Create room first
      await adapter.createRooms([
        {
          id: roomId,
          agentId: testAgentId,
          source: 'test',
          type: 'GROUP' as ChannelType,
          name: 'Test Room',
        },
      ]);

      const memoryId = uuidv4() as UUID;
      const memory: Memory = {
        id: memoryId,
        agentId: testAgentId,
        entityId: testEntityId,
        roomId: roomId,
        content: { text: 'Test memory' } as Content,
        createdAt: new Date(),
        metadata: { type: 'test' },
      };

      // Create memory
      await adapter.createMemory(memory, 'memories');

      // Remove memory
      await adapter.deleteMemory(memoryId);

      // Verify removal
      const retrieved = await adapter.getMemoryById(memoryId);
      expect(retrieved).toBeNull();
    });

    it('should handle deleteRoom', async () => {
      const room: Room = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        source: 'test',
        type: 'GROUP' as ChannelType,
        name: 'Test Room',
      };

      // Create room
      await adapter.createRooms([room]);

      // Delete room
      await adapter.deleteRoom(room.id);

      // Verify removal - use getRoomsByIds to check
      const retrieved = await adapter.getRoomsByIds([room.id]);
      expect(retrieved?.length).toBe(0);
    });

    it('should handle entity operations with metadata', async () => {
      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['Test Entity'],
        metadata: {
          category: 'person',
          age: 25,
          tags: ['developer', 'engineer'],
          nested: {
            level: 1,
            data: 'test',
          },
        },
      };

      await adapter.createEntities([entity]);
      const retrieved = await adapter.getEntitiesByNames({
        names: entity.names,
        agentId: testAgentId,
      });

      expect(retrieved.length).toBe(1);
      expect(retrieved[0]?.metadata?.category).toBe('person');
      expect(retrieved[0]?.metadata?.age).toBe(25);
      expect(retrieved[0]?.metadata?.tags).toEqual(['developer', 'engineer']);
      expect((retrieved[0]?.metadata?.nested as any)?.level).toBe(1);
    });

    it('should handle component operations with complex params', async () => {
      const worldId = uuidv4() as UUID;
      const sourceEntityId = uuidv4() as UUID;
      const roomId = uuidv4() as UUID;

      // Create world first
      await adapter.createWorld({
        id: worldId,
        agentId: testAgentId,
        serverId: uuidv4() as UUID,
        name: 'Test World',
      });

      // Create room
      await adapter.createRooms([
        {
          id: roomId,
          agentId: testAgentId,
          source: 'test',
          type: 'GROUP' as ChannelType,
          name: 'Test Room',
        },
      ]);

      // Create source entity
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
        type: 'inventory',
        worldId,
        entityId: testEntityId,
        sourceEntityId,
        agentId: testAgentId,
        roomId,
        data: {
          items: [
            { id: 'sword', quantity: 1, damage: 10 },
            { id: 'shield', quantity: 1, defense: 5 },
          ],
          maxCapacity: 10,
          currentWeight: 25.5,
        },
        createdAt: new Date(),
      };

      await adapter.createComponent(component);
      const retrieved = await adapter.getComponent(
        testEntityId,
        'inventory',
        worldId,
        sourceEntityId
      );

      expect(retrieved).toBeDefined();
      expect(retrieved?.data.items).toHaveLength(2);
      expect(retrieved?.data.maxCapacity).toBe(10);
      expect(retrieved?.data.currentWeight).toBe(25.5);
    });
  });

  describe('Search and Filtering', () => {
    beforeEach(async () => {
      // Clean up any existing entities from previous tests
      const existingEntities = await adapter.searchEntitiesByName({
        query: '',
        agentId: testAgentId,
        limit: 100,
      });
      for (const entity of existingEntities) {
        if (entity.id) {
          await adapter.deleteEntity(entity.id);
        }
      }
    });

    it('should search entities by name and limit results', async () => {
      // Create multiple entities
      const entities: Entity[] = [
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Alice Smith', 'Alicia'],
          metadata: { type: 'person' },
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Bob Johnson'],
          metadata: { type: 'person' },
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Alice Cooper'],
          metadata: { type: 'person' },
        },
      ];

      for (const entity of entities) {
        await adapter.createEntities([entity]);
      }

      // Search for entities with 'Alice' in name
      const searchResults = await adapter.searchEntitiesByName({
        query: 'Alice',
        agentId: testAgentId,
        limit: 10,
      });

      expect(searchResults.length).toBe(2);
      expect(
        searchResults.every((e) => e.names.some((name) => name.toLowerCase().includes('alice')))
      ).toBe(true);

      // Test with limit
      const limitedResults = await adapter.searchEntitiesByName({
        query: 'Alice',
        agentId: testAgentId,
        limit: 1,
      });

      expect(limitedResults.length).toBe(1);
    });

    it('should handle complex memory searches', async () => {
      const agentId = testAgentId;
      const roomId = uuidv4() as UUID;
      const entityId = uuidv4() as UUID;

      // Create entity first
      await adapter.createEntities([
        {
          id: entityId,
          agentId: testAgentId,
          names: ['Test Entity for Memory Search'],
          metadata: { type: 'test' },
        },
      ]);

      // Create room
      await adapter.createRooms([
        {
          id: roomId,
          agentId: testAgentId,
          source: 'test',
          type: 'GROUP' as ChannelType,
          name: 'Test Room',
        },
      ]);

      // Create memories with different metadata
      const memories: Memory[] = [
        {
          id: uuidv4() as UUID,
          agentId,
          entityId: entityId,
          roomId,
          content: { text: 'Meeting scheduled for tomorrow' } as Content,
          createdAt: new Date(Date.now() - 3600_000), // 1 hour ago
          metadata: { type: 'calendar', priority: 'high' },
        },
        {
          id: uuidv4() as UUID,
          agentId,
          entityId: entityId,
          roomId,
          content: { text: 'Remember to buy groceries' } as Content,
          createdAt: new Date(Date.now() - 1800_000), // 30 min ago
          metadata: { type: 'todo', priority: 'low' },
        },
        {
          id: uuidv4() as UUID,
          agentId,
          entityId: entityId,
          roomId,
          content: { text: 'Important meeting notes' } as Content,
          createdAt: new Date(Date.now() - 900_000), // 15 min ago
          metadata: { type: 'notes', priority: 'high' },
        },
      ];

      for (const memory of memories) {
        await adapter.createMemory(memory, 'memories');
      }

      // Get recent memories
      const recentMemories = await adapter.getMemories({
        roomId,
        tableName: 'memories',
        count: 2,
      });
      expect(recentMemories.length).toBe(2);
      // Memories are ordered by createdAt DESC, so most recent should be first
      expect((recentMemories[0].content as any).text).toBe('Important meeting notes');
    });
  });

  describe('Error Handling', () => {
    it('should handle duplicate entity creation gracefully (idempotent upsert)', async () => {
      const entityId = uuidv4() as UUID;
      const entity1: Entity = {
        id: entityId,
        agentId: testAgentId,
        names: ['Original Entity'],
        metadata: { type: 'original' },
      };
      const entity2: Entity = {
        id: entityId,
        agentId: testAgentId,
        names: ['Updated Entity'],
        metadata: { type: 'updated' },
      };

      // Create entity
      await adapter.createEntities([entity1]);

      // Duplicate creation succeeds silently (onConflictDoNothing)
      const result = await adapter.createEntities([entity2]);
      expect(result).toBe(true);

      // Original entity should remain unchanged
      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).toHaveLength(1);
      expect(retrieved![0].names).toEqual(['Original Entity']);
      expect(retrieved![0].metadata).toEqual({ type: 'original' });
    });

    it('should handle updating non-existent entity', async () => {
      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['Non-existent Entity'],
        metadata: { type: 'test' },
      };

      // Update should not throw but also shouldn't create
      await adapter.updateEntity(entity);

      // Verify entity doesn't exist
      const retrieved = await adapter.getEntitiesByNames({
        names: entity.names,
        agentId: testAgentId,
      });
      expect(retrieved.length).toBe(0);
    });

    it('should handle removing non-existent items', async () => {
      // These should not throw
      await adapter.deleteEntity(uuidv4() as UUID);
      await adapter.deleteMemory(uuidv4() as UUID);
      await adapter.deleteComponent(uuidv4() as UUID);
      await adapter.deleteRoom(uuidv4() as UUID);
    });
  });
});
