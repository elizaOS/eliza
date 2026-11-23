import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readDatabaseIdentityReceipt } from "./database-identity-receipt";
import { repairUnusedProductionTestGrant } from "./production-test-grant-admission";

const database = new PGlite();
const run = "43992407253";
const id = "11111111-1111-4111-8111-111111111111";
// PGlite has no cluster control file. Only identity discovery is substituted;
// the production selection, row lock, UPDATE, transaction and rollback run as SQL.
const client = {
  query: async (sql: string): Promise<{ rows: unknown[] }> =>
    sql.includes("pg_catalog.pg_control_system()")
      ? {
          rows: [
            {
              system_identifier: "1234567",
              database_name: "test",
              role_name: "test",
              server_version_num: "180000",
            },
          ],
        }
      : database.query(sql),
};
const oldEnvironment = { ...process.env };
beforeAll(async () => {
  await database.exec(`CREATE TABLE subscription_grant_codes (
    id uuid PRIMARY KEY, family text, plan_key text DEFAULT 'plus_monthly',
    catalog_version text DEFAULT 'v1', duration_days integer, duration_months integer,
    requires_no_paid_plan boolean DEFAULT true, max_redemptions integer DEFAULT 1,
    redeemed_count integer DEFAULT 0, disabled_at timestamptz,
    expires_at timestamptz DEFAULT now() + interval '1 day', label text);
    CREATE TABLE subscription_grants (code_id uuid);`);
  const identity = await readDatabaseIdentityReceipt(client, "production");
  process.env.ELIZA_OPERATOR_ENVIRONMENT = "production";
  process.env.GITHUB_REF = "refs/heads/main";
  process.env.DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256 =
    identity.clusterSha256;
  process.env.DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256 =
    identity.authoritySha256;
});
afterAll(async () => {
  process.env = oldEnvironment;
  await database.close();
});

async function seed(days = 7, changes = "") {
  await database.exec("TRUNCATE subscription_grants, subscription_grant_codes");
  await database.query(
    `INSERT INTO subscription_grant_codes(id,family,duration_days,label)
    VALUES ($1,'production_qa',$2,$3)`,
    [id, days, `production-test-${run}`],
  );
  if (changes) await database.exec(changes);
}
async function row() {
  return (await database.query("SELECT * FROM subscription_grant_codes"))
    .rows[0];
}

test("repair preserves the existing seven-day grant and replays without minting", async () => {
  await seed();
  const before = await row();
  expect(await repairUnusedProductionTestGrant(client, run)).toEqual({
    codeId: id,
    family: `production_qa_${run}`,
    replayed: false,
    minted: 0,
  });
  expect(await row()).toEqual({ ...before, family: `production_qa_${run}` });
  expect(await repairUnusedProductionTestGrant(client, run)).toEqual({
    codeId: id,
    family: `production_qa_${run}`,
    replayed: true,
    minted: 0,
  });
  expect(
    (await database.query("SELECT * FROM subscription_grants")).rows,
  ).toHaveLength(0);
});
for (const days of [1, 31])
  test(`repair admits original bounded term ${days}`, async () => {
    await seed(days);
    const before = await row();
    await repairUnusedProductionTestGrant(client, run);
    expect(await row()).toEqual({ ...before, family: `production_qa_${run}` });
  });
for (const [name, changes] of [
  ["zero term", "UPDATE subscription_grant_codes SET duration_days=0"],
  ["overlong term", "UPDATE subscription_grant_codes SET duration_days=32"],
  ["unbounded term", "UPDATE subscription_grant_codes SET duration_days=NULL"],
  ["calendar term", "UPDATE subscription_grant_codes SET duration_months=1"],
  ["used code", "UPDATE subscription_grant_codes SET redeemed_count=1"],
  ["existing grant", `INSERT INTO subscription_grants VALUES ('${id}')`],
  ["disabled code", "UPDATE subscription_grant_codes SET disabled_at=now()"],
  [
    "expired code",
    "UPDATE subscription_grant_codes SET expires_at=now()-interval '1 second'",
  ],
  ["wrong label", "UPDATE subscription_grant_codes SET label='another-run'"],
  [
    "foreign family",
    "UPDATE subscription_grant_codes SET family='customer_campaign'",
  ],
  ["multiple uses", "UPDATE subscription_grant_codes SET max_redemptions=2"],
  [
    "paid plan allowed",
    "UPDATE subscription_grant_codes SET requires_no_paid_plan=false",
  ],
  ["wrong plan", "UPDATE subscription_grant_codes SET plan_key='pro_monthly'"],
  ["wrong catalog", "UPDATE subscription_grant_codes SET catalog_version='v2'"],
] as const)
  test(`repair refuses ${name} without changing the code`, async () => {
    await seed(7, changes);
    const before = await row();
    await expect(repairUnusedProductionTestGrant(client, run)).rejects.toThrow(
      "production_grant_unused_code_required",
    );
    expect(await row()).toEqual(before);
  });
test("repair refuses a different database authority", async () => {
  await seed();
  const before = await row();
  const authority = process.env.DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256;
  process.env.DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256 = "0".repeat(64);
  try {
    await expect(repairUnusedProductionTestGrant(client, run)).rejects.toThrow(
      "production_grant_identity_mismatch",
    );
  } finally {
    process.env.DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256 = authority;
  }
  expect(await row()).toEqual(before);
});
