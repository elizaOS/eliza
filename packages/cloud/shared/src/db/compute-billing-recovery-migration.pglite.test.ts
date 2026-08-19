/** Executes the compute recovery migration and its database-owned invariants on real PGlite. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const ORG_A = "00000000-0000-4000-8000-000000000011";
const ORG_B = "00000000-0000-4000-8000-000000000022";
const AGENT = "00000000-0000-4000-8000-000000000033";
const AGENT_PENDING = "00000000-0000-4000-8000-000000000034";
const CONTAINER = "00000000-0000-4000-8000-000000000044";
const CONTAINER_B = "00000000-0000-4000-8000-000000000045";
const TX = "00000000-0000-4000-8000-000000000055";
const MISSING_TX = "00000000-0000-4000-8000-000000000056";
const EXACT_RECEIPT = "00000000-0000-4000-8000-000000000071";
const MISSING_RECEIPT = "00000000-0000-4000-8000-000000000072";
const MISMATCH_RECEIPT = "00000000-0000-4000-8000-000000000073";
const NULL_RECEIPT = "00000000-0000-4000-8000-000000000074";
const SUSPEND_JOB = "00000000-0000-4000-8000-000000000066";
const migration = readFileSync(
  new URL("./migrations/0265_compute_billing_recovery.sql", import.meta.url),
  "utf8",
).replaceAll("--> statement-breakpoint", "");
const migrationPrefix = migration.slice(0, migration.indexOf("CREATE TABLE agent_billing_records"));

let database: PGlite;

beforeAll(async () => {
  database = new PGlite();
  await database.exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY, credit_balance numeric(16,6) NOT NULL DEFAULT 0,
      pay_as_you_go_from_earnings boolean NOT NULL DEFAULT false
    );
    CREATE TABLE users (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, role text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, status text NOT NULL,
      execution_tier text NOT NULL, billing_status text NOT NULL DEFAULT 'active',
      last_backup_at timestamptz,
      last_billed_at timestamptz, total_billed numeric(12,4) NOT NULL DEFAULT 0,
      lifecycle_revision bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, organization_id)
    );
    CREATE TABLE containers (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, status text NOT NULL,
      image_tag text, environment_vars jsonb NOT NULL DEFAULT '{}', desired_count integer NOT NULL,
      cpu integer NOT NULL, memory integer NOT NULL, node_id text, volume_path text,
      last_billed_at timestamptz, total_billed numeric(12,4) NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL,
      amount numeric(12,6) NOT NULL
    );
    CREATE TABLE container_billing_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), container_id uuid NOT NULL,
      organization_id uuid NOT NULL,
      CONSTRAINT container_billing_records_organization_id_organizations_id_fk
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      amount numeric(12,4) NOT NULL,
      billing_period_start timestamptz NOT NULL, billing_period_end timestamptz NOT NULL,
      status text NOT NULL, credit_transaction_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
      agent_id text, type text NOT NULL, status text NOT NULL,
      data jsonb NOT NULL DEFAULT '{}', data_storage text NOT NULL DEFAULT 'inline',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO organizations (id, credit_balance) VALUES ('${ORG_A}', 10), ('${ORG_B}', 10);
    INSERT INTO agent_sandboxes
      (id, organization_id, status, execution_tier, last_billed_at, created_at)
      VALUES ('${AGENT}', '${ORG_A}', 'running', 'dedicated-always',
        '2026-08-19T01:00:00Z', '2026-08-19T01:00:00Z');
    INSERT INTO agent_sandboxes
      (id, organization_id, status, execution_tier, billing_status, last_billed_at, created_at)
      VALUES ('${AGENT_PENDING}', '${ORG_A}', 'running', 'dedicated-always',
        'shutdown_pending', '2026-08-19T01:00:00Z', '2026-08-19T01:00:00Z');
    INSERT INTO containers
      (id, organization_id, status, desired_count, cpu, memory, last_billed_at, created_at)
      VALUES
        ('${CONTAINER}', '${ORG_A}', 'running', 1, 1024, 2048,
          '2026-08-19T01:00:00Z', '2026-08-19T01:00:00Z'),
        ('${CONTAINER_B}', '${ORG_B}', 'running', 1, 1024, 2048,
          '2026-08-19T01:00:00Z', '2026-08-19T01:00:00Z');
    INSERT INTO credit_transactions (id, organization_id, amount)
      VALUES ('${TX}', '${ORG_A}', -0.01);
    INSERT INTO container_billing_records
      (id, container_id, organization_id, amount, billing_period_start, billing_period_end,
       status, credit_transaction_id)
      VALUES
        ('${EXACT_RECEIPT}', '${CONTAINER}', '${ORG_A}', 0.01,
          '2026-08-19T00:00:00Z', '2026-08-19T01:00:00Z', 'success', '${TX}'),
        ('${MISSING_RECEIPT}', '${CONTAINER}', '${ORG_A}', 0.01,
          '2026-08-18T23:00:00Z', '2026-08-19T00:00:00Z', 'success', '${MISSING_TX}'),
        ('${MISMATCH_RECEIPT}', '${CONTAINER_B}', '${ORG_B}', 0.01,
          '2026-08-19T00:00:00Z', '2026-08-19T01:00:00Z', 'success', '${TX}'),
        ('${NULL_RECEIPT}', '${CONTAINER}', '${ORG_A}', 0.01,
          '2026-08-18T22:00:00Z', '2026-08-18T23:00:00Z', 'success', NULL);
    INSERT INTO jobs (id, organization_id, agent_id, type, status, data, created_at)
      VALUES ('${SUSPEND_JOB}', '${ORG_A}', '${AGENT_PENDING}', 'agent_suspend',
        'pending', '{"agentId":"${AGENT_PENDING}","organizationId":"${ORG_A}","userId":"legacy-user"}',
        '2026-08-19T02:00:00Z');
  `);
  await database.exec(migration);
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("compute billing recovery migration", () => {
  test("backfills rate authority and appends exact lifecycle transitions", async () => {
    const initial = await database.query<{ workload_kind: string; rate_per_hour: string }>(
      `SELECT workload_kind, rate_per_hour::text FROM compute_billing_rate_segments
       ORDER BY workload_kind`,
    );
    expect(initial.rows).toEqual([
      { workload_kind: "agent", rate_per_hour: "0.010000" },
      { workload_kind: "agent", rate_per_hour: "0.010000" },
      { workload_kind: "container", rate_per_hour: "0.027917" },
      { workload_kind: "container", rate_per_hour: "0.027917" },
    ]);

    await database.exec(`UPDATE agent_sandboxes
      SET status = 'stopped', last_backup_at = now() WHERE id = '${AGENT}';
      UPDATE containers SET cpu = 2048 WHERE id = '${CONTAINER}';`);
    const transitions = await database.query<{
      workload_kind: string;
      billing_state: string;
      rate_per_hour: string;
    }>(`SELECT workload_kind, billing_state, rate_per_hour::text
       FROM compute_billing_rate_segments
       WHERE billing_state = 'backup' OR rate_per_hour = 0.055833
       ORDER BY workload_kind`);
    expect(transitions.rows).toEqual([
      { workload_kind: "agent", billing_state: "backup", rate_per_hour: "0.002500" },
      { workload_kind: "container", billing_state: "running", rate_per_hour: "0.055833" },
    ]);
    const revision = await database.query<{ lifecycle_revision: string }>(
      `SELECT lifecycle_revision::text FROM containers WHERE id = '${CONTAINER}'`,
    );
    expect(revision.rows[0]?.lifecycle_revision).toBe("1");
  });

  test("backfills overdue agent stop authority and binds the active job", async () => {
    const intent = await database.query<{
      agent_id: string;
      lifecycle_revision: string;
      status: string;
      job_id: string;
    }>(`SELECT agent_id::text, lifecycle_revision::text, status, job_id::text
       FROM agent_compute_stop_intents WHERE agent_id = '${AGENT_PENDING}'`);
    expect(intent.rows).toEqual([
      {
        agent_id: AGENT_PENDING,
        lifecycle_revision: "0",
        status: "pending",
        job_id: SUSPEND_JOB,
      },
    ]);
    const legacyJob = await database.query<{ authorization: string }>(
      `SELECT data->>'authorization' AS authorization FROM jobs WHERE id = '${SUSPEND_JOB}'`,
    );
    expect(legacyJob.rows).toEqual([{ authorization: "billing_request" }]);
  });

  test("binds receipts to the tenant ledger and retains immutable audit history", async () => {
    const organizationDeletes = await database.query<{ table_name: string; confdeltype: string }>(
      `SELECT conrelid::regclass::text AS table_name, confdeltype
       FROM pg_constraint
       WHERE conname IN (
         'agent_billing_records_organization_id_organizations_id_fk',
         'container_billing_records_organization_id_organizations_id_fk'
       )
       ORDER BY table_name`,
    );
    expect(organizationDeletes.rows).toEqual([
      { table_name: "agent_billing_records", confdeltype: "r" },
      { table_name: "container_billing_records", confdeltype: "r" },
    ]);
    const newWriteConstraints = await database.query<{ name: string; validated: boolean }>(
      `SELECT conname AS name, convalidated AS validated
       FROM pg_constraint
       WHERE conname IN (
         'container_billing_records_credit_transaction_tenant_fk',
         'container_billing_records_success_ledger_check'
       )
       ORDER BY conname`,
    );
    expect(newWriteConstraints.rows).toEqual([
      { name: "container_billing_records_credit_transaction_tenant_fk", validated: false },
      { name: "container_billing_records_success_ledger_check", validated: false },
    ]);
    const quarantined = await database.query<{
      receipt_id: string;
      classification: string;
    }>(`SELECT receipt_id::text, classification
       FROM container_billing_legacy_ledger_bindings
       ORDER BY receipt_id`);
    expect(quarantined.rows).toEqual([
      { receipt_id: MISSING_RECEIPT, classification: "missing_transaction" },
      { receipt_id: MISMATCH_RECEIPT, classification: "tenant_mismatch" },
      { receipt_id: NULL_RECEIPT, classification: "missing_reference" },
    ]);
    const exactQuarantine = await database.query<{ count: string }>(
      `SELECT count(*)::text FROM container_billing_legacy_ledger_bindings
       WHERE receipt_id = '${EXACT_RECEIPT}'`,
    );
    expect(exactQuarantine.rows[0]?.count).toBe("0");
    await expect(
      database.exec(`UPDATE container_billing_legacy_ledger_bindings
        SET classification = classification WHERE receipt_id = '${MISSING_RECEIPT}'`),
    ).rejects.toMatchObject({
      constraint: "container_billing_legacy_ledger_bindings_immutable",
    });
    await expect(
      database.exec(`DELETE FROM container_billing_legacy_ledger_bindings
        WHERE receipt_id = '${MISSING_RECEIPT}'`),
    ).rejects.toMatchObject({
      constraint: "container_billing_legacy_ledger_bindings_immutable",
    });
    await expect(
      database.exec(`TRUNCATE container_billing_legacy_ledger_bindings`),
    ).rejects.toMatchObject({
      constraint: "container_billing_legacy_ledger_bindings_immutable",
    });
    await expect(
      database.exec(`INSERT INTO container_billing_legacy_ledger_bindings
        (receipt_id, organization_id, credit_transaction_id, classification)
        VALUES ('${EXACT_RECEIPT}', '${ORG_A}', '${TX}', 'tenant_mismatch')`),
    ).rejects.toMatchObject({ constraint: "container_billing_legacy_ledger_bindings_reason" });
    await expect(
      database.exec(`INSERT INTO container_billing_records
        (container_id, organization_id, amount, billing_period_start, billing_period_end,
         status, credit_transaction_id)
        VALUES ('${CONTAINER}', '${ORG_A}', 0.01, now() - interval '3 hour', now(),
          'success', NULL)`),
    ).rejects.toMatchObject({ constraint: "container_billing_records_success_ledger_check" });
    await database.exec(`INSERT INTO container_billing_records
      (container_id, organization_id, amount, billing_period_start, billing_period_end,
       status, credit_transaction_id)
      VALUES ('${CONTAINER}', '${ORG_A}', 0, now() - interval '4 hour', now(),
        'failed', NULL)`);
    await expect(
      database.exec(`INSERT INTO container_billing_records
        (container_id, organization_id, amount, billing_period_start, billing_period_end,
         status, credit_transaction_id)
        VALUES ('${CONTAINER}', '${ORG_B}', 0.01, now() - interval '1 hour', now(),
          'success', '${TX}')`),
    ).rejects.toThrow();
    await expect(
      database.exec(`INSERT INTO container_billing_records
        (container_id, organization_id, amount, billing_period_start, billing_period_end,
         status, credit_transaction_id)
        VALUES ('${CONTAINER_B}', '${ORG_B}', 0.01, now() - interval '2 hour', now(),
          'success', '${TX}')`),
    ).rejects.toMatchObject({
      constraint: "container_billing_records_credit_transaction_tenant_fk",
    });
    await database.exec(`INSERT INTO container_billing_records
      (container_id, organization_id, amount, billing_period_start, billing_period_end,
       status, credit_transaction_id)
      VALUES ('${CONTAINER}', '${ORG_A}', 0.01, now() - interval '1 hour', now(),
        'success', '${TX}')`);
    await expect(
      database.exec(`UPDATE container_billing_records SET amount = amount`),
    ).rejects.toMatchObject({ constraint: "compute_billing_receipt_immutable" });
    await expect(database.exec(`TRUNCATE container_billing_records`)).rejects.toThrow();
    const beforeDelete = await database.query<{ count: string }>(
      `SELECT count(*)::text FROM container_billing_records`,
    );
    await database.exec(`DELETE FROM containers WHERE id IN ('${CONTAINER}', '${CONTAINER_B}')`);
    const retained = await database.query<{ count: string }>(
      `SELECT count(*)::text FROM container_billing_records`,
    );
    expect(retained.rows[0]?.count).toBe(beforeDelete.rows[0]?.count);
  });

  test("enforces numeric range at the shared ledger boundary", async () => {
    await database.exec(
      `UPDATE credit_transactions SET amount = 9999999999.999999 WHERE id = '${TX}'`,
    );
    await expect(
      database.exec(`UPDATE credit_transactions SET amount = 10000000000 WHERE id = '${TX}'`),
    ).rejects.toMatchObject({ code: "22003" });
  });

  test("fails closed on replay without rewriting quarantined history", async () => {
    const before = await database.query<{ receipt_id: string; classification: string }>(
      `SELECT receipt_id::text, classification
       FROM container_billing_legacy_ledger_bindings ORDER BY receipt_id`,
    );
    await expect(database.exec(`BEGIN; ${migration}; COMMIT;`)).rejects.toThrow();
    await database.exec("ROLLBACK");
    const after = await database.query<{ receipt_id: string; classification: string }>(
      `SELECT receipt_id::text, classification
       FROM container_billing_legacy_ledger_bindings ORDER BY receipt_id`,
    );
    expect(after.rows).toEqual(before.rows);
  });
});

test("0265 rolls back cleanly when a partial quarantine table collides", async () => {
  const partial = new PGlite();
  try {
    await partial.exec(`
      CREATE TABLE organizations (id uuid PRIMARY KEY);
      CREATE TABLE agent_sandboxes (
        id uuid PRIMARY KEY, last_billed_at timestamptz, total_billed numeric(12,4)
      );
      CREATE TABLE containers (
        id uuid PRIMARY KEY, organization_id uuid NOT NULL, last_billed_at timestamptz,
        total_billed numeric(12,4)
      );
      CREATE TABLE credit_transactions (
        id uuid PRIMARY KEY, organization_id uuid NOT NULL, amount numeric(12,6)
      );
      CREATE TABLE container_billing_records (
        id uuid PRIMARY KEY, container_id uuid NOT NULL, organization_id uuid NOT NULL,
        amount numeric(12,4) NOT NULL, credit_transaction_id uuid,
        CONSTRAINT container_billing_records_organization_id_organizations_id_fk
          FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );
      CREATE TABLE container_billing_legacy_ledger_bindings (receipt_id uuid PRIMARY KEY);
    `);
    await expect(partial.exec(`BEGIN; ${migrationPrefix}; COMMIT;`)).rejects.toThrow();
    await partial.exec("ROLLBACK");
    const amountPrecision = await partial.query<{ precision: number; scale: number }>(
      `SELECT numeric_precision AS precision, numeric_scale AS scale
       FROM information_schema.columns
       WHERE table_name = 'container_billing_records' AND column_name = 'amount'`,
    );
    expect(amountPrecision.rows).toEqual([{ precision: 12, scale: 4 }]);
    const originalConstraint = await partial.query<{ delete_action: string }>(
      `SELECT confdeltype AS delete_action FROM pg_constraint
       WHERE conname = 'container_billing_records_organization_id_organizations_id_fk'`,
    );
    expect(originalConstraint.rows).toEqual([{ delete_action: "c" }]);
  } finally {
    await partial.close();
  }
});
