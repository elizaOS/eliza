/** Exercises production grant cleanup against real PostgreSQL. Minimal surrounding tables retain economic evidence while the actual adapter removes operational access for one subject. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { AccountDeletionProviderContext } from "./account-deletion-saga";

const url = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `grant_retention_${randomUUID().replaceAll("-", "_")}`;
if (url) {
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = scoped.toString();
  process.env.TEST_DATABASE_URL = scoped.toString();
}
setDefaultTimeout(120_000);
const userId = randomUUID();
const organizationId = randomUUID();
const otherUser = randomUUID();
const otherOrganization = randomUUID();
const financialTables = [
  "subscription_allowance_transactions",
  "billing_funding_allocations",
  "billing_funding_reservations",
  "subscription_allowance_periods",
  "billing_subscription_incidents",
  "billing_subscription_event_receipts",
  "billing_subscription_commands",
  "billing_subscription_revisions",
  "billing_subscriptions",
  "affiliate_payout_outbox",
  "app_reservation_settlement_quarantines",
  "app_reservation_settlements",
  "container_billing_legacy_ledger_bindings",
  "container_billing_records",
  "compute_billing_rate_segments",
  "agent_billing_records",
  "payment_request_receipts",
  "stripe_checkout_legacy_quarantine",
  "stripe_checkout_orders",
  "stripe_customer_attempts",
  "stripe_customer_legacy_quarantines",
];
let db: Client;
let adapter: ReturnType<
  typeof import("./account-deletion-provider-adapters").createAccountDeletionProviderAdapters
>["other_grants"];
let close: typeof import("../../db/client").closeDatabaseConnectionsForTests;
let context: AccountDeletionProviderContext;

describe.skipIf(!url)("grant cleanup preserves billing history", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await db.query(
      "CREATE TABLE organizations(id uuid PRIMARY KEY,account_lifecycle_state text NOT NULL)",
    );
    await db.query(
      "CREATE TABLE organization_subscription_authorities(organization_id uuid PRIMARY KEY,subscription_id uuid,state text NOT NULL)",
    );
    await db.query("INSERT INTO organizations VALUES($1,'deletion_irreversible'),($2,'active')", [
      organizationId,
      otherOrganization,
    ]);
    await db.query(
      "INSERT INTO organization_subscription_authorities VALUES($1,$3,'available'),($2,$4,'available')",
      [organizationId, otherOrganization, randomUUID(), randomUUID()],
    );

    const { createAccountDeletionProviderAdapters, ACCOUNT_DELETION_LOCAL_GRANT_INVENTORY } =
      await import("./account-deletion-provider-adapters");
    close = (await import("../../db/client")).closeDatabaseConnectionsForTests;
    for (const table of financialTables) {
      await db.query(
        `CREATE TABLE ${table}(id integer PRIMARY KEY,organization_id uuid,initiated_by_user_id uuid,resolved_by_user_id uuid,affiliate_user_id uuid,payload jsonb NOT NULL)`,
      );
      await db.query(`INSERT INTO ${table} VALUES(1,$1,$2,$2,$2,$3),(2,$4,$5,$5,$5,$3)`, [
        organizationId,
        userId,
        { amount: "3.125000", providerId: "original", digest: "immutable" },
        otherOrganization,
        otherUser,
      ]);
    }
    for (const entry of ACCOUNT_DELETION_LOCAL_GRANT_INVENTORY) {
      await db.query(`CREATE TABLE ${entry.table}(id integer PRIMARY KEY,${entry.column} uuid)`);
      await db.query(`INSERT INTO ${entry.table} VALUES(1,$1),(2,$2)`, [
        entry.subject === "user" ? userId : organizationId,
        entry.subject === "user" ? otherUser : otherOrganization,
      ]);
    }
    context = {
      requestId: randomUUID(),
      requestDigest: "a".repeat(64),
      userId,
      organizationId,
      stewardUserId: "fixture",
      lifecycleRevision: 1,
      phaseReceiptId: randomUUID(),
      phaseGeneration: 1,
      blob: {} as AccountDeletionProviderContext["blob"],
    };
    adapter = createAccountDeletionProviderAdapters().other_grants;
  });
  afterAll(async () => {
    if (close) await close();
    if (!db) return;
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  });
  test("removes access and anonymizes operational grants without treating financial rows as remaining grants", async () => {
    const before = new Map<string, object[]>();
    for (const table of financialTables)
      before.set(table, (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows);
    expect((await adapter.inspect(context)).state).toBe("needs_execution");
    await adapter.execute(context, "fixture-grant-cleanup");
    expect((await adapter.inspect(context)).state).toBe("complete");
    expect(
      (
        await db.query(
          "SELECT state,subscription_id FROM organization_subscription_authorities WHERE organization_id=$1",
          [organizationId],
        )
      ).rows,
    ).toEqual([{ state: "unavailable", subscription_id: null }]);

    for (const table of financialTables)
      expect((await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows).toEqual(
        before.get(table),
      );
    expect((await db.query("SELECT * FROM app_billing_members ORDER BY id")).rows).toEqual([
      { id: 2, user_id: otherUser },
    ]);
    expect((await db.query("SELECT * FROM jobs ORDER BY id")).rows).toEqual([
      { id: 1, user_id: null },
      { id: 2, user_id: otherUser },
    ]);
    await adapter.execute(context, "fixture-grant-cleanup");
    expect((await adapter.inspect(context)).state).toBe("complete");
  });
});
