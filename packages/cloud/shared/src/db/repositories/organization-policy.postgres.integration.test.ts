/** Exercises production policy publication and storage admission with independent PostgreSQL writers and paused external effects. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createBillingSnapshotFixture } from "./account-billing-snapshot-test-fixture";

const databaseUrl = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schemaName = `quota_policy_${randomUUID().replaceAll("-", "_")}`;
const applicationName = `quota_policy_${randomUUID()}`;
const ORG = "61000000-0000-4000-8000-000000000009";
const LOCK = 1923094;
let writer: Client;
let database: typeof import("../client");
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitForOrganizationLock(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    // The deleting writer also observes inside BEGIN; refresh its activity
    // snapshot so an early non-waiting observation cannot hide a later lock.
    await writer.query("SELECT pg_stat_clear_snapshot()");
    const result = await writer.query<{ waiting: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%organizations%') waiting",
      [applicationName],
    );
    if (result.rows[0].waiting) return;
    await Bun.sleep(5);
  }
  throw new Error("Production mutation did not wait behind the organization policy transaction");
}
describe.skipIf(!databaseUrl)("organization policy primary transaction fences", () => {
  beforeAll(async () => {
    writer = new Client({ connectionString: databaseUrl });
    await writer.connect();
    await writer.query(`CREATE SCHEMA ${schemaName}`);
    await writer.query(`SET search_path TO ${schemaName},public`);
    if (!databaseUrl) throw new Error("PostgreSQL test URL required");
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `-c search_path=${schemaName},public`);
    url.searchParams.set("application_name", applicationName);
    process.env.DATABASE_URL = url.toString();
    process.env.TEST_DATABASE_URL = url.toString();
    await createBillingSnapshotFixture((query) => writer.query(query), "");
    await writer.query(`DROP VIEW org_rate_limit_overrides;
      CREATE TABLE org_rate_limit_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid UNIQUE REFERENCES organizations(id),completions_rpm integer,embeddings_rpm integer,standard_rpm integer,strict_rpm integer,note text,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now());
      ALTER TABLE org_storage_quota ADD PRIMARY KEY(organization_id);
      INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,account_lifecycle_state) VALUES('${ORG}',100,1,0,'{}',true,'active');`);
    database = await import("../client");
  }, 120000);
  afterAll(async () => {
    if (database) await database.closeDatabaseConnectionsForTests();
    if (writer) {
      await writer.query("SELECT pg_advisory_unlock_all()");
      await writer.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await writer.end();
    }
  });
  test("parallel inference policy readers overlap while a policy writer waits and invalidates their stamp", async () => {
    const { withOrganizationPolicyReadAdmission } = await import(
      "../../lib/services/organization-policy-admission"
    );
    const { requireOrganizationRateTier } = await import(
      "../../lib/services/organization-quota-policy"
    );
    const { orgRateLimitOverridesRepository } = await import("./org-rate-limit-overrides");
    const entered = [barrier(), barrier()];
    const release = barrier();
    const readers = entered.map((ready) =>
      withOrganizationPolicyReadAdmission(ORG, undefined, async (policy) => {
        ready.resolve();
        await release.promise;
        return policy.authority;
      }),
    );
    let mutation: Promise<unknown> | undefined;
    try {
      // Both callbacks must be reached before either releases its transaction.
      // Exclusive reader locks cannot pass this boundary.
      await Promise.race([
        Promise.all(entered.map((ready) => ready.promise)),
        Bun.sleep(3000).then(() => {
          throw new Error("Concurrent inference readers serialized behind one another");
        }),
      ]);
      let mutationFinished = false;
      mutation = orgRateLimitOverridesRepository
        .upsert({ organization_id: ORG, completions_rpm: 12 }, "admin:postgres-test")
        .then(() => {
          mutationFinished = true;
        });
      await waitForOrganizationLock();
      expect(mutationFinished).toBe(false);
      release.resolve();
      const stamps = await Promise.all(readers);
      await mutation;
      expect(stamps[0]).toEqual(stamps[1]);
      await expect(
        withOrganizationPolicyReadAdmission(ORG, stamps[0], async () => "dispatched"),
      ).rejects.toMatchObject({ code: "ORGANIZATION_POLICY_STALE" });
      expect(
        await withOrganizationPolicyReadAdmission(
          ORG,
          undefined,
          async (policy) => requireOrganizationRateTier(policy).completionsRpm,
        ),
      ).toBe(12);
    } finally {
      release.resolve();
      await Promise.allSettled(readers);
      await mutation;
    }
  }, 30000);
  test("an inference reader still fences credit updates and exclusive resource admission", async () => {
    const { sql } = await import("drizzle-orm");
    const { withOrganizationPolicyReadAdmission, withOrganizationPolicyAdmission } = await import(
      "../../lib/services/organization-policy-admission"
    );
    for (const operation of ["credit", "resource"] as const) {
      const entered = barrier(),
        release = barrier();
      const reader = withOrganizationPolicyReadAdmission(ORG, undefined, async () => {
        entered.resolve();
        await release.promise;
      });
      let mutation: Promise<unknown> | undefined;
      try {
        await entered.promise;
        let finished = false;
        mutation = (
          operation === "credit"
            ? database.dbWrite.execute(
                sql`UPDATE organizations SET credit_balance=credit_balance-1 WHERE id=${ORG}`,
              )
            : withOrganizationPolicyAdmission(ORG, undefined, async () => "resource admitted")
        ).then(() => {
          finished = true;
        });
        await waitForOrganizationLock();
        expect(finished).toBe(false);
        release.resolve();
        await reader;
        await mutation;
        expect(finished).toBe(true);
      } finally {
        release.resolve();
        await reader;
        await mutation;
      }
    }
  }, 30000);
  test("a paused old cache publication cannot overtake a newer committed policy warmer", async () => {
    const { cache } = await import("../../lib/cache/client");
    const { isInferenceAdmissionSnapshot } = await import(
      "../../lib/services/inference-auth-cache"
    );
    const { warmInferenceAdmissionSnapshot } = await import(
      "../../lib/services/inference-admission-snapshot"
    );
    const { orgRateLimitOverridesRepository } = await import("./org-rate-limit-overrides");
    const entered = barrier(),
      release = barrier();
    const published: string[] = [];
    let writes = 0;
    const transport = spyOn(cache, "setWithOutcome").mockImplementation(async (_key, value) => {
      if (!isInferenceAdmissionSnapshot(value))
        throw new Error("Invalid cache publication payload");
      const snapshot = value;
      writes++;
      if (writes === 1) {
        entered.resolve();
        await release.promise;
      }
      published.push(snapshot.authority.generation);
      return { kind: "written", backend: "redis_native" };
    });
    const old = warmInferenceAdmissionSnapshot(ORG);
    let newer: Promise<unknown> | undefined;
    try {
      await Promise.race([
        entered.promise,
        old.then(() => {
          throw new Error("Warmer completed without reaching cache transport");
        }),
      ]);
      newer = orgRateLimitOverridesRepository
        .upsert({ organization_id: ORG, completions_rpm: 7 }, "admin:postgres-test")
        .then(() => warmInferenceAdmissionSnapshot(ORG));
      await waitForOrganizationLock();
      expect(published).toEqual([]);
      release.resolve();
      await old;
      await newer;
      expect(published.length).toBe(2);
      expect(BigInt(published[1])).toBeGreaterThan(BigInt(published[0]));
    } finally {
      release.resolve();
      await old;
      await newer;
      transport.mockRestore();
    }
  }, 30000);
  test("a concurrent storage downgrade orders after an admitted reservation and denies subsequent growth", async () => {
    const { orgStorageQuotaRepository } = await import("./org-storage-quota");
    await orgStorageQuotaRepository.setBytesLimit(ORG, 10n, "admin:postgres-test");
    await writer.query(`CREATE FUNCTION pause_quota_reservation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.bytes_used>OLD.bytes_used THEN PERFORM pg_advisory_xact_lock(${LOCK}); END IF; RETURN NEW; END $$;
      CREATE TRIGGER pause_quota_reservation BEFORE UPDATE ON org_storage_quota FOR EACH ROW EXECUTE FUNCTION pause_quota_reservation();`);
    await writer.query(`SELECT pg_advisory_lock(${LOCK})`);
    const reservation = orgStorageQuotaRepository.tryReserveBytes(ORG, 7n);
    let downgrade: Promise<void> | undefined;
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        const rows = await writer.query<{ waiting: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=${LOCK} AND NOT granted) waiting`,
        );
        if (rows.rows[0].waiting) break;
        if (attempt === 199)
          throw new Error("Storage reservation did not reach its real conditional update");
        await Bun.sleep(5);
      }
      downgrade = orgStorageQuotaRepository.setBytesLimit(ORG, 5n, "admin:postgres-test");
      await waitForOrganizationLock();
      await writer.query(`SELECT pg_advisory_unlock(${LOCK})`);
      expect(await reservation).toBe(7n);
      await downgrade;
      expect(await orgStorageQuotaRepository.tryReserveBytes(ORG, 1n)).toBeNull();
      const rows = await writer.query<{ bytes_used: string; bytes_limit: string }>(
        `SELECT bytes_used,bytes_limit FROM org_storage_quota WHERE organization_id='${ORG}'`,
      );
      expect(rows.rows[0]).toEqual({ bytes_used: "7", bytes_limit: "5" });
    } finally {
      await writer.query(`SELECT pg_advisory_unlock_all()`);
      await reservation;
      await downgrade;
    }
  }, 30000);
  test("organization deletion cannot deadlock behind a provisioning candidate row", async () => {
    process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
    const { agentSandboxesRepository } = await import("./agent-sandboxes");
    const org = "61000000-0000-4000-8000-000000000010";
    const agent = "64000000-0000-4000-8000-000000000010";
    await writer.query(`ALTER TABLE agent_sandboxes ADD CONSTRAINT quota_test_org_fk FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
      INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,account_lifecycle_state) VALUES('${org}',100,1,0,'{}',true,'active');
      INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,quota_admission_scope) VALUES('${agent}','${org}','stopped','dedicated-always','organization');`);
    await writer.query("BEGIN");
    await writer.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [org]);
    // Observe rejection immediately so the expected deleted-authority error is
    // never an unhandled promise while the deleting transaction commits.
    const provisioning = agentSandboxesRepository.trySetProvisioning(agent).then(
      (value) => ({ kind: "returned" as const, value }),
      (error) => ({ kind: "rejected" as const, error }),
    );
    try {
      await waitForOrganizationLock();
      await writer.query("SET LOCAL lock_timeout='2s'");
      await writer.query("DELETE FROM organizations WHERE id=$1", [org]);
      await writer.query("COMMIT");
      const outcome = await provisioning;
      if (outcome.kind === "returned") expect(outcome.value).toBeUndefined();
      else expect(outcome.error).toMatchObject({ code: "ORGANIZATION_POLICY_UNAVAILABLE" });
      expect(
        (await writer.query("SELECT id FROM agent_sandboxes WHERE id=$1", [agent])).rows,
      ).toEqual([]);
    } finally {
      await writer.query("ROLLBACK");
      await provisioning;
    }
  }, 30000);
});
