/** Replays the actual undo migration over historical resume intent without inventing result or dispatch provenance. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { installOrganizationPolicyTestSchema } from "./organization-policy-test-fixture";

test("historical unresolved resume survives0384 and cannot become authoritative by null result or inferred ready", async () => {
  const db = new PGlite({ extensions: { btree_gist } });
  try {
    await db.exec(
      "CREATE TABLE organizations(id uuid PRIMARY KEY);CREATE TABLE users(id uuid PRIMARY KEY);",
    );
    await installOrganizationPolicyTestSchema((q) => db.exec(q));
    const migrate = async (name: string) => {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      for (const statement of sql.split("--> statement-breakpoint"))
        if (statement.trim()) await db.exec(statement);
    };
    await migrate("0383_subscription_cancellation_result.sql");
    const org = crypto.randomUUID(),
      user = crypto.randomUUID(),
      id = crypto.randomUUID();
    await db.query("INSERT INTO organizations(id) VALUES($1)", [org]);
    await db.query("INSERT INTO users(id) VALUES($1)", [user]);
    const sub = crypto.randomUUID();
    await db.query(
      `INSERT INTO billing_subscriptions(id,organization_id,provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,provider_object_digest,current_period_start,current_period_end,lifecycle_revision)
      VALUES($1,$2,'test','cus_oldresume','sub_oldresume','si_oldresume','plus_monthly','v1','active',$3,now(),now()+interval '1 month',1)`,
      [sub, org, "a".repeat(64)],
    );
    await db.query(
      `INSERT INTO billing_subscription_commands(id,organization_id,requested_by_user_id,kind,subscription_id,expected_subscription_revision,idempotency_key,provider_idempotency_key,request_digest,status,execution_generation,provider_started_at) VALUES($1,$2,$3,'resume',$5,1,'old-resume','old-provider-resume',$4,'OUTCOME_UNKNOWN',1,now())`,
      [id, org, user, "a".repeat(64), sub],
    );
    const before = (
      await db.query<Record<string, unknown>>(
        "SELECT * FROM billing_subscription_commands WHERE id=$1",
        [id],
      )
    ).rows[0]!;
    await migrate("0384_subscription_cancellation_undo.sql");
    expect(
      (await db.query("SELECT * FROM billing_subscription_commands WHERE id=$1", [id])).rows,
    ).toEqual([{ ...before, schedule_predecessor_command_id: null }]);
    await expect(
      db.query(
        "UPDATE billing_subscription_commands SET cancellation_dispatch_state='ready' WHERE id=$1",
        [id],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "UPDATE billing_subscription_commands SET status='APPLIED',completed_at=now(),applied_at=now(),provider_response_digest=$2 WHERE id=$1",
        [id, "b".repeat(64)],
      ),
    ).rejects.toThrow();
    expect(
      (
        await db.query(
          "SELECT status,cancellation_dispatch_state,result_subscription_revision FROM billing_subscription_commands WHERE id=$1",
          [id],
        )
      ).rows,
    ).toEqual([
      {
        status: "OUTCOME_UNKNOWN",
        cancellation_dispatch_state: null,
        result_subscription_revision: null,
      },
    ]);
  } finally {
    await db.close();
  }
}, 120000);
