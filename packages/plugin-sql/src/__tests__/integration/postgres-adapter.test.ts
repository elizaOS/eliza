import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PostgresConnectionManager } from '../../pg/manager';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { createTestDatabase } from '../test-helpers';
import type { UUID } from '@elizaos/core';

describe('PostgreSQL Adapter Integration Tests', () => {
  let adapter: PgDatabaseAdapter;
  let manager: PostgresConnectionManager;
  let cleanup: () => Promise<void>;
  const agentId: UUID = '00000000-0000-0000-0000-000000000000';

  // Only run these tests if POSTGRES_URL is set
  const shouldRunTests = !!process.env.POSTGRES_URL;

  beforeEach(async () => {
    if (!shouldRunTests) return;
    
    const { adapter: testAdapter, cleanup: testCleanup } = await createTestDatabase(agentId, []);
    
    if (testAdapter.constructor.name === 'PgDatabaseAdapter') {
      adapter = testAdapter as PgDatabaseAdapter;
      cleanup = testCleanup;
      
      // Get the manager from the adapter
      manager = (adapter as any).manager;
    }
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe.skipIf(!shouldRunTests)('Connection Management', () => {
    it('should initialize successfully', async () => {
      await adapter.init();
      const isReady = await adapter.isReady();
      expect(isReady).toBe(true);
    });

    it('should get database connection', async () => {
      const connection = await adapter.getConnection();
      expect(connection).toBeDefined();
      expect(connection).toHaveProperty('connect');
      expect(connection).toHaveProperty('query');
    });

    it('should close connection gracefully', async () => {
      await adapter.init();
      await adapter.close();
      
      // Should not throw
      expect(true).toBe(true);
    });

    it('should handle isReady when connection fails', async () => {
      // Create a manager with bad connection string
      const badManager = new PostgresConnectionManager('postgresql://bad:bad@localhost:9999/bad');
      const badAdapter = new PgDatabaseAdapter(agentId, badManager);
      
      const isReady = await badAdapter.isReady();
      expect(isReady).toBe(false);
      
      await badAdapter.close();
    });
  });

  describe.skipIf(!shouldRunTests)('Database Operations', () => {
    it('should perform withDatabase operation', async () => {
      await adapter.init();
      
      const result = await (adapter as any).withDatabase(async (db: any) => {
        // Simple query to test connection
        const res = await db.execute(
          db.sql`SELECT 1 as value`
        );
        return res[0].value;
      });
      
      expect(result).toBe(1);
    });

    it('should handle withDatabase errors', async () => {
      await adapter.init();
      
      let errorCaught = false;
      try {
        await (adapter as any).withDatabase(async (db: any) => {
          throw new Error('Test error');
        });
      } catch (error) {
        errorCaught = true;
        expect((error as Error).message).toBe('Test error');
      }
      
      expect(errorCaught).toBe(true);
    });

    it('should retry operations on failure', async () => {
      await adapter.init();
      
      let attempts = 0;
      const result = await (adapter as any).withDatabase(async (db: any) => {
        attempts++;
        if (attempts < 2) {
          throw new Error('Transient error');
        }
        return 'success';
      });
      
      expect(result).toBe('success');
      expect(attempts).toBe(2);
    });

    it('should respect max retries', async () => {
      await adapter.init();
      
      let attempts = 0;
      let errorCaught = false;
      
      try {
        await (adapter as any).withDatabase(async (db: any) => {
          attempts++;
          throw new Error('Persistent error');
        });
      } catch (error) {
        errorCaught = true;
        expect((error as Error).message).toBe('Persistent error');
      }
      
      expect(errorCaught).toBe(true);
      expect(attempts).toBe(3); // Default maxRetries
    });
  });

  describe.skipIf(!shouldRunTests)('Manager Operations', () => {
    it('should get database instance', () => {
      const db = manager.getDatabase();
      expect(db).toBeDefined();
    });

    it('should get pool connection', () => {
      const pool = manager.getConnection();
      expect(pool).toBeDefined();
      expect(pool).toHaveProperty('connect');
      expect(pool).toHaveProperty('end');
    });

    it('should acquire and release client', async () => {
      const client = await manager.getClient();
      expect(client).toBeDefined();
      expect(client).toHaveProperty('query');
      expect(client).toHaveProperty('release');
      
      // Release client
      await client.release();
    });

    it('should test connection successfully', async () => {
      const result = await manager.testConnection();
      expect(result).toBe(true);
    });

    it('should handle connection pool errors', async () => {
      // Force a connection error by closing the pool
      await manager.close();
      
      // Now try to get a client
      let errorCaught = false;
      try {
        await manager.getClient();
      } catch (error) {
        errorCaught = true;
      }
      
      expect(errorCaught).toBe(true);
    });

    it('should handle query failures during connection test', async () => {
      // Create a mock client that fails queries
      const mockClient = {
        query: vi.fn().mockRejectedValue(new Error('Query failed')),
        release: vi.fn(),
      };
      
      // Mock the pool to return our mock client
      const pool = manager.getConnection();
      const originalConnect = pool.connect;
      pool.connect = vi.fn().mockResolvedValue(mockClient);
      
      const result = await manager.testConnection();
      expect(result).toBe(false);
      expect(mockClient.release).toHaveBeenCalled();
      
      // Restore original
      pool.connect = originalConnect;
    });
  });

  describe.skipIf(!shouldRunTests)('Agent Operations', () => {
    it('should create an agent', async () => {
      await adapter.init();
      
      const result = await adapter.createAgent({
        id: agentId,
        name: 'Test Agent',
        createdAt: new Date().getTime(),
        updatedAt: new Date().getTime(),
        bio: 'Test agent bio',
      } as any);
      
      expect(result).toBe(true);
    });

    it('should retrieve an agent', async () => {
      await adapter.init();
      
      // Create agent first
      await adapter.createAgent({
        id: agentId,
        name: 'Test Agent',
        createdAt: new Date().getTime(),
        updatedAt: new Date().getTime(),
        bio: 'Test agent bio',
      } as any);
      
      const agent = await adapter.getAgent(agentId);
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('Test Agent');
    });

    it('should update an agent', async () => {
      await adapter.init();
      
      // Create agent first
      await adapter.createAgent({
        id: agentId,
        name: 'Test Agent',
        createdAt: new Date().getTime(),
        updatedAt: new Date().getTime(),
        bio: 'Test agent bio',
      } as any);
      
      // Update agent - updateAgent requires two arguments
      await adapter.updateAgent(agentId, {
        name: 'Updated Agent',
      });
      
      const agent = await adapter.getAgent(agentId);
      expect(agent?.name).toBe('Updated Agent');
      // Note: Agent type doesn't have metadata property in the interface
    });

    it('should delete an agent', async () => {
      await adapter.init();
      
      // Create agent first
      await adapter.createAgent({
        id: agentId,
        name: 'Test Agent',
        createdAt: new Date().getTime(),
        updatedAt: new Date().getTime(),
        bio: 'Test agent bio',
      } as any);
      
      const deleted = await adapter.deleteAgent(agentId);
      expect(deleted).toBe(true);
      
      const agent = await adapter.getAgent(agentId);
      expect(agent).toBeNull();
    });
  });
}); 