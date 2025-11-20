/**
 * Test helpers for environment cleanup and isolation
 * Provides utilities to save/restore environment state and clear caches
 */
import { getElizaPaths } from '@elizaos/core';

/**
 * Environment snapshot for restoration
 */
export interface EnvironmentSnapshot {
  PGLITE_DATA_DIR?: string;
  ELIZA_DATABASE_DIR?: string;
  IGNORE_BOOTSTRAP?: string;
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
 * @returns snapshot to restore in teardown
 */
export function setupTestEnvironment(): EnvironmentSnapshot {
  const snapshot = captureEnvironment();
  cleanTestEnvironment();
  return snapshot;
}

/**
 * Teardown test environment (for afterEach)
 */
export function teardownTestEnvironment(snapshot: EnvironmentSnapshot): void {
  restoreEnvironment(snapshot);
}
