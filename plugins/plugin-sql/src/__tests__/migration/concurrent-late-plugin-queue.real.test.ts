/**
 * Drives concurrent late-plugin registration through the real SQL adapter and
 * PGlite migrator, proving initialization and schema runs serialize losslessly.
 */
import { sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedTestDatabaseForMigration } from "../test-helpers";

const firstLateTable = pgTable("first_late_plugin_records", {
  value: text("value").notNull(),
});
const secondLateTable = pgTable("second_late_plugin_records", {
  value: text("value").notNull(),
});

describe("concurrent late-plugin migration queue", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("initializes once, migrates both queued schemas, and records each once", async () => {
    const setup = await createIsolatedTestDatabaseForMigration("concurrent-late-plugin-queue");
    cleanup = setup.cleanup;

    await Promise.all([
      setup.adapter.runPluginMigrations([
        {
          name: "first-late-plugin",
          schema: { firstLateTable },
        },
      ]),
      setup.adapter.runPluginMigrations([
        {
          name: "second-late-plugin",
          schema: { secondLateTable },
        },
      ]),
    ]);

    const tableRows = await setup.db.execute(sql`
			SELECT table_name
			FROM information_schema.tables
			WHERE table_schema = 'public'
				AND table_name IN (
					'first_late_plugin_records',
					'second_late_plugin_records'
				)
			ORDER BY table_name
		`);
    expect(tableRows.rows.map((row) => (row as { table_name: string }).table_name)).toEqual([
      "first_late_plugin_records",
      "second_late_plugin_records",
    ]);

    const migrationRows = await setup.db.execute(sql`
			SELECT plugin_name, COUNT(*)::int AS migration_count
			FROM migrations._migrations
			WHERE plugin_name IN ('first-late-plugin', 'second-late-plugin')
			GROUP BY plugin_name
			ORDER BY plugin_name
		`);
    expect(migrationRows.rows).toEqual([
      { plugin_name: "first-late-plugin", migration_count: 1 },
      { plugin_name: "second-late-plugin", migration_count: 1 },
    ]);
  });
});
