/**
 * Proves the runtime migrator drops indexes and foreign keys in the plugin's
 * own Postgres schema. Non-core plugins declare their tables with `pgSchema`
 * (app_lifeops, app_calendar, app_scheduling, ...), so an altered or removed
 * index, or a foreign key whose ON DELETE rule changed, lives outside
 * `public`. An unqualified `DROP INDEX` resolves through search_path and
 * misses it (the `CREATE INDEX IF NOT EXISTS` that follows then keeps the old
 * definition), and a foreign-key drop aimed at `public` fails the migration.
 */
import { sql } from "drizzle-orm";
import { foreignKey, pgSchema, text, uniqueIndex } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSnapshot } from "../../runtime-migrator/drizzle-adapters/snapshot-generator";
import { generateMigrationSQL } from "../../runtime-migrator/drizzle-adapters/sql-generator";
import { RuntimeMigrator } from "../../runtime-migrator/runtime-migrator";
import type { DrizzleDB } from "../../runtime-migrator/types";
import { createIsolatedTestDatabaseForMigration } from "../test-helpers";

const PLUGIN_NAME = "@elizaos/plugin-schema-drops-test";
const SCHEMA_NAME = "app_schema_drops";
const INDEX_NAME = "schema_drops_handoffs_active_owner";
const FK_NAME = "schema_drops_segments_session_fk";

const pluginSchema = pgSchema(SCHEMA_NAME);

// Same shape as app_lifeops.life_account_handoffs: one open handoff per owner.
function handoffsTable(index: "full" | "partial" | "none") {
  return pluginSchema.table(
    "handoffs",
    {
      id: text("id").primaryKey(),
      ownerId: text("owner_id").notNull(),
      phase: text("phase").notNull(),
    },
    (t) =>
      index === "none"
        ? []
        : index === "full"
          ? [uniqueIndex(INDEX_NAME).on(t.ownerId)]
          : [
              uniqueIndex(INDEX_NAME)
                .on(t.ownerId)
                .where(sql`${t.phase} NOT IN ('completed', 'cancelled')`),
            ]
  );
}

const sessionsTable = pluginSchema.table("sessions", {
  id: text("id").primaryKey(),
});

function segmentsTable(onDelete: "no action" | "cascade") {
  return pluginSchema.table(
    "segments",
    {
      id: text("id").primaryKey(),
      sessionId: text("session_id").notNull(),
    },
    (t) => [
      foreignKey({
        name: FK_NAME,
        columns: [t.sessionId],
        foreignColumns: [sessionsTable.id],
      }).onDelete(onDelete),
    ]
  );
}

async function indexDefinitions(db: DrizzleDB): Promise<string[]> {
  const result = await db.execute(
    sql`SELECT n.nspname || ': ' || pg_get_indexdef(c.oid) AS def
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = ${INDEX_NAME}`
  );
  return (result.rows as Array<{ def: string }>).map((row) => row.def);
}

async function foreignKeyDeleteRule(db: DrizzleDB): Promise<string | undefined> {
  const result = await db.execute(
    sql`SELECT c.confdeltype AS rule
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.conname = ${FK_NAME} AND n.nspname = ${SCHEMA_NAME}`
  );
  return (result.rows[0] as { rule?: string } | undefined)?.rule;
}

describe("Runtime migrator drops in a plugin's own schema", () => {
  it("qualifies DROP INDEX with the plugin schema", async () => {
    const before = await generateSnapshot({ handoffs: handoffsTable("full") });
    const after = await generateSnapshot({ handoffs: handoffsTable("partial") });

    const statements = await generateMigrationSQL(before, after);

    expect(statements).toContain(`DROP INDEX IF EXISTS "${SCHEMA_NAME}"."${INDEX_NAME}";`);
  });

  describe("against a real database", () => {
    let db: DrizzleDB;
    let cleanup: () => Promise<void>;
    let migrator: RuntimeMigrator;

    beforeEach(async () => {
      const testSetup = await createIsolatedTestDatabaseForMigration("plugin_schema_drops_test");
      db = testSetup.db;
      cleanup = testSetup.cleanup;
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${SCHEMA_NAME}" CASCADE`));
      migrator = new RuntimeMigrator(db);
      await migrator.initialize();
    });

    afterEach(async () => {
      await db?.execute(sql.raw(`DROP SCHEMA IF EXISTS "${SCHEMA_NAME}" CASCADE`));
      if (cleanup) {
        await cleanup();
      }
    });

    it("recreates an altered index with its new definition", async () => {
      await migrator.migrate(PLUGIN_NAME, { handoffs: handoffsTable("full") });
      await migrator.migrate(PLUGIN_NAME, { handoffs: handoffsTable("partial") });

      const definitions = await indexDefinitions(db);
      expect(definitions).toHaveLength(1);
      expect(definitions[0]).toMatch(new RegExp(`^${SCHEMA_NAME}: `));
      expect(definitions[0]).toContain("WHERE");

      // A completed handoff no longer blocks the owner's next one.
      await db.execute(
        sql.raw(
          `INSERT INTO "${SCHEMA_NAME}"."handoffs" (id, owner_id, phase)
           VALUES ('h1', 'owner', 'completed'), ('h2', 'owner', 'reviewed')`
        )
      );
    });

    it("removes an index the schema no longer declares", async () => {
      await migrator.migrate(PLUGIN_NAME, { handoffs: handoffsTable("full") });
      await migrator.migrate(PLUGIN_NAME, { handoffs: handoffsTable("none") });

      expect(await indexDefinitions(db)).toEqual([]);
    });

    it("recreates a foreign key whose ON DELETE rule changed", async () => {
      await migrator.migrate(PLUGIN_NAME, {
        sessions: sessionsTable,
        segments: segmentsTable("no action"),
      });
      expect(await foreignKeyDeleteRule(db)).toBe("a");

      await migrator.migrate(PLUGIN_NAME, {
        sessions: sessionsTable,
        segments: segmentsTable("cascade"),
      });

      expect(await foreignKeyDeleteRule(db)).toBe("c");
    });
  });
});
