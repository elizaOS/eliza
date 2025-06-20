import {
  AgentRuntime,
  ChannelType,
  type Component,
  type Entity,
  type Room,
  type UUID,
  type World,
  stringToUuid,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';
import { createIsolatedTestDatabase } from '../test-helpers';

describe('Component Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testEntityId: UUID;
  let testRoomId: UUID;
  let testWorldId: UUID;
  let testSourceEntityId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase('component-tests');
    adapter = setup.adapter;
    runtime = setup.runtime;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    // Generate random UUIDs for test data
    testWorldId = uuidv4() as UUID;
    testRoomId = uuidv4() as UUID;
    testEntityId = uuidv4() as UUID;
    testSourceEntityId = uuidv4() as UUID;

    await adapter.createWorld({
      id: testWorldId,
      agentId: testAgentId,
      name: 'Test World',
      serverId: 'test-server',
    } as World);
    await adapter.createRooms([
      {
        id: testRoomId,
        agentId: testAgentId,
        worldId: testWorldId,
        source: 'test',
        type: ChannelType.GROUP,
      } as Room,
    ]);
    await adapter.createEntities([
      { id: testEntityId, agentId: testAgentId, names: ['Test Entity'] } as Entity,
      { id: testSourceEntityId, agentId: testAgentId, names: ['Source Entity'] } as Entity,
    ]);
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe('Component Tests', () => {
    it('should create and retrieve a basic component', async () => {
      const component: Component = {
        id: stringToUuid('a0000000-0000-0000-0000-000000000001'),
        entityId: testEntityId,
        agentId: testAgentId,
        roomId: testRoomId,
        type: 'test_component',
        data: { value: 'test' },
        worldId: testWorldId,
        sourceEntityId: testSourceEntityId,
        createdAt: Date.now(),
      };

      await adapter.createComponent(component);
      const retrieved = await adapter.getComponent(testEntityId, 'test_component');
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(component.id);
      expect(retrieved?.data).toEqual({ value: 'test' });
    });

    it('should update an existing component', async () => {
      const originalComponent: Component = {
        id: stringToUuid('a0000000-0000-0000-0000-000000000002'),
        entityId: testEntityId,
        agentId: testAgentId,
        roomId: testRoomId,
        type: 'updatable_component',
        data: { value: 'original' },
        worldId: testWorldId,
        sourceEntityId: testSourceEntityId,
        createdAt: Date.now(),
      };
      await adapter.createComponent(originalComponent);

      const updatedComponent: Component = {
        ...originalComponent,
        data: { value: 'updated' },
      };
      await adapter.updateComponent(updatedComponent);

      const retrieved = await adapter.getComponent(testEntityId, 'updatable_component');
      expect(retrieved).toBeDefined();
      expect(retrieved?.data).toEqual({ value: 'updated' });
    });

    it('should delete a component', async () => {
      const component: Component = {
        id: stringToUuid('a0000000-0000-0000-0000-000000000003'),
        entityId: testEntityId,
        agentId: testAgentId,
        roomId: testRoomId,
        type: 'deletable_component',
        data: { value: 'original' },
        worldId: testWorldId,
        sourceEntityId: testSourceEntityId,
        createdAt: Date.now(),
      };
      await adapter.createComponent(component);
      let retrieved = await adapter.getComponent(testEntityId, 'deletable_component');
      expect(retrieved).toBeDefined();

      await adapter.deleteComponent(component.id);
      retrieved = await adapter.getComponent(testEntityId, 'deletable_component');
      expect(retrieved).toBeNull();
    });
  });
});
