/** Exercises the real cancellation-result migration against historical checkout rows and adversarial cross-source publication writes. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { installOrganizationPolicyTestSchema } from "./organization-policy-test-fixture";

const db = new PGlite({ extensions: { btree_gist } });
const org = randomUUID();
const otherOrg = randomUUID();
const actor = randomUUID();
const source = randomUUID();
const replacement = randomUUID();
const foreignSource = randomUUID();
const historicalCheckout = randomUUID();
const digest = "a".repeat(64);
let historicalRows: Record<string, unknown>[];

beforeAll(async () => {
  await db.exec(
    "CREATE TABLE organizations(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY);",
  );
  await installOrganizationPolicyTestSchema((query) => db.exec(query));
  await db.query("INSERT INTO organizations(id) VALUES($1),($2)", [org, otherOrg]);
  await db.query("INSERT INTO users(id) VALUES($1)", [actor]);
  for (const [id, organization] of [
    [source, org],
    [replacement, org],
    [foreignSource, otherOrg],
  ]) {
    const suffix = id.replaceAll("-", "");
    await db.query(
      `INSERT INTO billing_subscriptions(id,organization_id,provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,lifecycle_revision,provider_object_digest,cancel_at_period_end)
      VALUES($1,$2,'test',$3,$4,$5,'plus_monthly','v1',$7,now(),now()+interval '1 month',2,$6,true)`,
      [
        id,
        organization,
        `cus_${suffix}`,
        `sub_${suffix}`,
        `si_${suffix}`,
        digest,
        id === replacement ? "canceled" : "active",
      ],
    );
    for (const revision of [1, 2])
      await db.query(
        `INSERT INTO billing_subscription_revisions(organization_id,subscription_id,revision,source,provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,cancel_at_period_end,provider_object_digest)
      SELECT organization_id,id,$2::bigint,'reconciliation',provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,($2::bigint=2),provider_object_digest FROM billing_subscriptions WHERE id=$1`,
        [id, revision],
      );
  }
  await db.query(
    `INSERT INTO billing_subscription_commands(id,organization_id,requested_by_user_id,kind,target_plan_key,idempotency_key,provider_idempotency_key,request_digest,status,execution_generation,provider_started_at,provider_response_digest,completed_at,result_subscription_id,applied_at)
    VALUES($1,$2,$3,'checkout','plus_monthly','legacy-checkout-key','legacy-provider-key',$4,'APPLIED',1,now(),$4,now(),$5,now())`,
    [historicalCheckout, org, actor, digest, source],
  );
  historicalRows = (
    await db.query<Record<string, unknown>>(
      "SELECT * FROM billing_subscription_commands WHERE id=$1",
      [historicalCheckout],
    )
  ).rows;
  const migration = await readFile(
    new URL("../migrations/0383_subscription_cancellation_result.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint"))
    if (statement.trim()) await db.exec(statement);
}, 120_000);
afterAll(async () => {
  await db.close();
});

async function command() {
  const id = randomUUID();
  await db.query(
    `INSERT INTO billing_subscription_commands(id,organization_id,subscription_id,requested_by_user_id,kind,expected_subscription_revision,idempotency_key,provider_idempotency_key,request_digest,status,execution_generation,provider_started_at)
    VALUES($1,$2,$3,$4,'cancel',1,$5,$6,$7,'OUTCOME_UNKNOWN',1,now())`,
    [id, org, source, actor, `cancel:${id}`, `provider:${id}`, digest],
  );
  return id;
}
async function apply(id: string, resultSource: string | null, revision: number | null) {
  return db.query(
    `UPDATE billing_subscription_commands SET status='APPLIED',provider_response_digest=$2,completed_at=now(),applied_at=now(),result_subscription_id=$3,result_subscription_revision=$4 WHERE id=$1`,
    [id, digest, resultSource, revision],
  );
}

test("migration retains historical applied checkout without fabricating a result revision", async () => {
  expect(
    (
      await db.query("SELECT * FROM billing_subscription_commands WHERE id=$1", [
        historicalCheckout,
      ])
    ).rows,
  ).toEqual(
    historicalRows.map((row) => ({
      ...row,
      result_subscription_revision: null,
      cancellation_dispatch_state: null,
    })),
  );
});
test("cancel result identifies its immutable source revision and prevents its removal", async () => {
  const id = await command();
  await apply(id, source, 2);
  expect(
    (
      await db.query(
        "SELECT status,result_subscription_id,result_subscription_revision FROM billing_subscription_commands WHERE id=$1",
        [id],
      )
    ).rows,
  ).toEqual([
    { status: "APPLIED", result_subscription_id: source, result_subscription_revision: 2 },
  ]);
  await expect(
    db.query("DELETE FROM billing_subscriptions WHERE id=$1", [source]),
  ).rejects.toThrow();
  expect(
    (
      await db.query(
        "SELECT result_subscription_revision FROM billing_subscription_commands WHERE id=$1",
        [id],
      )
    ).rows,
  ).toEqual([{ result_subscription_revision: 2 }]);
});
test.each([
  [null, 2],
  [source, null],
  [source, 0],
  [source, 9],
  [replacement, 1],
  [foreignSource, 1],
] as const)(
  "invalid cancellation source/revision cannot become applied: %s/%s",
  async (resultSource, revision) => {
    const id = await command();
    await expect(apply(id, resultSource, revision)).rejects.toThrow();
    expect(
      (
        await db.query(
          "SELECT status,result_subscription_id,result_subscription_revision FROM billing_subscription_commands WHERE id=$1",
          [id],
        )
      ).rows,
    ).toEqual([
      {
        status: "OUTCOME_UNKNOWN",
        result_subscription_id: null,
        result_subscription_revision: null,
      },
    ]);
  },
);
test("an unresolved command cannot claim a result revision", async () => {
  const id = await command();
  await expect(
    db.query(
      "UPDATE billing_subscription_commands SET result_subscription_revision=1 WHERE id=$1",
      [id],
    ),
  ).rejects.toThrow();
});
test("late workers cannot rewrite applied cancellation result or response provenance", async () => {
  const id = await command();
  await apply(id, source, 1);
  const before = (await db.query("SELECT * FROM billing_subscription_commands WHERE id=$1", [id]))
    .rows;
  await expect(
    db.query(
      "UPDATE billing_subscription_commands SET result_subscription_revision=2 WHERE id=$1",
      [id],
    ),
  ).rejects.toThrow();
  await expect(
    db.query("UPDATE billing_subscription_commands SET provider_response_digest=$2 WHERE id=$1", [
      id,
      "b".repeat(64),
    ]),
  ).rejects.toThrow();
  await expect(
    db.query("UPDATE billing_subscription_commands SET execution_generation=2 WHERE id=$1", [id]),
  ).rejects.toThrow();
  expect(
    (await db.query("SELECT * FROM billing_subscription_commands WHERE id=$1", [id])).rows,
  ).toEqual(before);
});

test("historical unknown dispatch provenance cannot be upgraded into ready authority", async () => {
  const id = await command();
  await expect(
    db.query(
      "UPDATE billing_subscription_commands SET cancellation_dispatch_state='ready' WHERE id=$1",
      [id],
    ),
  ).rejects.toThrow();
  expect(
    (
      await db.query(
        "SELECT cancellation_dispatch_state FROM billing_subscription_commands WHERE id=$1",
        [id],
      )
    ).rows,
  ).toEqual([{ cancellation_dispatch_state: null }]);
});
