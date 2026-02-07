import { describe, expect, test } from "bun:test";

describe("plugin-sql e2e upgrade", () => {
  test("migration module exports are available", async () => {
    const mod = await import("../../../index.node");
    expect(mod.DatabaseMigrationService).toBeDefined();
    expect(mod.plugin).toBeDefined();
  });

  test("database adapter factory accepts configuration", async () => {
    const { createDatabaseAdapter } = await import("../../../index.node");
    expect(typeof createDatabaseAdapter).toBe("function");
  });

  test("migration service can be constructed and has expected API", async () => {
    const { DatabaseMigrationService } = await import("../../../index.node");
    const service = new DatabaseMigrationService();
    expect(typeof service.discoverAndRegisterPluginSchemas).toBe("function");
    expect(typeof service.registerSchema).toBe("function");
    expect(typeof service.runAllPluginMigrations).toBe("function");
  });
});
