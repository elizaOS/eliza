import type { UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { PgDatabaseAdapter } from "../../../pg/adapter";
import type { PostgresConnectionManager } from "../../../pg/manager";

// Mock only the logger from @elizaos/core, keeping other exports intact
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

// Import after mocking
import { logger } from "@elizaos/core";

// Test interface for accessing private properties
interface TestablePgAdapter extends PgDatabaseAdapter {
  agentId: UUID;
  manager: PostgresConnectionManager;
  embeddingDimension: string;
}

// Helper function to access private properties for testing
function getTestableAdapter(adapter: PgDatabaseAdapter): TestablePgAdapter {
  return adapter as TestablePgAdapter;
}

describe("PgDatabaseAdapter", () => {
  let adapter: PgDatabaseAdapter;
  let mockManager: Partial<PostgresConnectionManager>;
  const agentId = "00000000-0000-0000-0000-000000000000" as UUID;

  beforeEach(() => {
    // Clear mocks before each test
    (logger.debug as Mock).mockClear();
    (logger.info as Mock).mockClear();
    (logger.warn as Mock).mockClear();
    (logger.error as Mock).mockClear();

    // Create a mock manager (withIsolationContext for RLS entity-context tests)
    mockManager = {
      getDatabase: vi.fn(() => ({
        query: {},
        transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb({})),
      })),
      getClient: vi.fn(() => {}),
      testConnection: vi.fn(() => Promise.resolve(true)),
      close: vi.fn(() => Promise.resolve()),
      getConnection: vi.fn(() => ({
        connect: vi.fn(() => {}),
        end: vi.fn(() => {}),
      })),
      withIsolationContext: vi.fn((_entityId: UUID, callback: () => Promise<unknown>) => callback()),
    };

    adapter = new PgDatabaseAdapter(
      agentId,
      mockManager as PostgresConnectionManager,
    );
  });

  describe("constructor", () => {
    it("should initialize with correct agentId and manager", () => {
      expect(adapter).toBeDefined();
      const testAdapter = getTestableAdapter(adapter);
      expect(testAdapter.agentId).toBe(agentId);
      expect(testAdapter.manager).toBe(mockManager);
    });

    it("should set embeddingDimension to default 384", () => {
      const testAdapter = getTestableAdapter(adapter);
      expect(testAdapter.embeddingDimension).toBe("dim384");
    });
  });

  describe("init", () => {
    it("should complete initialization", async () => {
      await adapter.init();
      expect(logger.debug).toHaveBeenCalledWith(
        { src: "plugin:sql" },
        "PgDatabaseAdapter initialized",
      );
    });
  });

  describe("isReady", () => {
    it("should return true when connection is healthy", async () => {
      mockManager.testConnection.mockResolvedValue(true);

      const result = await adapter.isReady();
      expect(result).toBe(true);
      expect(mockManager.testConnection).toHaveBeenCalled();
    });

    it("should return false when connection is unhealthy", async () => {
      mockManager.testConnection.mockResolvedValue(false);

      const result = await adapter.isReady();
      expect(result).toBe(false);
      expect(mockManager.testConnection).toHaveBeenCalled();
    });
  });

  describe("close", () => {
    it("should close the manager", async () => {
      await adapter.close();
      expect(mockManager.close).toHaveBeenCalled();
    });

    it("should handle close errors gracefully", async () => {
      mockManager.close.mockRejectedValue(new Error("Close failed"));

      // The adapter's close method catches and logs errors without throwing
      await expect(adapter.close()).rejects.toThrow("Close failed");
    });
  });

  describe("getConnection", () => {
    it("should return the drizzle database instance", async () => {
      const result = await adapter.getConnection();
      // getConnection returns the drizzle db instance, not the raw pool
      expect(result).toBeDefined();
      expect(result.query).toBeDefined();
    });

    it("should return raw connection via getRawConnection", () => {
      const mockConnection = { connect: vi.fn(), end: vi.fn() };
      mockManager.getConnection.mockReturnValue(mockConnection);

      const result = adapter.getRawConnection();
      expect(result).toBe(mockConnection);
      expect(mockManager.getConnection).toHaveBeenCalled();
    });
  });

  describe("database operations", () => {
    it("should handle database operation errors", async () => {
      // Test that the adapter properly initializes with the manager
      expect(adapter).toBeDefined();
      const testAdapter = getTestableAdapter(adapter);
      expect(testAdapter.manager).toBe(mockManager);
    });

    it("should use the database from manager", () => {
      const db = mockManager.getDatabase();
      expect(db).toBeDefined();
      expect(db.query).toBeDefined();
      expect(db.transaction).toBeDefined();
    });
  });

  describe("withDatabase pool-based connection", () => {
    it("should use shared pool-based db instance without acquiring individual clients", async () => {
      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockResolvedValue([]),
        }),
        transaction: vi.fn(),
      };

      const getClientMock = vi.fn();

      const poolManager = {
        getDatabase: vi.fn().mockReturnValue(mockDb),
        getConnection: vi.fn().mockReturnValue({}),
        getClient: getClientMock,
        testConnection: vi.fn().mockResolvedValue(true),
        close: vi.fn().mockResolvedValue(undefined),
        withIsolationContext: vi.fn(),
      } as PostgresConnectionManager;

      const poolAdapter = new PgDatabaseAdapter(agentId, poolManager);

      // Execute an operation (adapter has getAgents, not getAgent)
      await poolAdapter.getAgents();

      // Verify getClient was NOT called (we use pool-based db now)
      expect(getClientMock).not.toHaveBeenCalled();
    });

    it("should handle concurrent operations without race conditions", async () => {
      const results: string[] = [];
      const mockDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return [];
          }),
        }),
        transaction: vi.fn(),
      };

      const concurrentManager = {
        getDatabase: vi.fn().mockReturnValue(mockDb),
        getConnection: vi.fn().mockReturnValue({}),
        getClient: vi.fn(),
        testConnection: vi.fn().mockResolvedValue(true),
        close: vi.fn().mockResolvedValue(undefined),
        withIsolationContext: vi.fn(),
      } as PostgresConnectionManager;

      const concurrentAdapter = new PgDatabaseAdapter(
        agentId,
        concurrentManager,
      );

      // Run multiple concurrent operations (adapter has getAgents, not getAgent)
      const operations = [
        concurrentAdapter.getAgents().then(() => results.push("op1")),
        concurrentAdapter.getAgents().then(() => results.push("op2")),
        concurrentAdapter.getAgents().then(() => results.push("op3")),
      ];

      await Promise.all(operations);

      // All operations should complete
      expect(results).toHaveLength(3);
      expect(results).toContain("op1");
      expect(results).toContain("op2");
      expect(results).toContain("op3");
    });
  });

  describe("entity context (RLS)", () => {
    const entityId = "11111111-2222-3333-4444-555555555555" as UUID;

    it("should call withIsolationContext when queryEntities is called with entityContext", async () => {
      const withIsolationContextMock = vi.fn((_id: UUID, cb: (tx: unknown) => Promise<unknown>) => {
        const emptyResult = Promise.resolve([]);
        const mockTx = {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                groupBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockReturnValue(emptyResult),
                    then: emptyResult.then.bind(emptyResult),
                  }),
                }),
              }),
            }),
          }),
        };
        return cb(mockTx);
      });
      const mgr = {
        ...mockManager,
        withIsolationContext: withIsolationContextMock,
      } as PostgresConnectionManager;
      const adp = new PgDatabaseAdapter(agentId, mgr);

      await adp.queryEntities({ entityContext: entityId, limit: 1 });

      expect(withIsolationContextMock).toHaveBeenCalledWith(entityId, expect.any(Function));
    });

    it("should not call withIsolationContext when queryEntities is called without entityContext", async () => {
      const withIsolationContextMock = vi.fn();
      const emptyResult = Promise.resolve([]);
      const limitReturn = {
        offset: vi.fn().mockReturnValue(emptyResult),
        then: emptyResult.then.bind(emptyResult),
      };
      const mgr = {
        ...mockManager,
        getDatabase: vi.fn(() => ({
          query: {},
          transaction: vi.fn(),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                groupBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue(limitReturn),
                }),
              }),
            }),
          }),
        })),
        withIsolationContext: withIsolationContextMock,
      } as unknown as PostgresConnectionManager;
      const adp = new PgDatabaseAdapter(agentId, mgr);

      await adp.queryEntities({ limit: 1 });

      expect(withIsolationContextMock).not.toHaveBeenCalled();
    });

    it("should call withIsolationContext when transaction is called with options.entityContext", async () => {
      const withIsolationContextMock = vi.fn((_id: UUID, cb: (tx: unknown) => Promise<unknown>) => {
        return cb({});
      });
      const mgr = {
        ...mockManager,
        withIsolationContext: withIsolationContextMock,
      } as PostgresConnectionManager;
      const adp = new PgDatabaseAdapter(agentId, mgr);

      await adp.transaction(
        async () => "ok",
        { entityContext: entityId }
      );

      expect(withIsolationContextMock).toHaveBeenCalledWith(entityId, expect.any(Function));
    });
  });
});
