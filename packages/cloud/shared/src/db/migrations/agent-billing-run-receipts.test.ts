/**
 * Applies the exact agent-billing run-receipt migration to an isolated PGlite
 * database and exercises its identity, lifecycle, precision, and diagnostic
 * bounds without touching a shared or deployed database.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const receiptMigrationUrl = new URL("./0274_agent_billing_run_receipts.sql", import.meta.url);
const pendingWarningMigrationUrl = new URL(
  "./0275_agent_billing_warning_pending.sql",
  import.meta.url,
);
let pg: PGlite;
let receiptMigrationSource = "";
let pendingWarningMigrationSource = "";

async function applyMigration(source: string): Promise<void> {
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await pg.exec(statement);
  }
}

beforeAll(async () => {
  pg = new PGlite();
  receiptMigrationSource = await Bun.file(receiptMigrationUrl).text();
  pendingWarningMigrationSource = await Bun.file(pendingWarningMigrationUrl).text();
  await applyMigration(receiptMigrationSource);
  await applyMigration(pendingWarningMigrationSource);
});

beforeEach(async () => {
  await pg.exec("DELETE FROM agent_billing_runs");
});

afterAll(async () => {
  await pg.close();
});

describe("0274 agent billing run receipts", () => {
  test("re-applies idempotently without replacing durable tables", async () => {
    await applyMigration(receiptMigrationSource);
    const tables = await pg.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'agent_billing_run%'
       ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "agent_billing_run_items",
      "agent_billing_runs",
    ]);
  });

  test("upgrades an already-created receipt table to admit pending warning recovery", async () => {
    const run = await pg.query<{ id: string }>(
      `INSERT INTO agent_billing_runs
        (invocation_key, trigger_kind, started_at, lease_token, lease_expires_at)
       VALUES ('manual:pending-warning-migration', 'manual', now(), gen_random_uuid(),
         now() + interval '5 minutes')
       RETURNING id`,
    );

    await expect(
      pg.query(
        `INSERT INTO agent_billing_run_items
          (run_id, sandbox_id, organization_id, agent_name, action,
           detail_code, detail_message)
         VALUES ($1, '423e4567-e89b-42d3-a456-426614174003',
           '123e4567-e89b-42d3-a456-426614174010', 'Pending Warning',
           'warning_pending', 'warning_delivery_pending',
           'Shutdown warning delivery is pending')`,
        [run.rows[0]?.id],
      ),
    ).resolves.toBeDefined();
    await expect(
      pg.query(
        `INSERT INTO agent_billing_run_items
          (run_id, sandbox_id, organization_id, agent_name, action)
         VALUES ($1, '523e4567-e89b-42d3-a456-426614174004',
           '123e4567-e89b-42d3-a456-426614174010', 'Invalid Action',
           'warning_delivered')`,
        [run.rows[0]?.id],
      ),
    ).rejects.toThrow();
  });

  test("stores started before one exact terminal partial-failure outcome", async () => {
    const started = await pg.query<{ id: string; status: string }>(
      `INSERT INTO agent_billing_runs
        (invocation_key, trigger_kind, schedule, scheduled_at, started_at,
         lease_token, lease_expires_at, created_at, updated_at)
       VALUES ($1, 'scheduled', '0 * * * *', $2, $2, gen_random_uuid(),
         $2::timestamptz + interval '5 minutes', $2, $2)
       RETURNING id, status`,
      [
        "cloudflare-cron:1787245200000:0%20*%20*%20*%20*:%2Fapi%2Fcron%2Fagent-billing",
        "2026-08-20T17:00:00.000Z",
      ],
    );
    expect(started.rows[0]?.status).toBe("started");

    const terminal = await pg.query<{
      status: string;
      total_revenue: string;
      error_samples: Array<{ code: string; message: string }>;
    }>(
      `UPDATE agent_billing_runs SET
         status = 'partial_failure', completed_at = $2, duration_ms = 25,
         sandboxes_processed = 2, sandboxes_billed = 1, errors = 1,
         total_revenue = '0.300000',
         error_samples = '[{"code":"sandbox_processing_failed","message":"Sandbox billing processing failed"}]'::jsonb,
         lease_expires_at = NULL, updated_at = $2
       WHERE id = $1
       RETURNING status, total_revenue::text, error_samples`,
      [started.rows[0]?.id, "2026-08-20T17:00:00.025Z"],
    );

    expect(terminal.rows[0]).toEqual({
      status: "partial_failure",
      total_revenue: "0.300000",
      error_samples: [
        {
          code: "sandbox_processing_failed",
          message: "Sandbox billing processing failed",
        },
      ],
    });
  });

  test("rejects duplicate invocation identity", async () => {
    const insert = () =>
      pg.query(
        `INSERT INTO agent_billing_runs
          (invocation_key, trigger_kind, started_at, lease_token, lease_expires_at)
         VALUES ('manual:agent-billing:fixed', 'manual', now(), gen_random_uuid(),
           now() + interval '5 minutes')`,
      );

    await insert();
    await expect(insert()).rejects.toThrow();
  });

  test("enforces one durable and financially coherent item per run and sandbox", async () => {
    const run = await pg.query<{ id: string }>(
      `INSERT INTO agent_billing_runs
        (invocation_key, trigger_kind, started_at, billing_cutoff_at,
         lease_token, lease_expires_at)
       VALUES ('manual:item-authority', 'manual', now(), now(), gen_random_uuid(),
         now() + interval '5 minutes')
       RETURNING id`,
    );
    const runId = run.rows[0]?.id;
    const insertBilled = () =>
      pg.query(
        `INSERT INTO agent_billing_run_items
          (run_id, sandbox_id, organization_id, agent_name, action, amount,
           new_balance, transaction_id)
         VALUES ($1, '123e4567-e89b-42d3-a456-426614174000',
           '123e4567-e89b-42d3-a456-426614174010', 'Durable Agent', 'billed',
           '0.123456', '9.876544', 'transaction-authority-1')`,
        [runId],
      );

    await insertBilled();
    await expect(insertBilled()).rejects.toThrow();
    await expect(
      pg.query(
        `INSERT INTO agent_billing_run_items
          (run_id, sandbox_id, organization_id, agent_name, action)
         VALUES ($1, '223e4567-e89b-42d3-a456-426614174001',
           '123e4567-e89b-42d3-a456-426614174010', 'Broken Error', 'error')`,
        [runId],
      ),
    ).rejects.toThrow();
    await expect(
      pg.query(
        `INSERT INTO agent_billing_run_items
          (run_id, sandbox_id, organization_id, agent_name, action, amount)
         VALUES ($1, '323e4567-e89b-42d3-a456-426614174002',
           '123e4567-e89b-42d3-a456-426614174010', 'False Warning',
           'warning_sent', '0.100000')`,
        [runId],
      ),
    ).rejects.toThrow();
  });

  test("rejects inconsistent terminal counters and more than twenty diagnostics", async () => {
    await expect(
      pg.query(
        `INSERT INTO agent_billing_runs
         (invocation_key, trigger_kind, status, started_at, completed_at,
           duration_ms, sandboxes_processed, errors, lease_token)
         VALUES ('manual:bad-empty', 'manual', 'empty', now(), now(), 0, 1, 0,
           gen_random_uuid())`,
      ),
    ).rejects.toThrow();
    await expect(
      pg.query(
        `INSERT INTO agent_billing_runs
          (invocation_key, trigger_kind, status, started_at, completed_at,
           duration_ms, sandboxes_processed, sandboxes_billed, errors, lease_token)
         VALUES ('manual:bad-duration', 'manual', 'succeeded',
           '2026-08-20T17:00:00.000Z', '2026-08-20T17:00:00.025Z',
           24, 1, 1, 0, gen_random_uuid())`,
      ),
    ).rejects.toThrow();

    const diagnostics = JSON.stringify(
      Array.from({ length: 21 }, (_, index) => ({
        code: `error_${index}`,
        message: "bounded",
      })),
    );
    await expect(
      pg.query(
        `INSERT INTO agent_billing_runs
          (invocation_key, trigger_kind, error_samples, lease_token, lease_expires_at)
         VALUES ('manual:too-many-errors', 'manual', $1::jsonb, gen_random_uuid(),
           now() + interval '5 minutes')`,
        [diagnostics],
      ),
    ).rejects.toThrow();

    const impossibleEvidence = [
      `INSERT INTO agent_billing_runs
       (invocation_key, trigger_kind, status, started_at, completed_at,
         duration_ms, sandboxes_processed, errors, lease_token)
       VALUES ('manual:bad-success-empty', 'manual', 'succeeded', now(), now(),
         0, 0, 0, gen_random_uuid())`,
      `INSERT INTO agent_billing_runs
        (invocation_key, trigger_kind, status, started_at, completed_at,
         duration_ms, sandboxes_processed, sandboxes_billed, warnings_sent,
         errors, lease_token)
       VALUES ('manual:bad-action-sum', 'manual', 'succeeded', now(), now(),
         0, 1, 1, 1, 0, gen_random_uuid())`,
      `INSERT INTO agent_billing_runs
        (invocation_key, trigger_kind, status, started_at, completed_at,
         duration_ms, sandboxes_processed, sandboxes_billed, warnings_sent,
         errors, lease_token)
       VALUES ('manual:bad-partial-no-errors', 'manual', 'partial_failure', now(), now(),
         0, 1, 1, 0, 0, gen_random_uuid())`,
      `INSERT INTO agent_billing_runs
        (invocation_key, trigger_kind, status, started_at, completed_at,
         duration_ms, sandboxes_processed, sandboxes_billed, warnings_sent,
         errors, lease_token)
       VALUES ('manual:bad-partial-sum', 'manual', 'partial_failure', now(), now(),
         0, 2, 1, 1, 1, gen_random_uuid())`,
    ];
    for (const statement of impossibleEvidence) {
      await expect(pg.query(statement)).rejects.toThrow();
    }
  });
});
