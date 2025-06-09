import { beforeAll, describe, it, expect, afterAll } from 'vitest';
import {
  type UUID,
  AgentRuntime,
  stringToUuid,
  ChannelType,
  type Entity,
  type Room,
  type World,
  type Memory,
  MemoryType,
  type Plugin,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { PgliteDatabaseAdapter } from '../../src/pglite/adapter';
import { createTestDatabase } from '../test-helpers';

// Mock a simple "hello-world" plugin for testing dynamic migrations
const helloWorldPlugin: Plugin = {
  name: 'test-hello-world',
  description: 'A test plugin for dynamic migrations.',
  schema: {
    hello_world: {
      columns: {
        id: { type: 'serial', primaryKey: true },
        message: { type: 'text' },
      },
      name: 'hello_world',
    },
    greetings: {
      columns: {
        id: { type: 'serial', primaryKey: true },
        greeting: { type: 'text' },
      },
      name: 'greetings',
    },
  },
};

describe('Plugin SQL Dynamic Migration', () => {
  let adapter: PgliteDatabaseAdapter;
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  const testAgentId = stringToUuid('7d37bdd6-f389-0f26-9498-ec770896d86f');

  beforeAll(async () => {
    ({ adapter, runtime, cleanup } = await createTestDatabase(testAgentId, [helloWorldPlugin]));
  }, 60000);

  afterAll(async () => {
    await cleanup();
  });

  it('should initialize runtime with SQL plugin and hello world plugin', () => {
    expect(runtime).toBeDefined();
    const dbAdapter = runtime.db;
    expect(dbAdapter).toBeDefined();
  });

  it('should create tables for the core sql plugin in the public schema', async () => {
    const db = adapter.getDatabase();
    const tables = await db.execute(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const tableNames = tables.rows.map((r: any) => r.table_name);
    expect(tableNames).toContain('agents');
    expect(tableNames).toContain('memories');
  });

  it.skip('should create tables for the hello-world plugin in a dedicated schema', async () => {
    const db = adapter.getDatabase();
    const tables = await db.execute(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'test_hello_world'`
    );
    const tableNames = tables.rows.map((r: any) => r.table_name);
    expect(tableNames).toContain('hello_world');
    expect(tableNames).toContain('greetings');
  });

  it('should store and retrieve memory using the dynamically created schema', async () => {
    const testEntityId = stringToUuid('test-entity-for-dynamic-migration');
    const testRoomId = stringToUuid('test-room-for-dynamic-migration');
    const testWorldId = stringToUuid('test-world-for-dynamic-migration');

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
        name: 'Test Room',
        source: 'test',
        type: ChannelType.GROUP,
      } as Room,
    ]);

    await adapter.createEntities([
      { id: testEntityId, agentId: testAgentId, names: ['Test Entity'] } as Entity,
    ]);

    const memory: Memory = {
      id: uuidv4() as UUID,
      agentId: testAgentId,
      roomId: testRoomId,
      entityId: testEntityId,
      worldId: testWorldId,
      content: { text: 'Hello from dynamic schema!' },
      metadata: { type: MemoryType.CUSTOM, source: 'test' },
    };

    const memoryId = await adapter.createMemory(memory, 'memories');
    const retrieved = await adapter.getMemoryById(memoryId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.content).toEqual({ text: 'Hello from dynamic schema!' });
  });
});
