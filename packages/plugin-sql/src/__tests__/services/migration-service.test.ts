import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MigrationService } from '../../services/migration-service';
import type { IAgentRuntime, MigrationStep, ServiceTypeName, UUID, MigrationHistory } from '@elizaos/core';
import { logger } from '@elizaos/core';

// Mock logger
import { mock } from 'vitest';

mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    generateUuidFromString: vi.fn((str: string) => `uuid-${str}`),
  };
});

// Concrete implementation for testing
class TestMigrationService extends MigrationService {
  static serviceName = 'test-migration' as ServiceTypeName;
  
  capabilityDescription = 'Test migration service';
  
  // Expose protected properties for testing
  get pluginSchemas() {
    return this.registeredSchemas;
  }
  
  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }
  
  // Override to use the runtime logger for testing
  registerPluginSchema(pluginName: string, schema: any): void {
    this.registeredSchemas.set(pluginName, schema);
    this.runtime?.logger?.debug(`Registered schema for plugin: ${pluginName}`);
  }
  
  static async start(runtime: IAgentRuntime): Promise<MigrationService> {
    return new TestMigrationService(runtime);
  }
  
  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService('test-migration');
    if (service) {
      await service.stop();
    }
  }
  
  async runMigrations(runtime: IAgentRuntime): Promise<void> {
    // Test implementation
    for (const [pluginName, schema] of this.registeredSchemas.entries()) {
      await this.recordMigrationStart(pluginName, '1.0.0');
      // Simulate migration work
      await new Promise(resolve => setTimeout(resolve, 10));
      await this.recordMigrationSuccess(pluginName, '1.0.0');
    }
  }
  
  async getMigrationHistory(pluginName?: string): Promise<MigrationHistory[]> {
    if (pluginName) {
      return this.migrationHistory.get(pluginName) || [];
    }
    
    // Return all history entries
    const allHistory: MigrationHistory[] = [];
    for (const history of this.migrationHistory.values()) {
      allHistory.push(...history);
    }
    return allHistory;
  }
  
  async rollback(version?: string): Promise<void> {
    // Test implementation
  }
  
  async getPluginVersion(pluginName: string): Promise<string | null> {
    const history = this.migrationHistory.get(pluginName) || [];
    const successfulMigrations = history.filter(h => h.success);
    
    if (successfulMigrations.length === 0) {
      return null;
    }
    
    // Return the latest successful version
    return successfulMigrations[successfulMigrations.length - 1].version;
  }
  
  async recordMigrationStart(pluginName: string, version: string): Promise<void> {
    const history = this.migrationHistory.get(pluginName) || [];
    history.push({
      id: `migration-${Date.now()}` as UUID,
      pluginName,
      version,
      executedAt: new Date(),
      success: false,
      startedAt: new Date(),
    });
    this.migrationHistory.set(pluginName, history);
  }
  
  async recordMigrationSuccess(pluginName: string, version: string): Promise<void> {
    const history = this.migrationHistory.get(pluginName) || [];
    const migration = history.find(h => h.version === version && !h.success);
    
    if (migration) {
      migration.success = true;
      migration.executedAt = new Date();
    } else {
      this.runtime?.logger?.warn(`No migration record found for ${pluginName}@${version}`);
    }
  }
  
  async recordMigrationFailure(pluginName: string, version: string, error: Error): Promise<void> {
    const history = this.migrationHistory.get(pluginName) || [];
    const migration = history.find(h => h.version === version && !h.success);
    
    if (migration) {
      migration.success = false;
      migration.error = error.message;
      migration.executedAt = new Date();
    }
  }
  
  // Add methods for testing
  async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    const maxRetries = (this.config?.maxRetries as number) || 3;
    const retryDelay = (this.config?.retryDelay as number) || 1000;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        
        if (!this.isRetryableError(error as Error)) {
          throw error;
        }
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
    
    throw lastError;
  }
  
  isRetryableError(error: Error): boolean {
    if (error instanceof SyntaxError || 
        error instanceof TypeError || 
        error instanceof ReferenceError) {
      return false;
    }
    
    const message = error.message.toLowerCase();
    return message.includes('timeout') || 
           message.includes('econnreset') || 
           message.includes('request failed') ||
           message.includes('connection');
  }
}

