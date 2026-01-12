import type { UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { PgliteDatabaseAdapter } from "../../../pglite/adapter";
import type { PGliteClientManager } from "../../../pglite/manager";

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
interface TestablePgliteAdapter extends PgliteDatabaseAdapter {
  agentId: UUID;
  manager: PGliteClientManager;
  embeddingDimension: string;
}

// Helper function to access private properties for testing
function getTestableAdapter(adapter: PgliteDatabaseAdapter): TestablePgliteAdapter {
  return adapter as TestablePgliteAdapter;
}

describe("PgliteDatabaseAdapter", () => {
  let adapter: PgliteDatabaseAdapter;
  let mockManager: Partial<PGliteClientManager>;
  const agentId = "00000000-0000-0000-0000-000000000000" as UUID;

  beforeEach(() => {
    // Clear mocks before each test
    (logger.debug as Mock).mockClear();
    (logger.info as Mock).mockClear();
    (logger.warn as Mock).mockClear();
    (logger.error as Mock).mockClear();

    // Create a mock manager
    mockManager = {
      getConnection: vi.fn().mockReturnValue({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        close: vi.fn().mockResolvedValue(undefined),
        transaction: vi.fn(),
      }),
      close: vi.fn().mockResolvedValue(undefined),
      isShuttingDown: vi.fn().mockReturnValue(false),
    };

    adapter = new PgliteDatabaseAdapter(agentId, mockManager as PGliteClientManager);
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
        "PGliteDatabaseAdapter initialized"
      );
    });
  });

  describe("close", () => {
    it("should close the manager", async () => {
      await adapter.close();
      expect(mockManager.close).toHaveBeenCalled();
    });
  });

  describe("isReady", () => {
    it("should return true when manager is not shutting down", async () => {
      mockManager.isShuttingDown.mockReturnValue(false);
      const result = await adapter.isReady();
      expect(result).toBe(true);
    });

    it("should return false when manager is shutting down", async () => {
      mockManager.isShuttingDown.mockReturnValue(true);
      const result = await adapter.isReady();
      expect(result).toBe(false);
    });
  });

  describe("getConnection", () => {
    it("should return the drizzle database instance", async () => {
      const result = await adapter.getConnection();
      // getConnection returns the drizzle db instance, not the raw PGlite client
      expect(result).toBeDefined();
      expect(result.query).toBeDefined();
    });

    it("should return raw connection via getRawConnection", () => {
      const mockConnection = { query: vi.fn(), close: vi.fn(), transaction: vi.fn() };
      mockManager.getConnection.mockReturnValue(mockConnection);

      const result = adapter.getRawConnection();
      expect(result).toBe(mockConnection);
      expect(mockManager.getConnection).toHaveBeenCalled();
    });
  });

  describe("database operations", () => {
    it("should use the connection from manager for operations", () => {
      const mockConnection = mockManager.getConnection();
      expect(mockConnection).toBeDefined();
      expect(mockConnection.query).toBeDefined();
      expect(mockConnection.transaction).toBeDefined();
    });
  });

  describe("withDatabase shutdown handling", () => {
    it("should throw error instead of returning null when database is shutting down", async () => {
      // Create adapter with manager that is shutting down
      const shuttingDownManager = {
        getConnection: vi.fn().mockReturnValue({
          query: vi.fn().mockResolvedValue({ rows: [] }),
          close: vi.fn().mockResolvedValue(undefined),
          transaction: vi.fn(),
        }),
        close: vi.fn().mockResolvedValue(undefined),
        isShuttingDown: vi.fn().mockReturnValue(true),
      } as PGliteClientManager;

      const shuttingDownAdapter = new PgliteDatabaseAdapter(agentId, shuttingDownManager);

      // Attempt operation during shutdown should throw
      await expect(shuttingDownAdapter.getAgent(agentId)).rejects.toThrow(
        "Database is shutting down - operation rejected"
      );

      // Verify warning was logged
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          src: "plugin:sql",
          error: "Database is shutting down - operation rejected",
        }),
        "Database operation rejected during shutdown"
      );
    });

    it("should include descriptive error message for shutdown rejection", async () => {
      const shuttingDownManager = {
        getConnection: vi.fn().mockReturnValue({
          query: vi.fn().mockResolvedValue({ rows: [] }),
          transaction: vi.fn(),
        }),
        close: vi.fn().mockResolvedValue(undefined),
        isShuttingDown: vi.fn().mockReturnValue(true),
      } as PGliteClientManager;

      const shuttingDownAdapter = new PgliteDatabaseAdapter(agentId, shuttingDownManager);

      try {
        await shuttingDownAdapter.getAgent(agentId);
        expect.unreachable("Should have thrown");
      } catch (error: unknown) {
        const err = error as Error;
        expect(err.message).toBe("Database is shutting down - operation rejected");
        expect(err).toBeInstanceOf(Error);
      }
    });
  });
});
