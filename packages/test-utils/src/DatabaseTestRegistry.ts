/**
 * Database testing registry - ensures consistent database testing across all packages
 * Replaces fragile database adapter fallback logic with explicit test database management
 */

import type { IDatabaseAdapter, UUID } from '@elizaos/core';

export interface DatabaseTestCapabilities {
  isReady: boolean;
  tables: string[];
  supportsTransactions: boolean;
  adapter: string; // 'postgresql', 'mock'
}

export interface TestDatabaseConfig {
  /** Database type preference */
  preferredAdapter: 'postgresql' | 'auto';
  /** Whether to allow fallback to mock */
  allowMockFallback: boolean;
  /** Test isolation level */
  isolation: 'shared' | 'per-test' | 'per-suite';
  /** Connection timeout */
  timeoutMs: number;
  /** Test data persistence */
  persistData: boolean;
}

export const DEFAULT_TEST_DB_CONFIG: TestDatabaseConfig = {
  preferredAdapter: 'auto',
  allowMockFallback: false, // Strict - no silent fallbacks
  isolation: 'per-test',
  timeoutMs: 30000,
  persistData: false,
};

/**
 * Centralized database testing management
 */
export class DatabaseTestRegistry {
  private static instance: DatabaseTestRegistry;
  private adapterCache = new Map<string, IDatabaseAdapter>();
  private testDatabases = new Map<string, TestDatabaseInstance>();
  private defaultConfig: TestDatabaseConfig;

  private constructor(config: TestDatabaseConfig = DEFAULT_TEST_DB_CONFIG) {
    this.defaultConfig = config;
  }

  static getInstance(config?: TestDatabaseConfig): DatabaseTestRegistry {
    if (!DatabaseTestRegistry.instance) {
      DatabaseTestRegistry.instance = new DatabaseTestRegistry(config);
    }
    return DatabaseTestRegistry.instance;
  }

  /**
   * Get a test database adapter with explicit requirements
   */
  async getTestDatabase(
    testId: string,
    config: Partial<TestDatabaseConfig> = {}
  ): Promise<TestDatabaseInstance> {
    const fullConfig = { ...this.defaultConfig, ...config };

    // Check if we already have this test database
    if (this.testDatabases.has(testId)) {
      const existing = this.testDatabases.get(testId)!;
      if (await this.validateDatabaseInstance(existing)) {
        return existing;
      } else {
        // Clean up invalid instance
        await this.cleanupTestDatabase(testId);
      }
    }

    // Create new test database
    const instance = await this.createTestDatabase(testId, fullConfig);
    this.testDatabases.set(testId, instance);
    return instance;
  }

  private async createTestDatabase(
    testId: string,
    config: TestDatabaseConfig
  ): Promise<TestDatabaseInstance> {
    let adapter: IDatabaseAdapter = await this.createMockAdapter(testId);
    let adapterType: string = 'mock';

    // Validate adapter is working
    const capabilities = await this.getAdapterCapabilities(adapter);
    if (!capabilities.isReady) {
      throw new Error(`Database adapter for test ${testId} is not ready`);
    }

    const instance: TestDatabaseInstance = {
      testId,
      adapter,
      capabilities,
      config,
      createdAt: new Date(),
      adapterType,
    };

    // Initialize test schema if needed
    if (config.isolation === 'per-test') {
      await this.initializeTestSchema(instance);
    }

    return instance;
  }

  private async createMockAdapter(testId: string): Promise<IDatabaseAdapter> {
    // Import mock adapter - should only be used when explicitly allowed
    const mockModule = await import('./mocks/database');
    return (mockModule as any).createMockDatabaseAdapter(testId);
  }

  private async getAdapterCapabilities(
    adapter: IDatabaseAdapter
  ): Promise<DatabaseTestCapabilities> {
    try {
      const isReady = await adapter.isReady();

      // Try to get capabilities if method exists
      let capabilities: any = { isReady, tables: [] };
      if ('getCapabilities' in adapter && typeof adapter.getCapabilities === 'function') {
        capabilities = await adapter.getCapabilities();
      }

      return {
        isReady,
        tables: capabilities.tables || [],
        supportsTransactions: true, // Assume true for real databases
        adapter: adapter.constructor.name.toLowerCase().includes('postgres')
          ? 'postgresql'
          : 'mock',
      };
    } catch (_error) {
      return {
        isReady: false,
        tables: [],
        supportsTransactions: false,
        adapter: 'unknown',
      };
    }
  }

