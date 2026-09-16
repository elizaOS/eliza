/**
 * Real PGlite upgrade checks for the domain migrations composed by personal
 * assistant. Reduced relational schemas retain legacy rows after owner-side
 * deletion; migrations, transaction rollback, and durable receipts are real.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateFinanceTables } from "../../plugin-finances/src/services/migration";
import { migrateGoalTables } from "../../plugin-goals/src/services/migration";
import { migrateInboxTables } from "../../plugin-inbox/src/inbox/migration";
import { migrateReminderTables } from "../../plugin-reminders/src/services/migration";
import {
  type CarveOutDatabase,
  runCarveOutMigration,
} from "../../plugin-sql/src/carve-out-migration";

const domains = [
  {
    domain: "finances",
    table: "life_payment_sources",
    migrate: migrateFinanceTables,
  },
  {
    domain: "goals",
    table: "life_goal_definitions",
    migrate: migrateGoalTables,
  },
  {
    domain: "inbox",
    table: "life_inbox_triage_examples",
    migrate: migrateInboxTables,
  },
  {
    domain: "reminders",
    table: "life_reminder_plans",
    migrate: migrateReminderTables,
  },
] as const;
let db: PGlite;
let directory: string;

afterEach(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture(
  domain: string,
  table: string,
): Promise<CarveOutDatabase> {
  directory = await mkdtemp(path.join(tmpdir(), "carve-out-upgrade-"));
  db = new PGlite(directory);
  await db.exec(`
    CREATE SCHEMA app_lifeops;
    CREATE SCHEMA app_${domain};
    CREATE TABLE app_lifeops.${table} (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE app_${domain}.${table} (LIKE app_lifeops.${table} INCLUDING ALL);
    INSERT INTO app_lifeops.${table} VALUES
      ('retained', 'owner', 'keep'), ('deleted', 'owner', 'remove');
  `);
  // The inbox migration repairs this separate additive field on every startup.
  if (domain === "inbox")
    await db.exec(`
    CREATE TABLE app_inbox.life_inbox_triage_entries (id TEXT PRIMARY KEY);
  `);
  return {
    execute: async (statement) =>
      (await db.query<Record<string, unknown>>(statement)).rows,
    transaction: (operation) =>
      db.transaction((transaction) =>
        operation(
          async (statement) =>
            (await transaction.query<Record<string, unknown>>(statement)).rows,
        ),
      ),
  };
}

async function reopen(): Promise<void> {
  await db.close();
  db = new PGlite(directory);
}

async function ownerRows(domain: string, table: string) {
  return (
    await db.query(`SELECT id, payload FROM app_${domain}.${table} ORDER BY id`)
  ).rows;
}

describe.each(domains)(
  "$domain owner adoption",
  ({ domain, table, migrate }) => {
    it("preserves a legacy import followed by owner deletion across database reopen", async () => {
      const database = await fixture(domain, table);
      // Historical import predates shared receipts. Its source remains untouched.
      await db.exec(
        `INSERT INTO app_${domain}.${table} SELECT * FROM app_lifeops.${table}`,
      );
      if (domain === "reminders")
        await db.exec(`
      CREATE TABLE app_reminders.reminders_migration_state (
        table_name TEXT PRIMARY KEY, migrated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO app_reminders.reminders_migration_state(table_name) VALUES ('${table}');
    `);
      await db.exec(
        `DELETE FROM app_${domain}.${table} WHERE agent_id = 'owner' AND id = 'deleted'`,
      );
      // Reminders' earlier marker also survives deletion of the last owner row.
      if (domain === "reminders")
        await db.exec(`DELETE FROM app_reminders.${table}`);
      const before = await ownerRows(domain, table);
      await reopen();
      await migrate(database);
      expect(await ownerRows(domain, table)).toEqual(before);
      expect(
        (await db.query(`SELECT id FROM app_lifeops.${table} ORDER BY id`))
          .rows,
      ).toEqual([{ id: "deleted" }, { id: "retained" }]);
    }, 120_000);

    it("honors an earlier completed receipt after every imported row is deleted", async () => {
      const database = await fixture(domain, table);
      await runCarveOutMigration(database, {
        key: `${domain}/${table}/v1`,
        sourceTables: [{ schema: "app_lifeops", table }],
        run: async (execute) => {
          await execute(
            `INSERT INTO app_${domain}.${table} SELECT * FROM app_lifeops.${table}`,
          );
        },
        outcome: () => "copied",
      });
      await db.exec(
        `DELETE FROM app_${domain}.${table} WHERE agent_id = 'owner'`,
      );
      await reopen();
      await migrate(database);
      expect(await ownerRows(domain, table)).toEqual([]);
      expect(
        (
          await db.query(`SELECT migration_key FROM app_eliza_migrations.carve_out_receipts
      WHERE migration_key = '${domain}/${table}/v2'`)
        ).rows,
      ).toEqual([]);
    }, 120_000);

    it("rolls back a corrupt fresh projection, then imports completely and preserves later deletion", async () => {
      const database = await fixture(domain, table);
      await db.exec(`
      CREATE FUNCTION corrupt_import() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.payload := 'corrupted'; RETURN NEW; END $$;
      CREATE TRIGGER corrupt_import BEFORE INSERT ON app_${domain}.${table}
      FOR EACH ROW EXECUTE FUNCTION corrupt_import();
    `);
      await expect(migrate(database)).rejects.toMatchObject({
        code: "CARVE_OUT_MIGRATION_COLLISION",
      });
      expect(await ownerRows(domain, table)).toEqual([]);
      expect(
        (
          await db.query(`SELECT migration_key FROM app_eliza_migrations.carve_out_receipts
      WHERE migration_key = '${domain}/${table}/v2'`)
        ).rows,
      ).toEqual([]);
      await db.exec(`DROP TRIGGER corrupt_import ON app_${domain}.${table}`);
      await migrate(database);
      expect(await ownerRows(domain, table)).toEqual([
        { id: "deleted", payload: "remove" },
        { id: "retained", payload: "keep" },
      ]);
      await db.exec(
        `DELETE FROM app_${domain}.${table} WHERE agent_id = 'owner'`,
      );
      await reopen();
      await migrate(database);
      expect(await ownerRows(domain, table)).toEqual([]);
    }, 120_000);
  },
);
