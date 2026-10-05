/** Runs the shared recovery contract on PostgreSQL and verifies publication fences with independent row-lock holders and atomic receipt-failure rollback. */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { definePaidRenewalRecoveryContract } from "./test-support/subscription-paid-renewal-recovery-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `renewal_recovery_${randomUUID().replaceAll("-", "_")}`;
let setup: Client | undefined;
async function connection() {
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`SET search_path TO ${schema},public`);
  return client;
}
async function query<Row extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  values?: unknown[],
) {
  if (!setup) throw new Error("PostgreSQL fixture not initialized");
  return setup.query<Row>(sql, values);
}
async function waitForOrganizationLock() {
  for (let attempt = 0; attempt < 500; attempt++) {
    const result = await query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query ILIKE '%organizations%FOR UPDATE%'",
      [schema],
    );
    if (result.rows.length) return;
    await Bun.sleep(20);
  }
  throw new Error("Recovery publication never waited on the independent organization lock");
}
async function publicationSnapshot(organizationId: string) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "billing_subscriptions",
    "billing_subscription_revisions",
    "subscription_allowance_periods",
    "subscription_allowance_transactions",
    "organization_subscription_authorities",
    "organization_entitlements",
    "organization_policy_audit",
    "billing_subscription_event_receipts",
  ]) {
    result[table] = (
      await query(`SELECT * FROM ${table} WHERE organization_id=$1`, [organizationId])
    ).rows;
  }
  return result;
}
(url ? describe : describe.skip)("paid-renewal recovery independent PostgreSQL sessions", () => {
  const contract = definePaidRenewalRecoveryContract({
    async setup() {
      setup = new Client({ connectionString: url });
      await setup.connect();
      await setup.query(`CREATE SCHEMA ${schema}`);
      await setup.query(`SET search_path TO ${schema},public`);
      const target = new URL(url!);
      target.searchParams.set("options", `-c search_path=${schema},public`);
      target.searchParams.set("application_name", schema);
      process.env.DATABASE_URL = target.toString();
      process.env.TEST_DATABASE_URL = target.toString();
      process.env.LOCAL_PG_POOL_MAX = "4";
    },
    async exec(sql) {
      await query(sql);
    },
    query,
    async close() {
      if (!setup) return;
      const { closeDatabaseConnectionsForTests } = await import("../client");
      try {
        await closeDatabaseConnectionsForTests();
        await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await setup.end();
      }
    },
  });

  for (const scenario of ["deletion", "lease"] as const) {
    test(`${scenario} changing while paid recovery waits denies all publication`, async () => {
      const fixture = await contract.seed();
      const holder = await connection();
      let ready!: () => void;
      const locked = new Promise<void>((resolve) => {
        ready = resolve;
      });
      contract.beforeChargeResponse(async () => {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
          fixture.source.organization_id,
        ]);
        ready();
      });
      const before = await publicationSnapshot(fixture.source.organization_id);
      const pending = contract.recover().then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await Promise.race([
          locked,
          pending.then(() => {
            throw new Error("Recovery completed before acquiring the controlled organization lock");
          }),
        ]);
        await waitForOrganizationLock();
        if (scenario === "deletion") {
          await holder.query(
            "UPDATE organizations SET paid_work_fenced_at=clock_timestamp() WHERE id=$1",
            [fixture.source.organization_id],
          );
        } else {
          let expired = false;
          for (let attempt = 0; attempt < 750; attempt++) {
            expired =
              (
                await query<{ expired: boolean }>(
                  "SELECT expires_at<=clock_timestamp() AS expired FROM subscription_reconciliation_attempts WHERE organization_id=$1 AND disposition='processing'",
                  [fixture.source.organization_id],
                )
              ).rows[0]?.expired === true;
            if (expired) break;
            await Bun.sleep(100);
          }
          expect(expired).toBe(true);
        }
        await holder.query("COMMIT");
        const outcome = await pending;
        if (scenario === "deletion") {
          expect("value" in outcome && outcome.value.attempts[0]?.disposition).toBe(
            "deletion_owned",
          );
        } else {
          expect("error" in outcome).toBe(true);
          if ("error" in outcome)
            expect(outcome.error).toMatchObject({
              code: "SUBSCRIPTION_RECONCILIATION_BOOKKEEPING_FAILED",
            });
        }
        expect(await publicationSnapshot(fixture.source.organization_id)).toEqual(before);
        expect(contract.writes()).toBe(0);
      } finally {
        await holder.query("ROLLBACK");
        await holder.end();
        await pending;
      }
    }, 120_000);
  }

  test("attempt completion failure rolls back paid source, grant and entitlement together", async () => {
    const fixture = await contract.seed();
    const before = await publicationSnapshot(fixture.source.organization_id);
    await query(`CREATE FUNCTION reject_recovery_publication_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.disposition='applied' THEN RAISE EXCEPTION 'controlled receipt completion failure'; END IF; RETURN NEW; END $$`);
    await query(
      "CREATE TRIGGER reject_recovery_publication_receipt BEFORE UPDATE ON subscription_reconciliation_attempts FOR EACH ROW EXECUTE FUNCTION reject_recovery_publication_receipt()",
    );
    try {
      const result = await contract.recover();
      expect(result.status).toBe("degraded");
      expect(result.attempts[0]?.disposition).toBe("unavailable");
      expect(await publicationSnapshot(fixture.source.organization_id)).toEqual(before);
      expect(contract.writes()).toBe(0);
    } finally {
      await query(
        "DROP TRIGGER reject_recovery_publication_receipt ON subscription_reconciliation_attempts",
      );
      await query("DROP FUNCTION reject_recovery_publication_receipt()");
    }
    await contract.makeDue(fixture.source.organization_id);
    expect((await contract.recover()).attempts[0]?.disposition).toBe("applied");
    expect(await contract.allowanceCount(fixture.source.organization_id)).toBe(1);
    expect(await contract.sourceRevision(fixture.source.id)).toBe(
      fixture.source.lifecycle_revision + 1,
    );
  });
});
