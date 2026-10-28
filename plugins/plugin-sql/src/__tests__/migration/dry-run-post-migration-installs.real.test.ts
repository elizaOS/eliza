/**
 * Real-PGlite regression test: a dry-run migration must not change the
 * database. `runAllPluginMigrations({ dryRun: true })` skips schema statements
 * in the RuntimeMigrator, and the post-migration object installs (identity
 * person-link attestation guard, message-search functions/column/indexes, RLS)
 * must not run either. A later real run must still install everything.
 */
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseMigrationService } from "../../migration-service";
import type { DrizzleDatabase } from "../../types";

let pgClient: PGlite;
let db: DrizzleDatabase;

const countSearchObjects = async (targetDb: DrizzleDatabase): Promise<number> => {
  const result = await targetDb.execute(sql`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM information_schema.columns
        WHERE table_name = 'memories' AND column_name = 'message_search_document'
      UNION ALL
      SELECT 1 FROM pg_proc
        WHERE proname IN ('eliza_search_fold', 'eliza_message_search_document', 'eliza_search_like_pattern')
      UNION ALL
      SELECT 1 FROM pg_indexes
        WHERE indexname = 'idx_memories_message_fts'
    ) AS installed
  `);
  return (result.rows[0] as { n: number }).n;
};

beforeEach(async () => {
  pgClient = new PGlite();
  db = drizzle(pgClient);
  await pgClient.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
});

afterEach(async () => {
  await pgClient.close();
});

describe("dry-run post-migration installs", () => {
  it("does not create message-search objects during a dry run", async () => {
    const migrationService = new DatabaseMigrationService({ databaseBackend: "pglite" });
    await migrationService.initializeWithDatabase(db);
    await migrationService.runAllPluginMigrations({ dryRun: true }, []);

    expect(await countSearchObjects(db)).toBe(0);
  });

  it("still installs the objects on a real run after a dry run", async () => {
    const migrationService = new DatabaseMigrationService({ databaseBackend: "pglite" });
    await migrationService.initializeWithDatabase(db);
    await migrationService.runAllPluginMigrations({ dryRun: true }, []);

    await migrationService.runAllPluginMigrations({}, []);
    expect(await countSearchObjects(db)).toBe(5);
  });

  it("installs the objects on a real run and stays idempotent", async () => {
    const migrationService = new DatabaseMigrationService({ databaseBackend: "pglite" });
    await migrationService.initializeWithDatabase(db);
    await migrationService.runAllPluginMigrations({}, []);
    expect(await countSearchObjects(db)).toBe(5);

    await migrationService.runAllPluginMigrations({}, []);
    expect(await countSearchObjects(db)).toBe(5);
  });
});
