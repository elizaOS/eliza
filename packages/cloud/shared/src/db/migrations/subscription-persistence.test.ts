/** Applies subscription persistence migrations to real PGlite and proves their durable invariants. */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { getTableConfig } from "drizzle-orm/pg-core";
import { billingFundingReservations } from "../schemas/billing-funding-reservations";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
} from "../schemas/billing-subscriptions";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";
import { subscriptionAllowanceTransactions } from "../schemas/subscription-allowance-transactions";

const ORG = "10000000-0000-4000-8000-000000000001";
const NEW_ORG = "10000000-0000-4000-8000-000000000002";
const SUBSCRIPTION = "20000000-0000-4000-8000-000000000001";
const PERIOD = "30000000-0000-4000-8000-000000000001";
const FREE_PREIMAGE = "free:v1:60:100:30:5:5:5:1:5:25";
const FREE_DIGEST = "79e8741542b6d430565b42253cb5afe09619c8e5764c545d4d19cab68fd1304b";
const migrationNames = [
  "0275_subscription_lifecycle_authority.sql",
  "0276_organization_entitlement_projection.sql",
  "0277_subscription_allowance_periods.sql",
  "0278_billing_funding_reservations.sql",
  "0279_subscription_allowance_transactions.sql",
  "0280_subscription_funding_reservation_phases.sql",
  "0281_organization_spendable_revision.sql",
  "0282_subscription_allowance_effective_expiry.sql",
] as const;
const migrations = await Promise.all(
  migrationNames.map((name) => readFile(new URL(name, import.meta.url), "utf8")),
);
const databases: PGlite[] = [];

setDefaultTimeout(120_000);
const authorityTables = [
  billingSubscriptions,
  billingSubscriptionRevisions,
  organizationEntitlements,
  subscriptionAllowancePeriods,
  billingFundingReservations,
  subscriptionAllowanceTransactions,
] as const;

