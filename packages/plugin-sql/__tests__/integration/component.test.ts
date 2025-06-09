import { beforeAll, describe, it, expect, afterAll } from 'vitest';
import {
  type Component,
  type Entity,
  type UUID,
  stringToUuid,
  AgentRuntime,
  ChannelType,
  type Room,
  type World,
} from '@elizaos/core';
import { PgliteDatabaseAdapter } from '../../src/pglite/adapter';
import { createTestDatabase } from '../test-helpers';

describe('Component Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter;
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testEntityId: UUID;
  let testRoomId: UUID;
  let testWorldId: UUID;
  let testSourceEntityId: UUID;

  beforeAll(async () => {
    testAgentId = stringToUuid('test-agent-for-component-tests');
    ({ adapter, runtime, cleanup } = await createTestDatabase(testAgentId));

    testWorldId = stringToUuid('00000000-0000-0000-0000-000000000001');
    testRoomId = stringToUuid('00000000-0000-0000-0000-000000000002');
    testEntityId = stringToUuid('00000000-0000-0000-0000-000000000003');
    testSourceEntityId = stringToUuid('00000000-0000-0000-0000-000000000004');

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
  }, 30000);

  afterAll(async () => {
    await cleanup();
  });

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
