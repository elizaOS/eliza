import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { v4 as uuidv4 } from 'uuid';
import type { UUID, Entity, Memory, Component, Agent, ChannelType } from '@elizaos/core';
import { DatabaseMigrationService } from '../../migration-service';
import * as schema from '../../schema';
import { PGlite } from '@electric-sql/pglite';
import { PGliteClientManager } from '../../pglite/manager';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';

// Use PGLite for testing instead of real PostgreSQL
describe('PostgreSQL E2E Tests', () => {
  const createTestAdapter = async () => {
    const client = new PGlite();
    const manager = new PGliteClientManager(client);
    const agentId = uuidv4() as UUID;
    const adapter = new PgliteDatabaseAdapter(agentId, manager);
    await adapter.init();

    // Run migrations for each adapter
    const migrationService = new DatabaseMigrationService();
    const db = adapter.getDatabase();
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([
      { name: '@elizaos/plugin-sql', description: 'SQL plugin', schema },
    ]);
    await migrationService.runAllPluginMigrations();

    return { adapter, agentId };
  };

  describe('Connection Management', () => {
    it('should test connection successfully', async () => {
      const { adapter } = await createTestAdapter();

      const isReady = await adapter.isReady();
      expect(isReady).toBe(true);

      await adapter.close();
    });

    it('should get connection', async () => {
      const { adapter } = await createTestAdapter();

      const connection = await adapter.getConnection();
      expect(connection).toBeDefined();

      await adapter.close();
    });
  });

  describe('Agent Operations', () => {
    it('should create and retrieve an agent', async () => {
      const { adapter, agentId } = await createTestAdapter();

      const agent: Partial<Agent> = {
        id: agentId,
        name: 'Test Agent',
        settings: {
          apiKey: 'test-key',
          model: 'gpt-4',
        },
      };

      const created = await adapter.createAgent(agent as Agent);
      expect(created).toBe(true);

      const retrieved = await adapter.getAgent(agentId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('Test Agent');
      expect(retrieved!.settings).toEqual(agent.settings!);

      await adapter.close();
    });

    it('should update an agent', async () => {
      const { adapter, agentId } = await createTestAdapter();

      const agent: Partial<Agent> = {
        id: agentId,
        name: 'Original Name',
      };

      await adapter.createAgent(agent as Agent);

      const updated = await adapter.updateAgent(agentId, {
        name: 'Updated Name',
        settings: { newSetting: 'value' },
      });

      expect(updated).toBe(true);

      const retrieved = await adapter.getAgent(agentId);
      expect(retrieved?.name).toBe('Updated Name');
      expect(retrieved?.settings?.newSetting).toBe('value');

      await adapter.close();
    });

    it('should delete an agent', async () => {
      const { adapter, agentId } = await createTestAdapter();

      const agent: Partial<Agent> = {
        id: agentId,
        name: 'To Delete',
      };

      await adapter.createAgent(agent as Agent);
      const deleted = await adapter.deleteAgent(agentId);
      expect(deleted).toBe(true);

      const retrieved = await adapter.getAgent(agentId);
      expect(retrieved).toBeNull();

      await adapter.close();
    });
  });

  describe('Entity Operations', () => {
    it('should create and retrieve entities', async () => {
      const { adapter, agentId } = await createTestAdapter();

      // Create agent first
      await adapter.createAgent({
        id: agentId,
        name: 'Test Agent',
      } as Agent);

      const entities: Entity[] = [
        {
          id: uuidv4() as UUID,
          agentId,
          names: ['Entity One'],
        },
        {
          id: uuidv4() as UUID,
          agentId,
          names: ['Entity Two'],
          metadata: { custom: 'data' },
        },
      ];

      const created = await adapter.createEntities(entities);
      expect(created).toBe(true);

      const entityIds = entities.map((e) => e.id).filter((id): id is UUID => id !== undefined);
      const retrieved = await adapter.getEntitiesByIds(entityIds);
      expect(retrieved).toHaveLength(2);

      // Sort by name to ensure consistent order
      const sortedRetrieved = retrieved?.sort((a, b) => a.names[0].localeCompare(b.names[0]));
      expect(sortedRetrieved?.[0].names).toContain('Entity One');
      expect(sortedRetrieved?.[1].metadata).toEqual({ custom: 'data' });

      await adapter.close();
    });

    it('should update an entity', async () => {
      const { adapter, agentId } = await createTestAdapter();

      // Create agent first
      await adapter.createAgent({
        id: agentId,
        name: 'Test Agent',
      } as Agent);

      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId,
        names: ['Original'],
      };

      await adapter.createEntities([entity]);

      await adapter.updateEntity({
        ...entity,
        names: ['Updated'],
        metadata: { updated: true },
      });

      const retrieved = await adapter.getEntitiesByIds([entity.id!]);
      expect(retrieved?.[0].names).toContain('Updated');
      expect(retrieved?.[0].metadata).toEqual({ updated: true });

      await adapter.close();
    });
  });

  describe('Memory Operations', () => {
    let adapter: PgliteDatabaseAdapter;
    let agentId: UUID;
    let roomId: UUID;
    let entityId: UUID;

    beforeEach(async () => {
      const result = await createTestAdapter();
      adapter = result.adapter;
      agentId = result.agentId;

      // Create agent first
      await adapter.createAgent({
        id: agentId,
        name: 'Test Agent',
      } as Agent);

      roomId = uuidv4() as UUID;
      entityId = uuidv4() as UUID;

      // Create room first
      await adapter.createRooms([
        {
          id: roomId,
          agentId,
          source: 'test',
          type: 'GROUP' as ChannelType,
          name: 'Test Room',
        },
      ]);

      // Create required entity
      await adapter.createEntities([
        {
          id: entityId,
          agentId,
          names: ['Test Entity'],
        },
      ]);
    });

    afterEach(async () => {
      await adapter.close();
    });

    it('should create and retrieve memories', async () => {
      const memory: Memory = {
        id: uuidv4() as UUID,
        agentId,
        entityId,
        roomId,
        content: { text: 'Test memory content' },
        metadata: {
          type: 'custom',
        },
        createdAt: Date.now(),
      };

      const memoryId = await adapter.createMemory(memory, 'memories');
      expect(memoryId).toBeDefined();

      const retrieved = await adapter.getMemoryById(memoryId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.content).toEqual({ text: 'Test memory content' });
    });

    it('should search memories by embedding', async () => {
      const embedding = Array(384).fill(0.1);
      const memory: Memory = {
        id: uuidv4() as UUID,
        agentId,
        entityId,
        roomId,
        content: { text: 'Searchable memory' },
        metadata: {
          type: 'custom',
        },
        embedding,
        createdAt: Date.now(),
      };

      await adapter.createMemory(memory, 'memories');

      const results = await adapter.searchMemories({
        tableName: 'memories',
        embedding,
        count: 10,
      });

      expect(results).toHaveLength(1);
      expect(results[0].content).toEqual({ text: 'Searchable memory' });
    });

    it('should update memory content', async () => {
      const memory: Memory = {
        id: uuidv4() as UUID,
        agentId,
        entityId,
        roomId,
        content: { text: 'Original content' },
        metadata: {
          type: 'custom',
        },
        createdAt: Date.now(),
      };

      const memoryId = await adapter.createMemory(memory, 'memories');

      const updated = await adapter.updateMemory({
        id: memoryId,
        content: { text: 'Updated content' },
        metadata: { type: 'custom', edited: true },
      });

      expect(updated).toBe(true);

      const retrieved = await adapter.getMemoryById(memoryId);
      expect(retrieved?.content).toEqual({ text: 'Updated content' });
      expect(retrieved?.metadata).toMatchObject({ type: 'custom', edited: true });
    });

    it('should delete memories', async () => {
      const memory: Memory = {
        id: uuidv4() as UUID,
        agentId,
        entityId,
        roomId,
        content: { text: 'To be deleted' },
        metadata: {
          type: 'custom',
        },
        createdAt: Date.now(),
      };

      const memoryId = await adapter.createMemory(memory, 'memories');
      await adapter.deleteMemory(memoryId);

      const retrieved = await adapter.getMemoryById(memoryId);
      expect(retrieved).toBeNull();
    });
  });

  describe('Component Operations', () => {
    let adapter: PgliteDatabaseAdapter;
    let agentId: UUID;
    let entityId: UUID;
    let roomId: UUID;
    let worldId: UUID;
    let sourceEntityId: UUID;

    beforeEach(async () => {
      const result = await createTestAdapter();
      adapter = result.adapter;
      agentId = result.agentId;

      // Create agent first
      await adapter.createAgent({
        id: agentId,
        name: 'Test Agent',
      } as Agent);

      entityId = uuidv4() as UUID;
      roomId = uuidv4() as UUID;
      worldId = uuidv4() as UUID;
      sourceEntityId = uuidv4() as UUID;

      await adapter.createWorld({
        id: worldId,
        agentId,
        serverId: uuidv4() as UUID,
        name: 'Test World',
      });

      // Create room
      await adapter.createRooms([
        {
          id: roomId,
          agentId,
          source: 'test',
          type: 'GROUP' as ChannelType,
          name: 'Test Room',
        },
      ]);

      await adapter.createEntities([
        {
          id: entityId,
          agentId,
          names: ['Component Test Entity'],
        },
        {
          id: sourceEntityId,
          agentId,
          names: ['Source Test Entity'],
        },
      ]);
    });

    afterEach(async () => {
      await adapter.close();
    });

    it('should create and retrieve components', async () => {
      const component: Component = {
        id: uuidv4() as UUID,
        entityId,
        agentId,
        roomId,
        worldId,
        sourceEntityId,
        type: 'test-component',
        data: { value: 'test data' },
        createdAt: Date.now(),
      };

      const created = await adapter.createComponent(component);
      expect(created).toBe(true);

      const retrieved = await adapter.getComponent(
        entityId,
        'test-component',
        worldId,
        sourceEntityId
      );
      expect(retrieved).toBeDefined();
      expect(retrieved?.data).toEqual({ value: 'test data' });
    });

    it('should update a component', async () => {
      const component: Component = {
        id: uuidv4() as UUID,
        entityId,
        agentId,
        roomId,
        worldId,
        sourceEntityId,
        type: 'update-test',
        data: { original: true },
        createdAt: Date.now(),
      };

      await adapter.createComponent(component);

      await adapter.updateComponent({
        ...component,
        data: { updated: true },
      });

      const retrieved = await adapter.getComponent(
        entityId,
        'update-test',
        worldId,
        sourceEntityId
      );
      expect(retrieved?.data).toEqual({ updated: true });
    });

    it('should delete a component', async () => {
      const component: Component = {
        id: uuidv4() as UUID,
        entityId,
        agentId,
        roomId,
        worldId,
        sourceEntityId,
        type: 'delete-test',
        data: {},
        createdAt: Date.now(),
      };

      await adapter.createComponent(component);
      await adapter.deleteComponent(component.id);

      const retrieved = await adapter.getComponent(
        entityId,
        'delete-test',
        worldId,
        sourceEntityId
      );
      expect(retrieved).toBeNull();
    });
  });

  describe('Transaction and Concurrency', () => {
    it('should handle concurrent operations', async () => {
      const { adapter, agentId } = await createTestAdapter();

      // Create agent first
      await adapter.createAgent({
        id: agentId,
        name: 'Test Agent',
      } as Agent);

      const operations = Array(5)
        .fill(null)
        .map((_, i) => {
          const entity: Entity = {
            id: uuidv4() as UUID,
            agentId,
            names: [`Concurrent Entity ${i}`],
          };
          return adapter.createEntities([entity]);
        });

      const results = await Promise.all(operations);
      expect(results.every((r) => r === true)).toBe(true);

      await adapter.close();
    });

    it('should handle large batch operations', async () => {
      const { adapter, agentId } = await createTestAdapter();

      // Create agent first
      await adapter.createAgent({
        id: agentId,
        name: 'Test Agent',
      } as Agent);

      const entities: Entity[] = Array(100)
        .fill(null)
        .map((_, i) => ({
          id: uuidv4() as UUID,
          agentId,
          names: [`Batch Entity ${i}`],
        }));

      const created = await adapter.createEntities(entities);
      expect(created).toBe(true);

      const entityIds = entities.map((e) => e.id).filter((id): id is UUID => id !== undefined);
      const retrieved = await adapter.getEntitiesByIds(entityIds);
      expect(retrieved).toHaveLength(100);

      await adapter.close();
    });
  });

  describe('Error Handling', () => {
    it('should handle duplicate agent creation', async () => {
      const { adapter, agentId } = await createTestAdapter();

      const agent: Partial<Agent> = {
        id: agentId,
        name: 'Duplicate Test',
      };

      await adapter.createAgent(agent as Agent);
      const secondCreate = await adapter.createAgent(agent as Agent);
      expect(secondCreate).toBe(false);

      await adapter.close();
    });

    it('should handle non-existent entity retrieval', async () => {
      const { adapter } = await createTestAdapter();

      const nonExistentId = uuidv4() as UUID;
      const result = await adapter.getEntitiesByIds([nonExistentId]);
      expect(result).toHaveLength(0);

      await adapter.close();
    });

    it('should handle invalid memory search', async () => {
      const { adapter } = await createTestAdapter();

      const results = await adapter.searchMemories({
        tableName: 'memories',
        embedding: Array(384).fill(0),
        count: 0, // Invalid count
      });
      expect(results).toHaveLength(0);

      await adapter.close();
    });
  });
});
