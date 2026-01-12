import type { UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Create mock pool instance - must be defined before vi.mock
const mockConnect = vi.fn();
const mockEnd = vi.fn();
const mockQuery = vi.fn();
const mockOn = vi.fn();

// Mock the 'pg' module with a proper constructor class
vi.mock("pg", () => {
  // Define the mock Pool class inside the factory to avoid hoisting issues
  const MockPool = function (this: Record<string, unknown>) {
    this.connect = mockConnect;
    this.end = mockEnd;
    this.query = mockQuery;
    this.on = mockOn;
    return this;
  };

  return {
    Pool: MockPool,
  };
});

// Import after mocking
import { PostgresConnectionManager } from "../../../pg/manager";

// Helper to access the mock functions
const mockPoolInstance = {
  connect: mockConnect,
  end: mockEnd,
  query: mockQuery,
  on: mockOn,
};

describe("PostgresConnectionManager", () => {
  beforeEach(() => {
    // Clear all mocks before each test
    mockPoolInstance.connect.mockClear();
    mockPoolInstance.end.mockClear();
    mockPoolInstance.query.mockClear();
  });

  describe("constructor", () => {
    it("should create an instance with connection URL", () => {
      const connectionUrl = "postgresql://user:pass@localhost:5432/testdb";
      const manager = new PostgresConnectionManager(connectionUrl);

      expect(manager).toBeDefined();
      expect(manager.getConnection()).toBeDefined();
      expect(manager.getDatabase()).toBeDefined();
    });
  });

  describe("getDatabase", () => {
    it("should return the drizzle database instance", () => {
      const connectionUrl = "postgresql://user:pass@localhost:5432/testdb";
      const manager = new PostgresConnectionManager(connectionUrl);

      const db = manager.getDatabase();
      expect(db).toBeDefined();
      expect(db.query).toBeDefined();
    });
  });

  describe("getConnection", () => {
    it("should return the pool instance", () => {
      const connectionUrl = "postgresql://user:pass@localhost:5432/testdb";
      const manager = new PostgresConnectionManager(connectionUrl);

      const connection = manager.getConnection();
      expect(connection).toBeDefined();
      // Check that the connection has the expected mock functions
      expect(connection.connect).toBe(mockPoolInstance.connect);
      expect(connection.end).toBe(mockPoolInstance.end);
      expect(connection.query).toBe(mockPoolInstance.query);
    });
  });

  describe("getClient", () => {
    it("should return a client from the pool", async () => {
      const connectionUrl = "postgresql://user:pass@localhost:5432/testdb";
      const manager = new PostgresConnectionManager(connectionUrl);

      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      };

      mockPoolInstance.connect.mockResolvedValue(mockClient);

      const client = await manager.getClient();
      expect(client).toBe(mockClient);
      expect(mockPoolInstance.connect).toHaveBeenCalled();
    });

    it("should throw error when pool connection fails", async () => {
      const connectionUrl = "postgresql://user:pass@localhost:5432/testdb";
      const manager = new PostgresConnectionManager(connectionUrl);

      mockPoolInstance.connect.mockRejectedValue(new Error("Connection failed"));

      await expect(manager.getClient()).rejects.toThrow("Connection failed");
    });
  });

  describe("testConnection", () => {
    it("should return true when connection is successful", async () => {
      const connectionUrl = "postgresql://user:pass@localhost:5432/testdb";
      const manager = new PostgresConnectionManager(connectionUrl);

      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      };

      mockPoolInstance.connect.mockResolvedValue(mockClient);

      const result = await manager.testConnection();
      expect(result).toBe(true);
      expect(mockPoolInstance.connect).toHaveBeenCalled();
      expect(mockClient.query).toHaveBeenCalledWith("SELECT 1");
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("should return false when connection fails", async () => {
      const connectionUrl = "postgresql://user:pass@localhost:5432/testdb";
      const manager = new PostgresConnectionManager(connectionUrl);

      mockPoolInstance.connect.mockRejectedValue(new Error("Connection failed"));

      const result = await manager.testConnection();
      expect(result).toBe(false);
    });

    it("should return false when query fails", async () => {
      const connectionUrl = "postgresql://user:pass@localhost:5432/testdb";
      const manager = new PostgresConnectionManager(connectionUrl);

      const mockClient = {
        query: vi.fn().mockRejectedValue(new Error("Query failed")),
        release: vi.fn(),
      };

      mockPoolInstance.connect.mockResolvedValue(mockClient);

      const result = await manager.testConnection();
      expect(result).toBe(false);
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe("close", () => {
    it("should end the pool connection", async () => {
      const connectionUrl = "postgresql://user:pass@localhost:5432/testdb";
      const manager = new PostgresConnectionManager(connectionUrl);

      mockPoolInstance.end.mockResolvedValue(undefined);

      await manager.close();
      expect(mockPoolInstance.end).toHaveBeenCalled();
    });

    it("should propagate errors during close", async () => {
      const connectionUrl = "postgresql://user:pass@localhost:5432/testdb";
      const manager = new PostgresConnectionManager(connectionUrl);

      mockPoolInstance.end.mockRejectedValue(new Error("Close failed"));

      await expect(manager.close()).rejects.toThrow("Close failed");
    });
  });

  describe("withEntityContext", () => {
    const connectionUrl = "postgresql://user:pass@localhost:5432/testdb";
    const testEntityId = "9f984e0e-1329-43f3-b2b7-02f74a148990";

    beforeEach(() => {
      // Reset environment variable
      delete process.env.ENABLE_DATA_ISOLATION;
    });

    it("should skip SET LOCAL when ENABLE_DATA_ISOLATION is not set", async () => {
      const manager = new PostgresConnectionManager(connectionUrl);
      const db = manager.getDatabase();

      // Mock the transaction method
      const mockTx = {
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
      };

      const originalTransaction = db.transaction;
      db.transaction = vi.fn(async (callback: (tx: typeof mockTx) => Promise<string>) => {
        return callback(mockTx);
      }) as typeof db.transaction;

      const result = await manager.withEntityContext(testEntityId as UUID, async (_tx) => {
        return "success";
      });

      expect(result).toBe("success");
      // SET LOCAL should NOT be called when ENABLE_DATA_ISOLATION is not true
      expect(mockTx.execute).not.toHaveBeenCalled();

      db.transaction = originalTransaction;
    });

    it("should skip SET LOCAL when entityId is null", async () => {
      process.env.ENABLE_DATA_ISOLATION = "true";

      const manager = new PostgresConnectionManager(connectionUrl);
      const db = manager.getDatabase();

      const mockTx = {
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      };

      const originalTransaction = db.transaction;
      db.transaction = vi.fn(async (callback: (tx: typeof mockTx) => Promise<string>) => {
        return callback(mockTx);
      }) as typeof db.transaction;

      const result = await manager.withEntityContext(null, async (_tx) => {
        return "success";
      });

      expect(result).toBe("success");
      // SET LOCAL should NOT be called when entityId is null
      expect(mockTx.execute).not.toHaveBeenCalled();

      db.transaction = originalTransaction;
    });

    it("should execute SET LOCAL with raw SQL (not parameterized) when isolation is enabled", async () => {
      process.env.ENABLE_DATA_ISOLATION = "true";

      const manager = new PostgresConnectionManager(connectionUrl);
      const db = manager.getDatabase();

      let executedQuery: unknown = null;
      const mockTx = {
        execute: vi.fn((query: unknown) => {
          executedQuery = query;
          return Promise.resolve({ rows: [] });
        }),
      };

      const originalTransaction = db.transaction;
      db.transaction = vi.fn(async (callback: (tx: typeof mockTx) => Promise<string>) => {
        return callback(mockTx);
      }) as typeof db.transaction;

      await manager.withEntityContext(testEntityId as UUID, async (_tx) => {
        return "success";
      });

      expect(mockTx.execute).toHaveBeenCalled();

      // Verify the query uses sql.raw() (inline value) not parameterized
      // sql.raw() produces a query with the value embedded in queryChunks[0].value[0]
      expect(executedQuery).toBeDefined();
      const queryStr = executedQuery?.queryChunks?.[0]?.value?.[0] || String(executedQuery);
      expect(queryStr).toContain(testEntityId);
      expect(queryStr).not.toContain("$1");

      db.transaction = originalTransaction;
    });

    it("should propagate callback errors", async () => {
      process.env.ENABLE_DATA_ISOLATION = "true";

      const manager = new PostgresConnectionManager(connectionUrl);
      const db = manager.getDatabase();

      const mockTx = {
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      };

      const originalTransaction = db.transaction;
      db.transaction = vi.fn(async (callback: (tx: typeof mockTx) => Promise<string>) => {
        return callback(mockTx);
      }) as typeof db.transaction;

      await expect(
        manager.withEntityContext(testEntityId as UUID, async (_tx) => {
          throw new Error("Callback error");
        })
      ).rejects.toThrow("Callback error");

      db.transaction = originalTransaction;
    });
  });
});
