/** Exercises actual recovery publication against independent PostgreSQL sessions, proving single-flight claims and lease expiry after waiting for the organization lock. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import {
  installCancellationTestSchema,
  seedCancellationTestAccount,
} from "./subscription-cancellation-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `reconciliation_${randomUUID().replaceAll("-", "_")}`;
let setup: Client,
  repo: typeof import("./subscription-reconciliation"),
  close: typeof import("../client").closeDatabaseConnectionsForTests;
async function connect() {
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`SET search_path TO ${schema},public`);
  return client;
}
(url ? describe : describe.skip)("reconciliation independent PostgreSQL authority", () => {
  beforeAll(async () => {
    setup = new Client({ connectionString: url });
    await setup.connect();
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.query(`SET search_path TO ${schema},public`);
    await installCancellationTestSchema((query) => setup.query(query));
    const migration = await readFile(
      new URL("../migrations/0385_subscription_reconciliation.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await setup.query(statement);
    const target = new URL(url!);
    target.searchParams.set("options", `-c search_path=${schema},public`);
    target.searchParams.set("application_name", schema);
    process.env.DATABASE_URL = target.toString();
    process.env.TEST_DATABASE_URL = target.toString();
    process.env.LOCAL_PG_POOL_MAX = "4";
    repo = await import("./subscription-reconciliation");
    ({ closeDatabaseConnectionsForTests: close } = await import("../client"));
  }, 120_000);
  afterAll(async () => {
    if (!setup) return;
    await close?.();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.end();
  });
  test("concurrent transactions acquire only one durable generation", async () => {
    const f = await seedCancellationTestAccount((text, values) => setup.query(text, values));
    const claims = await Promise.all([
      repo.claimSubscriptionReconciliation(f.input),
      repo.claimSubscriptionReconciliation(f.input),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      (
        await setup.query(
          "SELECT generation,disposition FROM subscription_reconciliation_attempts WHERE organization_id=$1",
          [f.input.organizationId],
        )
      ).rows,
    ).toEqual([{ generation: "1", disposition: "processing" }]);
  });
  test("an observation lease expired during a real organization-lock wait cannot publish", async () => {
    const f = await seedCancellationTestAccount((text, values) => setup.query(text, values));
    const authority = (await import("./subscription-authority")).subscriptionAuthorityRepository;
    const source = await authority.findById(f.input.organizationId, f.input.subscriptionId);
    if (!source) throw new Error("Missing source");
    const identity = {
      organizationId: f.input.organizationId,
      subscriptionId: f.input.subscriptionId,
      attemptId: randomUUID(),
      generation: 1,
      leaseToken: randomUUID(),
      expectedRevision: 1,
      identityDigest: repo.reconciliationDigest({
        source,
        expectedProjectionRevision: 1,
        organizationCustomerId: f.source.stripe_customer_id,
      }),
    };
    // A pre-existing receipt with a near deadline models work arriving at the finalizer near the end of its fixed production lease.
    await setup.query(
      "INSERT INTO subscription_reconciliation_scans(organization_id,subscription_id,generation,next_due_at) VALUES($1,$2,1,clock_timestamp()+interval '500 milliseconds')",
      [identity.organizationId, identity.subscriptionId],
    );
    await setup.query(
      "INSERT INTO subscription_reconciliation_attempts(id,organization_id,subscription_id,generation,expected_revision,expected_projection_revision,identity_digest,lease_token,started_at,expires_at) VALUES($1,$2,$3,1,1,1,$4,$5,clock_timestamp()-interval '1 second',clock_timestamp()+interval '500 milliseconds')",
      [
        identity.attemptId,
        identity.organizationId,
        identity.subscriptionId,
        identity.identityDigest,
        identity.leaseToken,
      ],
    );
    const blocker = await connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
      identity.organizationId,
    ]);
    const {
      last_provider_event_id: _id,
      last_provider_event_created_at: _time,
      ...values
    } = f.source;
    const result = repo
      .finalizeSubscriptionReconciliation(
        {
          ...identity,
          source,
          organizationCustomerId: f.source.stripe_customer_id,
          expectedProjectionRevision: 1,
        },
        {
          kind: "terminal",
          value: { ...values, status: "canceled", canceled_at: new Date(), ended_at: new Date() },
        },
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error }),
      );
    try {
      let waiting = false;
      for (let n = 0; n < 100; n++) {
        const query = await setup.query(
          "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
          [schema],
        );
        if (query.rows.length) {
          waiting = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      await setup.query("SELECT pg_sleep(0.7)");
    } finally {
      await blocker.query("COMMIT");
      await blocker.end();
    }
    const completed = await result;
    expect(completed.ok).toBe(false);
    if (completed.ok) throw new Error("Expired lease published");
    expect(completed.error).toMatchObject({ code: "SUBSCRIPTION_RECONCILIATION_LEASE_LOST" });
    expect(
      (
        await setup.query(
          "SELECT lifecycle_revision,status FROM billing_subscriptions WHERE id=$1",
          [identity.subscriptionId],
        )
      ).rows,
    ).toEqual([{ lifecycle_revision: "1", status: "active" }]);
    expect(
      (
        await setup.query(
          "SELECT disposition,result_revision FROM subscription_reconciliation_attempts WHERE id=$1",
          [identity.attemptId],
        )
      ).rows,
    ).toEqual([{ disposition: "processing", result_revision: null }]);
  });
});
