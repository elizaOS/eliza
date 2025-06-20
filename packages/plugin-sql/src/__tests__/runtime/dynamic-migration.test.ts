import {
  AgentRuntime,
  ChannelType,
  type Entity,
  type Memory,
  MemoryType,
  type Plugin,
  type Room,
  stringToUuid,
  type UUID,
  type World,
} from '@elizaos/core';
import { pgTable, serial, text, uuid } from 'drizzle-orm/pg-core';
import { v4 as uuidv4 } from 'uuid';
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';
import { createIsolatedTestDatabase } from '../test-helpers';

const helloWorldTable = pgTable('hello_world', {
  id: serial('id').primaryKey(),
  message: text('message'),
});

const greetingsTable = pgTable('greetings', {
  id: serial('id').primaryKey(),
  greeting: text('greeting'),
});

const helloWorldPlugin: Plugin = {
  name: 'test-hello-world',
  description: 'A test plugin for dynamic migrations.',
  schema: {
    helloWorldTable,
    greetingsTable,
  },
};

const usersTable = pgTable('users', {
  id: uuid('id').primaryKey(),
  name: text('name'),
});

const postsTable = pgTable('posts', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').references(() => usersTable.id),
  content: text('content'),
});

const commentsTable = pgTable('comments', {
  id: uuid('id').primaryKey(),
  postId: uuid('post_id').references(() => postsTable.id),
  userId: uuid('user_id').references(() => usersTable.id),
  text: text('text'),
});

const complexPlugin: Plugin = {
  name: 'test-complex-plugin',
  description: 'A test plugin with complex relationships.',
  schema: {
    usersTable,
    postsTable,
    commentsTable,
  },
};

describe('Dynamic Migration Tests', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase('dynamic-migration-tests', [
      helloWorldPlugin,
      complexPlugin,
    ]);
    adapter = setup.adapter;
    runtime = setup.runtime;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe('Migration Tests', () => {
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

    it('should create tables for the hello-world plugin in a dedicated schema', async () => {
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

    it('should handle complex relationships in dynamic schemas', async () => {
      const { adapter: complexAdapter, cleanup: complexCleanup } = await createIsolatedTestDatabase(
        'complex-plugin-tests',
        [complexPlugin]
      );

      const db = complexAdapter.getDatabase();
      const tables = await db.execute(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'test_complex_plugin'`
      );
      const tableNames = tables.rows.map((r: any) => r.table_name);
      expect(tableNames).toContain('users');
      expect(tableNames).toContain('posts');
      expect(tableNames).toContain('comments');

      await complexCleanup();
    });
  });
});
