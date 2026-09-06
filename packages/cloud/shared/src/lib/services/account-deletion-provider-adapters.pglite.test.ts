/** Proves the restrictive-grant inventory reaches real SQL terminal absence on isolated PGlite. */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
setDefaultTimeout(120_000);

import { sql } from "drizzle-orm";
import {
  closeDatabaseConnectionsForTests,
  dbWrite,
  getPgliteClientForTests,
} from "../../db/client";
import {
  ACCOUNT_DELETION_LOCAL_GRANT_INVENTORY,
  createAccountDeletionProviderAdapters,
} from "./account-deletion-provider-adapters";
import type { AccountDeletionProviderContext } from "./account-deletion-saga";

const SUBSCRIPTION_ID = "30000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";

const context = {
  requestId: "50000000-0000-4000-8000-000000000001",
  requestDigest: "a".repeat(64),
  userId: USER_ID,
  organizationId: ORGANIZATION_ID,
  stewardUserId: "steward-personal",
  lifecycleRevision: 2,
  phaseReceiptId: "60000000-0000-4000-8000-000000000001",
  phaseGeneration: 1,
  blob: {},
} as AccountDeletionProviderContext;

beforeAll(async () => {
  await getPgliteClientForTests().exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY, account_lifecycle_state text NOT NULL DEFAULT 'active');
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE credit_transactions (id uuid PRIMARY KEY, organization_id uuid REFERENCES organizations(id), CONSTRAINT credit_transactions_id_org_idx UNIQUE(id, organization_id));
  `);
  for (const name of [
    "0373_subscription_authority.sql",
    "0374_subscription_funding_transaction_uniqueness.sql",
    "0379_subscription_account_authority.sql",
  ]) {
    const migration = await readFile(
      new URL(`../../db/migrations/${name}`, import.meta.url),
      "utf8",
    );
    await getPgliteClientForTests().transaction(async (tx) => {
      await tx.exec(migration);
    });
  }

  const migrated = await getPgliteClientForTests().query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public'",
  );
  const migratedTables = new Set(migrated.rows.map((row) => row.tablename));
  const columnsByTable = new Map<string, Set<string>>();
  for (const { table, column } of ACCOUNT_DELETION_LOCAL_GRANT_INVENTORY) {
    const columns = columnsByTable.get(table) ?? new Set<string>();
    columns.add(column);
    columnsByTable.set(table, columns);
  }
  for (const [table, columns] of columnsByTable) {
    if (migratedTables.has(table)) continue;
    const columnDefinitions = [...columns].map((column) => sql`${sql.raw(column)} uuid`);
    await dbWrite.execute(
      sql`CREATE TABLE ${sql.raw(table)} (
        id uuid PRIMARY KEY,
        ${sql.join(columnDefinitions, sql`, `)}
      )`,
    );
  }
  for (const entry of ACCOUNT_DELETION_LOCAL_GRANT_INVENTORY) {
    if (migratedTables.has(entry.table)) continue;
    const subject = entry.subject === "user" ? USER_ID : ORGANIZATION_ID;
    await dbWrite.execute(
      sql`INSERT INTO ${sql.raw(entry.table)} (id, ${sql.raw(entry.column)})
          VALUES (${crypto.randomUUID()}, ${subject})`,
    );
  }
  await getPgliteClientForTests().exec(`
    INSERT INTO organizations(id) VALUES ('${ORGANIZATION_ID}');
    INSERT INTO billing_subscriptions (id, organization_id, provider_environment, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id, plan_key, catalog_version, status, current_period_start, current_period_end, lifecycle_revision, provider_object_digest)
    VALUES ('${SUBSCRIPTION_ID}', '${ORGANIZATION_ID}', 'test', 'cus_erasure', 'sub_erasure', 'si_erasure', 'plus_monthly', 'v1', 'active', '2026-08-01Z', '2026-09-01Z', 1, '${"a".repeat(64)}');
    INSERT INTO billing_subscription_revisions (organization_id, subscription_id, revision, source, provider_environment, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id, plan_key, catalog_version, status, current_period_start, current_period_end, cancel_at_period_end, provider_object_digest)
    VALUES ('${ORGANIZATION_ID}', '${SUBSCRIPTION_ID}', 1, 'webhook', 'test', 'cus_erasure', 'sub_erasure', 'si_erasure', 'plus_monthly', 'v1', 'active', '2026-08-01Z', '2026-09-01Z', false, '${"a".repeat(64)}');
    UPDATE organization_subscription_authorities SET state='current', subscription_id='${SUBSCRIPTION_ID}' WHERE organization_id='${ORGANIZATION_ID}';
  `);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("account deletion restrictive-grant terminal absence", () => {
  test("executes the same inventory it inspects, including payment and billing rows", async () => {
    const adapter = createAccountDeletionProviderAdapters().other_grants;

    await expect(adapter.inspect(context)).resolves.toEqual({ state: "needs_execution" });
    await expect(adapter.execute(context, "before-irreversible-fence")).rejects.toMatchObject({
      code: "SUBSCRIPTION_AUTHORITY_CONFLICT",
    });
    await dbWrite.execute(
      sql`UPDATE organizations SET account_lifecycle_state='deletion_irreversible' WHERE id=${ORGANIZATION_ID}`,
    );
    await adapter.execute(context, "delete-local-grants-once");
    await expect(adapter.inspect(context)).resolves.toMatchObject({ state: "complete" });

    const association = await dbWrite.execute(
      sql`SELECT subscription_id, state FROM organization_subscription_authorities WHERE organization_id=${ORGANIZATION_ID}`,
    );
    expect(association.rows).toEqual([{ subscription_id: null, state: "unavailable" }]);
    for (const entry of ACCOUNT_DELETION_LOCAL_GRANT_INVENTORY) {
      const result = await dbWrite.execute(
        sql`SELECT count(*)::int AS count FROM ${sql.raw(entry.table)}
            WHERE ${sql.raw(entry.column)} IS NOT NULL`,
      );
      expect(result.rows[0]?.count).toBe(0);
    }
    await dbWrite.execute(sql`DELETE FROM organizations WHERE id=${ORGANIZATION_ID}`);
    const remaining = await dbWrite.execute(
      sql`SELECT organization_id FROM organization_subscription_authorities WHERE organization_id=${ORGANIZATION_ID}`,
    );
    expect(remaining.rows).toEqual([]);
  });
  test("a departing actor cannot erase a different account's billing commands", async () => {
    const commandId = crypto.randomUUID();
    const sharedOrganizationId = crypto.randomUUID();
    const sharedSubscriptionId = crypto.randomUUID();
    await dbWrite.execute(sql`INSERT INTO users(id) VALUES (${USER_ID})`);
    await dbWrite.execute(sql`INSERT INTO organizations(id, account_lifecycle_state)
      VALUES (${ORGANIZATION_ID}, 'deletion_irreversible'), (${sharedOrganizationId}, 'active')`);
    await dbWrite.execute(sql`INSERT INTO billing_subscriptions (
      id, organization_id, provider_environment, stripe_customer_id, stripe_subscription_id,
      stripe_subscription_item_id, plan_key, catalog_version, status, current_period_start,
      current_period_end, lifecycle_revision, provider_object_digest)
      VALUES (${sharedSubscriptionId}, ${sharedOrganizationId}, 'test', 'cus_shared', 'sub_shared',
        'si_shared', 'plus_monthly', 'v1', 'active', '2026-08-01Z', '2026-09-01Z', 1, ${"a".repeat(64)})`);
    await dbWrite.execute(sql`
      INSERT INTO billing_subscription_commands(id, organization_id, requested_by_user_id,
        kind, target_plan_key, idempotency_key, provider_idempotency_key, request_digest)
      VALUES (${commandId}, ${sharedOrganizationId}, ${USER_ID}, 'checkout', 'plus_monthly',
        'shared-checkout-command', 'shared-provider-command', ${"b".repeat(64)})
    `);
    const incidentId = crypto.randomUUID();
    await dbWrite.execute(sql`INSERT INTO billing_subscription_incidents(
      id, organization_id, subscription_id, command_id, kind, severity, fingerprint,
      context, status, resolved_by_user_id, resolution, resolved_at)
      VALUES (${incidentId}, ${sharedOrganizationId}, ${sharedSubscriptionId}, ${commandId},
        'reconciliation', 'warning', ${"c".repeat(64)}, '{}', 'resolved', ${USER_ID},
        'Provider replay inspected and resolved', now())`);
    const adapter = createAccountDeletionProviderAdapters().other_grants;
    const membershipId = crypto.randomUUID();
    await dbWrite.execute(
      sql`INSERT INTO app_billing_members(id,user_id) VALUES(${membershipId},${USER_ID})`,
    );
    await expect(adapter.inspect(context)).resolves.toEqual({ state: "needs_execution" });
    await adapter.execute(context, "delete-personal-grants");
    const preserved = await dbWrite.execute(sql`
      SELECT organization_id,requested_by_user_id FROM billing_subscription_commands WHERE id=${commandId}
    `);
    expect(preserved.rows).toEqual([
      { organization_id: sharedOrganizationId, requested_by_user_id: USER_ID },
    ]);
    await expect(adapter.inspect(context)).resolves.toMatchObject({ state: "complete" });
    expect(
      (await dbWrite.execute(sql`SELECT id FROM app_billing_members WHERE id=${membershipId}`))
        .rows,
    ).toEqual([]);
    expect(
      (
        await dbWrite.execute(
          sql`SELECT organization_id,resolved_by_user_id,resolution FROM billing_subscription_incidents WHERE id=${incidentId}`,
        )
      ).rows,
    ).toEqual([
      {
        organization_id: sharedOrganizationId,
        resolved_by_user_id: null,
        resolution: "Provider replay inspected and resolved",
      },
    ]);
  });
});
