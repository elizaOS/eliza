import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime, IDatabaseAdapter, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createDatabaseAdapter, plugin } from "../../index";

/**
 * Type for the global singletons object used by plugin-sql.
 */
interface PluginSqlSingletons {
  pgLiteClientManager?: {
    getConnection?: () => { close?: () => Promise<void> };
  };
  postgresConnectionManager?: {
    close?: () => Promise<void>;
  };
}

/**
 * Augment globalThis to include the plugin-sql singletons symbol.
 */
interface GlobalWithSingletons {
  [key: symbol]: PluginSqlSingletons | undefined;
}

/**
 * Minimal test runtime interface for testing plugin-sql initialization.
 * This interface only includes the properties that plugin.init actually uses.
 */
interface TestRuntimeConfig {
  agentId: UUID;
  getSetting: Mock<(key: string) => string | boolean | number | null>;
  registerDatabaseAdapter: Mock<(adapter: IDatabaseAdapter) => void>;
  registerService: Mock<() => void>;
  getService: Mock<() => void>;
  databaseAdapter: IDatabaseAdapter | undefined;
  hasElizaOS: Mock<() => boolean>;
  logger: {
    info: Mock<() => void>;
    debug: Mock<() => void>;
    warn: Mock<() => void>;
    error: Mock<() => void>;
  };
}

/**
 * Creates a test runtime for testing plugin-sql.
 * The runtime is typed to satisfy IAgentRuntime for use with plugin.init.
 */
function createTestRuntime(
  overrides: Partial<TestRuntimeConfig> = {}
): TestRuntimeConfig & IAgentRuntime {
  const baseRuntime: TestRuntimeConfig = {
    agentId: "00000000-0000-0000-0000-000000000000" as UUID,
    getSetting: vi.fn(() => null),
    registerDatabaseAdapter: vi.fn(() => {}),
    registerService: vi.fn(() => {}),
    getService: vi.fn(() => {}),
    databaseAdapter: undefined,
    hasElizaOS: vi.fn(() => false),
    logger: {
      info: vi.fn(() => {}),
      debug: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
    },
    ...overrides,
  };

  // Return the runtime as IAgentRuntime - the plugin only uses the properties defined above.
  // This is safe because plugin.init only accesses these specific properties.
  return baseRuntime as TestRuntimeConfig & IAgentRuntime;
}

/**
 * Helper to clean up global singletons between tests.
 * This is necessary because createDatabaseAdapter uses global singletons
 * to share database connections, but tests use different temp directories.
 * IMPORTANT: Must close connections BEFORE deleting temp directories.
 */
async function cleanupGlobalSingletons() {
  const GLOBAL_SINGLETONS = Symbol.for("@elizaos/plugin-sql/global-singletons");
  const globalSymbols = globalThis as GlobalWithSingletons;
  const singletons = globalSymbols[GLOBAL_SINGLETONS];

  if (singletons?.pgLiteClientManager) {
    try {
      // Get the actual PGlite client and close it properly
      const client = singletons.pgLiteClientManager.getConnection?.();
      if (client?.close) {
        await client.close();
      }
    } catch {
      // Ignore errors during cleanup
    }
    delete singletons.pgLiteClientManager;
  }

  if (singletons?.postgresConnectionManager) {
    try {
      if (singletons.postgresConnectionManager.close) {
        await singletons.postgresConnectionManager.close();
      }
    } catch {
      // Ignore errors during cleanup
    }
    delete singletons.postgresConnectionManager;
  }
}

