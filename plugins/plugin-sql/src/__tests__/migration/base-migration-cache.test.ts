/**
 * Verifies the SQL adapter migrates each unchanged schema object once while
 * still rerunning a plugin whose schema object changes during hot reload. The
 * migration service is deterministic and mocked; no database or model runs.
 */
import type { UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BaseDrizzleAdapter } from "../../base";
import type { DatabaseMigrationService } from "../../migration-service";
import type { DrizzleDatabase } from "../../types";

class MigrationCacheAdapter extends BaseDrizzleAdapter {
  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async withEntityContext<T>(
    _entityId: UUID | null,
    callback: (tx: DrizzleDatabase) => Promise<T>
  ): Promise<T> {
    return callback(this.db);
  }

  protected async withDatabase<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  attachMigrationService(service: DatabaseMigrationService): void {
    this.migrationService = service;
  }
}

describe("BaseDrizzleAdapter migration cache", () => {
  it("skips unchanged schema instances but migrates a replacement instance", async () => {
    const registerSchema = vi.fn();
    const runAllPluginMigrations = vi.fn(async () => {});
    const service = {
      registerSchema,
      runAllPluginMigrations,
    } as unknown as DatabaseMigrationService;
    const adapter = new MigrationCacheAdapter("11111111-1111-1111-1111-111111111111" as UUID);
    adapter.attachMigrationService(service);
    const schema = { widgets: { id: "text" } };

    await adapter.runPluginMigrations([{ name: "widgets", schema }]);
    await adapter.runPluginMigrations([{ name: "widgets", schema }]);
    await adapter.runPluginMigrations([{ name: "widgets", schema: { ...schema } }]);
    const replacement = { widgets: { id: "uuid" } };
    await adapter.runPluginMigrations([{ name: "widgets", schema: replacement }]);

    expect(registerSchema).toHaveBeenCalledTimes(2);
    expect(runAllPluginMigrations).toHaveBeenCalledTimes(2);
    expect(runAllPluginMigrations).toHaveBeenNthCalledWith(1, undefined, ["widgets"]);
    expect(runAllPluginMigrations).toHaveBeenNthCalledWith(2, undefined, ["widgets"]);
  });

  it("does not cache dry-run migrations", async () => {
    const service = {
      registerSchema: vi.fn(),
      runAllPluginMigrations: vi.fn(async () => {}),
    } as unknown as DatabaseMigrationService;
    const adapter = new MigrationCacheAdapter("22222222-2222-2222-2222-222222222222" as UUID);
    adapter.attachMigrationService(service);
    const schema = { widgets: { id: "text" } };

    await adapter.runPluginMigrations([{ name: "widgets", schema }], {
      dryRun: true,
    });
    await adapter.runPluginMigrations([{ name: "widgets", schema }]);

    expect(service.runAllPluginMigrations).toHaveBeenCalledTimes(2);
  });
});
