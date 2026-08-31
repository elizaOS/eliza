/** Exercises durable command, deletion-fence, and provider-event migration invariants. */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  billingSubscriptionCommands,
  billingSubscriptionEventReceipts,
  billingSubscriptionIncidents,
  subscriptionBillingFences,
} from "../schemas/subscription-billing-operations";

const ORG = "10000000-0000-4000-8000-000000000001",
  OTHER = "10000000-0000-4000-8000-000000000002",
  USER = "11000000-0000-4000-8000-000000000001",
  SUB = "20000000-0000-4000-8000-000000000001",
  DIGEST = "a".repeat(64);
const migration = await readFile(
  new URL("0373_subscription_authority.sql", import.meta.url),
  "utf8",
);
const databases: PGlite[] = [];
setDefaultTimeout(120_000);
async function database(): Promise<PGlite> {
  const db = new PGlite({ extensions: { btree_gist } });
  databases.push(db);
  await db.exec(
    `CREATE TABLE organizations (id uuid PRIMARY KEY); CREATE TABLE users (id uuid PRIMARY KEY); CREATE TABLE credit_transactions (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), CONSTRAINT credit_transactions_id_org_idx UNIQUE (id,organization_id)); INSERT INTO organizations VALUES ('${ORG}'),('${OTHER}'); INSERT INTO users VALUES ('${USER}');`,
  );
  for (const statement of migration.split("--> statement-breakpoint"))
    if (statement.trim()) await db.exec(statement);
  await db.exec(
    `INSERT INTO billing_subscriptions (id,organization_id,provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,lifecycle_revision,provider_object_digest) VALUES ('${SUB}','${ORG}','test','cus_one','sub_one','si_one','plus_monthly','v1','active','2026-01-01Z','2026-02-01Z',1,'${DIGEST}')`,
  );
  return db;
}
afterEach(async () => Promise.all(databases.splice(0).map((db) => db.close())));
describe("0370 subscription operations", () => {
  test("matches every operation table's current Drizzle column contract", async () => {
    const db = await database();
    for (const table of [
      billingSubscriptionCommands,
      subscriptionBillingFences,
      billingSubscriptionEventReceipts,
      billingSubscriptionIncidents,
    ]) {
      const config = getTableConfig(table);
      const columns = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='${config.name}' ORDER BY ordinal_position`,
      );
      expect(columns.rows.map(({ column_name }) => column_name)).toEqual(
        config.columns.map(({ name }) => name),
      );
    }
  });
  test("rejects cross-tenant commands and immutable retry intent", async () => {
    const db = await database();
    await expect(
      db.exec(
        `INSERT INTO billing_subscription_commands (organization_id,subscription_id,requested_by_user_id,kind,expected_subscription_revision,idempotency_key,provider_idempotency_key,request_digest) VALUES ('${OTHER}','${SUB}','${USER}','cancel',1,'command.cross','provider.cross','${DIGEST}')`,
      ),
    ).rejects.toThrow(/foreign key/i);
    await db.exec(
      `INSERT INTO billing_subscription_commands (organization_id,subscription_id,requested_by_user_id,kind,target_plan_key,expected_subscription_revision,idempotency_key,provider_idempotency_key,request_digest) VALUES ('${ORG}','${SUB}','${USER}','upgrade','pro_monthly',1,'command.one','provider.one','${DIGEST}')`,
    );
    await expect(
      db.exec("UPDATE billing_subscription_commands SET target_plan_key='plus_monthly'"),
    ).rejects.toThrow(/immutable/i);
    await db.exec(
      `INSERT INTO billing_subscription_commands (organization_id,requested_by_user_id,kind,target_plan_key,idempotency_key,provider_idempotency_key,request_digest) VALUES ('${ORG}','${USER}','checkout','plus_monthly','checkout.one','provider.checkout.one','${DIGEST}')`,
    );
    await expect(
      db.exec(
        `INSERT INTO billing_subscription_commands (organization_id,requested_by_user_id,kind,idempotency_key,provider_idempotency_key,request_digest) VALUES ('${ORG}','${USER}','checkout','checkout.bad','provider.checkout.bad','${DIGEST}')`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });
  test("requires monotonic fences and immutable webhook identity", async () => {
    const db = await database();
    await db.exec(
      `INSERT INTO subscription_billing_fences (organization_id,subscription_id,provider_object_digest) VALUES ('${ORG}','${SUB}','${DIGEST}')`,
    );
    await expect(
      db.exec(
        "UPDATE subscription_billing_fences SET state='deletion_requested',deletion_requested_at=now()",
      ),
    ).rejects.toThrow(/monotonically/i);
    await db.exec(
      `INSERT INTO billing_subscription_event_receipts (organization_id,subscription_id,provider_event_id,event_type,provider_object_type,provider_object_id,livemode,event_created_at,payload_digest) VALUES ('${ORG}','${SUB}','evt_one','invoice.paid','invoice','in_one',false,'2026-01-02Z','${DIGEST}')`,
    );
    await expect(
      db.exec(`UPDATE billing_subscription_event_receipts SET payload_digest='${"b".repeat(64)}'`),
    ).rejects.toThrow(/immutable/i);
  });
});
