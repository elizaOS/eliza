/**
 * Test helpers for environment cleanup and isolation
 * Provides utilities to save/restore environment state and clear caches
 */
import { getElizaPaths } from '@elizaos/core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/**
 * Clean up global singletons from @elizaos/plugin-sql
 * This is critical for test isolation - PGLite creates a singleton manager
 * that persists across tests and points to a specific data directory.
 * Without cleanup, subsequent tests reuse the stale singleton pointing
 * to a deleted directory, causing "ENOENT" errors.
 */
async function cleanupPluginSqlSingletons(): Promise<void> {
  const GLOBAL_SINGLETONS = Symbol.for('@elizaos/plugin-sql/global-singletons');
  const globalSymbols = globalThis as unknown as Record<symbol, any>;
  const singletons = globalSymbols[GLOBAL_SINGLETONS];

  if (!singletons) return;

  // Cleanup PGLite client manager
  if (singletons.pgLiteClientManager) {
    try {
      const client = singletons.pgLiteClientManager.getConnection?.();
      if (client?.close) {
        await client.close();
      }
    } catch {
      // Ignore errors during cleanup
    }
    delete singletons.pgLiteClientManager;
  }

  // Cleanup PostgreSQL connection manager
  if (singletons.postgresConnectionManager) {
    try {
      await singletons.postgresConnectionManager.close?.();
    } catch {
      // Ignore errors during cleanup
    }
    delete singletons.postgresConnectionManager;
  }
}

/**
 * Environment snapshot for restoration
 */
export interface EnvironmentSnapshot {
  PGLITE_DATA_DIR?: string;
  ELIZA_DATABASE_DIR?: string;
  IGNORE_BOOTSTRAP?: string;
  testDbPath?: string; // Track the unique DB path for cleanup
  // Add more environment variables as needed
}

/**
 * Capture current environment state
 */
export function captureEnvironment(): EnvironmentSnapshot {
  return {
    PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR,
    ELIZA_DATABASE_DIR: process.env.ELIZA_DATABASE_DIR,
    IGNORE_BOOTSTRAP: process.env.IGNORE_BOOTSTRAP,
  };
}

/**
 * Clean test-related environment variables and ElizaPaths cache
 */
export function cleanTestEnvironment(): void {
  // Clear ElizaPaths singleton cache
  getElizaPaths().clearCache();

  // Clear environment variables
  delete process.env.PGLITE_DATA_DIR;
  delete process.env.ELIZA_DATABASE_DIR;
  delete process.env.IGNORE_BOOTSTRAP;
}

/**
 * Restore environment from snapshot
 */
export function restoreEnvironment(snapshot: EnvironmentSnapshot): void {
  // Clear cache first
  getElizaPaths().clearCache();

  // Restore or delete each variable
  if (snapshot.PGLITE_DATA_DIR !== undefined) {
    process.env.PGLITE_DATA_DIR = snapshot.PGLITE_DATA_DIR;
  } else {
    delete process.env.PGLITE_DATA_DIR;
  }

  if (snapshot.ELIZA_DATABASE_DIR !== undefined) {
    process.env.ELIZA_DATABASE_DIR = snapshot.ELIZA_DATABASE_DIR;
  } else {
    delete process.env.ELIZA_DATABASE_DIR;
  }

  if (snapshot.IGNORE_BOOTSTRAP !== undefined) {
    process.env.IGNORE_BOOTSTRAP = snapshot.IGNORE_BOOTSTRAP;
  } else {
    delete process.env.IGNORE_BOOTSTRAP;
  }
}

/**
 * Setup clean test environment (for beforeEach)
 * @param options - Optional configuration
 * @param options.isolateDatabase - If true, creates a unique temporary database directory for this test
 * @returns snapshot to restore in teardown
 */
export function setupTestEnvironment(options?: { isolateDatabase?: boolean }): EnvironmentSnapshot {
  const snapshot = captureEnvironment();
  cleanTestEnvironment();

  // Create unique database path if isolation requested
  if (options?.isolateDatabase) {
    // Create a true temporary directory using system temp directory
    // This approach matches plugin-sql's createIsolatedTestDatabase
    // Each test gets a completely isolated temp directory, avoiding PGlite global state conflicts
    const testDbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'eliza-server-test-'));
    process.env.PGLITE_DATA_DIR = testDbPath;
    snapshot.testDbPath = testDbPath;
  }

  return snapshot;
}

/**
 * Teardown test environment (for afterEach)
 * Cleans up database if it was created by setupTestEnvironment
 */
export async function teardownTestEnvironment(snapshot: EnvironmentSnapshot): Promise<void> {
  await cleanupPluginSqlSingletons();

  // Clean up test database if it exists
  if (snapshot.testDbPath && fs.existsSync(snapshot.testDbPath)) {
    try {
      fs.rmSync(snapshot.testDbPath, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors in tests
      console.warn(`Failed to cleanup test database at ${snapshot.testDbPath}:`, error);
    }
  }

  restoreEnvironment(snapshot);
}
