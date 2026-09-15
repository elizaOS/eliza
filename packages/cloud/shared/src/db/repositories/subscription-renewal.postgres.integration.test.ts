/** Exercises duplicate paid invoices and organization-lock lease/deletion races using independent real PostgreSQL sessions and migrated production finalization. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { installCancellationTestSchema } from "./subscription-cancellation-test-fixture";
import { seedRenewalTestAccount } from "./subscription-renewal-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `renewal_${randomUUID().replaceAll("-", "_")}`;
let setup: Client;
let finalize: typeof import("./subscription-renewal-finalization").finalizePaidRenewal;
let operations: typeof import("./subscription-billing-operations").subscriptionBillingOperationsRepository;
let close: typeof import("../client").closeDatabaseConnectionsForTests;
async function connection() {
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`SET search_path TO ${schema},public`);
  return client;
}
async function prepare(f: Awaited<ReturnType<typeof seedRenewalTestAccount>>, duration = 60000) {
  const eventId = `evt_${randomUUID().replaceAll("-", "")}`,
    eventCreatedAt = new Date();
  const receipt = await operations.recordEvent({
    organizationId: f.source.organization_id,
    subscriptionId: f.source.id,
    providerEventId: eventId,
    eventType: "invoice.paid",
    providerObjectType: "invoice",
    providerObjectId: f.invoice.id,
    livemode: false,
    eventCreatedAt,
    payloadDigest: "a".repeat(64),
    now: new Date(),
  });
  const leaseToken = randomUUID();
  if (
    !(await operations.claimEvent({
      organizationId: f.source.organization_id,
      receiptId: receipt.value.id,
      leaseToken,
      leaseDurationMs: duration,
    }))
  )
    throw new Error("receipt lease not acquired");
  return {
    ...f,
    organizationId: f.source.organization_id,
    subscriptionId: f.source.id,
    invoiceId: f.invoice.id,
    receiptId: receipt.value.id,
    leaseToken,
    expectedSubscriptionRevision: 2,
    expectedProjectionRevision: 2,
    providerEventId: eventId,
    eventCreatedAt,
  };
}
async function waitForOrgLock() {
  for (let i = 0; i < 500; i++) {
    const rows = await setup.query(
      "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query ILIKE '%organizations%FOR UPDATE%'",
      [schema],
    );
    if (rows.rowCount) return;
    await Bun.sleep(20);
  }
  throw new Error("Production renewal did not wait on organization lock");
}
async function snapshot(org: string) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "billing_subscriptions",
    "billing_subscription_revisions",
    "subscription_allowance_periods",
    "subscription_allowance_transactions",
    "organization_subscription_authorities",
    "organization_entitlements",
    "billing_subscription_event_receipts",
  ])
    result[table] = (
      await setup.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [org])
    ).rows;
  return result;
}
(url ? describe : describe.skip)("paid renewal independent PostgreSQL sessions", () => {
  beforeAll(async () => {
    setup = new Client({ connectionString: url });
    await setup.connect();
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.query(`SET search_path TO ${schema},public`);
    await installCancellationTestSchema((query) => setup.query(query));
    const target = new URL(url!);
    target.searchParams.set("options", `-c search_path=${schema},public`);
    target.searchParams.set("application_name", schema);
    process.env.DATABASE_URL = target.toString();
    process.env.TEST_DATABASE_URL = target.toString();
    process.env.LOCAL_PG_POOL_MAX = "4";
    process.env.ENVIRONMENT = "local";
    process.env.STRIPE_SECRET_KEY = "sk_test_renewalpg";
    process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
    process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
    process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
    process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
    ({ finalizePaidRenewal: finalize } = await import("./subscription-renewal-finalization"));
    ({ subscriptionBillingOperationsRepository: operations } = await import(
      "./subscription-billing-operations"
    ));
    ({ closeDatabaseConnectionsForTests: close } = await import("../client"));
  }, 120000);
  afterAll(async () => {
    if (!setup) return;
    await close();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.end();
  });
  test("distinct events concurrently funding one invoice create one immutable grant", async () => {
    const f = await seedRenewalTestAccount((text, values) => setup.query(text, values));
    const a = await prepare(f),
      b = await prepare(f);
    const results = await Promise.allSettled([finalize(a), finalize(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results[0]?.status === "rejected" ? a : b;
    expect(
      (await finalize({ ...loser, expectedSubscriptionRevision: 3, expectedProjectionRevision: 3 }))
        .replayed,
    ).toBe(true);
    expect(
      (
        await setup.query(
          "SELECT granted_amount, available_amount FROM subscription_allowance_periods WHERE organization_id=$1",
          [f.source.organization_id],
        )
      ).rows,
    ).toEqual([{ granted_amount: "25.000000", available_amount: "25.000000" }]);
    expect(
      (
        await setup.query(
          "SELECT count(*)::int AS grants FROM subscription_allowance_transactions WHERE organization_id=$1 AND kind='grant'",
          [f.source.organization_id],
        )
      ).rows,
    ).toEqual([{ grants: 1 }]);
  }, 30000);
  for (const scenario of ["lease", "deletion"] as const)
    test(`${scenario} changes while finalizer waits deny all writes`, async () => {
      const f = await seedRenewalTestAccount((text, values) => setup.query(text, values));
      const input = await prepare(f, scenario === "lease" ? 500 : 60000);
      const holder = await connection();
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
        f.source.organization_id,
      ]);
      const before = await snapshot(f.source.organization_id);
      const pending = finalize(input).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await waitForOrgLock();
        if (scenario === "lease") await Bun.sleep(600);
        else
          await holder.query(
            "UPDATE organizations SET paid_work_fenced_at=clock_timestamp() WHERE id=$1",
            [f.source.organization_id],
          );
        await holder.query("COMMIT");
        const outcome = await pending;
        expect("error" in outcome).toBe(true);
        expect(await snapshot(f.source.organization_id)).toEqual(before);
      } finally {
        await holder.query("ROLLBACK");
        await holder.end();
        await pending;
      }
    }, 30000);
});
