import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type UUID } from '@elizaos/core';
import { sql } from 'drizzle-orm';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PostgresConnectionManager } from '../../pg/manager';
import { v4 as uuidv4 } from 'uuid';

describe('PostgreSQL Adapter Direct Integration Tests', () => {
  const pgUrl = process.env.POSTGRES_URL;
  const shouldRun = !!pgUrl;
  
  describe.skipIf(!shouldRun)('PostgreSQL Adapter Direct Tests', () => {
    let adapter: PgDatabaseAdapter;
    let manager: PostgresConnectionManager;
    let testAgentId: UUID;

    beforeAll(async () => {
      testAgentId = uuidv4() as UUID;
      manager = new PostgresConnectionManager(pgUrl!);
      adapter = new PgDatabaseAdapter(testAgentId, manager);
      await adapter.init();
    });

    afterAll(async () => {
      // Clean up test data
      const db = manager.getDatabase();
      await db.execute(sql`DELETE FROM agents WHERE id = ${testAgentId}`);
      await manager.close();
    });

    describe('Initialization and Connection', () => {
      it('should initialize adapter successfully', () => {
        expect(adapter).toBeDefined();
        // agentId is protected, just verify adapter exists
        expect(adapter.getDatabase()).toBeDefined();
      });

      it('should test connection through manager', async () => {
        const isConnected = await manager.testConnection();
        expect(isConnected).toBe(true);
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

    describe('Agent Operations Through Manager', () => {
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
          }
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
      it('should get client from pool', async () => {
        const client = await manager.getClient();
        
        expect(client).toBeDefined();
        expect(client.query).toBeDefined();
        
        // Test the client
        const result = await client.query('SELECT NOW()');
        expect(result.rows[0].now).toBeInstanceOf(Date);
        
        // Release the client
        client.release();
      });

      it('should handle multiple concurrent clients', async () => {
        const clients = await Promise.all([
          manager.getClient(),
          manager.getClient(),
          manager.getClient(),
        ]);
        
        expect(clients).toHaveLength(3);
        
        // Use all clients concurrently
        const results = await Promise.all(
          clients.map((client, index) => 
            client.query('SELECT $1::int as id', [index])
          )
        );
        
        results.forEach((result, index) => {
          expect(result.rows[0].id).toBe(index);
        });
        
        // Release all clients
        clients.forEach(client => client.release());
      });
    });

    describe('Error Handling in Manager', () => {
      it('should handle query errors gracefully', async () => {
        const db = manager.getDatabase();
        
        await expect(
          db.execute(sql`SELECT * FROM non_existent_table`)
        ).rejects.toThrow();
      });

      it('should maintain connection after error', async () => {
        const db = manager.getDatabase();
        
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
            INSERT INTO json_test (data) VALUES (${JSON.stringify(testData)})
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
          const tags = ['tag1', 'tag2', 'tag3'];
          
          await db.execute(sql`
            INSERT INTO array_test (tags) VALUES (${tags})
          `);
          
          const result = await db.execute(sql`
            SELECT tags FROM array_test WHERE 'tag2' = ANY(tags)
          `);
          
          expect(result.rows[0].tags).toEqual(tags);
        } finally {
          await db.execute(sql`DROP TABLE IF EXISTS array_test`);
        }
      });

      it('should support timestamp operations', async () => {
        const db = adapter.getDatabase();
        
        const result = await db.execute(sql`
          SELECT 
            NOW() as current_time,
            NOW() + INTERVAL '1 day' as tomorrow,
            NOW() - INTERVAL '1 hour' as hour_ago
        `);
        
        const row = result.rows[0];
        expect(row.current_time).toBeInstanceOf(Date);
        expect(row.tomorrow).toBeInstanceOf(Date);
        expect(row.hour_ago).toBeInstanceOf(Date);
        
        // Verify the intervals
        const current = new Date(row.current_time as string | number | Date);
        const tomorrow = new Date(row.tomorrow as string | number | Date);
        const hourAgo = new Date(row.hour_ago as string | number | Date);
        
        expect(tomorrow.getTime() - current.getTime()).toBeCloseTo(24 * 60 * 60 * 1000, -3);
        expect(current.getTime() - hourAgo.getTime()).toBeCloseTo(60 * 60 * 1000, -3);
      });
    });

    describe('Adapter Shutdown', () => {
      it('should handle close gracefully', async () => {
        // Create a temporary adapter
        const tempManager = new PostgresConnectionManager(pgUrl!);
        const tempAdapter = new PgDatabaseAdapter(uuidv4() as UUID, tempManager);
        await tempAdapter.init();
        
        // Close it
        await tempAdapter.close();
        
        // Should not be able to use it after close
        await expect(tempManager.testConnection()).rejects.toThrow();
      });
    });
  });
}); 