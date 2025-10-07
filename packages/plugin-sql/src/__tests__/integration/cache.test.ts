import { AgentRuntime, type UUID } from '@elizaos/core';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';
import { cacheTable } from '../../schema';
import { createIsolatedTestDatabase } from '../test-helpers';

describe('Cache Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase('cache-tests');
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

  describe('Cache Tests', () => {
    beforeEach(async () => {
      // Clean up cache table before each test
      await adapter.getDatabase().delete(cacheTable);
    });

    it('should set and get a simple string value', async () => {
      const key = 'simple_key';
      const value = 'hello world';
      await adapter.setCache(key, value);
      const retrievedValue = await adapter.getCache(key);
      expect(retrievedValue).toBe(value);
    });

    it('should set and get a complex object value', async () => {
      const key = 'complex_key';
      const value = { a: 1, b: { c: 'nested' }, d: [1, 2, 3] };
      await adapter.setCache(key, value);
      const retrievedValue = await adapter.getCache(key);
      expect(retrievedValue).toEqual(value);
    });

    it('should update an existing cache value', async () => {
      const key = 'update_key';
      await adapter.setCache(key, 'initial_value');
      await adapter.setCache(key, 'updated_value');
      const retrievedValue = await adapter.getCache(key);
      expect(retrievedValue).toBe('updated_value');
    });

    it('should delete a cache value', async () => {
      const key = 'delete_key';
      await adapter.setCache(key, 'some value');
      await adapter.deleteCache(key);
      const retrievedValue = await adapter.getCache(key);
      expect(retrievedValue).toBeUndefined();
    });

    it('should return undefined for a non-existent key', async () => {
      const retrievedValue = await adapter.getCache('non_existent_key');
      expect(retrievedValue).toBeUndefined();
    });
  });
});
