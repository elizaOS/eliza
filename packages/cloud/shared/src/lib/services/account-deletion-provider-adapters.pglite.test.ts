/** Proves the restrictive-grant inventory reaches real SQL terminal absence on isolated PGlite. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

import { sql } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import {
  ACCOUNT_DELETION_LOCAL_GRANT_INVENTORY,
  createAccountDeletionProviderAdapters,
} from "./account-deletion-provider-adapters";
import type { AccountDeletionProviderContext } from "./account-deletion-saga";

const USER_ID = "20000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";

const context = {
  requestId: "50000000-0000-4000-8000-000000000001",
  requestDigest: "a".repeat(64),
  userId: USER_ID,
  organizationId: ORGANIZATION_ID,
  stewardUserId: "steward-personal",
  lifecycleRevision: 2,
  blob: {},
} as AccountDeletionProviderContext;

beforeAll(async () => {
  const columnsByTable = new Map<string, Set<string>>();
  for (const { table, column } of ACCOUNT_DELETION_LOCAL_GRANT_INVENTORY) {
    const columns = columnsByTable.get(table) ?? new Set<string>();
    columns.add(column);
    columnsByTable.set(table, columns);
  }
  for (const [table, columns] of columnsByTable) {
    const columnDefinitions = [...columns].map((column) => sql`${sql.raw(column)} uuid`);
    await dbWrite.execute(
      sql`CREATE TABLE ${sql.raw(table)} (
        id uuid PRIMARY KEY,
        ${sql.join(columnDefinitions, sql`, `)}
      )`,
    );
  }
  await dbWrite.execute(sql`
    CREATE FUNCTION reject_subscription_append_only_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF current_setting('eliza.subscription_account_deletion_authority', true) = 'on' THEN
        RETURN NULL;
      END IF;
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
    END;
    $$
  `);
  for (const table of ["billing_subscription_revisions", "subscription_allowance_transactions"]) {
    await dbWrite.execute(
      sql`CREATE TRIGGER ${sql.raw(`${table}_immutable_guard`)}
          BEFORE UPDATE OR DELETE OR TRUNCATE ON ${sql.raw(table)}
          FOR EACH STATEMENT EXECUTE FUNCTION reject_subscription_append_only_mutation()`,
    );
  }
  for (const entry of ACCOUNT_DELETION_LOCAL_GRANT_INVENTORY) {
    const subject = entry.subject === "user" ? USER_ID : ORGANIZATION_ID;
    await dbWrite.execute(
      sql`INSERT INTO ${sql.raw(entry.table)} (id, ${sql.raw(entry.column)})
          VALUES (${crypto.randomUUID()}, ${subject})`,
    );
  }
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("account deletion restrictive-grant terminal absence", () => {
  test("executes the same inventory it inspects, including payment and billing rows", async () => {
    const adapter = createAccountDeletionProviderAdapters().other_grants;

    await expect(adapter.inspect(context)).resolves.toEqual({ state: "needs_execution" });
    await adapter.execute(context, "delete-local-grants-once");
    await expect(adapter.inspect(context)).resolves.toMatchObject({ state: "complete" });

    for (const entry of ACCOUNT_DELETION_LOCAL_GRANT_INVENTORY) {
      const result = await dbWrite.execute(
        sql`SELECT count(*)::int AS count FROM ${sql.raw(entry.table)}
            WHERE ${sql.raw(entry.column)} IS NOT NULL`,
      );
      expect(result.rows[0]?.count).toBe(0);
    }
  });
});
