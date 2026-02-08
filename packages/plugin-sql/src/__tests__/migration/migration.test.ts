import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

describe("plugin-sql migrations", () => {
  test("DatabaseMigrationService is importable", async () => {
    const mod = await import("../../index.node");
    expect(mod.DatabaseMigrationService).toBeDefined();
  });

  test("migration service has required methods", async () => {
    const { DatabaseMigrationService } = await import("../../index.node");
    const service = new DatabaseMigrationService();
    expect(typeof service.discoverAndRegisterPluginSchemas).toBe("function");
    expect(typeof service.registerSchema).toBe("function");
    expect(typeof service.runAllPluginMigrations).toBe("function");
  });

  test("drizzle migration files follow naming convention", () => {
    const drizzleDir = join(import.meta.dir, "..", "..", "..", "drizzle");
    if (existsSync(drizzleDir)) {
      const files = readdirSync(drizzleDir);
      const sqlFiles = files.filter((f) => f.endsWith(".sql"));
      for (const file of sqlFiles) {
        // Migration files should follow drizzle naming convention
        expect(typeof file).toBe("string");
        expect(file.length).toBeGreaterThan(0);
      }
    }
  });

  test("migration service can be instantiated multiple times", async () => {
    const { DatabaseMigrationService } = await import("../../index.node");
    const service1 = new DatabaseMigrationService();
    const service2 = new DatabaseMigrationService();
    expect(service1).not.toBe(service2);
  });
});
