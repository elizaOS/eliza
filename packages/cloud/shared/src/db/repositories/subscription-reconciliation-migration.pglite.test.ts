/** Exercises reconciliation receipt constraints through the actual migration and primary SQL, including immutable provenance, tenant binding and erasure. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { installCancellationTestSchema } from "./subscription-cancellation-test-fixture";

const db = new PGlite({ extensions: { btree_gist } });
const org = randomUUID(),
  source = randomUUID(),
  foreignOrg = randomUUID(),
  foreignSource = randomUUID();
const digest = "a".repeat(64);
let generation = 0;
beforeAll(async () => {
  await installCancellationTestSchema((query) => db.exec(query));
  const migration = await readFile(
    new URL("../migrations/0385_subscription_reconciliation.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint"))
    if (statement.trim()) await db.exec(statement);
  for (const [organizationId, subscriptionId] of [
    [org, source],
    [foreignOrg, foreignSource],
  ]) {
    await db.query("INSERT INTO organizations(id) VALUES($1)", [organizationId]);
    await db.query(
      `INSERT INTO billing_subscriptions(id,organization_id,provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,lifecycle_revision,provider_object_digest) VALUES($1,$2,'test',$3,$4,$5,'plus_monthly','v1','active',now(),now()+interval '1 month',3,$6)`,
      [
        subscriptionId,
        organizationId,
        `cus_${subscriptionId.replaceAll("-", "")}`,
        `sub_${subscriptionId.replaceAll("-", "")}`,
        `si_${subscriptionId.replaceAll("-", "")}`,
        digest,
      ],
    );
    for (const revision of [1, 2, 3])
      await db.query(
        `INSERT INTO billing_subscription_revisions(organization_id,subscription_id,revision,source,provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,cancel_at_period_end,provider_object_digest) SELECT organization_id,id,$2,'reconciliation',provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,false,provider_object_digest FROM billing_subscriptions WHERE id=$1`,
        [subscriptionId, revision],
      );
  }
}, 120_000);
afterAll(() => db.close());
async function attempt() {
  const id = randomUUID();
  await db.query(
    `INSERT INTO subscription_reconciliation_attempts(id,organization_id,subscription_id,generation,expected_revision,expected_projection_revision,identity_digest,lease_token,expires_at) VALUES($1,$2,$3,$4,1,1,$5,$6,now()+interval '1 minute')`,
    [id, org, source, ++generation, digest, randomUUID()],
  );
  return id;
}
test("processing identity cannot be repointed before completion", async () => {
  const id = await attempt();
  await expect(
    db.query("UPDATE subscription_reconciliation_attempts SET expected_revision=2 WHERE id=$1", [
      id,
    ]),
  ).rejects.toThrow();
  await expect(
    db.query(
      "UPDATE subscription_reconciliation_attempts SET lease_token=gen_random_uuid() WHERE id=$1",
      [id],
    ),
  ).rejects.toThrow();
  expect(
    (
      await db.query<{ expected_revision: number }>(
        "SELECT expected_revision FROM subscription_reconciliation_attempts WHERE id=$1",
        [id],
      )
    ).rows[0].expected_revision,
  ).toBe(1);
});
test("applied publication requires a complete contiguous result and immutable outcome", async () => {
  const id = await attempt();
  for (const [result, observed] of [
    [null, null],
    [2, null],
    [3, 3],
  ])
    await expect(
      db.query(
        `UPDATE subscription_reconciliation_attempts SET disposition='applied',completed_at=clock_timestamp(),observation_digest=$2,result_revision=$3,observed_revision=$4 WHERE id=$1`,
        [id, digest, result, observed],
      ),
    ).rejects.toThrow();
  await db.query(
    `UPDATE subscription_reconciliation_attempts SET disposition='applied',completed_at=clock_timestamp(),observation_digest=$2,result_revision=2,observed_revision=2 WHERE id=$1`,
    [id, digest],
  );
  await expect(
    db.query("UPDATE subscription_reconciliation_attempts SET observation_digest=$2 WHERE id=$1", [
      id,
      "b".repeat(64),
    ]),
  ).rejects.toThrow();
  const duplicate = await attempt();
  await expect(
    db.query(
      `UPDATE subscription_reconciliation_attempts SET disposition='applied',completed_at=clock_timestamp(),observation_digest=$2,result_revision=2,observed_revision=2 WHERE id=$1`,
      [duplicate, digest],
    ),
  ).rejects.toThrow();
});
test("no-change receipts bind a real revision and can repeat without competing publication", async () => {
  for (let n = 0; n < 2; n++) {
    const id = await attempt();
    await expect(
      db.query(
        `UPDATE subscription_reconciliation_attempts SET disposition='no_change',completed_at=clock_timestamp(),observation_digest=$2,observed_revision=99 WHERE id=$1`,
        [id, digest],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `UPDATE subscription_reconciliation_attempts SET disposition='no_change',completed_at=started_at-interval '1 second',observation_digest=$2,observed_revision=1 WHERE id=$1`,
        [id, digest],
      ),
    ).rejects.toThrow();
    await db.query(
      `UPDATE subscription_reconciliation_attempts SET disposition='no_change',completed_at=clock_timestamp(),observation_digest=$2,observed_revision=1 WHERE id=$1`,
      [id, digest],
    );
  }
  expect(
    (
      await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM subscription_reconciliation_attempts WHERE disposition='no_change'",
      )
    ).rows[0].count,
  ).toBe(2);
});
test("source identity cannot cross tenants and erasure removes its receipt chain only", async () => {
  await expect(
    db.query(
      `INSERT INTO subscription_reconciliation_attempts(organization_id,subscription_id,generation,expected_revision,identity_digest,lease_token,expires_at) VALUES($1,$2,1,1,$3,gen_random_uuid(),now()+interval '1 minute')`,
      [foreignOrg, source, digest],
    ),
  ).rejects.toThrow();
  await db.query(
    "INSERT INTO subscription_reconciliation_scans(organization_id,subscription_id) VALUES($1,$2)",
    [org, source],
  );
  await db.exec(
    "BEGIN; SELECT set_config('eliza.subscription_account_deletion_authority', 'on', true)",
  );
  await db.query("DELETE FROM billing_subscription_revisions WHERE subscription_id=$1", [source]);
  await db.query("DELETE FROM billing_subscriptions WHERE id=$1", [source]);
  await db.exec("COMMIT");
  expect(
    (
      await db.query(
        "SELECT * FROM subscription_reconciliation_attempts WHERE organization_id=$1",
        [org],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await db.query("SELECT * FROM subscription_reconciliation_scans WHERE organization_id=$1", [
        org,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (await db.query("SELECT id FROM billing_subscriptions WHERE id=$1", [foreignSource])).rows,
  ).toHaveLength(1);
});
