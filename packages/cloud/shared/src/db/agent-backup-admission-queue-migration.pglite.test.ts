/** Proves the explicit queued/deferred backup admission authority in PGlite. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  AGENT_BACKUP_ADMISSION_SHARD_COUNT,
  agentBackupAdmissionEnrollmentShards,
  agentBackupAdmissionWork,
} from "./schemas/agent-backup-admission";
import { agentBackupGcOutbox } from "./schemas/agent-backup-catalog";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const HISTORY_ID = "20000000-0000-4000-8000-000000000001";
const SANDBOX_ID = "30000000-0000-4000-8000-000000000001";
const BACKUP_ID = "40000000-0000-4000-8000-000000000001";
const GC_OUTBOX_ID = "50000000-0000-4000-8000-000000000001";
const migration = readFileSync(
  new URL("./migrations/0331_agent_backup_admission_queue.sql", import.meta.url),
  "utf8",
);

let database: PGlite;

async function applyMigration(): Promise<void> {
  await database.transaction(async (transaction) => {
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await transaction.exec(statement);
    }
  });
}

async function insertWork(params: {
  workKind: "schedule_capture" | "catalog_operation" | "gc_object";
  referenceColumn: "sandbox_id" | "backup_id" | "gc_outbox_id";
  referenceId: string;
  priorityClass: string;
  basePriority: number;
  state?: "queued" | "deferred";
  deferredReason?: string;
  requiresNode?: boolean;
}): Promise<void> {
  const state = params.state ?? "queued";
  const deferredReason = params.deferredReason ? `'${params.deferredReason}'` : "NULL";
  const requiresNode = params.requiresNode ?? params.workKind !== "gc_object";
  const nodeHistoryId = requiresNode ? `'${HISTORY_ID}'` : "NULL";
  await database.exec(`
    INSERT INTO agent_backup_admission_work (
      work_kind, organization_id, ${params.referenceColumn}, node_history_id,
      requires_node_lane, priority_class, base_priority, source_due_at,
      first_eligible_at, state, not_before, deferred_reason,
      ready_cohort, cohort_ordinal, shard_id
    ) VALUES (
      '${params.workKind}', '${ORGANIZATION_ID}', '${params.referenceId}', ${nodeHistoryId},
      ${requiresNode}, '${params.priorityClass}', ${params.basePriority},
      '2026-08-26T10:00:00Z', '2026-08-26T10:00:00Z', '${state}',
      '2026-08-26T10:00:00Z', ${deferredReason},
      nextval('agent_backup_admission_cohort_seq'), 0,
      agent_backup_admission_expected_shard('${params.referenceId}'::uuid)
    )
  `);
}

beforeAll(async () => {
  database = new PGlite();
  await database.exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY
    );
    CREATE TABLE agent_node_incarnation_histories (
      id uuid PRIMARY KEY
    );
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      UNIQUE (id, organization_id)
    );
    CREATE TABLE agent_sandbox_backups (
      id uuid PRIMARY KEY,
      catalog_organization_id uuid REFERENCES organizations(id),
      UNIQUE (id, catalog_organization_id)
    );
    CREATE TABLE agent_backup_gc_outbox (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id)
    );
    INSERT INTO organizations (id) VALUES ('${ORGANIZATION_ID}');
    INSERT INTO agent_node_incarnation_histories (id) VALUES ('${HISTORY_ID}');
    INSERT INTO agent_sandboxes (id, organization_id)
      VALUES ('${SANDBOX_ID}', '${ORGANIZATION_ID}');
    INSERT INTO agent_sandbox_backups (id, catalog_organization_id)
      VALUES ('${BACKUP_ID}', '${ORGANIZATION_ID}');
    INSERT INTO agent_backup_gc_outbox (id, organization_id)
      VALUES ('${GC_OUTBOX_ID}', '${ORGANIZATION_ID}');
  `);
  await applyMigration();
  await applyMigration();
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("0331 backup admission queue migration", () => {
  test("seeds every work-kind shard and preserves an interrupted scan", async () => {
    const seeded = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM agent_backup_admission_enrollment_shards
    `);
    expect(seeded.rows).toEqual([{ count: AGENT_BACKUP_ADMISSION_SHARD_COUNT * 3 }]);

    await database.exec(`
      UPDATE agent_backup_admission_enrollment_shards
      SET scan_cutoff_at = '2026-08-26T12:00:00Z',
          scan_cursor_due_at = '2026-08-26T11:00:00Z',
          scan_cursor_id = '${SANDBOX_ID}',
          active_cohort = 41,
          lease_owner = 'cohort-worker',
          lease_generation = '60000000-0000-4000-8000-000000000001',
          lease_expires_at = '2026-08-26T12:05:00Z'
      WHERE work_kind = 'schedule_capture' AND shard_id = 0
    `);
    await applyMigration();
    const resumed = await database.query<{
      active_cohort: number;
      lease_owner: string;
      scan_cursor_id: string;
    }>(`
      SELECT active_cohort::int, lease_owner, scan_cursor_id
      FROM agent_backup_admission_enrollment_shards
      WHERE work_kind = 'schedule_capture' AND shard_id = 0
    `);
    expect(resumed.rows).toEqual([
      {
        active_cohort: 41,
        lease_owner: "cohort-worker",
        scan_cursor_id: SANDBOX_ID,
      },
    ]);
  });

  test("stores queued, deferred, and GC work with exact priority and lanes", async () => {
    await insertWork({
      workKind: "schedule_capture",
      referenceColumn: "sandbox_id",
      referenceId: SANDBOX_ID,
      priorityClass: "active_rpo",
      basePriority: 1,
    });
    await insertWork({
      workKind: "catalog_operation",
      referenceColumn: "backup_id",
      referenceId: BACKUP_ID,
      priorityClass: "secondary_replication",
      basePriority: 4,
      state: "deferred",
      deferredReason: "SECONDARY_BACKPRESSURE",
    });
    await insertWork({
      workKind: "gc_object",
      referenceColumn: "gc_outbox_id",
      referenceId: GC_OUTBOX_ID,
      priorityClass: "garbage_collection",
      basePriority: 6,
      requiresNode: false,
    });

    const rows = await database.query<{
      base_priority: number;
      priority_class: string;
      requires_node_lane: boolean;
      state: string;
      work_kind: string;
    }>(`
      SELECT work_kind, priority_class, base_priority, state, requires_node_lane
      FROM agent_backup_admission_work
      ORDER BY base_priority
    `);
    expect(rows.rows).toEqual([
      {
        base_priority: 1,
        priority_class: "active_rpo",
        requires_node_lane: true,
        state: "queued",
        work_kind: "schedule_capture",
      },
      {
        base_priority: 4,
        priority_class: "secondary_replication",
        requires_node_lane: true,
        state: "deferred",
        work_kind: "catalog_operation",
      },
      {
        base_priority: 6,
        priority_class: "garbage_collection",
        requires_node_lane: false,
        state: "queued",
        work_kind: "gc_object",
      },
    ]);
  });

  test("allows a later schedule cycle but deduplicates the exact deadline", async () => {
    const insertLaterCycle = `
      INSERT INTO agent_backup_admission_work (
        work_kind, organization_id, sandbox_id, node_history_id,
        requires_node_lane, priority_class, base_priority, source_due_at,
        first_eligible_at, state, not_before, ready_cohort, cohort_ordinal, shard_id
      ) VALUES (
        'schedule_capture', '${ORGANIZATION_ID}', '${SANDBOX_ID}', '${HISTORY_ID}',
        TRUE, 'periodic_capture', 3, '2026-08-26T11:00:00Z',
        '2026-08-26T11:00:00Z', 'queued', '2026-08-26T11:00:00Z',
        nextval('agent_backup_admission_cohort_seq'), 0,
        agent_backup_admission_expected_shard('${SANDBOX_ID}'::uuid)
      )
    `;
    await database.exec(insertLaterCycle);
    await expect(database.exec(insertLaterCycle)).rejects.toThrow();
  });

  test("rejects priority, state, lane, and deterministic-shard confusion", async () => {
    await expect(
      database.exec(`
        UPDATE agent_backup_admission_work
        SET base_priority = 0
        WHERE sandbox_id = '${SANDBOX_ID}'
      `),
    ).rejects.toThrow();
    await expect(
      database.exec(`
        UPDATE agent_backup_admission_work
        SET state = 'queued', deferred_reason = 'SHOULD_NOT_SURVIVE'
        WHERE backup_id = '${BACKUP_ID}'
      `),
    ).rejects.toThrow();
    await expect(
      database.exec(`
        UPDATE agent_backup_admission_work
        SET requires_node_lane = TRUE, node_history_id = '${HISTORY_ID}'
        WHERE gc_outbox_id = '${GC_OUTBOX_ID}'
      `),
    ).rejects.toThrow();
    await expect(
      database.exec(`
        UPDATE agent_backup_admission_work
        SET shard_id = (shard_id + 1) % 64
        WHERE sandbox_id = '${SANDBOX_ID}'
      `),
    ).rejects.toThrow();
  });

  test("keeps identity and age immutable while retry cohorts move only forward", async () => {
    await expect(
      database.exec(`
        UPDATE agent_backup_admission_work
        SET first_eligible_at = first_eligible_at + interval '1 second'
        WHERE backup_id = '${BACKUP_ID}'
      `),
    ).rejects.toThrow("backup admission work identity is immutable");
    await expect(
      database.exec(`
        UPDATE agent_backup_admission_work
        SET state = 'leased', deferred_reason = NULL,
            lease_owner = 'worker',
            lease_generation = '60000000-0000-4000-8000-000000000002',
            lease_expires_at = clock_timestamp() + interval '1 minute'
        WHERE backup_id = '${BACKUP_ID}'
      `),
    ).rejects.toThrow("must re-enter a queued cohort");

    await database.exec(`
      UPDATE agent_backup_admission_work
      SET state = 'queued', deferred_reason = NULL,
          ready_cohort = ready_cohort + 1, not_before = clock_timestamp()
      WHERE backup_id = '${BACKUP_ID}'
    `);
    await expect(
      database.exec(`
        UPDATE agent_backup_admission_work
        SET ready_cohort = ready_cohort - 1
        WHERE backup_id = '${BACKUP_ID}'
      `),
    ).rejects.toThrow("cohort cannot move backward");

    await database.exec(`
      UPDATE agent_backup_admission_work
      SET state = 'leased', lease_owner = 'worker',
          lease_generation = '60000000-0000-4000-8000-000000000003',
          lease_expires_at = clock_timestamp() + interval '1 minute',
          attempts = attempts + 1
      WHERE backup_id = '${BACKUP_ID}'
    `);
    await database.exec(`
      UPDATE agent_backup_admission_work
      SET state = 'settled', lease_owner = NULL, lease_generation = NULL,
          lease_expires_at = NULL, settled_at = clock_timestamp()
      WHERE backup_id = '${BACKUP_ID}'
    `);
    await expect(
      database.exec(`
        UPDATE agent_backup_admission_work
        SET updated_at = clock_timestamp()
        WHERE backup_id = '${BACKUP_ID}'
      `),
    ).rejects.toThrow("settled backup admission work is immutable");
  });

  test("keeps Drizzle models aligned with queue constraints and references", () => {
    const shardConfig = getTableConfig(agentBackupAdmissionEnrollmentShards);
    expect(shardConfig.name).toBe("agent_backup_admission_enrollment_shards");
    expect(shardConfig.primaryKeys).toHaveLength(1);
    expect(shardConfig.checks.map(({ name }) => name).sort()).toEqual([
      "agent_backup_admission_enrollment_shards_bounds_check",
      "agent_backup_admission_enrollment_shards_lease_shape_check",
      "agent_backup_admission_enrollment_shards_scan_shape_check",
    ]);

    const workConfig = getTableConfig(agentBackupAdmissionWork);
    expect(workConfig.name).toBe("agent_backup_admission_work");
    expect(workConfig.foreignKeys).toHaveLength(5);
    expect(
      workConfig.foreignKeys
        .map(({ reference }) => reference().name)
        .filter((name): name is string => Boolean(name))
        .sort(),
    ).toEqual([
      "agent_backup_admission_work_backup_tenant_fkey",
      "agent_backup_admission_work_gc_tenant_fkey",
      "agent_backup_admission_work_sandbox_tenant_fkey",
    ]);
    expect(workConfig.checks.map(({ name }) => name).sort()).toEqual([
      "agent_backup_admission_work_counters_check",
      "agent_backup_admission_work_lane_check",
      "agent_backup_admission_work_priority_check",
      "agent_backup_admission_work_reference_shape_check",
      "agent_backup_admission_work_state_shape_check",
    ]);

    const gcConfig = getTableConfig(agentBackupGcOutbox);
    expect(gcConfig.uniqueConstraints.map(({ name }) => name)).toContain(
      "agent_backup_gc_outbox_tenant_identity_unique",
    );
  });
});
