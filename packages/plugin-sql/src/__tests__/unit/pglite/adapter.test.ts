import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgliteDatabaseAdapter } from '../../../pglite/adapter';

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

describe('PgliteDatabaseAdapter', () => {
  let adapter: PgliteDatabaseAdapter;
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
      getConnection: mock().mockReturnValue({
        query: mock().mockResolvedValue({ rows: [] }),
        close: mock().mockResolvedValue(undefined),
        transaction: mock(),
      }),
      close: mock().mockResolvedValue(undefined),
      isShuttingDown: mock().mockReturnValue(false),
    };

    adapter = new PgliteDatabaseAdapter(agentId, mockManager);
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
        'PgliteDatabaseAdapter: Migrations are handled by the migration service'
      );
    });
  });

  describe('init', () => {
    it('should complete initialization', async () => {
      await adapter.init();
      expect(logger.debug).toHaveBeenCalledWith(
        'PGliteDatabaseAdapter initialized, skipping automatic migrations.'
      );
    });
  });

  describe('close', () => {
    it('should close the manager', async () => {
      await adapter.close();
      expect(mockManager.close).toHaveBeenCalled();
    });
  });

  describe('isReady', () => {
    it('should return true when manager is not shutting down', async () => {
      mockManager.isShuttingDown.mockReturnValue(false);
      const result = await adapter.isReady();
      expect(result).toBe(true);
    });

    it('should return false when manager is shutting down', async () => {
      mockManager.isShuttingDown.mockReturnValue(true);
      const result = await adapter.isReady();
      expect(result).toBe(false);
    });
  });

  describe('getConnection', () => {
    it('should return the connection from manager', async () => {
      const mockConnection = { query: mock(), close: mock() };
      mockManager.getConnection.mockReturnValue(mockConnection);

      const result = await adapter.getConnection();
      expect(result).toBe(mockConnection as any);
      expect(mockManager.getConnection).toHaveBeenCalled();
    });
  });

  describe('database operations', () => {
    it('should use the connection from manager for operations', () => {
      const mockConnection = mockManager.getConnection();
      expect(mockConnection).toBeDefined();
      expect(mockConnection.query).toBeDefined();
      expect(mockConnection.transaction).toBeDefined();
    });

    it('should handle query errors gracefully', async () => {
      const mockConnection = {
        query: mock().mockRejectedValue(new Error('Query failed')),
      };
      mockManager.getConnection.mockReturnValue(mockConnection);

      const connection = await adapter.getConnection();
      await expect(connection.query('SELECT 1')).rejects.toThrow('Query failed');
    });
  });
});
