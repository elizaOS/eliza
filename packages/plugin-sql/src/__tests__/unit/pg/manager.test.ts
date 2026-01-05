import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Create mock pool instance
const mockPoolInstance = {
  connect: mock(),
  end: mock(),
  query: mock(),
};

// Mock the 'pg' module
mock.module('pg', () => ({
  Pool: mock(() => mockPoolInstance),
}));

// Import after mocking
import { PostgresConnectionManager } from '../../../pg/manager';

describe('PostgresConnectionManager', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    mockPoolInstance.connect.mockClear();
    mockPoolInstance.end.mockClear();
    mockPoolInstance.query.mockClear();
  });

  describe('constructor', () => {
    it('should create an instance with connection URL', () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);

      expect(manager).toBeDefined();
      expect(manager.getConnection()).toBeDefined();
      expect(manager.getDatabase()).toBeDefined();
    });
  });

  describe('getDatabase', () => {
    it('should return the drizzle database instance', () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);

      const db = manager.getDatabase();
      expect(db).toBeDefined();
      expect(db.query).toBeDefined();
    });
  });

  describe('getConnection', () => {
    it('should return the pool instance', () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);

      const connection = manager.getConnection();
      expect(connection).toBeDefined();
      expect(connection).toBe(mockPoolInstance as any);
    });
  });

  describe('getClient', () => {
    it('should return a client from the pool', async () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);

      const mockClient = {
        query: mock().mockResolvedValue({ rows: [] }),
        release: mock(),
      };

      mockPoolInstance.connect.mockResolvedValue(mockClient);

      const client = await manager.getClient();
      expect(client).toBe(mockClient as any);
      expect(mockPoolInstance.connect).toHaveBeenCalled();
    });

    it('should throw error when pool connection fails', async () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);

      mockPoolInstance.connect.mockRejectedValue(new Error('Connection failed'));

      await expect(manager.getClient()).rejects.toThrow('Connection failed');
    });
  });

  describe('testConnection', () => {
    it('should return true when connection is successful', async () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);

      const mockClient = {
        query: mock().mockResolvedValue({ rows: [] }),
        release: mock(),
      };

      mockPoolInstance.connect.mockResolvedValue(mockClient);

      const result = await manager.testConnection();
      expect(result).toBe(true);
      expect(mockPoolInstance.connect).toHaveBeenCalled();
      expect(mockClient.query).toHaveBeenCalledWith('SELECT 1');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should return false when connection fails', async () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);

      mockPoolInstance.connect.mockRejectedValue(new Error('Connection failed'));

      const result = await manager.testConnection();
      expect(result).toBe(false);
    });

    it('should return false when query fails', async () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);

      const mockClient = {
        query: mock().mockRejectedValue(new Error('Query failed')),
        release: mock(),
      };

      mockPoolInstance.connect.mockResolvedValue(mockClient);

      const result = await manager.testConnection();
      expect(result).toBe(false);
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('should end the pool connection', async () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);

      mockPoolInstance.end.mockResolvedValue(undefined);

      await manager.close();
      expect(mockPoolInstance.end).toHaveBeenCalled();
    });

    it('should propagate errors during close', async () => {
      const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
      const manager = new PostgresConnectionManager(connectionUrl);

      mockPoolInstance.end.mockRejectedValue(new Error('Close failed'));

      await expect(manager.close()).rejects.toThrow('Close failed');
    });
  });

  describe('withEntityContext', () => {
    const connectionUrl = 'postgresql://user:pass@localhost:5432/testdb';
    const testEntityId = '9f984e0e-1329-43f3-b2b7-02f74a148990';

    beforeEach(() => {
      // Reset environment variable
      delete process.env.ENABLE_DATA_ISOLATION;
    });

    it('should skip SET LOCAL when ENABLE_DATA_ISOLATION is not set', async () => {
      const manager = new PostgresConnectionManager(connectionUrl);
      const db = manager.getDatabase();

      // Mock the transaction method
      const mockTx = {
        execute: mock().mockResolvedValue({ rows: [] }),
        select: mock().mockReturnThis(),
        from: mock().mockReturnThis(),
      };

      const originalTransaction = db.transaction;
      db.transaction = mock(async (callback: any) => {
        return callback(mockTx);
      }) as any;

      const result = await manager.withEntityContext(testEntityId as any, async (_tx) => {
        return 'success';
      });

      expect(result).toBe('success');
      // SET LOCAL should NOT be called when ENABLE_DATA_ISOLATION is not true
      expect(mockTx.execute).not.toHaveBeenCalled();

      db.transaction = originalTransaction;
    });

    it('should skip SET LOCAL when entityId is null', async () => {
      process.env.ENABLE_DATA_ISOLATION = 'true';

      const manager = new PostgresConnectionManager(connectionUrl);
      const db = manager.getDatabase();

      const mockTx = {
        execute: mock().mockResolvedValue({ rows: [] }),
      };

      const originalTransaction = db.transaction;
      db.transaction = mock(async (callback: any) => {
        return callback(mockTx);
      }) as any;

      const result = await manager.withEntityContext(null, async (_tx) => {
        return 'success';
      });

      expect(result).toBe('success');
      // SET LOCAL should NOT be called when entityId is null
      expect(mockTx.execute).not.toHaveBeenCalled();

      db.transaction = originalTransaction;
    });

    it('should execute SET LOCAL with raw SQL (not parameterized) when isolation is enabled', async () => {
      process.env.ENABLE_DATA_ISOLATION = 'true';

      const manager = new PostgresConnectionManager(connectionUrl);
      const db = manager.getDatabase();

      let executedQuery: any = null;
      const mockTx = {
        execute: mock((query: any) => {
          executedQuery = query;
          return Promise.resolve({ rows: [] });
        }),
      };

      const originalTransaction = db.transaction;
      db.transaction = mock(async (callback: any) => {
        return callback(mockTx);
      }) as any;

      await manager.withEntityContext(testEntityId as any, async (_tx) => {
        return 'success';
      });

      expect(mockTx.execute).toHaveBeenCalled();

      // Verify the query uses sql.raw() (inline value) not parameterized
      // sql.raw() produces a query with the value embedded in queryChunks[0].value[0]
      expect(executedQuery).toBeDefined();
      const queryStr = executedQuery?.queryChunks?.[0]?.value?.[0] || String(executedQuery);
      expect(queryStr).toContain(testEntityId);
      expect(queryStr).not.toContain('$1');

      db.transaction = originalTransaction;
    });

    it('should propagate callback errors', async () => {
      process.env.ENABLE_DATA_ISOLATION = 'true';

      const manager = new PostgresConnectionManager(connectionUrl);
      const db = manager.getDatabase();

      const mockTx = {
        execute: mock().mockResolvedValue({ rows: [] }),
      };

      const originalTransaction = db.transaction;
      db.transaction = mock(async (callback: any) => {
        return callback(mockTx);
      }) as any;

      await expect(
        manager.withEntityContext(testEntityId as any, async (_tx) => {
          throw new Error('Callback error');
        })
      ).rejects.toThrow('Callback error');

      db.transaction = originalTransaction;
    });
  });
});
