import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { type UUID } from '@elizaos/core';
import { sql } from 'drizzle-orm';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';
import { PGliteClientManager } from '../../pglite/manager';
import { PGlite } from '@electric-sql/pglite';
import { DatabaseMigrationService } from '../../migration-service';
import * as schema from '../../schema';
import { v4 as uuidv4 } from 'uuid';

describe('PostgreSQL Adapter Direct Integration Tests', () => {
  describe('PostgreSQL Adapter Direct Tests', () => {
    let adapter: PgliteDatabaseAdapter;
    let manager: PGliteClientManager;
    let testAgentId: UUID;

    beforeAll(async () => {
      testAgentId = uuidv4() as UUID;
      const client = new PGlite();
      manager = new PGliteClientManager(client);
      adapter = new PgliteDatabaseAdapter(testAgentId, manager);
      await adapter.init();

      // Run migrations
      const migrationService = new DatabaseMigrationService();
      const db = adapter.getDatabase();
      await migrationService.initializeWithDatabase(db);
      migrationService.discoverAndRegisterPluginSchemas([
        { name: '@elizaos/plugin-sql', description: 'SQL plugin', schema },
      ]);
      await migrationService.runAllPluginMigrations();
    });

    afterAll(async () => {
      // Clean up test data
      const db = adapter.getDatabase();
      await db.execute(sql`DELETE FROM agents WHERE id = ${testAgentId}`);
      await adapter.close();
    });

    describe('Initialization and Connection', () => {
      it('should initialize adapter successfully', () => {
        expect(adapter).toBeDefined();
        expect(adapter.getDatabase()).toBeDefined();
      });

      it('should test connection through adapter', async () => {
        const isReady = await adapter.isReady();
        expect(isReady).toBe(true);
      });

      it('should get database instance', () => {
        const db = adapter.getDatabase();
        expect(db).toBeDefined();
        expect(db.execute).toBeDefined();
      });

      it('should check if adapter is ready', async () => {
        const isReady = await adapter.isReady();
        expect(isReady).toBe(true);
      });
    });

    describe('Raw Database Operations', () => {
      it('should execute raw SQL through adapter database', async () => {
        const db = adapter.getDatabase();

        const result = await db.execute(sql`SELECT 1 as value`);

        expect(result).toBeDefined();
        expect(result.rows).toBeDefined();
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toEqual({ value: 1 });
      });

      it('should handle transactions through adapter', async () => {
        const db = adapter.getDatabase();

        // Create test table
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS pg_adapter_test (
            id SERIAL PRIMARY KEY,
            value INTEGER
          )
        `);

        try {
          // Test transaction
          await db.transaction(async (tx) => {
            await tx.execute(sql`INSERT INTO pg_adapter_test (value) VALUES (100)`);
            await tx.execute(sql`INSERT INTO pg_adapter_test (value) VALUES (200)`);
          });

          const result = await db.execute(sql`
            SELECT SUM(value) as total FROM pg_adapter_test
          `);

          expect(Number(result.rows[0].total)).toBe(300);
        } finally {
          // Clean up
          await db.execute(sql`DROP TABLE IF EXISTS pg_adapter_test`);
        }
      });
    });

    describe('Agent Operations', () => {
      it('should create an agent', async () => {
        const created = await adapter.createAgent({
          id: testAgentId,
          name: 'PG Direct Test Agent',
          bio: 'Test agent for PostgreSQL direct tests',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        expect(created).toBe(true);
      });

      it('should retrieve the created agent', async () => {
        const agent = await adapter.getAgent(testAgentId);

        expect(agent).toBeDefined();
        expect(agent?.id).toBe(testAgentId);
        expect(agent?.name).toBe('PG Direct Test Agent');
      });

      it('should update agent settings', async () => {
        const updated = await adapter.updateAgent(testAgentId, {
          settings: {
            theme: 'dark',
            language: 'en',
          },
        });

        expect(updated).toBe(true);

        const agent = await adapter.getAgent(testAgentId);
        expect(agent?.settings).toEqual({
          theme: 'dark',
          language: 'en',
        });
      });
    });

    describe('Connection Manager Features', () => {
      it('should get connection from manager', () => {
        const connection = manager.getConnection();

        expect(connection).toBeDefined();
        expect(connection.query).toBeDefined();
      });

      it('should handle multiple operations', async () => {
        const db = adapter.getDatabase();

        // Execute multiple operations
        const results = await Promise.all([
          db.execute(sql`SELECT 1 as id`),
          db.execute(sql`SELECT 2 as id`),
          db.execute(sql`SELECT 3 as id`),
        ]);

        expect(results).toHaveLength(3);
        results.forEach((result, index) => {
          expect(result.rows[0].id).toBe(index + 1);
        });
      });
    });

    describe('Error Handling', () => {
      it('should handle query errors gracefully', async () => {
        const db = adapter.getDatabase();

        let errorThrown = false;
        try {
          await db.execute(sql`SELECT * FROM non_existent_table`);
        } catch (error) {
          errorThrown = true;
          expect(error).toBeDefined();
        }

        expect(errorThrown).toBe(true);
      });

      it('should maintain connection after error', async () => {
        const db = adapter.getDatabase();

        // Cause an error
        try {
          await db.execute(sql`INVALID SQL`);
        } catch (e) {
          // Expected error
        }

        // Connection should still work
        const result = await db.execute(sql`SELECT 1 as value`);
        expect(result.rows[0].value).toBe(1);
      });
    });

    describe('Advanced Features', () => {
      it('should support JSON operations', async () => {
        const db = adapter.getDatabase();

        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS json_test (
            id SERIAL PRIMARY KEY,
            data JSONB
          )
        `);

        try {
          const testData = { name: 'test', values: [1, 2, 3] };

          await db.execute(sql`
            INSERT INTO json_test (data) VALUES (${JSON.stringify(testData)}::jsonb)
          `);

          const result = await db.execute(sql`
            SELECT data FROM json_test WHERE data->>'name' = 'test'
          `);

          expect(result.rows[0].data).toEqual(testData);
        } finally {
          await db.execute(sql`DROP TABLE IF EXISTS json_test`);
        }
      });

      it('should support array operations', async () => {
        const db = adapter.getDatabase();

        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS array_test (
            id SERIAL PRIMARY KEY,
            tags TEXT[]
          )
        `);

        try {
          // PGLite requires array syntax
          await db.execute(sql`
            INSERT INTO array_test (tags) VALUES (ARRAY['tag1', 'tag2', 'tag3'])
          `);

          const result = await db.execute(sql`
            SELECT tags FROM array_test WHERE 'tag2' = ANY(tags)
          `);

          expect(result.rows[0].tags).toEqual(['tag1', 'tag2', 'tag3']);
        } finally {
          await db.execute(sql`DROP TABLE IF EXISTS array_test`);
        }
      });

      it('should support timestamp operations', async () => {
        const db = adapter.getDatabase();

        const result = await db.execute(sql`
          SELECT 
            CURRENT_TIMESTAMP as current_time,
            CURRENT_TIMESTAMP + INTERVAL '1 day' as tomorrow,
            CURRENT_TIMESTAMP - INTERVAL '1 hour' as hour_ago
        `);

        const row = result.rows[0];
        expect(row.current_time).toBeDefined();
        expect(row.tomorrow).toBeDefined();
        expect(row.hour_ago).toBeDefined();
      });
    });

    describe('Adapter Shutdown', () => {
      it('should handle close gracefully', async () => {
        // Create a temporary adapter
        const tempClient = new PGlite();
        const tempManager = new PGliteClientManager(tempClient);
        const tempAdapter = new PgliteDatabaseAdapter(uuidv4() as UUID, tempManager);
        await tempAdapter.init();

        // Close it
        await tempAdapter.close();

        // Should not be ready after close
        const isReady = await tempAdapter.isReady();
        expect(isReady).toBe(false);
      });
    });
  });
});
