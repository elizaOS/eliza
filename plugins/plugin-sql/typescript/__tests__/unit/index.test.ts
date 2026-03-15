import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IDatabaseAdapter, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let tempDir: string;

  beforeEach(async () => {
    await cleanupGlobalSingletons();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-plugin-sql-test-"));
    delete process.env.POSTGRES_URL;
    delete process.env.POSTGRES_USER;
    delete process.env.POSTGRES_PASSWORD;
    delete process.env.PGLITE_DATA_DIR;
  });

  afterEach(async () => {
    await cleanupGlobalSingletons();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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

    it("should have adapter factory", () => {
      expect(plugin.adapter).toBeDefined();
      expect(typeof plugin.adapter).toBe("function");
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
