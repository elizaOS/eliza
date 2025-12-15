/**
 * DatabaseFixture - Provides isolated database instances for testing
 *
 * Creates unique database directories per test to prevent state pollution.
 * Supports both PGLite and PostgreSQL backends.
 * Implements Symbol.asyncDispose for automatic cleanup.
 *
 * @example
 * ```typescript
 * describe('My Test Suite', () => {
 *   it('should work with isolated DB', async () => {
 *     await using dbFixture = new DatabaseFixture();
 *     const { adapter, dbPath } = await dbFixture.setup();
 *
 *     // Test code here - cleanup is automatic!
 *   });
 * });
 * ```
 */

import type { IDatabaseAdapter, UUID } from '@elizaos/core';
import { stringToUuid } from '@elizaos/core';
import path from 'node:path';
import fs from 'node:fs';
import { createDatabaseAdapter } from '@elizaos/plugin-sql';
import {
  setupTestEnvironment,
  teardownTestEnvironment,
  type EnvironmentSnapshot,
} from '../test-utils/environment';

/**
 * Options for database fixture setup
 */
export interface DatabaseFixtureOptions {
  /**
   * Agent ID to use for the database adapter
   * @default Random UUID
   */
  agentId?: UUID;

  /**
   * Use PostgreSQL instead of PGLite
   * @default false
   */
  usePostgres?: boolean;

  /**
   * PostgreSQL connection URL (required if usePostgres=true)
   */
  postgresUrl?: string;

  /**
   * Base directory for test databases
   * @default '.test-db'
   */
  testDbBaseDir?: string;

  /**
   * Whether to disable bootstrap plugin
   * @default true
   */
  disableBootstrap?: boolean;
}

/**
 * Result returned from database fixture setup
 */
export interface DatabaseFixtureResult {
  /**
   * The database adapter instance
   */
  adapter: IDatabaseAdapter;

  /**
   * Agent ID used by the adapter
   */
  agentId: UUID;

  /**
   * Path to the database directory (PGLite only)
   */
  dbPath?: string;

  /**
   * Environment snapshot for manual restoration if needed
   */
  envSnapshot: EnvironmentSnapshot;
}

/**
 * Database fixture for isolated test databases
 */
export class DatabaseFixture {
  private adapter: IDatabaseAdapter | null = null;
  private dbPath: string | null = null;
  private envSnapshot: EnvironmentSnapshot | null = null;
  private agentId: UUID | null = null;
  private cleanupPerformed = false;

  /**
   * Set up an isolated database for testing
   */
  async setup(options: DatabaseFixtureOptions = {}): Promise<DatabaseFixtureResult> {
    // Generate unique agent ID
    this.agentId =
      options.agentId ??
      stringToUuid(`test-agent-${Date.now()}-${Math.random().toString(36).substring(7)}`);

    // Setup isolated environment
    this.envSnapshot = setupTestEnvironment({ isolateDatabase: true });

    // Disable bootstrap if requested
    if (options.disableBootstrap !== false) {
      process.env.IGNORE_BOOTSTRAP = 'true';
    }

    if (options.usePostgres) {
      // PostgreSQL setup
      if (!options.postgresUrl) {
        throw new Error('postgresUrl is required when usePostgres=true');
      }

      this.adapter = createDatabaseAdapter(
        {
          postgresUrl: options.postgresUrl,
        },
        this.agentId
      );

      return {
        adapter: this.adapter,
        agentId: this.agentId,
        envSnapshot: this.envSnapshot,
      };
    } else {
      // PGLite setup
      const baseDir = options.testDbBaseDir || '.test-db';
      this.dbPath = path.join(
        process.cwd(),
        baseDir,
        `test-${Date.now()}-${Math.random().toString(36).substring(7)}`
      );

      // Ensure base directory exists
      if (!fs.existsSync(path.dirname(this.dbPath))) {
        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      }

      // Update environment to use isolated database
      process.env.PGLITE_DATA_DIR = this.dbPath;

      this.adapter = createDatabaseAdapter(
        {
          dataDir: this.dbPath,
        },
        this.agentId
      );

      return {
        adapter: this.adapter,
        agentId: this.agentId,
        dbPath: this.dbPath,
        envSnapshot: this.envSnapshot,
      };
    }
  }

  /**
   * Get the database adapter (must call setup() first)
   */
  getAdapter(): IDatabaseAdapter {
    if (!this.adapter) {
      throw new Error('DatabaseFixture not initialized. Call setup() first.');
    }
    return this.adapter;
  }

  /**
   * Get the agent ID (must call setup() first)
   */
  getAgentId(): UUID {
    if (!this.agentId) {
      throw new Error('DatabaseFixture not initialized. Call setup() first.');
    }
    return this.agentId;
  }

  /**
   * Get the database path (PGLite only, must call setup() first)
   */
  getDbPath(): string | null {
    return this.dbPath;
  }

  /**
   * Clean up database resources
   */
  async cleanup(): Promise<void> {
    if (this.cleanupPerformed) {
      return;
    }

    try {
      // Close database connection if adapter has a close method
      if (this.adapter && typeof (this.adapter as any).close === 'function') {
        try {
          await (this.adapter as any).close();
        } catch (error) {
          console.warn('Failed to close database adapter:', error);
        }
      }

      // Clean up database directory for PGLite
      if (this.dbPath && fs.existsSync(this.dbPath)) {
        try {
          fs.rmSync(this.dbPath, { recursive: true, force: true });
        } catch (error) {
          console.warn(`Failed to cleanup test database at ${this.dbPath}:`, error);
        }
      }

      // Restore environment
      if (this.envSnapshot) {
        await teardownTestEnvironment(this.envSnapshot);
      }
    } finally {
      this.cleanupPerformed = true;
      this.adapter = null;
      this.dbPath = null;
      this.envSnapshot = null;
      this.agentId = null;
    }
  }

  /**
   * Symbol.asyncDispose implementation for automatic cleanup
   * Enables `await using` syntax
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.cleanup();
  }

  /**
   * Helper to create a quick isolated PGLite database
   * @returns Database fixture result with adapter and cleanup function
   */
  static async createIsolated(
    options: DatabaseFixtureOptions = {}
  ): Promise<DatabaseFixtureResult & { cleanup: () => Promise<void> }> {
    const fixture = new DatabaseFixture();
    const result = await fixture.setup(options);

    return {
      ...result,
      cleanup: () => fixture.cleanup(),
    };
  }
}
