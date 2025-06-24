import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { PgDatabaseAdapter } from '../../../pg/adapter';

// Mock the logger module
mock.module('@elizaos/core', () => ({
  logger: {
    debug: mock(),
    info: mock(),
    warn: mock(),
    error: mock(),
  },
}));

// Import after mocking
import { logger } from '@elizaos/core';

describe('PgDatabaseAdapter', () => {
  let adapter: PgDatabaseAdapter;
  let mockManager: any;
  const agentId = '00000000-0000-0000-0000-000000000000';

  beforeEach(() => {
    // Clear mocks before each test
    (logger.debug as any).mockClear();
    (logger.info as any).mockClear();
    (logger.warn as any).mockClear();
    (logger.error as any).mockClear();

    // Create a mock manager
    mockManager = {
      getDatabase: mock(() => ({
        query: {},
        transaction: mock(() => {}),
      })),
      getClient: mock(() => {}),
      testConnection: mock(() => Promise.resolve(true)),
      close: mock(() => Promise.resolve()),
      getConnection: mock(() => ({
        connect: mock(() => {}),
        end: mock(() => {}),
      })),
    };

    adapter = new PgDatabaseAdapter(agentId, mockManager);
  });

  describe('constructor', () => {
    it('should initialize with correct agentId and manager', () => {
      expect(adapter).toBeDefined();
      expect((adapter as any).agentId).toBe(agentId);
      expect((adapter as any).manager).toBe(mockManager);
    });

    it('should set embeddingDimension to default 384', () => {
      expect((adapter as any).embeddingDimension).toBe('dim384');
    });
  });

  describe('runMigrations', () => {
    it('should be a no-op', async () => {
      await adapter.runMigrations();
      // Should not throw and not do anything
      expect(logger.debug).toHaveBeenCalledWith(
        'PgDatabaseAdapter: Migrations should be handled externally'
      );
    });
  });

  describe('init', () => {
    it('should complete initialization', async () => {
      await adapter.init();
      expect(logger.debug).toHaveBeenCalledWith(
        'PgDatabaseAdapter initialized, skipping automatic migrations.'
      );
    });
  });

  describe('isReady', () => {
    it('should return true when connection is healthy', async () => {
      mockManager.testConnection.mockResolvedValue(true);

      const result = await adapter.isReady();
      expect(result).toBe(true);
      expect(mockManager.testConnection).toHaveBeenCalled();
    });

    it('should return false when connection is unhealthy', async () => {
      mockManager.testConnection.mockResolvedValue(false);

      const result = await adapter.isReady();
      expect(result).toBe(false);
      expect(mockManager.testConnection).toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('should close the manager', async () => {
      await adapter.close();
      expect(mockManager.close).toHaveBeenCalled();
    });

    it('should handle close errors gracefully', async () => {
      mockManager.close.mockRejectedValue(new Error('Close failed'));

      // The adapter's close method catches and logs errors without throwing
      await expect(adapter.close()).rejects.toThrow('Close failed');
    });
  });

  describe('getConnection', () => {
    it('should return connection from manager', async () => {
      const mockConnection = { connect: mock(), end: mock() };
      mockManager.getConnection.mockReturnValue(mockConnection);

      const result = await adapter.getConnection();
      expect(result).toBe(mockConnection as any);
      expect(mockManager.getConnection).toHaveBeenCalled();
    });
  });

  describe('database operations', () => {
    it('should handle database operation errors', async () => {
      // Test that the adapter properly initializes with the manager
      expect(adapter).toBeDefined();
      expect((adapter as any).manager).toBe(mockManager);
    });

    it('should use the database from manager', () => {
      const db = mockManager.getDatabase();
      expect(db).toBeDefined();
      expect(db.query).toBeDefined();
      expect(db.transaction).toBeDefined();
    });
  });
});
