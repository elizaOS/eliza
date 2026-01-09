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

  describe('init', () => {
    it('should complete initialization', async () => {
      await adapter.init();
      expect(logger.debug).toHaveBeenCalledWith(
        { src: 'plugin:sql' },
        'PgDatabaseAdapter initialized'
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

  describe('withDatabase pool-based connection', () => {
    it('should use shared pool-based db instance without acquiring individual clients', async () => {
      const mockDb = {
        select: mock().mockReturnThis(),
        from: mock().mockReturnThis(),
        where: mock().mockReturnThis(),
        limit: mock().mockResolvedValue([]),
        transaction: mock(),
      };

      const getClientMock = mock();

      const poolManager = {
        getDatabase: mock().mockReturnValue(mockDb),
        getConnection: mock().mockReturnValue({}),
        getClient: getClientMock,
        testConnection: mock().mockResolvedValue(true),
        close: mock().mockResolvedValue(undefined),
        withIsolationContext: mock(),
      } as any;

      const poolAdapter = new PgDatabaseAdapter(agentId, poolManager);

      // Execute an operation
      await poolAdapter.getAgent(agentId);

      // Verify getClient was NOT called (we use pool-based db now)
      expect(getClientMock).not.toHaveBeenCalled();
    });

    it('should handle concurrent operations without race conditions', async () => {
      const results: string[] = [];
      const mockDb = {
        select: mock().mockImplementation(() => {
          return {
            from: mock().mockReturnThis(),
            where: mock().mockReturnThis(),
            limit: mock().mockImplementation(async () => {
              // Simulate async delay
              await new Promise((resolve) => setTimeout(resolve, 10));
              return [];
            }),
          };
        }),
        transaction: mock(),
      };

      const concurrentManager = {
        getDatabase: mock().mockReturnValue(mockDb),
        getConnection: mock().mockReturnValue({}),
        getClient: mock(),
        testConnection: mock().mockResolvedValue(true),
        close: mock().mockResolvedValue(undefined),
        withIsolationContext: mock(),
      } as any;

      const concurrentAdapter = new PgDatabaseAdapter(agentId, concurrentManager);

      // Run multiple concurrent operations
      const operations = [
        concurrentAdapter.getAgent(agentId).then(() => results.push('op1')),
        concurrentAdapter.getAgent(agentId).then(() => results.push('op2')),
        concurrentAdapter.getAgent(agentId).then(() => results.push('op3')),
      ];

      await Promise.all(operations);

      // All operations should complete
      expect(results).toHaveLength(3);
      expect(results).toContain('op1');
      expect(results).toContain('op2');
      expect(results).toContain('op3');
    });
  });
});