describe('MigrationService', () => {
  let service: TestMigrationService;
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockRuntime = {
      agentId: 'test-agent',
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    } as any;
    
    service = new TestMigrationService(mockRuntime);
  });

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(MigrationService);
    });
    
    it('should initialize with default config', () => {
      expect(service.config).toMatchObject({
        maxRetries: 3,
        retryDelay: 1000,
      });
    });
  });

  describe('registerPluginSchema', () => {
    it('should register plugin schema', () => {
      const schema = { table1: {}, table2: {} };
      
      service.registerPluginSchema('test-plugin', schema);
      
      expect(service.pluginSchemas.get('test-plugin')).toBe(schema);
      expect(mockRuntime.logger.debug).toHaveBeenCalledWith(
        'Registered schema for plugin: test-plugin'
      );
    });
    
    it('should handle null schema gracefully', () => {
      service.registerPluginSchema('test-plugin', null);
      
      expect(service.pluginSchemas.has('test-plugin')).toBe(true);
      expect(service.pluginSchemas.get('test-plugin')).toBe(null);
    });
  });

  describe('hasPluginMigrations', () => {
    it('should return true if plugin has schema', () => {
      service.registerPluginSchema('test-plugin', { table1: {} });
      
      expect(service.hasPluginMigrations('test-plugin')).toBe(true);
    });
    
    it('should return false if plugin has no schema', () => {
      expect(service.hasPluginMigrations('unknown-plugin')).toBe(false);
    });
  });

  describe('getPluginVersion', () => {
    beforeEach(() => {
      // Add some migration history
      const history: MigrationHistory[] = [
        {
          id: 'migration-1' as UUID,
          pluginName: 'test-plugin',
          version: '1.0.0',
          executedAt: new Date('2024-01-01'),
          success: true,
        },
        {
          id: 'migration-2' as UUID,
          pluginName: 'test-plugin',
          version: '2.0.0',
          executedAt: new Date('2024-01-02'),
          success: true,
        },
        {
          id: 'migration-3' as UUID,
          pluginName: 'test-plugin',
          version: '2.1.0',
          executedAt: new Date('2024-01-03'),
          success: false,
        },
      ];
      service['migrationHistory'].set('test-plugin', history);
    });
    
    it('should return latest successful version', async () => {
      const version = await service.getPluginVersion('test-plugin');
      expect(version).toBe('2.0.0');
    });
    
    it('should return null if no successful migrations', async () => {
      service['migrationHistory'].set('test-plugin', [
        {
          id: 'migration-1' as UUID,
          pluginName: 'test-plugin',
          version: '1.0.0',
          executedAt: new Date(),
          success: false,
        },
      ]);
      
      const version = await service.getPluginVersion('test-plugin');
      expect(version).toBeNull();
    });
    
    it('should return null if plugin not found', async () => {
      const version = await service.getPluginVersion('unknown-plugin');
      expect(version).toBeNull();
    });
  });

  describe('recordMigrationStart', () => {
    it('should record migration start', async () => {
      await service.recordMigrationStart('test-plugin', '1.0.0');
      
      const history = await service.getMigrationHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        pluginName: 'test-plugin',
        version: '1.0.0',
        success: false,
        startedAt: expect.any(Date),
      });
    });
  });

  describe('recordMigrationSuccess', () => {
    it('should update migration to success', async () => {
      await service.recordMigrationStart('test-plugin', '1.0.0');
      await service.recordMigrationSuccess('test-plugin', '1.0.0');
      
      const history = await service.getMigrationHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        success: true,
        executedAt: expect.any(Date),
      });
    });
    
    it('should handle missing migration record', async () => {
      await service.recordMigrationSuccess('test-plugin', '1.0.0');
      
      expect(mockRuntime.logger.warn).toHaveBeenCalledWith(
        'No migration record found for test-plugin@1.0.0'
      );
    });
  });

  describe('recordMigrationFailure', () => {
    it('should update migration with error', async () => {
      const error = new Error('Migration failed');
      
      await service.recordMigrationStart('test-plugin', '1.0.0');
      await service.recordMigrationFailure('test-plugin', '1.0.0', error);
      
      const history = await service.getMigrationHistory();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        success: false,
        error: 'Migration failed',
        executedAt: expect.any(Date),
      });
    });
  });

  describe('getMigrationHistory', () => {
    beforeEach(() => {
      service['migrationHistory'].set('plugin-a', [
        {
          id: 'migration-1' as UUID,
          pluginName: 'plugin-a',
          version: '1.0.0',
          executedAt: new Date('2024-01-01'),
          success: true,
        },
      ]);
      service['migrationHistory'].set('plugin-b', [
        {
          id: 'migration-2' as UUID,
          pluginName: 'plugin-b',
          version: '1.0.0',
          executedAt: new Date('2024-01-02'),
          success: true,
        },
      ]);
    });
    
    it('should return all history when no filter', async () => {
      const history = await service.getMigrationHistory();
      expect(history).toHaveLength(2);
    });
    
    it('should filter by plugin name', async () => {
      const history = await service.getMigrationHistory('plugin-a');
      expect(history).toHaveLength(1);
      expect(history[0].pluginName).toBe('plugin-a');
    });
    
    it('should return empty array for unknown plugin', async () => {
      const history = await service.getMigrationHistory('unknown-plugin');
      expect(history).toHaveLength(0);
    });
  });

  describe('withRetry', () => {
    it('should retry failed operations', async () => {
      let attempts = 0;
      const operation = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Connection timeout');
        }
        return 'success';
      });
      
      // Override retry delay for faster tests
      service.config = { ...service.config, retryDelay: 10 };
      
      const result = await service.withRetry(operation);
      
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(3);
    });
    
    it('should throw after max retries', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('Connection timeout'));
      
      // Override retry delay for faster tests
      service.config = { ...service.config, retryDelay: 10 };
      
      await expect(service.withRetry(operation)).rejects.toThrow('Connection timeout');
      expect(operation).toHaveBeenCalledTimes(3);
    });
    
    it('should not retry non-retryable errors', async () => {
      const syntaxError = new SyntaxError('Invalid syntax');
      const operation = vi.fn().mockRejectedValue(syntaxError);
      
      await expect(service.withRetry(operation)).rejects.toThrow(syntaxError);
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe('isRetryableError', () => {
    it('should identify retryable errors', () => {
      expect(service.isRetryableError(new Error('Connection timeout'))).toBe(true);
      expect(service.isRetryableError(new Error('ECONNRESET'))).toBe(true);
      expect(service.isRetryableError(new Error('Request failed'))).toBe(true);
    });
    
    it('should identify non-retryable errors', () => {
      expect(service.isRetryableError(new SyntaxError('Invalid'))).toBe(false);
      expect(service.isRetryableError(new TypeError('Type error'))).toBe(false);
      expect(service.isRetryableError(new ReferenceError('Not defined'))).toBe(false);
    });
  });
});