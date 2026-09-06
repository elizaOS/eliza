/**
 * Exercises the production billing snapshot transaction with independent PostgreSQL sessions.
 * A database lock pauses a real dependent read after the balance observation while another
 * session commits a lifecycle/allowance update. Removing production REPEATABLE READ or
 * reading subscription authority outside its transaction must produce a failing assertion.
 * Subscription tables use production migrations; empty unrelated resource tables are fixtures.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createBillingSnapshotFixture } from "./account-billing-snapshot-test-fixture";

const databaseUrl = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schemaName = `billing_snapshot_${randomUUID().replaceAll("-", "_")}`;
const ORG = "61000000-0000-4000-8000-000000000001";
const SUB = "62000000-0000-4000-8000-000000000001";
const LOCK = 1923095;
const DIGEST = "b".repeat(64);
let writer: Client;
let database: typeof import("../client");
let readSnapshot: typeof import("./account-billing-snapshot").readPrimaryAccountBillingSnapshot;
let project: typeof import("../../lib/services/account-subscription-snapshot").buildOrganizationSubscriptionSnapshot;

describe.skipIf(!databaseUrl)("coherent production account billing snapshot", () => {
  beforeAll(async () => {
    writer = new Client({ connectionString: databaseUrl });
    await writer.connect();
    await writer.query(`CREATE SCHEMA ${schemaName}`);
    await writer.query(`SET search_path TO ${schemaName}, public`);
    if (!databaseUrl) throw new Error("PostgreSQL test URL is required");
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `-c search_path=${schemaName},public`);
    process.env.DATABASE_URL = url.toString();
    process.env.TEST_DATABASE_URL = url.toString();
    await createBillingSnapshotFixture(
      (query) => writer.query(query),
      `PERFORM pg_advisory_xact_lock(${LOCK});`,
    );
    database = await import("../client");
    ({ readPrimaryAccountBillingSnapshot: readSnapshot } = await import(
      "./account-billing-snapshot"
    ));
    ({ buildOrganizationSubscriptionSnapshot: project } = await import(
      "../../lib/services/account-subscription-snapshot"
    ));
  }, 120_000);

  afterAll(async () => {
    if (database) await database.closeDatabaseConnectionsForTests();
    if (writer) {
      await writer.query(`SELECT pg_advisory_unlock_all()`);
      await writer.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await writer.end();
    }
  });

  test("balance, subscription and allowance cannot mix revisions across a concurrent commit", async () => {
    await writer.query(`SELECT pg_advisory_lock(${LOCK})`);
    // Attach both handlers immediately: a reader failure before lock acquisition
    // is observed and causes the test to fail instead of becoming unhandled.
    const pending = readSnapshot(ORG).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      let waiting = false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const result = await writer.query<{ waiting: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = ${LOCK} AND NOT granted) AS waiting`,
        );
        if (result.rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      await writer.query(`BEGIN;
        UPDATE organizations SET credit_balance = '20.000002', balance_revision = 2 WHERE id = '${ORG}';
        INSERT INTO billing_subscription_revisions(organization_id, subscription_id, revision, source, provider_environment, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id, plan_key, catalog_version, status, current_period_start, current_period_end, cancel_at_period_end, provider_object_digest)
        VALUES('${ORG}', '${SUB}', 2, 'webhook', 'test', 'cus_snapshot', 'sub_snapshot', 'si_snapshot', 'plus_monthly', 'v1', 'active', '2026-08-01Z', '2026-09-01Z', true, '${DIGEST}');
        UPDATE billing_subscriptions SET lifecycle_revision = 2, cancel_at_period_end = true WHERE id = '${SUB}';
        UPDATE organization_entitlements SET source_subscription_revision = 2, projection_revision = 2 WHERE organization_id = '${ORG}';
        UPDATE subscription_allowance_periods SET available_amount = '24.000000', settled_amount = '1.000001' WHERE organization_id = '${ORG}';
        COMMIT;`);
    } finally {
      // error-policy:J6 Roll back a failed test write and release only this test's lock.
      await writer.query("ROLLBACK");
      await writer.query(`SELECT pg_advisory_unlock(${LOCK})`);
    }
    const observed = await pending;
    if ("error" in observed) throw observed.error;
    expect(observed.value.organization).toMatchObject({
      creditBalance: "10.000001",
      balanceRevision: "1",
    });
    expect(project(observed.value.subscription, observed.value.observedAt)).toMatchObject({
      status: "available",
      value: {
        lifecycleRevision: "1",
        cancelAtPeriodEnd: false,
        allowance: { status: "available", value: { unreserved: "25.000001", settled: "0.000000" } },
      },
    });
    const refreshed = await readSnapshot(ORG);
    expect(refreshed.organization).toMatchObject({
      creditBalance: "20.000002",
      balanceRevision: "2",
    });
    expect(project(refreshed.subscription, refreshed.observedAt)).toMatchObject({
      status: "available",
      value: {
        lifecycleRevision: "2",
        cancelAtPeriodEnd: true,
        allowance: { status: "available", value: { unreserved: "24.000000", settled: "1.000001" } },
      },
    });
  }, 30_000);
});