describe("SQL Plugin", () => {
  let runtime: TestRuntimeConfig & IAgentRuntime;
  let tempDir: string;

  beforeEach(async () => {
    // Clean up any existing singletons from previous tests
    await cleanupGlobalSingletons();

    // Create a temporary directory for tests
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-plugin-sql-test-"));

    // Reset environment variables
    delete process.env.POSTGRES_URL;
    delete process.env.POSTGRES_USER;
    delete process.env.POSTGRES_PASSWORD;
    delete process.env.PGLITE_DATA_DIR;

    runtime = createTestRuntime();
  });

  afterEach(async () => {
    // Clean up singletons BEFORE deleting the directory
    await cleanupGlobalSingletons();

    // Clean up temporary directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // Reset environment variables
    delete process.env.PGLITE_DATA_DIR;
  });

  describe("Plugin Structure", () => {
    it("should have correct plugin metadata", () => {
      expect(plugin.name).toBe("@elizaos/plugin-sql");
      expect(plugin.description).toBe(
        "A plugin for SQL database access with dynamic schema migrations"
      );
      expect(plugin.priority).toBe(0);
    });

    it("should have schema defined", () => {
      expect(plugin.schema).toBeDefined();
      // Schema exports individual table definitions
      expect(plugin.schema).toHaveProperty("agentTable");
      expect(plugin.schema).toHaveProperty("entityTable");
      expect(plugin.schema).toHaveProperty("memoryTable");
    });

    it("should have init function", () => {
      expect(plugin.init).toBeDefined();
      expect(typeof plugin.init).toBe("function");
    });
  });

  describe("Plugin Initialization", () => {
    it("should skip initialization if adapter already exists", async () => {
      // Set up runtime with existing adapter using a minimal mock adapter
      const existingAdapter: IDatabaseAdapter = {
        db: {},
        init: async () => {},
        close: async () => {},
        isReady: async () => true,
        getConnection: async () => ({}),
      } as IDatabaseAdapter;
      runtime.databaseAdapter = existingAdapter;

      if (plugin.init) {
        await plugin.init({}, runtime);
      }

      // Logger calls can be tested with vi.spyOn() in vitest
      // Just verify that registerDatabaseAdapter wasn't called
      expect(runtime.registerDatabaseAdapter).not.toHaveBeenCalled();
    });

    it("should register database adapter when none exists", async () => {
      // Set PGLITE_DATA_DIR to temp directory to avoid directory creation issues
      process.env.PGLITE_DATA_DIR = tempDir;
      runtime.getSetting = vi.fn((key) => {
        // Return temp directory for database paths to avoid directory creation issues
        if (key === "PGLITE_DATA_DIR") {
          return tempDir;
        }
        return null;
      });

      if (plugin.init) {
        await plugin.init({}, runtime);
      }

      expect(runtime.registerDatabaseAdapter).toHaveBeenCalled();
    });

    it("should use POSTGRES_URL when available", async () => {
      runtime.getSetting = vi.fn((key) => {
        if (key === "POSTGRES_URL") return "postgresql://localhost:5432/test";
        return null;
      });

      if (plugin.init) {
        await plugin.init({}, runtime);
      }

      expect(runtime.registerDatabaseAdapter).toHaveBeenCalled();
    });

    it("should use PGLITE_DATA_DIR when provided", async () => {
      const customDir = path.join(tempDir, "custom-pglite");
      runtime.getSetting = vi.fn((key) => {
        if (key === "PGLITE_DATA_DIR") return customDir;
        return null;
      });

      if (plugin.init) {
        await plugin.init({}, runtime);
      }

      expect(runtime.registerDatabaseAdapter).toHaveBeenCalled();
    });

    it("should use default path if PGLITE_DATA_DIR is not set", async () => {
      runtime.getSetting = vi.fn(() => null);

      if (plugin.init) {
        await plugin.init({}, runtime);
      }

      expect(runtime.registerDatabaseAdapter).toHaveBeenCalled();
    });

    it("should prefer to use PGLITE_DATA_DIR when environment variable is set", async () => {
      // Set PGLITE_DATA_DIR to temp directory to avoid directory creation issues
      process.env.PGLITE_DATA_DIR = tempDir;
      runtime.getSetting = vi.fn(() => null);

      if (plugin.init) {
        await plugin.init({}, runtime);
      }

      expect(runtime.registerDatabaseAdapter).toHaveBeenCalled();
    });
  });

  describe("createDatabaseAdapter", () => {
    const agentId = "00000000-0000-0000-0000-000000000000";

    it("should create PgDatabaseAdapter when postgresUrl is provided", () => {
      const config = {
        postgresUrl: "postgresql://localhost:5432/test",
      };

      const adapter = createDatabaseAdapter(config, agentId);

      expect(adapter).toBeDefined();
    });

    it("should create PgliteDatabaseAdapter when no postgresUrl is provided", () => {
      // Set PGLITE_DATA_DIR to avoid directory creation issues
      process.env.PGLITE_DATA_DIR = tempDir;
      const config = {
        dataDir: path.join(tempDir, "custom-data"),
      };

      const adapter = createDatabaseAdapter(config, agentId);

      expect(adapter).toBeDefined();
    });

    it("should use default dataDir when none provided", () => {
      // Set PGLITE_DATA_DIR to avoid directory creation issues
      process.env.PGLITE_DATA_DIR = tempDir;
      const config = {};

      const adapter = createDatabaseAdapter(config, agentId);

      expect(adapter).toBeDefined();
    });

    it("should reuse singleton managers", () => {
      // Create first adapter
      const adapter1 = createDatabaseAdapter(
        { postgresUrl: "postgresql://localhost:5432/test" },
        agentId
      );

      // Create second adapter with same config
      const adapter2 = createDatabaseAdapter(
        { postgresUrl: "postgresql://localhost:5432/test" },
        agentId
      );

      expect(adapter1).toBeDefined();
      expect(adapter2).toBeDefined();
    });
  });
});
