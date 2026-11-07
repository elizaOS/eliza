/** Migration-level journal invariants; not provider proof or a publication service test. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { loadCanonicalMigrations } from "../../../scripts/admin/canonical-migration-ledger";

const db = new PGlite();
const org = randomUUID(),
  foreign = randomUUID(),
  grant = randomUUID(),
  subscription = randomUUID();
const period = randomUUID();
const digest = "a".repeat(64);
const observed = new Date("2026-01-01T00:00:00Z");
const observation = {
  kind: "renewal_adjustment_observation",
  version: 1,
  organizationId: org,
  subscriptionId: subscription,
  invoiceAuthorityDigest: digest,
  invoiceDetailsDigest: digest,
  settlementDetailsDigest: digest,
  grantDigest: digest,
  observation: { invoice: { id: "in_original" } },
  digest,
};
// Minimal prerequisite shapes isolate the migration's database invariants.
// Runtime/provider/schema validation requires the separate repository integration suite.
beforeAll(async () => {
  await db.exec(`CREATE TABLE organizations(id uuid PRIMARY KEY,is_active boolean DEFAULT true,
    account_lifecycle_state text DEFAULT 'active',account_deletion_request_id uuid,paid_work_fenced_at timestamptz);
    CREATE TABLE subscription_allowance_periods(id uuid PRIMARY KEY,organization_id uuid,billing_scope_id uuid,merchant_key text,grant_source text,subscription_id uuid,stripe_invoice_id text);
    CREATE TABLE subscription_allowance_transactions(id uuid PRIMARY KEY,organization_id uuid,kind text,
    billing_scope_id uuid,merchant_key text,source_subscription_id uuid,source_invoice_id text,request_digest text,metadata jsonb,allowance_period_id uuid);`);
  await db.query("INSERT INTO organizations(id) VALUES ($1),($2)", [org, foreign]);
  await db.query(
    "INSERT INTO subscription_allowance_periods VALUES ($1,$2,NULL,'platform','paid_invoice',$3,'in_original')",
    [period, org, subscription],
  );
  await db.query(
    "INSERT INTO subscription_allowance_transactions VALUES ($1,$2,'grant',NULL,'platform',$3,'in_original',$4,$5,$6)",
    [
      grant,
      org,
      subscription,
      digest,
      JSON.stringify({
        renewalInvoiceAuthority: { digest },
        renewalInvoiceDetails: { digest },
        renewalSettlementDetails: { digest },
      }),
      period,
    ],
  );
  const migrations = await loadCanonicalMigrations();
  const index = migrations.findIndex(
    (m) => m.entry.tag === "0528_subscription_adjustment_observations",
  );
  expect(index).toBeGreaterThan(0);
  expect(migrations[index - 1]!.entry.tag).toBe("0527_organization_schedule_late_configuration");
  const migration = migrations[index]!;
  expect(migration.entry.idx).toBe(migrations[index - 1]!.entry.idx + 1);
  for (const statement of migration.statements) await db.exec(statement);
  const claims = migrations[index + 1]!;
  expect(claims.entry.tag).toBe("0529_subscription_adjustment_recovery");
  expect(claims.entry.idx).toBe(migration.entry.idx + 1);
  for (const statement of claims.statements) await db.exec(statement);
}, 30000);
afterAll(() => db.close());
async function insert({
  id = randomUUID(),
  request = randomUUID(),
  version = 1,
  previous = null as string | null,
  payload = observation as Record<string, unknown>,
  organization = org,
  time = observed,
} = {}) {
  await db.query(
    `INSERT INTO subscription_adjustment_observations(id,organization_id,grant_id,request_id,version,previous_id,observation,observed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, organization, grant, request, version, previous, JSON.stringify(payload), time],
  );
  return id;
}
let first: string;
test("ordered observations preserve prior versions and cannot be changed or deleted", async () => {
  first = await insert();
  const second = await insert({ version: 2, previous: first });
  expect(
    (await db.query("SELECT version FROM subscription_adjustment_observations ORDER BY version"))
      .rows,
  ).toEqual([{ version: 1 }, { version: 2 }]);
  await expect(
    db.query("UPDATE subscription_adjustment_observations SET observation='{}' WHERE id=$1", [
      first,
    ]),
  ).rejects.toThrow();
  await expect(
    db.query("DELETE FROM subscription_adjustment_observations WHERE id=$1", [second]),
  ).rejects.toThrow();
});
test("stale, skipped and foreign predecessors cannot extend the history", async () => {
  for (const args of [
    { version: 3, previous: first },
    { version: 4, previous: null },
    { version: 3, previous: randomUUID() },
  ])
    await expect(insert(args)).rejects.toThrow();
});
test("foreign ownership, grant digests and missing original evidence are rejected", async () => {
  const head = (
    await db.query<{ id: string }>(
      "SELECT id FROM subscription_adjustment_observations ORDER BY version DESC LIMIT 1",
    )
  ).rows[0]!.id;
  await expect(
    insert({
      version: 3,
      previous: head,
      organization: foreign,
      payload: { ...observation, organizationId: foreign },
    }),
  ).rejects.toThrow();
  for (const key of [
    "grantDigest",
    "invoiceAuthorityDigest",
    "invoiceDetailsDigest",
    "settlementDetailsDigest",
  ])
    await expect(
      insert({ version: 3, previous: head, payload: { ...observation, [key]: "b".repeat(64) } }),
    ).rejects.toThrow();
  await expect(
    insert({
      version: 3,
      previous: head,
      payload: { ...observation, observation: { invoice: { id: "in_foreign" } } },
    }),
  ).rejects.toThrow();
});
test("organization fences and backwards observation times deny appends", async () => {
  const head = (
    await db.query<{ id: string }>(
      "SELECT id FROM subscription_adjustment_observations ORDER BY version DESC LIMIT 1",
    )
  ).rows[0]!.id;
  await expect(
    insert({ version: 3, previous: head, time: new Date("2025-01-01") }),
  ).rejects.toThrow();
  await expect(
    insert({ version: 3, previous: head, time: new Date("2099-01-01") }),
  ).rejects.toThrow();
  await db.query("UPDATE organizations SET paid_work_fenced_at=clock_timestamp() WHERE id=$1", [
    org,
  ]);
  await expect(insert({ version: 3, previous: head })).rejects.toThrow();
  expect(
    (await db.query("SELECT count(*)::int AS count FROM subscription_adjustment_observations"))
      .rows,
  ).toEqual([{ count: 2 }]);
  expect(
    (await db.query("SELECT count(*)::int AS count FROM subscription_allowance_transactions")).rows,
  ).toEqual([{ count: 1 }]);
});

test("attempt identity, terminal receipts and null completion timestamps cannot be rewritten", async () => {
  const id = randomUUID(),
    token = randomUUID();
  await db.query(
    "INSERT INTO subscription_adjustment_scans(grant_id,organization_id,generation) VALUES($1,$2,1)",
    [grant, org],
  );
  await db.query(
    "INSERT INTO subscription_adjustment_attempts(id,grant_id,organization_id,generation,lease_token,original_digest,started_at,expires_at) VALUES($1,$2,$3,1,$4,$5,clock_timestamp(),clock_timestamp()+interval '1 minute')",
    [id, grant, org, token, digest],
  );
  await expect(
    db.query("UPDATE subscription_adjustment_attempts SET lease_token=$1 WHERE id=$2", [
      randomUUID(),
      id,
    ]),
  ).rejects.toThrow();
  await expect(
    db.query(
      "UPDATE subscription_adjustment_attempts SET disposition='failed',reason='provider_unavailable' WHERE id=$1",
      [id],
    ),
  ).rejects.toThrow();
  await expect(
    db.query(
      "UPDATE subscription_adjustment_attempts SET disposition='recorded',observation_id=$1,completed_at=clock_timestamp() WHERE id=$2",
      [first, id],
    ),
  ).rejects.toThrow();
  await db.query(
    "UPDATE subscription_adjustment_attempts SET disposition='failed',reason='provider_unavailable',completed_at=clock_timestamp() WHERE id=$1",
    [id],
  );
  await expect(
    db.query("UPDATE subscription_adjustment_attempts SET reason='changed' WHERE id=$1", [id]),
  ).rejects.toThrow();
  await expect(
    db.query("DELETE FROM subscription_adjustment_attempts WHERE id=$1", [id]),
  ).rejects.toThrow();
  await expect(
    db.query(
      "INSERT INTO subscription_adjustment_attempts(grant_id,organization_id,generation,lease_token,original_digest,started_at,expires_at) VALUES($1,$2,2,$3,$4,clock_timestamp(),clock_timestamp()+interval '1 minute')",
      [grant, foreign, randomUUID(), digest],
    ),
  ).rejects.toThrow();
});
