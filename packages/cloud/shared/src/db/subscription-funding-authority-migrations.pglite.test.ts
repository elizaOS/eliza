/**
 * Applies the production subscription-authority migrations to PGlite and proves
 * the database fences that serialize funding phases and invalidate spendability.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const SUB_A = "20000000-0000-4000-8000-000000000001";
const SUB_B = "20000000-0000-4000-8000-000000000002";
const PERIOD_A = "30000000-0000-4000-8000-000000000001";
const ROOT_A = "40000000-0000-4000-8000-000000000001";
const ROOT_B = "40000000-0000-4000-8000-000000000002";
const PHASE_ONE = "40000000-0000-4000-8000-000000000011";
const PHASE_TWO = "40000000-0000-4000-8000-000000000012";

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
const migrationSql = await Promise.all(
  migrationNames.map((name) => readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8")),
);
const databases: PGlite[] = [];

// Applying eight production migrations can exceed two minutes on a shared CI
// runner when several PGlite/WASM suites initialize concurrently.
setDefaultTimeout(300_000);

async function applyProductionMigrations(database: PGlite): Promise<void> {
  for (const migration of migrationSql) {
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  }
}

async function createDatabase(): Promise<PGlite> {
  const database = new PGlite({ extensions: { btree_gist } });
  databases.push(database);
  await database.exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      credit_balance numeric(16,6) NOT NULL DEFAULT 0.000000,
      display_name text NOT NULL DEFAULT 'tenant'
    );
    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      CONSTRAINT credit_transactions_id_org_idx UNIQUE (id, organization_id)
    );
    INSERT INTO organizations (id, credit_balance) VALUES
      ('${ORG_A}', 42.000000), ('${ORG_B}', 84.000000);
  `);
  await applyProductionMigrations(database);
  await seedSubscription(database, ORG_A, SUB_A, "sub_authorityA", "si_authorityA");
  await seedSubscription(database, ORG_B, SUB_B, "sub_authorityB", "si_authorityB");
  return database;
}

async function seedSubscription(
  database: PGlite,
  organizationId: string,
  subscriptionId: string,
  stripeSubscriptionId: string,
  stripeItemId: string,
): Promise<void> {
  await database.exec(`
    INSERT INTO billing_subscriptions (
      id, organization_id, stripe_subscription_id, stripe_subscription_item_id,
      plan_key, catalog_version, status, current_period_start, current_period_end,
      lifecycle_revision, provider_object_version, provider_object_digest
    ) VALUES (
      '${subscriptionId}', '${organizationId}', '${stripeSubscriptionId}', '${stripeItemId}',
      'plus_monthly', 'v1', 'active', '2026-01-01T00:00:00Z',
      '2026-02-01T00:00:00Z', 1, 1, '${"a".repeat(64)}'
    );
    INSERT INTO billing_subscription_revisions (
      organization_id, subscription_id, revision, source, stripe_subscription_id,
      stripe_subscription_item_id, plan_key, catalog_version, status,
      current_period_start, current_period_end, cancel_at_period_end,
      provider_object_version, provider_object_digest
    ) VALUES (
      '${organizationId}', '${subscriptionId}', 1, 'webhook', '${stripeSubscriptionId}',
      '${stripeItemId}', 'plus_monthly', 'v1', 'active', '2026-01-01T00:00:00Z',
      '2026-02-01T00:00:00Z', false, 1, '${"a".repeat(64)}'
    );
  `);
}

async function insertPurchasedReservation(
  database: PGlite,
  values: {
    id: string;
    organizationId: string;
    operationId: string;
    transactionId: string;
    phase?: "overage";
    sequence?: number;
    parentId?: string;
    rootId?: string;
  },
): Promise<void> {
  await database.exec(`
    INSERT INTO credit_transactions (id, organization_id)
    VALUES ('${values.transactionId}', '${values.organizationId}');
    INSERT INTO billing_funding_reservations (
      id, organization_id, logical_operation_id, funding_class, requested_amount,
      allowance_amount, purchased_credit_amount,
      purchased_credit_reservation_transaction_id, expires_at,
      reservation_phase, phase_sequence, parent_reservation_id, root_reservation_id
    ) VALUES (
      '${values.id}', '${values.organizationId}', '${values.operationId}', 'cash_only', 1,
      0, 1, '${values.transactionId}', '2099-01-01T00:00:00Z',
      '${values.phase ?? "initial"}', ${values.sequence ?? 0},
      ${values.parentId ? `'${values.parentId}'` : "NULL"},
      ${values.rootId ? `'${values.rootId}'` : "NULL"}
    );
  `);
}

async function spendableRevision(database: PGlite, organizationId = ORG_A): Promise<bigint> {
  const result = await database.query<{ revision: string }>(`
    SELECT spendable_revision::text AS revision
    FROM organizations WHERE id = '${organizationId}'
  `);
  return BigInt(result.rows[0]!.revision);
}

async function expectConstraint(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(operation).rejects.toThrow(pattern);
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("subscription funding production migration authority", () => {
  test("accepts one contiguous overage chain and rejects gaps, duplicates, and cross-tenant links", async () => {
    const database = await createDatabase();
    await insertPurchasedReservation(database, {
      id: ROOT_A,
      organizationId: ORG_A,
      operationId: "operation.root.a",
      transactionId: "50000000-0000-4000-8000-000000000001",
    });
    await insertPurchasedReservation(database, {
      id: ROOT_B,
      organizationId: ORG_B,
      operationId: "operation.root.b",
      transactionId: "50000000-0000-4000-8000-000000000002",
    });
    await insertPurchasedReservation(database, {
      id: PHASE_ONE,
      organizationId: ORG_A,
      operationId: "operation.overage.a.1",
      transactionId: "50000000-0000-4000-8000-000000000011",
      phase: "overage",
      sequence: 1,
      parentId: ROOT_A,
      rootId: ROOT_A,
    });
    await insertPurchasedReservation(database, {
      id: PHASE_TWO,
      organizationId: ORG_A,
      operationId: "operation.overage.a.2",
      transactionId: "50000000-0000-4000-8000-000000000012",
      phase: "overage",
      sequence: 2,
      parentId: PHASE_ONE,
      rootId: ROOT_A,
    });

    const phases = await database.query<{ reservation_phase: string; phase_sequence: number }>(`
      SELECT reservation_phase, phase_sequence
      FROM billing_funding_reservations
      WHERE organization_id = '${ORG_A}'
      ORDER BY phase_sequence
    `);
    expect(phases.rows).toEqual([
      { reservation_phase: "initial", phase_sequence: 0 },
      { reservation_phase: "overage", phase_sequence: 1 },
      { reservation_phase: "overage", phase_sequence: 2 },
    ]);

    await expectConstraint(
      insertPurchasedReservation(database, {
        id: "40000000-0000-4000-8000-000000000013",
        organizationId: ORG_A,
        operationId: "operation.overage.a.4",
        transactionId: "50000000-0000-4000-8000-000000000013",
        phase: "overage",
        sequence: 4,
        parentId: PHASE_TWO,
        rootId: ROOT_A,
      }),
      /preceding phase/i,
    );
    await expectConstraint(
      insertPurchasedReservation(database, {
        id: "40000000-0000-4000-8000-000000000014",
        organizationId: ORG_A,
        operationId: "operation.overage.a.duplicate",
        transactionId: "50000000-0000-4000-8000-000000000014",
        phase: "overage",
        sequence: 2,
        parentId: PHASE_ONE,
        rootId: ROOT_A,
      }),
      /root_phase_sequence|unique/i,
    );
    await expectConstraint(
      insertPurchasedReservation(database, {
        id: "40000000-0000-4000-8000-000000000015",
        organizationId: ORG_A,
        operationId: "operation.overage.cross.tenant",
        transactionId: "50000000-0000-4000-8000-000000000015",
        phase: "overage",
        sequence: 1,
        parentId: ROOT_B,
        rootId: ROOT_B,
      }),
      /tenant_fk|foreign key|tenant-scoped/i,
    );
  });

  test("accepts effective expiry inside the paid period and rejects both invalid boundaries", async () => {
    const database = await createDatabase();
    await database.exec(`
      INSERT INTO subscription_allowance_periods (
        id, organization_id, subscription_id, subscription_revision, stripe_invoice_id,
        plan_key, catalog_version, period_start, period_end, expires_at,
        granted_amount, remaining_amount
      ) VALUES (
        '${PERIOD_A}', '${ORG_A}', '${SUB_A}', 1, 'in_effective1',
        'plus_monthly', 'v1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z',
        '2026-01-20T00:00:00Z', 25, 25
      );
    `);
    await database.exec(`
      INSERT INTO subscription_allowance_periods (
        organization_id, subscription_id, subscription_revision, stripe_invoice_id,
        plan_key, catalog_version, period_start, period_end, expires_at,
        granted_amount, remaining_amount
      ) VALUES (
        '${ORG_B}', '${SUB_B}', 1, 'in_effective2', 'plus_monthly', 'v1',
        '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z',
        '2026-02-01T00:00:00Z', 25, 25
      );
    `);

    for (const [invoiceId, expiresAt] of [
      ["in_atstart", "2026-02-01T00:00:00Z"],
      ["in_afterend", "2026-04-02T00:00:00Z"],
    ] as const) {
      await expectConstraint(
        database.exec(`
          INSERT INTO subscription_allowance_periods (
            organization_id, subscription_id, subscription_revision, stripe_invoice_id,
            plan_key, catalog_version, period_start, period_end, expires_at,
            granted_amount, remaining_amount
          ) VALUES (
            '${ORG_A}', '${SUB_A}', 1, '${invoiceId}', 'plus_monthly', 'v1',
            '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z',
            '${expiresAt}', 25, 25
          )
        `),
        /subscription_allowance_periods_period_check|check constraint/i,
      );
    }
  });

  test("advances revisions only when purchased or allowance spendability changes", async () => {
    const database = await createDatabase();
    expect(await spendableRevision(database)).toBe(0n);

    await database.exec(`UPDATE organizations SET display_name = 'renamed' WHERE id = '${ORG_A}'`);
    expect(await spendableRevision(database)).toBe(0n);
    await database.exec(
      `UPDATE organizations SET credit_balance = credit_balance WHERE id = '${ORG_A}'`,
    );
    expect(await spendableRevision(database)).toBe(0n);
    await database.exec(
      `UPDATE organizations SET credit_balance = credit_balance - 1 WHERE id = '${ORG_A}'`,
    );
    const purchasedRevision = await spendableRevision(database);
    expect(purchasedRevision).toBeGreaterThan(0n);
    expect(await spendableRevision(database, ORG_B)).toBe(0n);

    await database.exec(`
      INSERT INTO subscription_allowance_periods (
        id, organization_id, subscription_id, subscription_revision, stripe_invoice_id,
        plan_key, catalog_version, period_start, period_end, expires_at,
        granted_amount, remaining_amount
      ) VALUES (
        '${PERIOD_A}', '${ORG_A}', '${SUB_A}', 1, 'in_revision1', 'plus_monthly', 'v1',
        '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z',
        '2026-02-01T00:00:00Z', 25, 25
      );
    `);
    const insertedRevision = await spendableRevision(database);
    expect(insertedRevision).toBeGreaterThan(purchasedRevision);
    await database.exec(
      `UPDATE subscription_allowance_periods SET updated_at = now() WHERE id = '${PERIOD_A}'`,
    );
    expect(await spendableRevision(database)).toBe(insertedRevision);
    await database.exec(
      `UPDATE subscription_allowance_periods SET remaining_amount = 24 WHERE id = '${PERIOD_A}'`,
    );
    const remainingRevision = await spendableRevision(database);
    expect(remainingRevision).toBeGreaterThan(insertedRevision);
    await database.exec(
      `UPDATE subscription_allowance_periods SET expires_at = '2026-01-31T00:00:00Z' WHERE id = '${PERIOD_A}'`,
    );
    const expiryRevision = await spendableRevision(database);
    expect(expiryRevision).toBeGreaterThan(remainingRevision);
    await database.exec(`DELETE FROM subscription_allowance_periods WHERE id = '${PERIOD_A}'`);
    expect(await spendableRevision(database)).toBeGreaterThan(expiryRevision);
    expect(await spendableRevision(database, ORG_B)).toBe(0n);
  });
});
