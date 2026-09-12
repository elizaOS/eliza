/**
 * Exercises legacy schema upgrades against real PGlite while preserving stored
 * rows and enforcing foreign keys with destructive migrations disabled.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { sql } from "drizzle-orm";
import { foreignKey, pgTable, unique, uuid } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RuntimeMigrator } from "../../runtime-migrator/runtime-migrator";
import * as currentSchema from "../../schema";
import { sessionSummaries as legacySessionSummaries } from "../../schema/sessionSummaries";

let client: PGlite;

beforeEach(() => {
  vi.stubEnv("POSTGRES_URL", "");
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS", "false");
  client = new PGlite({ extensions: { vector } });
});

afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
});

it("boots the current SQL schema over legacy summary rows without dropping or rewriting them", async () => {
  const db = drizzle(client);
  const migrator = new RuntimeMigrator(db);
  const plugin = "@elizaos/plugin-sql";
  await migrator.migrate(plugin, {
    ...currentSchema,
    sessionSummaries: legacySessionSummaries,
  });
  await db.execute(sql`
    INSERT INTO session_summaries
      (id, agent_id, room_id, summary, message_count, last_message_offset,
       start_time, end_time, topics, metadata, embedding)
    VALUES
      ('00000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000002',
       '00000000-0000-4000-8000-000000000003',
       'Preserve the original project history.', 7, 11,
       '2026-08-01 12:00:00', '2026-08-01 13:00:00',
       '["project"]'::jsonb, '{"source":"legacy"}'::jsonb,
       ARRAY[0.25,0.5]::real[])
  `);
  const before = await db.execute(sql`SELECT row_to_json(s) AS data FROM session_summaries s`);

  await migrator.migrate(plugin, currentSchema);
  await migrator.migrate(plugin, currentSchema);

  const after = await db.execute(sql`SELECT row_to_json(s) AS data FROM session_summaries s`);
  expect(after.rows).toEqual(before.rows);
  expect(after.rows).toHaveLength(1);
});

it("adds the referenced composite unique constraint before a new table's foreign key", async () => {
  const db = drizzle(client);
  const migrator = new RuntimeMigrator(db);
  const oldAccounts = pgTable("legacy_accounts", {
    id: uuid("id").primaryKey(),
    agentId: uuid("agent_id").notNull(),
  });
  await migrator.migrate("upgrade-fixture", { accounts: oldAccounts });
  await client.query(`INSERT INTO legacy_accounts VALUES
    ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')`);
  const accounts = pgTable(
    "legacy_accounts",
    {
      id: uuid("id").primaryKey(),
      agentId: uuid("agent_id").notNull(),
    },
    (table) => [unique("legacy_accounts_id_agent_unique").on(table.id, table.agentId)]
  );
  const memberships = pgTable(
    "new_memberships",
    {
      id: uuid("id").primaryKey(),
      accountId: uuid("account_id").notNull(),
      agentId: uuid("agent_id").notNull(),
    },
    (table) => [
      foreignKey({
        name: "new_membership_account_fk",
        columns: [table.accountId, table.agentId],
        foreignColumns: [accounts.id, accounts.agentId],
      }),
    ]
  );

  await migrator.migrate("upgrade-fixture", { accounts, memberships });
  await client.query(`INSERT INTO new_memberships VALUES
    ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
     '00000000-0000-4000-8000-000000000002')`);
  await expect(
    client.query(`INSERT INTO new_memberships VALUES
    ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
     '00000000-0000-4000-8000-000000000005')`)
  ).rejects.toMatchObject({ code: "23503" });
  expect((await client.query("SELECT id FROM legacy_accounts")).rows).toHaveLength(1);
});