async function database(): Promise<PGlite> {
  const db = new PGlite({ extensions: { btree_gist } });
  databases.push(db);
  await db.exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      credit_balance numeric(16,6) NOT NULL DEFAULT 0.000000
    );
    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      CONSTRAINT credit_transactions_id_org_idx UNIQUE (id, organization_id)
    );
    INSERT INTO organizations (id, credit_balance) VALUES ('${ORG}', 42.000000);
  `);
  for (const migration of migrations) {
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.exec(statement);
    }
  }
  return db;
}

async function seedSubscription(db: PGlite): Promise<void> {
  await db.exec(`
    INSERT INTO billing_subscriptions (
      id, organization_id, stripe_subscription_id, stripe_subscription_item_id,
      plan_key, catalog_version, status, current_period_start, current_period_end,
      lifecycle_revision, provider_object_version, provider_object_digest
    ) VALUES (
      '${SUBSCRIPTION}', '${ORG}', 'sub_test1', 'si_test1', 'plus_monthly', 'v1', 'active',
      '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 1, 1, '${"a".repeat(64)}'
    );
    INSERT INTO billing_subscription_revisions (
      organization_id, subscription_id, revision, source,
      stripe_subscription_id, stripe_subscription_item_id, plan_key, catalog_version, status,
      current_period_start, current_period_end, cancel_at_period_end,
      provider_object_version, provider_object_digest
    ) VALUES (
      '${ORG}', '${SUBSCRIPTION}', 1, 'webhook', 'sub_test1', 'si_test1',
      'plus_monthly', 'v1', 'active', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z',
      false, 1, '${"a".repeat(64)}'
    );
  `);
}

async function seedPeriod(db: PGlite): Promise<void> {
  await seedSubscription(db);
  await db.exec(`
    INSERT INTO subscription_allowance_periods (
      id, organization_id, subscription_id, subscription_revision, stripe_invoice_id,
      plan_key, catalog_version, period_start, period_end, expires_at,
      granted_amount, remaining_amount
    ) VALUES (
      '${PERIOD}', '${ORG}', '${SUBSCRIPTION}', 1, 'in_invoice1', 'plus_monthly', 'v1',
      '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z',
      25.000000, 25.000000
    );
  `);
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0275-0282 subscription persistence migrations", () => {
  test("apply in journal order with every authority table present", async () => {
    const db = await database();
    const tables = await db.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'billing_subscriptions', 'billing_subscription_revisions',
        'organization_entitlements', 'subscription_allowance_periods',
        'billing_funding_reservations', 'subscription_allowance_transactions'
      ) ORDER BY table_name
    `);
    expect(tables.rows).toHaveLength(6);
    for (const table of authorityTables) {
      const config = getTableConfig(table);
      const columns = await db.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${config.name}'
        ORDER BY ordinal_position
      `);
      expect(columns.rows.map(({ column_name }) => column_name)).toEqual(
        config.columns.map(({ name }) => name),
      );
    }
    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", import.meta.url), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(
      journal.entries
        .filter(({ idx }) => idx >= 269 && idx < 269 + migrationNames.length)
        .map(({ idx, tag }) => ({ idx, tag })),
    ).toEqual(
      migrationNames.map((name, offset) => ({ idx: 269 + offset, tag: name.slice(0, -4) })),
    );
  });

  test("backfills and seeds the exact free entitlement projection", async () => {
    const db = await database();
    expect(createHash("sha256").update(FREE_PREIMAGE).digest("hex")).toBe(FREE_DIGEST);
    await db.exec(`INSERT INTO organizations (id, credit_balance) VALUES ('${NEW_ORG}', 7)`);
    const rows = await db.query<{
      organization_id: string;
      limits: string;
      source_digest: string;
    }>(`
      SELECT organization_id,
        concat_ws(':', completions_rpm, embeddings_rpm, standard_rpm, strict_rpm,
          cloud_characters_ceiling, agent_sandboxes_ceiling, containers_ceiling,
          storage_gib_ceiling, apps_ceiling) AS limits,
        source_digest
      FROM organization_entitlements ORDER BY organization_id
    `);
    expect(rows.rows).toEqual([
      { organization_id: ORG, limits: "60:100:30:5:5:5:1:5:25", source_digest: FREE_DIGEST },
      {
        organization_id: NEW_ORG,
        limits: "60:100:30:5:5:5:1:5:25",
        source_digest: FREE_DIGEST,
      },
    ]);
    await db.exec(`DELETE FROM organizations WHERE id = '${NEW_ORG}'`);
    const deletedProjection = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM organization_entitlements WHERE organization_id = '${NEW_ORG}'`,
    );
    expect(deletedProjection.rows).toEqual([{ count: 0 }]);
  });

  test("rejects overlapping periods while accepting adjacent billing periods", async () => {
    const db = await database();
    await seedPeriod(db);
    await expect(
      db.exec(`INSERT INTO subscription_allowance_periods (
        organization_id, subscription_id, subscription_revision, stripe_invoice_id,
        plan_key, catalog_version, period_start, period_end, expires_at,
        granted_amount, remaining_amount
      ) VALUES ('${ORG}', '${SUBSCRIPTION}', 1, 'in_overlap', 'plus_monthly', 'v1',
        '2026-01-15T00:00:00Z', '2026-02-15T00:00:00Z', '2026-02-15T00:00:00Z', 25, 25)`),
    ).rejects.toThrow(/subscription_allowance_periods_no_overlap|conflicting key/i);
    await db.exec(`INSERT INTO subscription_allowance_periods (
      organization_id, subscription_id, subscription_revision, stripe_invoice_id,
      plan_key, catalog_version, period_start, period_end, expires_at,
      granted_amount, remaining_amount
    ) VALUES ('${ORG}', '${SUBSCRIPTION}', 1, 'in_adjacent', 'plus_monthly', 'v1',
      '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z', 25, 25)`);
  });

  test("accepts an early effective expiry but never one beyond the invoice period", async () => {
    const db = await database();
    await seedSubscription(db);
    await db.exec(`INSERT INTO subscription_allowance_periods (
      organization_id, subscription_id, subscription_revision, stripe_invoice_id,
      plan_key, catalog_version, period_start, period_end, expires_at,
      granted_amount, remaining_amount
    ) VALUES ('${ORG}', '${SUBSCRIPTION}', 1, 'in_earlyexpiry', 'plus_monthly', 'v1',
      '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-01-20T00:00:00Z', 25, 25)`);
    await expect(
      db.exec(`INSERT INTO subscription_allowance_periods (
        organization_id, subscription_id, subscription_revision, stripe_invoice_id,
        plan_key, catalog_version, period_start, period_end, expires_at,
        granted_amount, remaining_amount
      ) VALUES ('${ORG}', '${SUBSCRIPTION}', 1, 'in_lateexpiry', 'plus_monthly', 'v1',
        '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z',
        '2026-03-02T00:00:00Z', 25, 25)`),
    ).rejects.toThrow(/subscription_allowance_periods_period_check|check constraint/i);
  });

  test("advances one spendable revision for purchased-credit and allowance mutations", async () => {
    const db = await database();
    const revision = async (): Promise<number> => {
      const result = await db.query<{ revision: number }>(
        `SELECT spendable_revision::int AS revision FROM organizations WHERE id = '${ORG}'`,
      );
      return result.rows[0]!.revision;
    };
    expect(await revision()).toBe(0);
    await db.exec(
      `UPDATE organizations SET credit_balance = credit_balance - 1 WHERE id = '${ORG}'`,
    );
    const afterPurchasedDebit = await revision();
    expect(afterPurchasedDebit).toBeGreaterThan(0);
    await seedPeriod(db);
    const afterAllowanceGrant = await revision();
    expect(afterAllowanceGrant).toBeGreaterThan(afterPurchasedDebit);
    await db.exec(
      `UPDATE subscription_allowance_periods SET remaining_amount = remaining_amount - 1 WHERE id = '${PERIOD}'`,
    );
    expect(await revision()).toBeGreaterThan(afterAllowanceGrant);
  });

  test("enforces a tenant-scoped, contiguous overage reservation chain", async () => {
    const db = await database();
    const OTHER_ORG = "10000000-0000-4000-8000-000000000099";
    const ROOT = "40000000-0000-4000-8000-000000000001";
    const OTHER_ROOT = "40000000-0000-4000-8000-000000000099";
    const OVERAGE_ONE = "40000000-0000-4000-8000-000000000002";
    await db.exec(`
      INSERT INTO organizations (id, credit_balance) VALUES ('${OTHER_ORG}', 10);
      INSERT INTO credit_transactions (id, organization_id) VALUES
        ('50000000-0000-4000-8000-000000000001', '${ORG}'),
        ('50000000-0000-4000-8000-000000000002', '${ORG}'),
        ('50000000-0000-4000-8000-000000000003', '${ORG}'),
        ('50000000-0000-4000-8000-000000000099', '${OTHER_ORG}');
      INSERT INTO billing_funding_reservations (
        id, organization_id, logical_operation_id, funding_class,
        requested_amount, allowance_amount, purchased_credit_amount,
        purchased_credit_reservation_transaction_id, expires_at
      ) VALUES
        ('${ROOT}', '${ORG}', 'operation.root.001', 'cash_only', 1, 0, 1,
          '50000000-0000-4000-8000-000000000001', '2099-01-01T00:00:00Z'),
        ('${OTHER_ROOT}', '${OTHER_ORG}', 'operation.root.099', 'cash_only', 1, 0, 1,
          '50000000-0000-4000-8000-000000000099', '2099-01-01T00:00:00Z');
      INSERT INTO billing_funding_reservations (
        id, organization_id, logical_operation_id, reservation_phase, phase_sequence,
        parent_reservation_id, root_reservation_id, funding_class,
        requested_amount, allowance_amount, purchased_credit_amount,
        purchased_credit_reservation_transaction_id, expires_at
      ) VALUES ('${OVERAGE_ONE}', '${ORG}', 'operation.overage.001', 'overage', 1,
        '${ROOT}', '${ROOT}', 'cash_only', 1, 0, 1,
        '50000000-0000-4000-8000-000000000002', '2099-01-01T00:00:00Z');
    `);
    await expect(
      db.exec(`INSERT INTO billing_funding_reservations (
        organization_id, logical_operation_id, reservation_phase, phase_sequence,
        parent_reservation_id, root_reservation_id, funding_class,
        requested_amount, allowance_amount, purchased_credit_amount,
        purchased_credit_reservation_transaction_id, expires_at
      ) VALUES ('${ORG}', 'operation.overage.cross', 'overage', 2,
        '${OTHER_ROOT}', '${ROOT}', 'cash_only', 1, 0, 1,
        '50000000-0000-4000-8000-000000000003', '2099-01-01T00:00:00Z')`),
    ).rejects.toThrow(/preceding phase|parent_tenant_fk|foreign key/i);
    await expect(
      db.exec(`INSERT INTO billing_funding_reservations (
        organization_id, logical_operation_id, reservation_phase, phase_sequence,
        parent_reservation_id, root_reservation_id, funding_class,
        requested_amount, allowance_amount, purchased_credit_amount,
        purchased_credit_reservation_transaction_id, expires_at
      ) VALUES ('${ORG}', 'operation.overage.skip2', 'overage', 3,
        '${OVERAGE_ONE}', '${ROOT}', 'cash_only', 1, 0, 1,
        '50000000-0000-4000-8000-000000000003', '2099-01-01T00:00:00Z')`),
    ).rejects.toThrow(/preceding phase/i);
  });

  test("keeps lifecycle revisions and allowance transactions append-only", async () => {
    const db = await database();
    await seedPeriod(db);
    await expect(
      db.exec(`UPDATE billing_subscription_revisions SET source = 'admin'`),
    ).rejects.toThrow(/append-only/i);
    await db.exec(`INSERT INTO subscription_allowance_transactions (
      organization_id, allowance_period_id, sequence, kind, amount,
      remaining_before, remaining_after, expired_before, expired_after,
      clawed_back_before, clawed_back_after, idempotency_key
    ) VALUES ('${ORG}', '${PERIOD}', 1, 'grant', 25, 0, 25, 0, 0, 0, 0, 'grant.period.1')`);
    await expect(
      db.exec(`UPDATE subscription_allowance_transactions SET amount = 24`),
    ).rejects.toThrow(/append-only/i);
    await expect(db.exec(`DELETE FROM subscription_allowance_transactions`)).rejects.toThrow(
      /append-only/i,
    );
    await db.exec(`
      UPDATE subscription_allowance_periods SET remaining_amount = 0 WHERE id = '${PERIOD}';
      INSERT INTO subscription_allowance_transactions (
        organization_id, allowance_period_id, sequence, kind, amount,
        remaining_before, remaining_after, expired_before, expired_after,
        clawed_back_before, clawed_back_after, idempotency_key
      ) VALUES ('${ORG}', '${PERIOD}', 2, 'close', 0, 0, 0, 0, 0, 0, 0, 'close.period.1');
      UPDATE subscription_allowance_periods SET state = 'closed' WHERE id = '${PERIOD}';
    `);
    const closed = await db.query<{ state: string }>(
      `SELECT state FROM subscription_allowance_periods WHERE id = '${PERIOD}'`,
    );
    expect(closed.rows).toEqual([{ state: "closed" }]);
  });

  test("records a paid in-period upgrade as an append-only allowance adjustment", async () => {
    const db = await database();
    await seedPeriod(db);
    await db.exec(`
      INSERT INTO billing_subscription_revisions (
        organization_id, subscription_id, revision, source,
        stripe_subscription_id, stripe_subscription_item_id, plan_key, catalog_version, status,
        current_period_start, current_period_end, cancel_at_period_end,
        provider_object_version, provider_object_digest
      ) VALUES (
        '${ORG}', '${SUBSCRIPTION}', 2, 'webhook', 'sub_test1', 'si_test1',
        'pro_monthly', 'v1', 'active', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z',
        false, 2, '${"b".repeat(64)}'
      );
      INSERT INTO subscription_allowance_transactions (
        organization_id, allowance_period_id, sequence, kind, amount,
        source_subscription_id, source_subscription_revision, source_invoice_id,
        source_plan_key, source_catalog_version,
        remaining_before, remaining_after, expired_before, expired_after,
        clawed_back_before, clawed_back_after, idempotency_key
      ) VALUES (
        '${ORG}', '${PERIOD}', 1, 'grant_adjustment', 20,
        '${SUBSCRIPTION}', 2, 'in_upgrade1', 'pro_monthly', 'v1',
        25, 45, 0, 0, 0, 0, 'upgrade.period.1'
      );
      UPDATE subscription_allowance_periods
      SET granted_amount = granted_amount + 20, remaining_amount = remaining_amount + 20
      WHERE id = '${PERIOD}';
    `);
    const adjusted = await db.query<{ granted: string; remaining: string }>(`
      SELECT granted_amount::text AS granted, remaining_amount::text AS remaining
      FROM subscription_allowance_periods WHERE id = '${PERIOD}'
    `);
    expect(adjusted.rows).toEqual([{ granted: "45.000000", remaining: "45.000000" }]);
    await expect(
      db.exec(`INSERT INTO subscription_allowance_transactions (
        organization_id, allowance_period_id, sequence, kind, amount,
        source_subscription_id, source_subscription_revision, source_invoice_id,
        source_plan_key, source_catalog_version,
        remaining_before, remaining_after, expired_before, expired_after,
        clawed_back_before, clawed_back_after, idempotency_key
      ) VALUES ('${ORG}', '${PERIOD}', 2, 'grant_adjustment', 1, '${SUBSCRIPTION}', 2,
        'in_upgrade1', 'pro_monthly', 'v1', 45, 46, 0, 0, 0, 0, 'upgrade.period.2')`),
    ).rejects.toThrow(/source_invoice|unique/i);
  });

  test("does not mutate purchased credit while establishing or using allowance authority", async () => {
    const db = await database();
    await seedPeriod(db);
    await db.exec(`INSERT INTO subscription_allowance_transactions (
      organization_id, allowance_period_id, sequence, kind, amount,
      remaining_before, remaining_after, expired_before, expired_after,
      clawed_back_before, clawed_back_after, idempotency_key
    ) VALUES ('${ORG}', '${PERIOD}', 1, 'grant', 25, 0, 25, 0, 0, 0, 0, 'grant.period.1')`);
    const balance = await db.query<{ credit_balance: string }>(
      `SELECT credit_balance::text AS credit_balance FROM organizations WHERE id = '${ORG}'`,
    );
    expect(balance.rows).toEqual([{ credit_balance: "42.000000" }]);
  });
});
