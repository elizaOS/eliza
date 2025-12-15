/**
 * Test that the .eliza directory is automatically created when using PGLite with a file path
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringToUuid } from '@elizaos/core';
import { createDatabaseAdapter } from '../../index';

/**
 * Helper to clean up global singletons between tests.
 * This is necessary because createDatabaseAdapter uses global singletons
 * to share database connections, but tests use different temp directories.
 */
async function cleanupGlobalSingletons() {
  const GLOBAL_SINGLETONS = Symbol.for('@elizaos/plugin-sql/global-singletons');
  const globalSymbols = globalThis as unknown as Record<symbol, any>;
  const singletons = globalSymbols[GLOBAL_SINGLETONS];

  if (singletons?.pgLiteClientManager) {
    try {
      // Get the actual PGlite client and close it properly
      const client = singletons.pgLiteClientManager.getConnection?.();
      if (client?.close) {
        await client.close();
      }
    } catch {
      // Ignore errors during cleanup
    }
    delete singletons.pgLiteClientManager;
  }

  if (singletons?.postgresConnectionManager) {
    try {
      await singletons.postgresConnectionManager.close?.();
    } catch {
      // Ignore errors during cleanup
    }
    delete singletons.postgresConnectionManager;
  }
}

describe('Directory Creation', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Clean up any existing singletons from previous tests
    await cleanupGlobalSingletons();
    tempDir = mkdtempSync(path.join(tmpdir(), 'eliza-test-'));
  });

  afterEach(async () => {
    // Clean up singletons BEFORE deleting the directory
    await cleanupGlobalSingletons();

    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should automatically create directory for PGLite when it does not exist', () => {
    const dataDir = path.join(tempDir, '.eliza', '.elizadb');
    const agentId = stringToUuid('test-agent');

    // Directory should not exist yet
    expect(existsSync(dataDir)).toBe(false);

    // Create adapter - should create the directory
    const adapter = createDatabaseAdapter({ dataDir }, agentId);

    // Directory should now exist
    expect(existsSync(dataDir)).toBe(true);
    expect(adapter).toBeDefined();
  });

  it('should not fail if directory already exists', () => {
    const dataDir = path.join(tempDir, '.eliza', '.elizadb');
    const agentId = stringToUuid('test-agent');

    // Create directory first
    const { mkdirSync } = require('node:fs');
    mkdirSync(dataDir, { recursive: true });
    expect(existsSync(dataDir)).toBe(true);

    // Create adapter - should not fail
    const adapter = createDatabaseAdapter({ dataDir }, agentId);

    // Directory should still exist
    expect(existsSync(dataDir)).toBe(true);
    expect(adapter).toBeDefined();
  });

  it('should not create directory for memory:// URIs', () => {
    const agentId = stringToUuid('test-agent');

    // This should not try to create a directory
    const adapter = createDatabaseAdapter({ dataDir: 'memory://' }, agentId);

    // No directory should be created
    expect(existsSync('memory://')).toBe(false);
    expect(adapter).toBeDefined();
  });

  it('should not create directory for idb:// URIs', () => {
    const agentId = stringToUuid('test-agent');

    // This should not try to create a directory
    const adapter = createDatabaseAdapter({ dataDir: 'idb://test-db' }, agentId);

    // No directory should be created
    expect(existsSync('idb://test-db')).toBe(false);
    expect(adapter).toBeDefined();
  });

  it('should not create directory when using PostgreSQL', () => {
    const dataDir = path.join(tempDir, '.eliza', '.elizadb');
    const agentId = stringToUuid('test-agent');

    // Directory should not exist yet
    expect(existsSync(dataDir)).toBe(false);

    // Create adapter with postgresUrl - should NOT create directory
    const adapter = createDatabaseAdapter(
      {
        dataDir,
        postgresUrl: 'postgresql://user:pass@localhost:5432/testdb',
      },
      agentId
    );

    // Directory should NOT be created when using PostgreSQL
    expect(existsSync(dataDir)).toBe(false);
    expect(adapter).toBeDefined();
  });
});
