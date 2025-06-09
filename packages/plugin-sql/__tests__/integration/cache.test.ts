import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { PgliteDatabaseAdapter } from '../../src/pglite/adapter';
import { type UUID, stringToUuid } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { createTestDatabase } from '../test-helpers';
import { cacheTable } from '../../src/schema';

describe('Cache Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter;
  let cleanup: () => Promise<void>;
  const testAgentId = stringToUuid('test-agent-for-cache-tests');

  beforeAll(async () => {
    ({ adapter, cleanup } = await createTestDatabase(testAgentId));
  });

  beforeEach(async () => {
    // Clear the cache table before each test
    const db = adapter.getDatabase();
    await db.delete(cacheTable);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('should set and get a simple string value', async () => {
    const key = 'simple_key';
    const value = 'hello world';

    const setResult = await adapter.setCache(key, value);
    expect(setResult).toBe(true);

    const retrievedValue = await adapter.getCache<string>(key);
    expect(retrievedValue).toBe(value);
  });

  it('should set and get a complex object value', async () => {
    const key = 'complex_key';
    const value = { a: 1, b: { c: 'nested' }, d: [1, 2, 3] };

    const setResult = await adapter.setCache(key, value);
    expect(setResult).toBe(true);

    const retrievedValue = await adapter.getCache<typeof value>(key);
    expect(retrievedValue).toEqual(value);
  });

  it('should update an existing cache value', async () => {
    const key = 'update_key';
    await adapter.setCache(key, 'initial_value');

    const updateResult = await adapter.setCache(key, 'updated_value');
    expect(updateResult).toBe(true);

    const retrievedValue = await adapter.getCache<string>(key);
    expect(retrievedValue).toBe('updated_value');
  });

  it('should delete a cache value', async () => {
    const key = 'delete_key';
    await adapter.setCache(key, 'some value');

    const deleteResult = await adapter.deleteCache(key);
    expect(deleteResult).toBe(true);

    const retrievedValue = await adapter.getCache(key);
    expect(retrievedValue).toBeUndefined();
  });

  it('should return undefined for a non-existent key', async () => {
    const retrievedValue = await adapter.getCache('non_existent_key');
    expect(retrievedValue).toBeUndefined();
  });
});
