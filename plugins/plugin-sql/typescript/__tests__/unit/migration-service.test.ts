import type { Plugin } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseMigrationService } from "../../migration-service";

// Mock the logger to avoid console output during tests
const mockLogger = {
  info: vi.fn(() => {}),
  warn: vi.fn(() => {}),
  error: vi.fn(() => {}),
  debug: vi.fn(() => {}),
};

// In vitest, we use vi.fn() for mocking
// Mock the custom migrator
const mockRunPluginMigrations = vi.fn(() => Promise.resolve());

// For this test, we'll spy on the actual logger rather than mock the entire module

// Mock database interface for testing
interface MockDatabase {
  query: {
    agentTable: { findFirst: ReturnType<typeof vi.fn> };
    entityTable: { findFirst: ReturnType<typeof vi.fn> };
    memoryTable: { findFirst: ReturnType<typeof vi.fn> };
  };
  transaction: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}

describe("DatabaseMigrationService", () => {
  let migrationService: DatabaseMigrationService;
  let mockDb: MockDatabase;

  beforeEach(() => {
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    mockRunPluginMigrations.mockClear();

    // Create mock database
    mockDb = {
      query: {
        agentTable: { findFirst: vi.fn(() => {}) },
        entityTable: { findFirst: vi.fn(() => {}) },
        memoryTable: { findFirst: vi.fn(() => {}) },
      },
      transaction: vi.fn(() => {}),
      execute: vi.fn(() => Promise.resolve({ rows: [] })),
    };

    migrationService = new DatabaseMigrationService();
  });

  describe("constructor", () => {
    it("should create an instance", () => {
      expect(migrationService).toBeDefined();
      expect(migrationService).toBeInstanceOf(DatabaseMigrationService);
    });
  });

  // Helper interface for accessing private properties
  interface TestableMigrationService {
    db: typeof mockDb;
  }

  // Helper function to access private properties for testing
  function getTestableService(service: DatabaseMigrationService): TestableMigrationService {
    return service as TestableMigrationService;
  }

  describe("initializeWithDatabase", () => {
    it("should initialize with database", async () => {
      await migrationService.initializeWithDatabase(mockDb);

      // In vitest we can use vi.spyOn() for log assertions if needed
      // Access private db property for testing
      const testService = getTestableService(migrationService);
      expect(testService.db).toBe(mockDb);
    });
  });

  describe("discoverAndRegisterPluginSchemas", () => {
    it("should register plugins with schemas", () => {
      const plugins: Plugin[] = [
        {
          name: "plugin1",
          description: "Test plugin 1",
          schema: { table1: {} },
        },
        {
          name: "plugin2",
          description: "Test plugin 2",
          schema: { table2: {} },
        },
        {
          name: "plugin3",
          description: "Plugin without schema",
        },
      ];

      migrationService.discoverAndRegisterPluginSchemas(plugins);
    });

    it("should handle empty plugin array", () => {
      migrationService.discoverAndRegisterPluginSchemas([]);
    });

    it("should handle plugins without schemas", () => {
      const plugins: Plugin[] = [
        {
          name: "plugin1",
          description: "Plugin without schema",
        },
        {
          name: "plugin2",
          description: "Another plugin without schema",
        },
      ];

      migrationService.discoverAndRegisterPluginSchemas(plugins);
    });
  });

  describe("runAllPluginMigrations", () => {
    it("should throw if database not initialized", async () => {
      await expect(migrationService.runAllPluginMigrations()).rejects.toThrow(
        "Database or migrator not initialized in DatabaseMigrationService"
      );
    });

    it("should run migrations for registered plugins", async () => {
      // Initialize database
      await migrationService.initializeWithDatabase(mockDb);

      // Register plugins
      const plugins: Plugin[] = [
        {
          name: "plugin1",
          description: "Test plugin 1",
          schema: { table1: {} },
        },
        {
          name: "plugin2",
          description: "Test plugin 2",
          schema: { table2: {} },
        },
      ];

      migrationService.discoverAndRegisterPluginSchemas(plugins);

      // Simply await - if it throws, the test fails automatically
      await migrationService.runAllPluginMigrations();
    });

    it("should handle migration errors", async () => {
      // Initialize database
      await migrationService.initializeWithDatabase(mockDb);

      // Register a plugin
      migrationService.discoverAndRegisterPluginSchemas([
        {
          name: "error-plugin",
          description: "Test plugin",
          schema: { tables: {} },
        },
      ]);

      // Simply await - if it throws, the test fails automatically
      await migrationService.runAllPluginMigrations();
    });

    it("should run migrations even with no plugins", async () => {
      // Initialize database
      await migrationService.initializeWithDatabase(mockDb);

      // Don't register any plugins

      // Run migrations
      await migrationService.runAllPluginMigrations();
    });
  });
});
