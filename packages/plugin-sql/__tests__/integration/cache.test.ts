import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { SqliteDatabaseAdapter } from '../../src/sqlite/adapter';
import { SqliteClientManager } from '../../src/sqlite/manager';
import { type UUID } from '@elizaos/core';
import { cacheTestAgentSettings, testCacheEntries } from './seed';
import { setupMockedMigrations } from '../test-helpers';
setupMockedMigrations();

// Mock only the logger
vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
    },
  };
});

describe('Cache Integration Tests', () => {
  // Database connection variables
  let connectionManager: SqliteClientManager;
  let adapter: SqliteDatabaseAdapter;
  let testAgentId: UUID;

  beforeAll(async () => {
    // Create a random agent ID for use with the adapter
    testAgentId = cacheTestAgentSettings.id as UUID;

    // Initialize connection manager and adapter
    connectionManager = new SqliteClientManager({});
    await connectionManager.initialize();
    adapter = new SqliteDatabaseAdapter(testAgentId, connectionManager);
    await adapter.init();

    // Ensure the test agent exists
    await adapter.createAgent(cacheTestAgentSettings);
  }, 5000);

  afterAll(async () => {
    // Clean up any test agents
    const client = connectionManager.getConnection();
    try {
      await client.query(`DELETE FROM agents WHERE name = '${cacheTestAgentSettings.name}'`);
    } finally {
      // No release needed for Sqlite instance from getConnection like with pg PoolClient
    }

    // Close all connections
    await adapter.close();
  });

  beforeEach(async () => {
    // Clean up any existing cache entries for our test agent
    try {
      const client = connectionManager.getConnection();
      await client.query(`DELETE FROM cache WHERE "agentId" = '${testAgentId}'`);
    } catch (error) {
      console.error('Error cleaning test cache data:', error);
    }
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  describe('setCache', () => {
    it('should successfully set a string cache value', async () => {
      const { key, value } = testCacheEntries.stringValue;

      const result = await adapter.setCache(key, value);

      expect(result).toBe(true);

      // Verify the cache was set in the database
      interface CacheRow {
        value: string;
        // Add other relevant fields from the cache table if necessary for type safety
        [key: string]: any; // Allow other properties
      }
      const client = connectionManager.getConnection();
      try {
        const dbResult = await client.query<CacheRow>(
          `SELECT * FROM cache WHERE "agentId" = '${testAgentId}' AND key = '${key}'`
        );
        expect(dbResult.rows.length).toBe(1);
        expect(dbResult.rows[0].value).toBe(value);
      } finally {
        // No release needed for Sqlite instance from getConnection like with pg PoolClient
      }
    });

    it('should successfully set a number cache value', async () => {
      const { key, value } = testCacheEntries.numberValue;

      const result = await adapter.setCache(key, value);

      expect(result).toBe(true);

      // Verify via getCache
      const retrievedValue = await adapter.getCache<number>(key);
      expect(retrievedValue).toBe(value);
    });

    it('should successfully set an object cache value', async () => {
      const { key, value } = testCacheEntries.objectValue;

      const result = await adapter.setCache(key, value);

      expect(result).toBe(true);

      // Verify via getCache
      const retrievedValue = await adapter.getCache(key);
      expect(retrievedValue).toEqual(value);
    });

    it('should successfully set an array cache value', async () => {
      const { key, value } = testCacheEntries.arrayValue;

      const result = await adapter.setCache(key, value);

      expect(result).toBe(true);

      // Verify via getCache
      const retrievedValue = await adapter.getCache(key);
      expect(retrievedValue).toEqual(value);
    });

    it('should update an existing cache value', async () => {
      const { key } = testCacheEntries.stringValue;
      const initialValue = 'initial value';
      const updatedValue = 'updated value';

      // Set initial value
      await adapter.setCache(key, initialValue);

      // Update value
      const result = await adapter.setCache(key, updatedValue);

      expect(result).toBe(true);

      // Verify via getCache
      const retrievedValue = await adapter.getCache<string>(key);
      expect(retrievedValue).toBe(updatedValue);
    });
  });

  describe('getCache', () => {
    it('should retrieve an existing cache value', async () => {
      const { key, value } = testCacheEntries.stringValue;

      // Set cache first
      await adapter.setCache(key, value);

      // Retrieve cache
      const result = await adapter.getCache<string>(key);

      expect(result).toBe(value);
    });

    it('should return undefined for non-existent cache key', async () => {
      const result = await adapter.getCache<string>('non_existent_key');

      expect(result).toBeUndefined();
    });

    it('should handle complex object retrieval correctly', async () => {
      const { key, value } = testCacheEntries.objectValue;

      // Set cache first
      await adapter.setCache(key, value);

      // Retrieve cache
      const result = await adapter.getCache<typeof value>(key);

      expect(result).toEqual(value);
      expect(result?.properties.active).toBe(true);
      expect(result?.tags).toEqual(['test', 'cache', 'integration']);
    });

    it('should handle array retrieval correctly', async () => {
      const { key, value } = testCacheEntries.arrayValue;

      // Set cache first
      await adapter.setCache(key, value);

      // Retrieve cache
      const result = await adapter.getCache<typeof value>(key);

      expect(result).toEqual(value);
      expect(result?.[3]).toBe('four');
      // Type assertion to handle the fifth element which is an object with a 'five' property
      const fifthElement = result?.[4] as { five: number };
      expect(fifthElement?.five).toBe(5);
    });

    it('should handle type-safe retrieval with generics', async () => {
      interface TestInterface {
        name: string;
        count: number;
        isActive: boolean;
      }

      const testObject: TestInterface = {
        name: 'Test',
        count: 10,
        isActive: true,
      };

      // Set cache
      await adapter.setCache('typed_cache', testObject);

      // Retrieve with type
      const result = await adapter.getCache<TestInterface>('typed_cache');

      expect(result).toBeDefined();
      if (result) {
        // TypeScript should know this is a TestInterface
        expect(result.name).toBe('Test');
        expect(result.count).toBe(10);
        expect(result.isActive).toBe(true);
      }
    });
  });

  describe('deleteCache', () => {
    it('should delete an existing cache value', async () => {
      const { key, value } = testCacheEntries.stringValue;

      // Set cache first
      await adapter.setCache(key, value);

      // Delete cache
      const result = await adapter.deleteCache(key);

      expect(result).toBe(true);

      // Verify it's deleted
      const retrievedValue = await adapter.getCache<string>(key);
      expect(retrievedValue).toBeUndefined();
    });

    it('should return true when deleting non-existent cache key', async () => {
      const result = await adapter.deleteCache('non_existent_key');

      // Most implementations return success even if nothing was deleted
      expect(result).toBe(true);
    });

    it('should only delete the specified key', async () => {
      // Set multiple cache entries
      await adapter.setCache(testCacheEntries.stringValue.key, testCacheEntries.stringValue.value);
      await adapter.setCache(testCacheEntries.numberValue.key, testCacheEntries.numberValue.value);

      // Delete one
      await adapter.deleteCache(testCacheEntries.stringValue.key);

      // Verify only the specified one was deleted
      const stringValue = await adapter.getCache<string>(testCacheEntries.stringValue.key);
      const numberValue = await adapter.getCache<number>(testCacheEntries.numberValue.key);

      expect(stringValue).toBeUndefined();
      expect(numberValue).toBe(testCacheEntries.numberValue.value);
    });
  });

  describe('Error handling', () => {
    it('should handle errors when setting cache', async () => {
      const result = await adapter.setCache('error_key', 'error_value');
      expect(typeof result).toBe('boolean');
    });

    it('should handle errors when getting cache', async () => {
      const result = await adapter.getCache('error_key');
      expect(result).toBeUndefined();
    });

    it('should handle errors when deleting cache', async () => {
      const result = await adapter.deleteCache('error_key');
      expect(typeof result).toBe('boolean');
    });

    it('should handle large payloads when setting cache', async () => {
      const largeObject = {
        data: Array(1000).fill('x').join(''),
      };

      const result = await adapter.setCache('large_key', largeObject);
      expect(result).toBe(true);

      const retrieved = await adapter.getCache('large_key');
      expect(retrieved).toEqual(largeObject);
    });
  });
});