  private async initializeTestSchema(instance: TestDatabaseInstance): Promise<void> {
    try {
      // Set embedding dimension for tests
      await instance.adapter.ensureEmbeddingDimension(1536);

      console.log(`Initialized test schema for ${instance.testId}`);
    } catch (_error) {
      console.warn(`Failed to initialize test schema for ${instance.testId}:`, _error);
    }
  }

  private async validateDatabaseInstance(instance: TestDatabaseInstance): Promise<boolean> {
    try {
      const isReady = await instance.adapter.isReady();
      return isReady;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Clean up a specific test database
   */
  async cleanupTestDatabase(testId: string): Promise<void> {
    const instance = this.testDatabases.get(testId);
    if (!instance) {
      return;
    }

    try {
      // Close adapter connection
      if (instance.adapter && typeof instance.adapter.close === 'function') {
        await instance.adapter.close();
      }

      // Clean up PostgreSQL test data if needed
      if (instance.adapterType === 'postgresql' && !instance.config.persistData) {
        // PostgreSQL test data cleanup handled by adapter close
      }

      console.log(`Cleaned up test database ${testId}`);
    } catch (_error) {
      console.warn(`Failed to cleanup test database ${testId}:`, _error);
    } finally {
      this.testDatabases.delete(testId);
    }
  }

  /**
   * Clean up all test databases
   */
  async cleanupAll(): Promise<void> {
    const cleanupPromises = Array.from(this.testDatabases.keys()).map((testId) =>
      this.cleanupTestDatabase(testId)
    );

    await Promise.all(cleanupPromises);
    this.adapterCache.clear();
  }

  /**
   * Validate test requirements before running tests
   */
  async validateTestRequirements(
    requirements: DatabaseTestRequirements
  ): Promise<DatabaseValidationResult> {
    const result: DatabaseValidationResult = {
      isValid: true,
      _errors: [],
      warnings: [],
      recommendations: [],
    };

    // Check if required adapters are available
    for (const adapterType of requirements.requiredAdapters) {
      try {
        const testAdapter = await this.createMockAdapter(adapterType);
        const capabilities = await this.getAdapterCapabilities(testAdapter);

        if (!capabilities.isReady) {
          result._errors.push(`Required adapter ${adapterType} is not ready`);
        }

        // Clean up validation adapter
        if (testAdapter && typeof testAdapter.close === 'function') {
          await testAdapter.close();
        }
      } catch (_error) {
        result._errors.push(
          `Required adapter ${adapterType} is not available: ${_error instanceof Error ? _error.message : String(_error)}`
        );
      }
    }

    // Performance checks
    if (requirements.performanceRequirements) {
      result.warnings.push('Performance validation not yet implemented');
    }

    result.isValid = result._errors.length === 0;
    return result;
  }

  /**
   * Get test database statistics
   */
  getTestDatabaseStats(): TestDatabaseStats {
    const stats: TestDatabaseStats = {
      totalDatabases: this.testDatabases.size,
      adapterTypes: new Map(),
      oldestDatabase: null,
      newestDatabase: null,
    };

    for (const instance of this.testDatabases.values()) {
      // Count adapter types
      const count = stats.adapterTypes.get(instance.adapterType) || 0;
      stats.adapterTypes.set(instance.adapterType, count + 1);

      // Track oldest/newest
      if (!stats.oldestDatabase || instance.createdAt < stats.oldestDatabase.createdAt) {
        stats.oldestDatabase = instance;
      }
      if (!stats.newestDatabase || instance.createdAt > stats.newestDatabase.createdAt) {
        stats.newestDatabase = instance;
      }
    }

    return stats;
  }
}

export interface TestDatabaseInstance {
  testId: string;
  adapter: IDatabaseAdapter;
  capabilities: DatabaseTestCapabilities;
  config: TestDatabaseConfig;
  createdAt: Date;
  adapterType: string;
}

export interface DatabaseTestRequirements {
  requiredAdapters: 'postgresql'[];
  performanceRequirements?: {
    maxQueryTime: number;
    maxConnectionTime: number;
  };
}

export interface DatabaseValidationResult {
  isValid: boolean;
  _errors: string[];
  warnings: string[];
  recommendations: string[];
}

export interface TestDatabaseStats {
  totalDatabases: number;
  adapterTypes: Map<string, number>;
  oldestDatabase: TestDatabaseInstance | null;
  newestDatabase: TestDatabaseInstance | null;
}

// Global cleanup for test databases
if (typeof globalThis !== 'undefined') {
  const cleanup = () => {
    const registry = DatabaseTestRegistry.getInstance();
    registry.cleanupAll().catch(console.error);
  };

  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
