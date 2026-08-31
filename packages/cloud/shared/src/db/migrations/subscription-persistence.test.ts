/** Applies the subscription authority migration chain to real PGlite. */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  billingFundingAllocations,
  billingFundingReservations,
} from "../schemas/billing-funding-reservations";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
} from "../schemas/billing-subscriptions";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";
import { subscriptionAllowanceTransactions } from "../schemas/subscription-allowance-transactions";

const ORG = "10000000-0000-4000-8000-000000000001";
const SUB = "20000000-0000-4000-8000-000000000001";
const PERIOD = "30000000-0000-4000-8000-000000000001";
const DIGEST = "a".repeat(64);
const migrations = await Promise.all(
  ["0373_subscription_authority.sql", "0374_subscription_funding_transaction_uniqueness.sql"].map(
    (name) => readFile(new URL(name, import.meta.url), "utf8"),
  ),
);
const databases: PGlite[] = [];
setDefaultTimeout(120_000);
async function database(): Promise<PGlite> {
  const db = new PGlite({ extensions: { btree_gist } });
  databases.push(db);
  await db.exec(
    `CREATE TABLE organizations (id uuid PRIMARY KEY); CREATE TABLE users (id uuid PRIMARY KEY); CREATE TABLE credit_transactions (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), CONSTRAINT credit_transactions_id_org_idx UNIQUE (id, organization_id)); INSERT INTO organizations VALUES ('${ORG}');`,
  );
  for (const migration of migrations) {
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await db.exec(statement);
  }
  return db;
}
async function seed(db: PGlite): Promise<void> {
  await db.exec(
    `INSERT INTO billing_subscriptions (id,organization_id,provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,lifecycle_revision,provider_object_digest) VALUES ('${SUB}','${ORG}','test','cus_test1','sub_test1','si_test1','plus_monthly','v1','active','2026-01-01Z','2026-02-01Z',1,'${DIGEST}'); INSERT INTO billing_subscription_revisions (organization_id,subscription_id,revision,source,provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,cancel_at_period_end,provider_object_digest) VALUES ('${ORG}','${SUB}',1,'webhook','test','cus_test1','sub_test1','si_test1','plus_monthly','v1','active','2026-01-01Z','2026-02-01Z',false,'${DIGEST}');`,
  );
}
afterEach(async () => Promise.all(databases.splice(0).map((db) => db.close())));
describe("subscription authority migrations", () => {
  test("matches every authority table's current Drizzle column contract", async () => {
    const db = await database();
    for (const table of [
      billingSubscriptions,
      billingSubscriptionRevisions,
      organizationEntitlements,
      subscriptionAllowancePeriods,
      billingFundingReservations,
      billingFundingAllocations,
      subscriptionAllowanceTransactions,
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
  test("is the journal tail and seeds existing and future free entitlements", async () => {
    const db = await database();
    await db.exec("INSERT INTO organizations VALUES ('10000000-0000-4000-8000-000000000002')");
    const rows = await db.query<{ plan_key: string; entitlement_effective: boolean }>(
      "SELECT plan_key, entitlement_effective FROM organization_entitlements ORDER BY organization_id",
    );
    expect(rows.rows).toEqual([
      { plan_key: "free", entitlement_effective: true },
      { plan_key: "free", entitlement_effective: true },
    ]);
    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", import.meta.url), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 357,
      tag: "0374_subscription_funding_transaction_uniqueness",
    });
  });
  test("tenant-fences revisions and excludes overlapping allowance periods", async () => {
    const db = await database();
    await seed(db);
    await db.exec(
      `INSERT INTO subscription_allowance_periods (id,organization_id,subscription_id,subscription_revision,provider_environment,stripe_invoice_id,plan_key,catalog_version,period_start,period_end,expires_at,granted_amount,available_amount) VALUES ('${PERIOD}','${ORG}','${SUB}',1,'test','in_one','plus_monthly','v1','2026-01-01Z','2026-02-01Z','2026-02-01Z',25,25)`,
    );
    await expect(
      db.exec(
        `INSERT INTO subscription_allowance_periods (organization_id,subscription_id,subscription_revision,provider_environment,stripe_invoice_id,plan_key,catalog_version,period_start,period_end,expires_at,granted_amount,available_amount) VALUES ('${ORG}','${SUB}',1,'test','in_two','plus_monthly','v1','2026-01-15Z','2026-02-15Z','2026-02-15Z',25,25)`,
      ),
    ).rejects.toThrow(/overlap|conflict/i);
    await expect(
      db.exec("UPDATE billing_subscription_revisions SET source='admin'"),
    ).rejects.toThrow(/append-only/i);
    await expect(db.exec("TRUNCATE billing_subscription_revisions CASCADE")).rejects.toThrow(
      /append-only/i,
    );
  });
  test("enforces conservation and append-only allowance history", async () => {
    const db = await database();
    await seed(db);
    await db.exec(
      `INSERT INTO subscription_allowance_periods (id,organization_id,subscription_id,subscription_revision,provider_environment,stripe_invoice_id,plan_key,catalog_version,period_start,period_end,expires_at,granted_amount,available_amount) VALUES ('${PERIOD}','${ORG}','${SUB}',1,'test','in_one','plus_monthly','v1','2026-01-01Z','2026-02-01Z','2026-02-01Z',25,25); INSERT INTO subscription_allowance_transactions (organization_id,allowance_period_id,sequence,kind,amount,available_before,available_after,reserved_before,reserved_after,settled_before,settled_after,expired_before,expired_after,clawed_back_before,clawed_back_after,idempotency_key,request_digest) VALUES ('${ORG}','${PERIOD}',1,'grant',25,0,25,0,0,0,0,0,0,0,0,'grant.one','${DIGEST}')`,
    );
    await expect(
      db.exec("UPDATE subscription_allowance_transactions SET amount=24"),
    ).rejects.toThrow(/append-only/i);
    await expect(
      db.exec(`UPDATE subscription_allowance_periods SET available_amount=24 WHERE id='${PERIOD}'`),
    ).rejects.toThrow(/amounts_check/i);
  });

  test("prevents one settlement or refund ledger movement from funding multiple allocations", async () => {
    const db = await database();
    await db.exec(`
      INSERT INTO credit_transactions (id, organization_id) VALUES
        ('40000000-0000-4000-8000-000000000001','${ORG}'),
        ('40000000-0000-4000-8000-000000000002','${ORG}'),
        ('40000000-0000-4000-8000-000000000003','${ORG}'),
        ('40000000-0000-4000-8000-000000000004','${ORG}'),
        ('40000000-0000-4000-8000-000000000005','${ORG}');
      INSERT INTO billing_funding_reservations
        (id, organization_id, logical_operation_id, request_digest, funding_class,
         requested_amount, reserved_amount, expires_at)
      VALUES
        ('50000000-0000-4000-8000-000000000001','${ORG}','operation.unique.one','${DIGEST}',
         'cash_only',1,1,'2027-01-01Z'),
        ('50000000-0000-4000-8000-000000000002','${ORG}','operation.unique.two','${"b".repeat(64)}',
         'cash_only',1,1,'2027-01-01Z'),
        ('50000000-0000-4000-8000-000000000003','${ORG}','operation.unique.three','${"c".repeat(64)}',
         'cash_only',1,1,'2027-01-01Z');
      INSERT INTO billing_funding_allocations
        (organization_id, reservation_id, sequence, source,
         purchased_credit_reservation_transaction_id,
         purchased_credit_settlement_transaction_id,
         purchased_credit_refund_transaction_id, reserved_amount)
      VALUES
        ('${ORG}','50000000-0000-4000-8000-000000000001',1,'purchased_credit',
         '40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000003',
         '40000000-0000-4000-8000-000000000004',1);
    `);
    await expect(
      db.exec(`INSERT INTO billing_funding_allocations
        (organization_id, reservation_id, sequence, source,
         purchased_credit_reservation_transaction_id,
         purchased_credit_settlement_transaction_id, reserved_amount)
        VALUES ('${ORG}','50000000-0000-4000-8000-000000000002',1,'purchased_credit',
          '40000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000003',1)`),
    ).rejects.toThrow(/billing_funding_allocations_credit_settle_idx/);
    await expect(
      db.exec(`INSERT INTO billing_funding_allocations
        (organization_id, reservation_id, sequence, source,
         purchased_credit_reservation_transaction_id,
         purchased_credit_refund_transaction_id, reserved_amount)
        VALUES ('${ORG}','50000000-0000-4000-8000-000000000003',1,'purchased_credit',
          '40000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000004',1)`),
    ).rejects.toThrow(/billing_funding_allocations_credit_refund_idx/);
  });

  test("keeps subscription history append-only except inside account erasure authority", async () => {
    const db = await database();
    await seed(db);
    await expect(db.exec("DELETE FROM billing_subscription_revisions")).rejects.toThrow(
      /append-only/,
    );
    await db.exec(`
      BEGIN;
      SELECT set_config('eliza.subscription_account_deletion_authority', 'on', true);
      DELETE FROM organization_entitlements WHERE organization_id='${ORG}';
      DELETE FROM billing_subscription_revisions WHERE organization_id='${ORG}';
      DELETE FROM billing_subscriptions WHERE organization_id='${ORG}';
      DELETE FROM organizations WHERE id='${ORG}';
      COMMIT;
    `);
    const remaining = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM organizations WHERE id='${ORG}'`,
    );
    expect(remaining.rows).toEqual([{ count: "0" }]);
  });
});
