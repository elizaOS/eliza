/**
 * Real-PGlite migration tests for the production guard around message-search
 * DDL. The guard is environment-driven because the migration service only sees
 * a Drizzle handle, not the adapter/manager that selected Postgres vs PGlite.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plugin as sqlPlugin } from "../../index";
import { DatabaseMigrationService } from "../../migration-service";
import type { DrizzleDatabase } from "../../types";

describe("message-search production DDL guard", () => {
  let pgClient: PGlite;
  let db: DrizzleDatabase;
  let originalNodeEnv: string | undefined;
  let originalApplyMessageSearchObjects: string | undefined;

  beforeEach(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    originalApplyMessageSearchObjects = process.env.ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS;

    pgClient = new PGlite({ extensions: { vector } });
    db = drizzle(pgClient);
  });

  afterEach(async () => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalApplyMessageSearchObjects === undefined) {
      delete process.env.ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS;
    } else {
      process.env.ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS = originalApplyMessageSearchObjects;
    }

    await pgClient.close();
  });

  const runSqlPluginMigration = async (databaseBackend: "postgres" | "pglite") => {
    const migrationService = new DatabaseMigrationService({ databaseBackend });
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([sqlPlugin]);
    await migrationService.runAllPluginMigrations();
  };

  const messageSearchColumnExists = async (): Promise<boolean> => {
    const result = await db.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'memories'
        AND column_name = 'message_search_document'
    `);
    return result.rows.length > 0;
  };

  it("skips generated-column/index DDL by default for production Postgres startup", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS;

    await runSqlPluginMigration("postgres");

    expect(await messageSearchColumnExists()).toBe(false);
  });

  it("applies generated-column/index DDL in production Postgres only when explicitly enabled", async () => {
    process.env.NODE_ENV = "production";
    process.env.ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS = "true";

    await runSqlPluginMigration("postgres");

    expect(await messageSearchColumnExists()).toBe(true);
  });

  it("keeps automatic install enabled for embedded PGlite production builds", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS;

    await runSqlPluginMigration("pglite");

    expect(await messageSearchColumnExists()).toBe(true);
  });
});
