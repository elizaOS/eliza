/** Applies the split admission migrations to PGlite and proves durable cohort invariants. */

import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  agentBackupAdmissionClaimShards,
  agentBackupAdmissionEnrollmentShards,
  agentBackupAdmissionWork,
} from "../schemas/agent-backup-admission";
import { agentSandboxBackups, agentSandboxes } from "../schemas/agent-sandboxes";

const migrationNames = [
  "0346_agent_backup_admission_sandbox_source_stamp.sql",
  "0347_agent_backup_admission_node_source_stamp.sql",
  "0348_agent_backup_admission_snapshot_visibility.sql",
  "0349_agent_backup_admission_cohort_authority.sql",
  "0350_agent_backup_admission_cohort_seed.sql",
  "0351_agent_backup_admission_work_table.sql",
  "0352_agent_backup_admission_work_shapes.sql",
  "0353_agent_backup_admission_work_state_shapes.sql",
  "0354_agent_backup_admission_work_stage_policy.sql",
  "0355_agent_backup_admission_work_indexes.sql",
  "0356_agent_backup_admission_work_identity_guard.sql",
  "0357_agent_backup_admission_work_state_guard.sql",
  "0358_agent_backup_admission_work_delete_guard.sql",
  "0359_agent_backup_admission_shard_guard.sql",
  "0360_agent_backup_admission_claim_authority.sql",
  "0361_agent_backup_admission_claim_seed.sql",
  "0362_agent_backup_admission_claim_indexes.sql",
  "0363_agent_backup_admission_claim_guard.sql",
  "0364_agent_backup_admission_claim_eligibility.sql",
  "0365_agent_backup_admission_unsettled_schedule_index.sql",
  "0366_agent_backup_admission_enrollment_source_indexes.sql",
  "0367_agent_backup_admission_enrollment_watermark_guard.sql",
  "0368_agent_backup_admission_enrollment_source_stamp.sql",
  "0369_agent_backup_admission_recovery_cursor.sql",
] as const;
const migrations = await Promise.all(
  migrationNames.map((name) => Bun.file(new URL(`./${name}`, import.meta.url)).text()),
);
const journalUrl = new URL("./meta/_journal.json", import.meta.url);
const databases: PGlite[] = [];

const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const SANDBOX_A = "20000000-0000-4000-8000-000000000001";
const SANDBOX_B = "20000000-0000-4000-8000-000000000002";
const SANDBOX_C = "20000000-0000-4000-8000-000000000003";
const HISTORY_A = "30000000-0000-4000-8000-000000000001";
const HISTORY_B = "30000000-0000-4000-8000-000000000002";
const BACKUP_A = "40000000-0000-4000-8000-000000000001";
const GC_A = "50000000-0000-4000-8000-000000000001";
const GC_OBJECT_A = "51000000-0000-4000-8000-000000000001";
const GC_OBJECT_B = "51000000-0000-4000-8000-000000000002";
const ACTIVATION = "60000000-0000-4000-8000-000000000001";
const DUE = "2026-08-20 00:00:00+00";
const DEADLINE = "2026-08-20 00:15:00+00";
const CONTAINER = "a".repeat(64);
const IMAGE = `sha256:${"b".repeat(64)}`;

interface ScheduleInsertOptions {
  sourceDue?: string;
  rpoDeadline?: string;
  notBefore?: string;
  shardId?: number;
}

interface ClaimCycleOptions {
  maxCohort?: number;
  maxOrdinal?: number;
  maxId?: string;
  observedAt?: string;
}

async function applyAll(db: PGlite): Promise<void> {
  for (const migration of migrations) {
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await db.exec(statement);
    }
  }
}

async function database(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      account_lifecycle_state text NOT NULL DEFAULT 'active',
      is_active boolean NOT NULL DEFAULT TRUE,
      account_deletion_request_id uuid
    );
    CREATE TABLE agent_node_incarnation_histories (id uuid PRIMARY KEY);
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, sandbox_id text,
      status text, pool_status text, execution_tier text, activation_generation uuid,
      activation_lifecycle_revision bigint, lifecycle_revision bigint,
      activation_phase text, activation_receipt_hash text, activation_container_id text,
      activation_node_id text, activation_image_digest text, activation_boot_id uuid,
      activation_authority_published_at timestamptz, activation_dispatched_at timestamptz,
      activation_completed_at timestamptz, next_backup_at timestamptz,
      backup_schedule_last_protected_at timestamptz,
      deleted_at timestamptz, deletion_attempt_id uuid,
      CONSTRAINT agent_sandboxes_id_organization_unique UNIQUE (id, organization_id)
    );
    CREATE TABLE docker_nodes (
      id uuid PRIMARY KEY, node_id text, current_node_history_id uuid,
      node_incarnation uuid, fleet_kind text, infrastructure_provider text,
      provider_server_id text, host_key_fingerprint text
    );
    CREATE TABLE agent_sandbox_backups (
      id uuid PRIMARY KEY, catalog_organization_id uuid, catalog_state text,
      catalog_resume_state text, source_node_history_id uuid,
      source_node_record_id uuid, source_node_incarnation uuid,
      CONSTRAINT agent_sandbox_backups_catalog_identity_unique
        UNIQUE (id, catalog_organization_id)
    );
    CREATE TABLE agent_backup_objects (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL,
      UNIQUE (id, organization_id)
    );
    CREATE TABLE agent_backup_gc_outbox (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL,
      object_id uuid NOT NULL, action text NOT NULL,
      UNIQUE (object_id, action),
      FOREIGN KEY (object_id, organization_id)
        REFERENCES agent_backup_objects (id, organization_id)
    );
    INSERT INTO organizations (id) VALUES ('${ORG_A}'), ('${ORG_B}');
    INSERT INTO agent_node_incarnation_histories VALUES ('${HISTORY_A}'), ('${HISTORY_B}');
    INSERT INTO agent_sandboxes (
      id, organization_id, sandbox_id, status, pool_status, execution_tier,
      activation_generation, activation_lifecycle_revision, lifecycle_revision,
      activation_phase, activation_receipt_hash, activation_container_id,
      activation_node_id, activation_image_digest, activation_boot_id,
      activation_authority_published_at, activation_dispatched_at,
      activation_completed_at, next_backup_at
    ) VALUES
      ('${SANDBOX_A}', '${ORG_A}', 'sandbox-a', 'active', 'allocated', 'dedicated',
        '${ACTIVATION}', 7, 7, 'active', '${"c".repeat(64)}', '${CONTAINER}',
        'node-a', '${IMAGE}', '${HISTORY_A}', now(), now(), '${DUE}', '${DUE}'),
      ('${SANDBOX_B}', '${ORG_A}', 'sandbox-b', 'active', 'allocated', 'dedicated',
        '${ACTIVATION}', 7, 7, 'active', '${"c".repeat(64)}', '${CONTAINER}',
        'node-b', '${IMAGE}', '${HISTORY_B}', now(), now(), '${DUE}', '${DUE}'),
      ('${SANDBOX_C}', '${ORG_B}', 'sandbox-c', 'active', 'allocated', 'dedicated',
        '${ACTIVATION}', 7, 7, 'active', '${"c".repeat(64)}', '${CONTAINER}',
        'node-a', '${IMAGE}', '${HISTORY_A}', now(), now(), '${DUE}', '${DUE}');
    INSERT INTO docker_nodes VALUES
      ('70000000-0000-4000-8000-000000000001', 'node-a', '${HISTORY_A}',
        '${HISTORY_A}', 'robot', 'hetzner', NULL, 'SHA256:a'),
      ('70000000-0000-4000-8000-000000000002', 'node-b', '${HISTORY_B}',
        '${HISTORY_B}', 'robot', 'hetzner', NULL, 'SHA256:b');
    INSERT INTO agent_sandbox_backups (id, catalog_organization_id)
      VALUES ('${BACKUP_A}', '${ORG_A}');
    INSERT INTO agent_backup_objects VALUES
      ('${GC_OBJECT_A}', '${ORG_A}'), ('${GC_OBJECT_B}', '${ORG_A}');
    INSERT INTO agent_backup_gc_outbox VALUES
      ('${GC_A}', '${ORG_A}', '${GC_OBJECT_A}', 'delete_object');
  `);
  await applyAll(db);
  return db;
}

async function insertSchedule(
  db: PGlite,
  id: string,
  organizationId: string,
  sandboxId: string,
  historyId: string,
  options: ScheduleInsertOptions = {},
): Promise<void> {
  await db.query(
    `INSERT INTO agent_backup_admission_work (
       id, work_kind, work_stage, organization_id, sandbox_id, node_history_id,
       source_activation_generation, source_lifecycle_revision, source_provider_handle,
       source_container_id, source_image_digest, source_rpo_ms, requires_node_lane,
       priority_class, base_priority, source_due_at, rpo_deadline_at, not_before,
       ready_cohort, cohort_ordinal, shard_id
     ) VALUES ($1::uuid, 'schedule_capture', 'reserve_capture', $2::uuid, $3::uuid,
       $4::uuid, $5::uuid, 7, 'sandbox-provider', $6, $7, 900000, TRUE,
       'periodic_capture', 3, $8::timestamptz, $9::timestamptz, $10::timestamptz,
       1, 0, COALESCE($11::smallint, agent_backup_admission_expected_shard($3::uuid)))`,
    [
      id,
      organizationId,
      sandboxId,
      historyId,
      ACTIVATION,
      CONTAINER,
      IMAGE,
      options.sourceDue ?? DUE,
      options.rpoDeadline ?? DEADLINE,
      options.notBefore ?? options.sourceDue ?? DUE,
      options.shardId ?? null,
    ],
  );
}

async function startScheduleClaimCycle(db: PGlite, options: ClaimCycleOptions = {}): Promise<void> {
  await db.query(
    `UPDATE agent_backup_admission_claim_shards
    SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
      cycle_observed_at = $1::timestamptz, cycle_max_cohort = $2,
      cycle_max_ordinal = $3, cycle_max_id = $4::uuid,
      cycle_aging_interval_ms = 900000, priority_pass = 0
    WHERE work_kind = 'schedule_capture' AND shard_id = 32`,
    [
      options.observedAt ?? "2000-01-01 00:00:00+00",
      options.maxCohort ?? 42,
      options.maxOrdinal ?? 99,
      options.maxId ?? "80000000-0000-4fff-bfff-ffffffffffff",
    ],
  );
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("backup admission cohort migrations", () => {
  test("stay split, ordered, and below the migration lock budget", async () => {
    const journal = (await Bun.file(journalUrl).json()) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.slice(-migrationNames.length).map(({ tag }) => `${tag}.sql`)).toEqual([
      ...migrationNames,
    ]);
    for (const migration of migrations) expect(migration.split("\n").length).toBeLessThan(100);
  });

  test("keeps deployed constraint and index names aligned with Drizzle", async () => {
    const shardConfig = getTableConfig(agentBackupAdmissionEnrollmentShards);
    const claimShardConfig = getTableConfig(agentBackupAdmissionClaimShards);
    const workConfig = getTableConfig(agentBackupAdmissionWork);
    const backupConfig = getTableConfig(agentSandboxBackups);
    const sandboxConfig = getTableConfig(agentSandboxes);
    const expectedConstraints = [
      "agent_backup_admission_enrollment_shards_pkey",
      "agent_backup_admission_claim_shards_pkey",
      "agent_backup_admission_claim_shards_bounds_check",
      "agent_backup_admission_claim_shards_recovery_shape_check",
      "agent_backup_admission_claim_shards_cycle_shape_check",
      "agent_backup_admission_claim_shards_proof_shape_check",
      "agent_backup_admission_work_claim_proof_shape_check",
      "agent_backup_admission_work_retry_exhaustion_check",
      "agent_backup_admission_work_organization_id_fkey",
      "agent_backup_admission_work_node_history_id_fkey",
      "agent_backup_admission_work_sandbox_tenant_fkey",
      "agent_backup_admission_work_backup_tenant_fkey",
      "agent_backup_admission_work_gc_authority_fkey",
      "agent_backup_admission_work_gc_object_tenant_fkey",
    ];
    const configuredConstraints = [
      ...shardConfig.primaryKeys.map((key) => key.getName()),
      ...claimShardConfig.primaryKeys.map((key) => key.getName()),
      ...claimShardConfig.checks.map((constraint) => constraint.name),
      ...workConfig.foreignKeys.map((key) => key.getName()),
      ...workConfig.checks.map((constraint) => constraint.name),
    ];
    expect(configuredConstraints).toEqual(expect.arrayContaining(expectedConstraints));
    expect(claimShardConfig.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "agent_backup_admission_claim_shards_bounds_check",
        "agent_backup_admission_claim_shards_recovery_shape_check",
        "agent_backup_admission_claim_shards_cycle_shape_check",
        "agent_backup_admission_claim_shards_proof_shape_check",
      ]),
    );
    expect(claimShardConfig.indexes.map(({ config }) => config.name)).toContain(
      "agent_backup_admission_claim_shards_turn_idx",
    );

    const expectedWorkIndexes = [
      "agent_backup_admission_work_schedule_uidx",
      "agent_backup_admission_work_unsettled_schedule_uidx",
      "agent_backup_admission_work_operation_stage_uidx",
      "agent_backup_admission_work_gc_uidx",
      "agent_backup_admission_work_organization_idx",
      "agent_backup_admission_work_leased_organization_uidx",
      "agent_backup_admission_work_leased_node_uidx",
      "agent_backup_admission_work_due_idx",
      "agent_backup_admission_work_shard_idx",
      "agent_backup_admission_work_claim_scan_idx",
      "agent_backup_admission_work_deferred_ready_shard_idx",
      "agent_backup_admission_work_expired_lease_shard_idx",
      "agent_backup_admission_work_expired_lease_idx",
    ];
    expect(workConfig.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining(expectedWorkIndexes),
    );
    const expectedBackupIndexes = [
      "agent_sandbox_backups_admission_active_org_idx",
      "agent_sandbox_backups_admission_capture_history_idx",
      "agent_sandbox_backups_admission_capture_fallback_idx",
    ];
    expect(backupConfig.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining(expectedBackupIndexes),
    );
    const expectedSourceIndexes = [
      "agent_sandboxes_backup_admission_initial_frontier_idx",
      "agent_sandboxes_backup_admission_scheduled_frontier_idx",
      "agent_sandboxes_backup_admission_rpo_frontier_idx",
    ];
    expect(sandboxConfig.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining(expectedSourceIndexes),
    );

    const db = await database();
    const deployedConstraints = await db.query<{ name: string }>(`
      SELECT conname AS name FROM pg_constraint
      WHERE conrelid IN (
        'agent_backup_admission_enrollment_shards'::regclass,
        'agent_backup_admission_claim_shards'::regclass,
        'agent_backup_admission_work'::regclass
      )
    `);
    expect(deployedConstraints.rows.map(({ name }) => name)).toEqual(
      expect.arrayContaining(expectedConstraints),
    );
    const deployedIndexes = await db.query<{ name: string }>(`
      SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'agent_backup_admission_work'
    `);
    expect(deployedIndexes.rows.map(({ name }) => name)).toEqual(
      expect.arrayContaining(expectedWorkIndexes),
    );
    const deployedBackupIndexes = await db.query<{ name: string }>(`
      SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'agent_sandbox_backups'
    `);
    expect(deployedBackupIndexes.rows.map(({ name }) => name)).toEqual(
      expect.arrayContaining(expectedBackupIndexes),
    );
    const deployedSourceIndexes = await db.query<{ definition: string; name: string }>(`
      SELECT indexname AS name, indexdef AS definition FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'agent_sandboxes'
        AND indexname LIKE 'agent_sandboxes_backup_admission_%_frontier_idx'
      ORDER BY indexname
    `);
    expect(deployedSourceIndexes.rows.map(({ name }) => name)).toEqual(
      expect.arrayContaining(expectedSourceIndexes),
    );
    for (const { definition } of deployedSourceIndexes.rows) {
      expect(definition).toMatch(/get_byte\(uuid_send\(id\), 0\).*64/i);
      expect(definition).toMatch(/WHERE.*status.*running.*activation_phase.*active/is);
      expect(definition).toContain("'dedicated-lazy'");
      expect(definition).toContain("'dedicated-always'");
      expect(definition).toContain("'custom'");
      expect(definition).toMatch(/deleted_at IS NULL/i);
      expect(definition).toMatch(/deletion_attempt_id IS NULL/i);
      expect(definition).not.toContain("<> 'shared'");
    }
    const deployedClaimIndexes = await db.query<{ name: string }>(`
      SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'agent_backup_admission_claim_shards'
    `);
    expect(deployedClaimIndexes.rows.map(({ name }) => name)).toContain(
      "agent_backup_admission_claim_shards_turn_idx",
    );
    const indexShapes = await db.query<{
      name: string;
      columns: string;
      predicate: string | null;
      unique: boolean;
    }>(`
      SELECT index_relation.relname AS name,
        (SELECT string_agg(attribute.attname, ',' ORDER BY key.ordinality)
          FROM unnest(index_record.indkey) WITH ORDINALITY AS key(attnum, ordinality)
          JOIN pg_attribute attribute ON attribute.attrelid = index_record.indrelid
            AND attribute.attnum = key.attnum) AS columns,
        pg_get_expr(index_record.indpred, index_record.indrelid) AS predicate,
        index_record.indisunique AS unique
      FROM pg_index index_record
      JOIN pg_class index_relation ON index_relation.oid = index_record.indexrelid
      WHERE index_relation.relname IN (
        'agent_backup_admission_claim_shards_turn_idx',
        'agent_backup_admission_work_claim_scan_idx',
        'agent_backup_admission_work_deferred_ready_shard_idx',
        'agent_backup_admission_work_expired_lease_shard_idx',
        'agent_backup_admission_work_organization_idx',
        'agent_backup_admission_work_schedule_uidx',
        'agent_backup_admission_work_unsettled_schedule_uidx',
        'agent_sandbox_backups_admission_active_org_idx',
        'agent_sandbox_backups_admission_capture_history_idx',
        'agent_sandbox_backups_admission_capture_fallback_idx'
      )
      ORDER BY index_relation.relname
    `);
    expect(indexShapes.rows.map(({ name, columns }) => ({ name, columns }))).toEqual([
      {
        name: "agent_backup_admission_claim_shards_turn_idx",
        columns: "work_kind,last_turn,shard_id",
      },
      {
        name: "agent_backup_admission_work_claim_scan_idx",
        columns: "work_kind,shard_id,ready_cohort,cohort_ordinal,id",
      },
      {
        name: "agent_backup_admission_work_deferred_ready_shard_idx",
        columns: "work_kind,shard_id,not_before,id",
      },
      {
        name: "agent_backup_admission_work_expired_lease_shard_idx",
        columns: "work_kind,shard_id,lease_expires_at,id",
      },
      {
        name: "agent_backup_admission_work_organization_idx",
        columns: "organization_id,id",
      },
      {
        name: "agent_backup_admission_work_schedule_uidx",
        columns:
          "sandbox_id,node_history_id,source_activation_generation,source_lifecycle_revision,source_due_at",
      },
      {
        name: "agent_backup_admission_work_unsettled_schedule_uidx",
        columns: "sandbox_id,source_activation_generation,source_lifecycle_revision",
      },
      {
        name: "agent_sandbox_backups_admission_active_org_idx",
        columns: "catalog_organization_id",
      },
      {
        name: "agent_sandbox_backups_admission_capture_fallback_idx",
        columns: "source_node_record_id,source_node_incarnation",
      },
      {
        name: "agent_sandbox_backups_admission_capture_history_idx",
        columns: "source_node_history_id",
      },
    ]);
    const predicateByIndex = new Map(
      indexShapes.rows.map(({ name, predicate }) => [name, predicate]),
    );
    expect(predicateByIndex.get("agent_backup_admission_claim_shards_turn_idx")).toBeNull();
    expect(predicateByIndex.get("agent_backup_admission_work_claim_scan_idx")).toMatch(
      /state.*queued/i,
    );
    expect(predicateByIndex.get("agent_backup_admission_work_deferred_ready_shard_idx")).toMatch(
      /state.*deferred/i,
    );
    expect(predicateByIndex.get("agent_backup_admission_work_expired_lease_shard_idx")).toMatch(
      /state.*leased/i,
    );
    expect(predicateByIndex.get("agent_backup_admission_work_organization_idx")).toBeNull();
    expect(predicateByIndex.get("agent_backup_admission_work_schedule_uidx")).toMatch(
      /work_kind.*schedule_capture.*NOT.*state.*settled.*settled_reason.*RETRY_EXHAUSTED.*attempts.*12/is,
    );
    expect(
      indexShapes.rows.find(({ name }) => name === "agent_backup_admission_work_schedule_uidx")
        ?.unique,
    ).toBe(true);
    expect(predicateByIndex.get("agent_backup_admission_work_unsettled_schedule_uidx")).toMatch(
      /work_kind.*schedule_capture.*state.*settled/is,
    );
    expect(
      indexShapes.rows.find(
        ({ name }) => name === "agent_backup_admission_work_unsettled_schedule_uidx",
      )?.unique,
    ).toBe(true);
    expect(predicateByIndex.get("agent_sandbox_backups_admission_active_org_idx")).toMatch(
      /catalog_state.*scheduled.*capturing.*captured.*uploading.*primary_uploaded.*primary_verified.*secondary_pending.*failed_retryable/is,
    );
    for (const name of [
      "agent_sandbox_backups_admission_capture_history_idx",
      "agent_sandbox_backups_admission_capture_fallback_idx",
    ]) {
      expect(predicateByIndex.get(name)).toMatch(
        /catalog_state.*scheduled.*capturing.*failed_retryable.*catalog_resume_state.*scheduled.*capturing/is,
      );
    }
    expect(predicateByIndex.get("agent_sandbox_backups_admission_capture_history_idx")).toMatch(
      /source_node_history_id.*IS NOT NULL/i,
    );
    expect(predicateByIndex.get("agent_sandbox_backups_admission_capture_fallback_idx")).toMatch(
      /source_node_history_id.*IS NULL/i,
    );
    await db.exec("SET enable_seqscan = off");
    const explainIndex = async (selectSql: string): Promise<string> => {
      const explained = await db.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (FORMAT JSON, COSTS OFF) ${selectSql}`,
      );
      return JSON.stringify(explained.rows);
    };
    expect(
      await explainIndex(`SELECT 1 FROM agent_backup_admission_work
        WHERE organization_id = '${ORG_A}' ORDER BY id`),
    ).toContain("agent_backup_admission_work_organization_idx");
    expect(
      await explainIndex(`SELECT 1 FROM agent_backup_admission_work
        WHERE work_kind = 'schedule_capture' AND sandbox_id = '${SANDBOX_A}'
          AND source_activation_generation = '${ACTIVATION}'
          AND source_lifecycle_revision = 7 AND state <> 'settled'`),
    ).toContain("agent_backup_admission_work_unsettled_schedule_uidx");
    expect(
      await explainIndex(`SELECT 1 FROM agent_backup_admission_work
        WHERE work_kind = 'schedule_capture' AND sandbox_id = '${SANDBOX_A}'
          AND node_history_id = '${HISTORY_A}'
          AND source_activation_generation = '${ACTIVATION}'
          AND source_lifecycle_revision = 7 AND source_due_at = '${DUE}'
          AND NOT (state = 'settled' AND settled_reason = 'RETRY_EXHAUSTED'
            AND attempts = 12)`),
    ).toContain("agent_backup_admission_work_schedule_uidx");
    expect(
      await explainIndex(`SELECT 1 FROM agent_sandbox_backups
        WHERE catalog_organization_id = '${ORG_A}'
          AND catalog_state IN (
            'scheduled', 'capturing', 'captured', 'uploading', 'primary_uploaded',
            'primary_verified', 'secondary_pending', 'failed_retryable'
          )`),
    ).toContain("agent_sandbox_backups_admission_active_org_idx");
    expect(
      await explainIndex(`SELECT 1 FROM agent_sandbox_backups
        WHERE source_node_history_id = '${HISTORY_A}'
          AND (catalog_state IN ('scheduled', 'capturing')
            OR (catalog_state = 'failed_retryable'
              AND catalog_resume_state IN ('scheduled', 'capturing')))`),
    ).toContain("agent_sandbox_backups_admission_capture_history_idx");
    expect(
      await explainIndex(`SELECT 1 FROM agent_sandbox_backups
        WHERE source_node_history_id IS NULL
          AND source_node_record_id = '70000000-0000-4000-8000-000000000001'
          AND source_node_incarnation = '${HISTORY_A}'
          AND (catalog_state IN ('scheduled', 'capturing')
            OR (catalog_state = 'failed_retryable'
              AND catalog_resume_state IN ('scheduled', 'capturing')))`),
    ).toContain("agent_sandbox_backups_admission_capture_fallback_idx");
    const addedGcIndexes = await db.query<{ name: string }>(`
      SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'agent_backup_gc_outbox'
        AND indexname = 'agent_backup_gc_outbox_tenant_identity_uidx'
    `);
    expect(addedGcIndexes.rows).toHaveLength(0);
  });

  test("replays without resetting frozen enrollment or claim progress", async () => {
    const db = await database();
    const historicalSources = await db.query<{
      table_name: string;
      total: number;
      sentinel: number;
    }>(`
      SELECT 'agent_sandboxes' AS table_name, count(*)::int AS total,
        count(*) FILTER (WHERE backup_admission_xid = '0'::xid8)::int AS sentinel
      FROM agent_sandboxes
      UNION ALL
      SELECT 'docker_nodes', count(*)::int,
        count(*) FILTER (WHERE backup_admission_xid = '0'::xid8)::int
      FROM docker_nodes
      ORDER BY table_name
    `);
    expect(historicalSources.rows).toEqual([
      { table_name: "agent_sandboxes", total: 3, sentinel: 3 },
      { table_name: "docker_nodes", total: 2, sentinel: 2 },
    ]);
    const sourceDefaults = await db.query<{
      table_name: string;
      is_not_null: boolean;
      default_sql: string;
    }>(`
      SELECT relation.relname AS table_name, attribute.attnotnull AS is_not_null,
        pg_get_expr(default_value.adbin, default_value.adrelid) AS default_sql
      FROM pg_attribute attribute
      JOIN pg_class relation ON relation.oid = attribute.attrelid
      JOIN pg_attrdef default_value ON default_value.adrelid = attribute.attrelid
        AND default_value.adnum = attribute.attnum
      WHERE relation.relname IN ('agent_sandboxes', 'docker_nodes')
        AND attribute.attname = 'backup_admission_xid'
      ORDER BY relation.relname
    `);
    expect(sourceDefaults.rows).toEqual([
      { table_name: "agent_sandboxes", is_not_null: true, default_sql: "pg_current_xact_id()" },
      { table_name: "docker_nodes", is_not_null: true, default_sql: "pg_current_xact_id()" },
    ]);

    const counts = await db.query<{ kind: string; count: number }>(`
      SELECT work_kind AS kind, count(*)::int AS count
      FROM agent_backup_admission_enrollment_shards GROUP BY work_kind ORDER BY work_kind
    `);
    expect(counts.rows).toEqual([
      { kind: "catalog_operation", count: 64 },
      { kind: "gc_object", count: 64 },
      { kind: "schedule_capture", count: 64 },
    ]);
    const claimCounts = await db.query<{ kind: string; count: number }>(`
      SELECT work_kind AS kind, count(*)::int AS count
      FROM agent_backup_admission_claim_shards GROUP BY work_kind ORDER BY work_kind
    `);
    expect(claimCounts.rows).toEqual(counts.rows);

    await db.exec(`UPDATE agent_backup_admission_enrollment_shards
      SET scan_cutoff_at = clock_timestamp(), scan_snapshot = pg_current_snapshot(),
        scan_schedule_rpo_ms = 900000,
        active_cohort = nextval('agent_backup_admission_cohort_seq'),
        lease_owner = 'migration-test',
        lease_generation = '91000000-0000-4000-8000-000000000001',
        lease_expires_at = clock_timestamp() + interval '1 minute'
      WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
    await db.exec(`UPDATE agent_backup_admission_claim_shards
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
        cycle_observed_at = clock_timestamp(), cycle_max_cohort = 42,
        cycle_max_ordinal = 99,
        cycle_max_id = '80000000-0000-4fff-bfff-ffffffffffff',
        cycle_aging_interval_ms = 900000, priority_pass = 0,
        updated_at = clock_timestamp()
      WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
    await expect(
      db.exec(`UPDATE agent_backup_admission_claim_shards
        SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          scan_cursor_cohort = 1
        WHERE work_kind = 'schedule_capture' AND shard_id = 32`),
    ).rejects.toThrow();
    await db.exec(`UPDATE agent_backup_admission_claim_shards
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
        scan_cursor_cohort = 1, scan_cursor_ordinal = 0,
        scan_cursor_id = '80000000-0000-4000-8000-000000000001',
        updated_at = clock_timestamp()
      WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
    await expect(
      db.exec(`UPDATE agent_backup_admission_enrollment_shards
        SET scan_cursor_due_at = scan_cutoff_at,
          scan_cursor_id = '21000000-0000-4000-8000-000000000001',
          scan_cursor_ordinal = 0,
          lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL
        WHERE work_kind = 'schedule_capture' AND shard_id = 32`),
    ).rejects.toThrow(/scan_shape_check/i);

    const before = await db.query<{ xid: string }>(`
      SELECT backup_admission_xid::text AS xid FROM agent_sandboxes WHERE id = '${SANDBOX_A}'
    `);
    await db.exec(`UPDATE agent_sandboxes SET backup_admission_xid = '1'::xid8
      WHERE id = '${SANDBOX_A}'`);
    const spoofed = await db.query<{ xid: string }>(`
      SELECT backup_admission_xid::text AS xid FROM agent_sandboxes WHERE id = '${SANDBOX_A}'
    `);
    expect(spoofed.rows).toEqual(before.rows);
    await db.exec(`UPDATE agent_sandboxes SET next_backup_at = next_backup_at + interval '1 second'
      WHERE id = '${SANDBOX_A}'`);
    const frozen = await db.query<{ visible: boolean }>(`
      SELECT agent_backup_admission_source_visible(
        s.backup_admission_xid, shard.scan_snapshot
      ) AS visible
      FROM agent_sandboxes s JOIN agent_backup_admission_enrollment_shards shard
        ON shard.work_kind = 'schedule_capture' AND shard.shard_id = 32
      WHERE s.id = '${SANDBOX_A}'
    `);
    expect(frozen.rows).toEqual([{ visible: false }]);

    await applyAll(db);
    const replayed = await db.query<{ total: number; active: number }>(`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE active_cohort IS NOT NULL)::int AS active
      FROM agent_backup_admission_enrollment_shards
    `);
    expect(replayed.rows).toEqual([{ total: 192, active: 1 }]);
    const replayedClaim = await db.query<{
      total: number;
      active: number;
      last_turn: string;
      max_cohort: string;
      max_ordinal: number;
      max_id: string;
      cursor_cohort: string;
    }>(`
      SELECT (SELECT count(*)::int FROM agent_backup_admission_claim_shards) AS total,
        (SELECT count(*)::int FROM agent_backup_admission_claim_shards
          WHERE cycle_observed_at IS NOT NULL) AS active,
        last_turn::text AS last_turn, cycle_max_cohort::text AS max_cohort,
        cycle_max_ordinal AS max_ordinal, cycle_max_id::text AS max_id,
        scan_cursor_cohort::text AS cursor_cohort
      FROM agent_backup_admission_claim_shards
      WHERE work_kind = 'schedule_capture' AND shard_id = 32
    `);
    expect(replayedClaim.rows).toEqual([
      {
        total: 192,
        active: 1,
        last_turn: "3",
        max_cohort: "42",
        max_ordinal: 99,
        max_id: "80000000-0000-4fff-bfff-ffffffffffff",
        cursor_cohort: "1",
      },
    ]);
    await expect(
      db.exec(`UPDATE agent_backup_admission_claim_shards
        SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          scan_cursor_cohort = 0
        WHERE work_kind = 'schedule_capture' AND shard_id = 32`),
    ).rejects.toThrow(/cursor must advance/i);
    await expect(
      db.exec(`DELETE FROM agent_backup_admission_claim_shards
        WHERE work_kind = 'schedule_capture' AND shard_id = 32`),
    ).rejects.toThrow(/cannot be removed/i);
  });

  test("keeps source sharding distinct from opaque claim work IDs", async () => {
    const db = await database();
    const WORK = "80000000-0000-4000-8000-000000000041";
    const clock = await db.query<{ before: string; due: string; deadline: string }>(`
      SELECT statement_timestamp()::text AS before,
        (statement_timestamp() - interval '1 hour')::text AS due,
        (statement_timestamp() - interval '45 minutes')::text AS deadline
    `);
    const timing = clock.rows[0];
    if (!timing) throw new Error("database clock fixture is missing");
    const shards = await db.query<{ source_shard: number; work_id_hash: number }>(`
      SELECT agent_backup_admission_expected_shard('${SANDBOX_A}') AS source_shard,
        agent_backup_admission_expected_shard('${WORK}') AS work_id_hash
    `);
    expect(shards.rows).toEqual([{ source_shard: 32, work_id_hash: 0 }]);
    await expect(
      insertSchedule(db, WORK, ORG_A, SANDBOX_A, HISTORY_A, {
        sourceDue: timing.due,
        rpoDeadline: timing.deadline,
        notBefore: timing.due,
        shardId: 0,
      }),
    ).rejects.toThrow(/agent_backup_admission_work_counters_check/i);
    await insertSchedule(db, WORK, ORG_A, SANDBOX_A, HISTORY_A, {
      sourceDue: timing.due,
      rpoDeadline: timing.deadline,
      notBefore: timing.due,
    });
    await startScheduleClaimCycle(db, { maxCohort: 1, maxOrdinal: 0, maxId: WORK });
    const authority = await db.query<{ database_owned: boolean; max_id: string }>(
      `SELECT cycle_observed_at >= $1::timestamptz
          AND cycle_observed_at <= statement_timestamp() AS database_owned,
          cycle_max_id::text AS max_id
        FROM agent_backup_admission_claim_shards
        WHERE work_kind = 'schedule_capture' AND shard_id = 32`,
      [timing.before],
    );
    expect(authority.rows).toEqual([{ database_owned: true, max_id: WORK }]);
    await db.exec(`UPDATE agent_backup_admission_claim_shards
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
        scan_cursor_cohort = 1, scan_cursor_ordinal = 0, scan_cursor_id = '${WORK}'
      WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
    await db.exec(`UPDATE agent_backup_admission_work
      SET state = 'leased', lease_owner = 'opaque-work-id',
        lease_generation = '93000000-0000-4000-8000-000000000041',
        lease_expires_at = statement_timestamp() + interval '1 hour', attempts = attempts + 1
      WHERE id = '${WORK}'`);
    const proof = await db.query<{
      work_id: string;
      max_id: string;
      cursor_id: string;
      work_shard: number;
      proof_pass: number;
      effective_priority: number;
    }>(`SELECT work.id::text AS work_id, shard.cycle_max_id::text AS max_id,
        shard.scan_cursor_id::text AS cursor_id, work.shard_id AS work_shard,
        work.claim_proof_priority_pass AS proof_pass,
        agent_backup_admission_effective_priority(work.base_priority,
          work.first_eligible_at, shard.cycle_observed_at,
          shard.cycle_aging_interval_ms) AS effective_priority
      FROM agent_backup_admission_work work
      JOIN agent_backup_admission_claim_shards shard
        ON shard.work_kind = work.work_kind AND shard.shard_id = work.shard_id
      WHERE work.id = '${WORK}'`);
    expect(proof.rows).toEqual([
      {
        work_id: WORK,
        max_id: WORK,
        cursor_id: WORK,
        work_shard: 32,
        proof_pass: 0,
        effective_priority: 0,
      },
    ]);
    const functionAuthority = await db.query<{ volatility: string; parallel: string }>(`
      SELECT provolatile::text AS volatility, proparallel::text AS parallel
      FROM pg_proc WHERE proname = 'agent_backup_admission_effective_priority'
    `);
    expect(functionAuthority.rows).toEqual([{ volatility: "i", parallel: "s" }]);
  });

  test("rejects future readiness and a fresh base-three item at pass zero", async () => {
    const futureDb = await database();
    const FUTURE_WORK = "80000000-0000-4000-8000-000000000042";
    const futureClock = await futureDb.query<{
      due: string;
      deadline: string;
      not_before: string;
    }>(`SELECT (statement_timestamp() - interval '1 hour')::text AS due,
        (statement_timestamp() - interval '45 minutes')::text AS deadline,
        (statement_timestamp() + interval '1 hour')::text AS not_before`);
    const futureTiming = futureClock.rows[0];
    if (!futureTiming) throw new Error("future readiness fixture is missing");
    await insertSchedule(futureDb, FUTURE_WORK, ORG_A, SANDBOX_A, HISTORY_A, {
      sourceDue: futureTiming.due,
      rpoDeadline: futureTiming.deadline,
      notBefore: futureTiming.not_before,
    });
    await startScheduleClaimCycle(futureDb, {
      maxCohort: 1,
      maxOrdinal: 0,
      maxId: FUTURE_WORK,
    });
    await expect(
      futureDb.exec(`UPDATE agent_backup_admission_work
        SET state = 'leased', lease_owner = 'future-work',
          lease_generation = '93000000-0000-4000-8000-000000000042',
          lease_expires_at = statement_timestamp() + interval '2 hours',
          attempts = attempts + 1 WHERE id = '${FUTURE_WORK}'`),
    ).rejects.toThrow(/claim requires ready work/i);

    const freshDb = await database();
    const FRESH_WORK = "80000000-0000-4000-8000-000000000043";
    const freshClock = await freshDb.query<{ due: string; deadline: string }>(`
      SELECT statement_timestamp()::text AS due,
        (statement_timestamp() + interval '15 minutes')::text AS deadline
    `);
    const freshTiming = freshClock.rows[0];
    if (!freshTiming) throw new Error("fresh priority fixture is missing");
    await insertSchedule(freshDb, FRESH_WORK, ORG_A, SANDBOX_A, HISTORY_A, {
      sourceDue: freshTiming.due,
      rpoDeadline: freshTiming.deadline,
      notBefore: freshTiming.due,
    });
    await startScheduleClaimCycle(freshDb, {
      maxCohort: 1,
      maxOrdinal: 0,
      maxId: FRESH_WORK,
    });
    const freshEligibility = await freshDb.query<{
      base_priority: number;
      age_ms: number;
      effective_priority: number;
    }>(`SELECT work.base_priority,
        EXTRACT(EPOCH FROM (shard.cycle_observed_at - work.first_eligible_at)) * 1000
          AS age_ms,
        agent_backup_admission_effective_priority(work.base_priority,
          work.first_eligible_at, shard.cycle_observed_at,
          shard.cycle_aging_interval_ms) AS effective_priority
      FROM agent_backup_admission_work work
      JOIN agent_backup_admission_claim_shards shard
        ON shard.work_kind = work.work_kind AND shard.shard_id = work.shard_id
      WHERE work.id = '${FRESH_WORK}'`);
    expect(freshEligibility.rows[0]).toMatchObject({ base_priority: 3, effective_priority: 3 });
    await expect(
      freshDb.exec(`UPDATE agent_backup_admission_work
        SET state = 'leased', lease_owner = 'wrong-pass',
          lease_generation = '93000000-0000-4000-8000-000000000043',
          lease_expires_at = statement_timestamp() + interval '1 hour',
          attempts = attempts + 1 WHERE id = '${FRESH_WORK}'`),
    ).rejects.toThrow(/exact effective priority pass/i);
    const rolledBack = await freshDb.query<{
      state: string;
      attempts: number;
      proof: string | null;
    }>(`SELECT state, attempts, claim_proof_turn::text AS proof
      FROM agent_backup_admission_work WHERE id = '${FRESH_WORK}'`);
    expect(rolledBack.rows).toEqual([{ state: "queued", attempts: 0, proof: null }]);
  });

  test("enforces monotonic claim turns, frozen cycles, and complete priority passes", async () => {
    const db = await database();
    await expect(
      db.exec(`UPDATE agent_backup_admission_claim_shards
        SET shard_id = 64, last_turn = nextval('agent_backup_admission_claim_turn_seq')
        WHERE work_kind = 'schedule_capture' AND shard_id = 32`),
    ).rejects.toThrow(/identity is immutable/i);
    await expect(
      db.exec(`UPDATE agent_backup_admission_claim_shards SET last_turn = last_turn
        WHERE work_kind = 'schedule_capture' AND shard_id = 32`),
    ).rejects.toThrow(/turn must advance/i);
    await expect(
      db.exec(`UPDATE agent_backup_admission_claim_shards
        SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          cycle_observed_at = clock_timestamp(), cycle_max_cohort = 1,
          cycle_max_ordinal = 0,
          cycle_max_id = '1f000000-0000-4fff-bfff-ffffffffffff',
          cycle_aging_interval_ms = 900000, priority_pass = 0,
          last_admitted_work_id = '1f000000-0000-4000-8000-000000000001'
        WHERE work_kind = 'schedule_capture' AND shard_id = 31`),
    ).rejects.toThrow(/start at its first pass/i);
    await db.exec(`UPDATE agent_backup_admission_claim_shards
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
        cycle_observed_at = '2000-01-01 00:00:00+00', cycle_max_cohort = 42,
        cycle_max_ordinal = 99,
        cycle_max_id = '80000000-0000-4fff-bfff-ffffffffffff',
        cycle_aging_interval_ms = 900000, priority_pass = 0
      WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
    await expect(
      db.exec(`UPDATE agent_backup_admission_claim_shards
        SET last_turn = nextval('agent_backup_admission_claim_turn_seq'), cycle_max_cohort = 43
        WHERE work_kind = 'schedule_capture' AND shard_id = 32`),
    ).rejects.toThrow(/cycle authority is immutable/i);
    await expect(
      db.exec(`UPDATE agent_backup_admission_claim_shards
        SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          scan_cursor_cohort = 42, scan_cursor_ordinal = 100,
          scan_cursor_id = '80000000-0000-4000-8000-000000000001'
        WHERE work_kind = 'schedule_capture' AND shard_id = 32`),
    ).rejects.toThrow(/cycle_shape_check/i);
    await db.exec(`UPDATE agent_backup_admission_claim_shards
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
        scan_cursor_cohort = 10, scan_cursor_ordinal = 2,
        scan_cursor_id = '80000000-0000-4000-8000-000000000001'
      WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
    await expect(
      db.exec(`UPDATE agent_backup_admission_claim_shards
        SET last_turn = nextval('agent_backup_admission_claim_turn_seq'), priority_pass = 1
        WHERE work_kind = 'schedule_capture' AND shard_id = 32`),
    ).rejects.toThrow(/must reset its cursor/i);
    await db.exec(`UPDATE agent_backup_admission_claim_shards
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
        scan_cursor_cohort = cycle_max_cohort, scan_cursor_ordinal = cycle_max_ordinal,
        scan_cursor_id = cycle_max_id
      WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
    await db.exec(`UPDATE agent_backup_admission_claim_shards
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'), priority_pass = 1,
        scan_cursor_cohort = NULL, scan_cursor_ordinal = NULL, scan_cursor_id = NULL
      WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
    await expect(
      db.exec(`UPDATE agent_backup_admission_claim_shards
        SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          cycle_observed_at = NULL, cycle_max_cohort = NULL, cycle_max_ordinal = NULL,
          cycle_max_id = NULL, cycle_aging_interval_ms = NULL, priority_pass = NULL
        WHERE work_kind = 'schedule_capture' AND shard_id = 32`),
    ).rejects.toThrow(/before its final pass/i);
    await db.exec(`UPDATE agent_backup_admission_claim_shards
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
        scan_cursor_cohort = cycle_max_cohort, scan_cursor_ordinal = cycle_max_ordinal,
        scan_cursor_id = cycle_max_id
      WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
    await db.exec(`UPDATE agent_backup_admission_claim_shards
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'), priority_pass = 2,
        scan_cursor_cohort = NULL, scan_cursor_ordinal = NULL, scan_cursor_id = NULL
      WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
    await db.exec(`UPDATE agent_backup_admission_claim_shards
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
        scan_cursor_cohort = cycle_max_cohort, scan_cursor_ordinal = cycle_max_ordinal,
        scan_cursor_id = cycle_max_id
      WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
    await db.exec(`UPDATE agent_backup_admission_claim_shards
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'), priority_pass = 3,
        scan_cursor_cohort = NULL, scan_cursor_ordinal = NULL, scan_cursor_id = NULL
      WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
    await expect(
      db.exec(`UPDATE agent_backup_admission_claim_shards
        SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
          cycle_observed_at = NULL, cycle_max_cohort = NULL, cycle_max_ordinal = NULL,
          cycle_max_id = NULL, cycle_aging_interval_ms = NULL, priority_pass = NULL
        WHERE work_kind = 'schedule_capture' AND shard_id = 32`),
    ).rejects.toThrow(/final pass and high-water/i);
    await db.exec(`UPDATE agent_backup_admission_claim_shards
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
        scan_cursor_cohort = cycle_max_cohort, scan_cursor_ordinal = cycle_max_ordinal,
        scan_cursor_id = cycle_max_id
      WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
    await db.exec(`UPDATE agent_backup_admission_claim_shards
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
        cycle_observed_at = NULL, cycle_max_cohort = NULL, cycle_max_ordinal = NULL,
        cycle_max_id = NULL, cycle_aging_interval_ms = NULL, priority_pass = NULL,
        scan_cursor_cohort = NULL, scan_cursor_ordinal = NULL, scan_cursor_id = NULL
      WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
    await db.exec(`UPDATE agent_backup_admission_claim_shards
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
        cycle_observed_at = clock_timestamp(), cycle_max_cohort = 1,
        cycle_max_ordinal = 0, cycle_max_id = '80000000-0000-4fff-bfff-ffffffffffff',
        cycle_aging_interval_ms = 900000, priority_pass = 0
      WHERE work_kind = 'gc_object' AND shard_id = 0`);
    await expect(db.exec(`TRUNCATE agent_backup_admission_claim_shards`)).rejects.toThrow(
      /cannot be removed/i,
    );
  });

  test("accepts only a fresh exact queued-to-leased proof for claim-cycle restart", async () => {
    const db = await database();
    const WORK = "80000000-0000-4000-8000-000000000011";
    await insertSchedule(db, WORK, ORG_A, SANDBOX_A, HISTORY_A);
    await startScheduleClaimCycle(db);
    await db.exec(`UPDATE agent_backup_admission_claim_shards
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
        scan_cursor_cohort = 1, scan_cursor_ordinal = 0,
        scan_cursor_id = '${WORK}'
      WHERE work_kind = 'schedule_capture' AND shard_id = 32`);

    await db.exec(`UPDATE agent_backup_admission_work
      SET state = 'leased', lease_owner = 'partial-claim',
        lease_generation = '93000000-0000-4000-8000-000000000001',
        lease_expires_at = clock_timestamp() + interval '1 hour', attempts = attempts + 1
      WHERE id = '${WORK}'`);
    const staleProof = await db.query<{
      cycle: string;
      proof: string;
      xid: string;
      pass: number;
      attempt: number;
    }>(`SELECT claim_cycle_start_turn::text AS cycle, claim_proof_turn::text AS proof,
        claim_proof_xid::text AS xid, claim_proof_priority_pass AS pass,
        claim_proof_attempt AS attempt
      FROM agent_backup_admission_work WHERE id = '${WORK}'`);
    expect(staleProof.rows[0]).toMatchObject({ pass: 0, attempt: 1 });
    await db.exec(`UPDATE agent_backup_admission_work
      SET lease_expires_at = lease_expires_at + interval '1 minute'
      WHERE id = '${WORK}'`);
    const heartbeatProof = await db.query<{
      cycle: string;
      proof: string;
      xid: string;
      pass: number;
      attempt: number;
    }>(`SELECT claim_cycle_start_turn::text AS cycle, claim_proof_turn::text AS proof,
        claim_proof_xid::text AS xid, claim_proof_priority_pass AS pass,
        claim_proof_attempt AS attempt
      FROM agent_backup_admission_work WHERE id = '${WORK}'`);
    expect(heartbeatProof.rows).toEqual(staleProof.rows);
    await expect(
      db.exec(`UPDATE agent_backup_admission_work
        SET claim_proof_xid = pg_current_xact_id() WHERE id = '${WORK}'`),
    ).rejects.toThrow(/proof changes only on queued to leased/i);

    await expect(
      db.transaction(async (tx) => {
        await tx.exec(`UPDATE agent_backup_admission_work
          SET lease_expires_at = lease_expires_at + interval '1 minute'
          WHERE id = '${WORK}'`);
        await tx.exec(`UPDATE agent_backup_admission_claim_shards
          SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
            priority_pass = 0, scan_cursor_cohort = NULL,
            scan_cursor_ordinal = NULL, scan_cursor_id = NULL,
            last_admitted_work_id = '${WORK}',
            last_admission_proof_turn = (
              SELECT claim_proof_turn FROM agent_backup_admission_work WHERE id = '${WORK}'
            )
          WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
      }),
    ).rejects.toThrow(/same-transaction admission proof/i);
    const unchangedProof = await db.query<{ proof: string; xid: string }>(`
      SELECT claim_proof_turn::text AS proof, claim_proof_xid::text AS xid
      FROM agent_backup_admission_work WHERE id = '${WORK}'`);
    expect(unchangedProof.rows).toEqual(
      heartbeatProof.rows.map(({ proof, xid }) => ({ proof, xid })),
    );

    await db.exec(`UPDATE agent_backup_admission_work
      SET state = 'queued', lease_owner = NULL, lease_generation = NULL,
        lease_expires_at = NULL, not_before = clock_timestamp(), ready_cohort = ready_cohort + 1
      WHERE id = '${WORK}'`);
    await expect(
      db.transaction(async (tx) => {
        await tx.exec(`UPDATE agent_backup_admission_work
          SET state = 'leased', lease_owner = 'expiring-claim',
            lease_generation = '93000000-0000-4000-8000-000000000004',
            lease_expires_at = clock_timestamp() + interval '25 milliseconds',
            attempts = attempts + 1
          WHERE id = '${WORK}'`);
        const proof = await tx.query<{ turn: string }>(`
          SELECT claim_proof_turn::text AS turn
          FROM agent_backup_admission_work WHERE id = '${WORK}'`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await tx.exec(`UPDATE agent_backup_admission_claim_shards
          SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
            priority_pass = 0, scan_cursor_cohort = NULL,
            scan_cursor_ordinal = NULL, scan_cursor_id = NULL,
            last_admitted_work_id = '${WORK}',
            last_admission_proof_turn = ${proof.rows[0]?.turn}
          WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
      }),
    ).rejects.toThrow(/same-transaction admission proof/i);
    const expiredAdmissionRollback = await db.query<{ attempts: number; state: string }>(`
      SELECT attempts, state FROM agent_backup_admission_work WHERE id = '${WORK}'`);
    expect(expiredAdmissionRollback.rows).toEqual([{ attempts: 1, state: "queued" }]);

    const claimAndRestart = async (generation: string): Promise<string> =>
      await db.transaction(async (tx) => {
        await tx.exec(`UPDATE agent_backup_admission_work
          SET state = 'leased', lease_owner = 'real-claim',
            lease_generation = '${generation}',
            lease_expires_at = clock_timestamp() + interval '1 hour', attempts = attempts + 1
          WHERE id = '${WORK}'`);
        const proof = await tx.query<{ turn: string }>(`
          SELECT claim_proof_turn::text AS turn
          FROM agent_backup_admission_work WHERE id = '${WORK}'`);
        await tx.exec(`UPDATE agent_backup_admission_claim_shards
          SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
            priority_pass = 0, scan_cursor_cohort = NULL,
            scan_cursor_ordinal = NULL, scan_cursor_id = NULL,
            last_admitted_work_id = '${WORK}',
            last_admission_proof_turn = ${proof.rows[0]?.turn}
          WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
        return proof.rows[0]?.turn ?? "";
      });
    const firstConsumedProof = await claimAndRestart("93000000-0000-4000-8000-000000000002");
    expect(BigInt(firstConsumedProof)).toBeGreaterThan(BigInt(staleProof.rows[0]?.proof ?? "0"));

    await db.exec(`UPDATE agent_backup_admission_claim_shards
      SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
        scan_cursor_cohort = 2, scan_cursor_ordinal = 0,
        scan_cursor_id = '${WORK}'
      WHERE work_kind = 'schedule_capture' AND shard_id = 32`);
    await db.exec(`UPDATE agent_backup_admission_work
      SET state = 'queued', lease_owner = NULL, lease_generation = NULL,
        lease_expires_at = NULL, not_before = clock_timestamp(), ready_cohort = ready_cohort + 1
      WHERE id = '${WORK}'`);
    const sameWorkNextProof = await claimAndRestart("93000000-0000-4000-8000-000000000003");
    const consumed = await db.query<{
      work_id: string;
      proof: string;
      attempt: number;
    }>(`SELECT shard.last_admitted_work_id::text AS work_id,
        shard.last_admission_proof_turn::text AS proof, work.claim_proof_attempt AS attempt
      FROM agent_backup_admission_claim_shards shard
      JOIN agent_backup_admission_work work ON work.id = shard.last_admitted_work_id
      WHERE shard.work_kind = 'schedule_capture' AND shard.shard_id = 32`);
    expect(consumed.rows).toEqual([{ work_id: WORK, proof: sameWorkNextProof, attempt: 3 }]);
    expect(BigInt(sameWorkNextProof)).toBeGreaterThan(BigInt(firstConsumedProof));
  });

  test("enforces replay identities, explicit states, exact lanes, and lease fences", async () => {
    const db = await database();
    const WORK_A = "80000000-0000-4000-8000-000000000001";
    const WORK_B = "80000000-0000-4000-8000-000000000002";
    const WORK_C = "80000000-0000-4000-8000-000000000003";
    await startScheduleClaimCycle(db);
    await insertSchedule(db, WORK_A, ORG_A, SANDBOX_A, HISTORY_A);
    await expect(
      insertSchedule(db, "80000000-0000-4000-8000-000000000004", ORG_A, SANDBOX_A, HISTORY_A),
    ).rejects.toThrow();
    await insertSchedule(db, WORK_B, ORG_A, SANDBOX_B, HISTORY_B);
    await insertSchedule(db, WORK_C, ORG_B, SANDBOX_C, HISTORY_A);
    await expect(
      insertSchedule(db, "80000000-0000-4000-8000-000000000005", ORG_A, SANDBOX_A, HISTORY_B),
    ).rejects.toThrow(/unsettled_schedule_uidx/i);

    await expect(
      db.exec(`UPDATE agent_backup_admission_work
        SET state = 'leased', lease_owner = 'expired-claim',
          lease_generation = '90000000-0000-4000-8000-000000000006',
          lease_expires_at = clock_timestamp() - interval '1 second', attempts = attempts + 1
        WHERE id = '${WORK_B}'`),
    ).rejects.toThrow(/claim requires a live lease/i);
    await db.exec(`UPDATE agent_backup_admission_work
      SET state = 'leased', lease_owner = 'expired-heartbeat',
        lease_generation = '90000000-0000-4000-8000-000000000007',
        lease_expires_at = clock_timestamp() + interval '50 milliseconds', attempts = attempts + 1
      WHERE id = '${WORK_B}'`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(
      db.exec(`UPDATE agent_backup_admission_work
        SET lease_expires_at = clock_timestamp() + interval '1 hour'
        WHERE id = '${WORK_B}'`),
    ).rejects.toThrow(/expired.*lease cannot be renewed/i);
    await db.exec(`UPDATE agent_backup_admission_work
      SET state = 'queued', lease_owner = NULL, lease_generation = NULL,
        lease_expires_at = NULL, not_before = clock_timestamp(), ready_cohort = ready_cohort + 1
      WHERE id = '${WORK_B}'`);

    await expect(
      db.exec(`UPDATE agent_backup_admission_work
        SET state = 'deferred', deferred_reason = 'capacity_wait'
        WHERE id = '${WORK_B}'`),
    ).rejects.toThrow(/state_shape_check/i);
    await expect(
      db.exec(`UPDATE agent_backup_admission_work
        SET state = 'leased', lease_owner = 'worker-a',
          lease_generation = '90000000-0000-4000-8000-000000000001',
          lease_expires_at = clock_timestamp() + interval '1 hour'
        WHERE id = '${WORK_A}'`),
    ).rejects.toThrow();
    await db.exec(`UPDATE agent_backup_admission_work
      SET state = 'leased', lease_owner = 'worker-a',
        lease_generation = '90000000-0000-4000-8000-000000000001',
        lease_expires_at = clock_timestamp() + interval '1 hour', attempts = attempts + 1
      WHERE id = '${WORK_A}'`);
    await expect(
      db.exec(`UPDATE agent_backup_admission_work
        SET state = 'leased', lease_owner = 'worker-b',
          lease_generation = '90000000-0000-4000-8000-000000000002',
          lease_expires_at = clock_timestamp() + interval '1 hour', attempts = attempts + 1
        WHERE id = '${WORK_B}'`),
    ).rejects.toThrow(/leased_organization_uidx/i);
    await expect(
      db.exec(`UPDATE agent_backup_admission_work
        SET state = 'leased', lease_owner = 'worker-c',
          lease_generation = '90000000-0000-4000-8000-000000000003',
          lease_expires_at = clock_timestamp() + interval '1 hour', attempts = attempts + 1
        WHERE id = '${WORK_C}'`),
    ).rejects.toThrow(/leased_node_uidx/i);
    await expect(
      db.exec(`UPDATE agent_backup_admission_work
        SET lease_generation = '90000000-0000-4000-8000-000000000004'
        WHERE id = '${WORK_A}'`),
    ).rejects.toThrow(/preserve its fence/i);
    await expect(
      db.exec(`UPDATE agent_backup_admission_work SET source_due_at = source_due_at - interval '1 second'
        WHERE id = '${WORK_A}'`),
    ).rejects.toThrow(/identity is immutable/i);
    await expect(
      db.exec(`UPDATE agent_backup_admission_work
        SET id = '80000000-0000-4000-8000-000000000099' WHERE id = '${WORK_A}'`),
    ).rejects.toThrow(/identity is immutable/i);
    await expect(
      db.exec(`DELETE FROM agent_backup_admission_work WHERE id = '${WORK_B}'`),
    ).rejects.toThrow(/unsettled/i);
    await db.exec(`UPDATE agent_backup_admission_work SET state = 'settled',
      lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL,
      settled_at = clock_timestamp(), settled_reason = 'CAPTURE_RESERVED'
      WHERE id = '${WORK_A}'`);
    await expect(
      db.exec(`UPDATE agent_backup_admission_work SET updated_at = clock_timestamp()
        WHERE id = '${WORK_A}'`),
    ).rejects.toThrow(/settled.*immutable/i);
    await insertSchedule(db, "80000000-0000-4000-8000-000000000005", ORG_A, SANDBOX_A, HISTORY_B);
  });

  test("preserves exhausted retry epochs without disabling the exact due backup", async () => {
    const db = await database();
    const exhaustedWork = "80000000-0000-4000-8000-000000000101";
    const freshWork = "80000000-0000-4000-8000-000000000102";
    await startScheduleClaimCycle(db);
    await insertSchedule(db, exhaustedWork, ORG_A, SANDBOX_A, HISTORY_A);

    await expect(
      db.exec(`UPDATE agent_backup_admission_work
        SET state = 'settled', settled_at = clock_timestamp(),
          settled_reason = 'RETRY_EXHAUSTED'
        WHERE id = '${exhaustedWork}'`),
    ).rejects.toThrow(/retry_exhaustion_check/i);

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      await db.exec(`UPDATE agent_backup_admission_work
        SET state = 'leased', lease_owner = 'retry-epoch-${attempt}',
          lease_generation = gen_random_uuid(),
          lease_expires_at = clock_timestamp() + interval '1 hour',
          attempts = attempts + 1
        WHERE id = '${exhaustedWork}'`);
      if (attempt < 12) {
        await db.exec(`UPDATE agent_backup_admission_work
          SET state = 'queued', lease_owner = NULL, lease_generation = NULL,
            lease_expires_at = NULL, ready_cohort = ready_cohort + 1
          WHERE id = '${exhaustedWork}'`);
      }
    }
    await db.exec(`UPDATE agent_backup_admission_work
      SET state = 'queued', lease_owner = NULL, lease_generation = NULL,
        lease_expires_at = NULL, ready_cohort = ready_cohort + 1
      WHERE id = '${exhaustedWork}'`);
    await expect(
      db.exec(`UPDATE agent_backup_admission_work
        SET state = 'leased', lease_owner = 'retry-epoch-13',
          lease_generation = gen_random_uuid(),
          lease_expires_at = clock_timestamp() + interval '1 hour',
          attempts = attempts + 1
        WHERE id = '${exhaustedWork}'`),
    ).rejects.toThrow(/retry attempt limit/i);
    const cappedWork = await db.query<{ state: string; attempts: number }>(
      `SELECT state, attempts FROM agent_backup_admission_work WHERE id = '${exhaustedWork}'`,
    );
    expect(cappedWork.rows).toEqual([{ state: "queued", attempts: 12 }]);
    await db.exec(`UPDATE agent_backup_admission_work
      SET state = 'settled', lease_owner = NULL, lease_generation = NULL,
        lease_expires_at = NULL, settled_at = clock_timestamp(),
        settled_reason = 'RETRY_EXHAUSTED'
      WHERE id = '${exhaustedWork}'`);
    await expect(
      db.exec(`UPDATE agent_backup_admission_work SET updated_at = clock_timestamp()
        WHERE id = '${exhaustedWork}'`),
    ).rejects.toThrow(/settled.*immutable/i);

    await insertSchedule(db, freshWork, ORG_A, SANDBOX_A, HISTORY_A);
    await expect(
      insertSchedule(db, "80000000-0000-4000-8000-000000000103", ORG_A, SANDBOX_A, HISTORY_A),
    ).rejects.toThrow();
    const epochs = await db.query<{
      id: string;
      state: string;
      attempts: number;
      settled_reason: string | null;
    }>(`SELECT id::text, state, attempts, settled_reason
      FROM agent_backup_admission_work
      WHERE sandbox_id = '${SANDBOX_A}' AND source_due_at = '${DUE}'
      ORDER BY id`);
    expect(epochs.rows).toEqual([
      {
        id: exhaustedWork,
        state: "settled",
        attempts: 12,
        settled_reason: "RETRY_EXHAUSTED",
      },
      { id: freshWork, state: "queued", attempts: 0, settled_reason: null },
    ]);

    await db.exec(`UPDATE agent_backup_admission_work
      SET state = 'leased', lease_owner = 'fresh-epoch',
        lease_generation = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + interval '1 hour',
        attempts = attempts + 1
      WHERE id = '${freshWork}'`);
    await db.exec(`UPDATE agent_backup_admission_work
      SET state = 'settled', lease_owner = NULL, lease_generation = NULL,
        lease_expires_at = NULL, settled_at = clock_timestamp(),
        settled_reason = 'CAPTURE_RESERVED'
      WHERE id = '${freshWork}'`);
    await expect(
      insertSchedule(db, "80000000-0000-4000-8000-000000000104", ORG_A, SANDBOX_A, HISTORY_A),
    ).rejects.toThrow(/schedule_uidx/i);
  });

  test("rejects forged inserts, cross-tenant work, replay, and authority removal", async () => {
    const db = await database();
    const WORK_A = "81000000-0000-4000-8000-000000000001";
    const ORG_C = "10000000-0000-4000-8000-000000000003";
    const BACKUP_B = "40000000-0000-4000-8000-000000000002";
    await db.exec(`UPDATE organizations
      SET account_lifecycle_state = 'deletion_recovery', is_active = FALSE,
        account_deletion_request_id = '50000000-0000-4000-8000-000000000099'
      WHERE id = '${ORG_B}'`);
    await expect(
      insertSchedule(db, "81000000-0000-4000-8000-000000000099", ORG_B, SANDBOX_C, HISTORY_A),
    ).rejects.toThrow(/requires active account authority/i);
    await db.exec(`UPDATE organizations
      SET account_lifecycle_state = 'active', is_active = TRUE,
        account_deletion_request_id = NULL
      WHERE id = '${ORG_B}'`);
    await expect(
      db.query(
        `INSERT INTO agent_backup_admission_work (
           id, work_kind, work_stage, organization_id, sandbox_id, node_history_id,
           source_activation_generation, source_lifecycle_revision, source_provider_handle,
           source_container_id, source_image_digest, source_rpo_ms, requires_node_lane,
           priority_class, base_priority, source_due_at, rpo_deadline_at, not_before,
           ready_cohort, cohort_ordinal, shard_id, state, lease_owner, lease_generation,
           lease_expires_at, attempts
         ) VALUES ($1::uuid, 'schedule_capture', 'reserve_capture', $2::uuid, $3::uuid,
           $4::uuid, $5::uuid, 7, 'sandbox-provider', $6, $7, 900000, TRUE,
           'periodic_capture', 3, $8::timestamptz, $9::timestamptz, $8::timestamptz,
           1, 0, agent_backup_admission_expected_shard($3::uuid), 'leased', 'forged',
           '92000000-0000-4000-8000-000000000001', now() + interval '1 hour', 1)`,
        [WORK_A, ORG_A, SANDBOX_A, HISTORY_A, ACTIVATION, CONTAINER, IMAGE, DUE, DEADLINE],
      ),
    ).rejects.toThrow(/enter queued at attempt zero/i);

    await expect(
      db.exec(`INSERT INTO agent_backup_admission_work (
        work_kind, work_stage, organization_id, gc_object_id, requires_node_lane,
        priority_class, base_priority, source_due_at, not_before,
        ready_cohort, cohort_ordinal, shard_id
      ) VALUES ('gc_object', 'delete_object', '${ORG_B}', '${GC_OBJECT_A}', FALSE,
        'garbage_collection', 6, '${DUE}', '${DUE}', 1, 0,
        agent_backup_admission_expected_shard('${GC_OBJECT_A}'))`),
    ).rejects.toThrow(/gc_object_tenant_fkey/i);

    await expect(
      db.exec(`INSERT INTO agent_backup_admission_work (
        work_kind, work_stage, organization_id, gc_object_id, requires_node_lane,
        priority_class, base_priority, source_due_at, not_before,
        ready_cohort, cohort_ordinal, shard_id
      ) VALUES ('gc_object', 'delete_object', '${ORG_A}', '${GC_OBJECT_B}', FALSE,
        'garbage_collection', 6, '${DUE}', '${DUE}', 1, 0,
        agent_backup_admission_expected_shard('${GC_OBJECT_B}'))`),
    ).rejects.toThrow(/gc_authority_fkey/i);

    await db.exec(`INSERT INTO agent_backup_admission_work (
      work_kind, work_stage, organization_id, backup_id, requires_node_lane,
      priority_class, base_priority, source_due_at, not_before,
      ready_cohort, cohort_ordinal, shard_id
    ) VALUES ('catalog_operation', 'primary_publication', '${ORG_A}', '${BACKUP_A}', FALSE,
      'periodic_capture', 3, '${DUE}', '${DUE}', 1, 0,
      agent_backup_admission_expected_shard('${BACKUP_A}'))`);
    await expect(
      db.exec(`DELETE FROM agent_sandbox_backups WHERE id = '${BACKUP_A}'`),
    ).rejects.toThrow(/unsettled/i);
    await db.exec(`UPDATE agent_backup_admission_work
      SET state = 'settled', settled_at = clock_timestamp(), settled_reason = 'PUBLISHED'
      WHERE backup_id = '${BACKUP_A}'`);
    await expect(
      db.exec(`INSERT INTO agent_backup_admission_work (
        work_kind, work_stage, organization_id, backup_id, requires_node_lane,
        priority_class, base_priority, source_due_at, not_before,
        ready_cohort, cohort_ordinal, shard_id
      ) VALUES ('catalog_operation', 'primary_publication', '${ORG_A}', '${BACKUP_A}', FALSE,
        'periodic_capture', 3, '${DUE}', '${DUE}', 2, 0,
        agent_backup_admission_expected_shard('${BACKUP_A}'))`),
    ).rejects.toThrow(/operation_stage_uidx/i);
    await db.exec(`DELETE FROM agent_sandbox_backups WHERE id = '${BACKUP_A}'`);

    await db.exec(`INSERT INTO agent_backup_admission_work (
      work_kind, work_stage, organization_id, gc_object_id, requires_node_lane,
      priority_class, base_priority, source_due_at, not_before,
      ready_cohort, cohort_ordinal, shard_id
    ) VALUES ('gc_object', 'delete_object', '${ORG_A}', '${GC_OBJECT_A}', FALSE,
      'garbage_collection', 6, '${DUE}', '${DUE}', 1, 0,
      agent_backup_admission_expected_shard('${GC_OBJECT_A}'))`);
    await expect(
      db.exec(`DELETE FROM agent_backup_gc_outbox WHERE id = '${GC_A}'`),
    ).rejects.toThrow(/unsettled/i);
    await db.exec(`UPDATE agent_backup_admission_work
      SET state = 'settled', settled_at = clock_timestamp(), settled_reason = 'GC_COMPLETE'
      WHERE gc_object_id = '${GC_OBJECT_A}'`);
    await expect(
      db.exec(`INSERT INTO agent_backup_admission_work (
        work_kind, work_stage, organization_id, gc_object_id, requires_node_lane,
        priority_class, base_priority, source_due_at, not_before,
        ready_cohort, cohort_ordinal, shard_id
      ) VALUES ('gc_object', 'delete_object', '${ORG_A}', '${GC_OBJECT_A}', FALSE,
        'garbage_collection', 6, '${DUE}', '${DUE}', 2, 0,
        agent_backup_admission_expected_shard('${GC_OBJECT_A}'))`),
    ).rejects.toThrow(/gc_uidx/i);
    await db.exec(`DELETE FROM agent_backup_gc_outbox WHERE id = '${GC_A}'`);
    const remainingGcWork = await db.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM agent_backup_admission_work
      WHERE gc_object_id = '${GC_OBJECT_A}'
    `);
    expect(remainingGcWork.rows[0]?.count).toBe(0);

    await db.exec(`INSERT INTO organizations (id) VALUES ('${ORG_C}');
      INSERT INTO agent_sandbox_backups (id, catalog_organization_id)
        VALUES ('${BACKUP_B}', '${ORG_C}');
      INSERT INTO agent_backup_admission_work (
        work_kind, work_stage, organization_id, backup_id, requires_node_lane,
        priority_class, base_priority, source_due_at, not_before,
        ready_cohort, cohort_ordinal, shard_id
      ) VALUES ('catalog_operation', 'primary_publication', '${ORG_C}', '${BACKUP_B}', FALSE,
        'periodic_capture', 3, '${DUE}', '${DUE}', 1, 0,
        agent_backup_admission_expected_shard('${BACKUP_B}'))`);
    await expect(db.exec(`DELETE FROM organizations WHERE id = '${ORG_C}'`)).rejects.toThrow(
      /unsettled/i,
    );
    await db.exec(`UPDATE agent_backup_admission_work
      SET state = 'settled', settled_at = clock_timestamp(), settled_reason = 'CANCELED'
      WHERE organization_id = '${ORG_C}'`);
    await db.exec(`DELETE FROM organizations WHERE id = '${ORG_C}'`);
    const organizationCascade = await db.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM agent_backup_admission_work
      WHERE organization_id = '${ORG_C}'
    `);
    expect(organizationCascade.rows).toEqual([{ count: 0 }]);

    await insertSchedule(db, WORK_A, ORG_A, SANDBOX_A, HISTORY_A);
    await expect(db.exec(`DELETE FROM agent_sandboxes WHERE id = '${SANDBOX_A}'`)).rejects.toThrow(
      /unsettled/i,
    );
    await db.exec(`UPDATE agent_backup_admission_work
      SET state = 'settled', settled_at = clock_timestamp(), settled_reason = 'CANCELED'
      WHERE id = '${WORK_A}'`);
    await db.exec(`DELETE FROM agent_sandboxes WHERE id = '${SANDBOX_A}'`);
    const cascaded = await db.query<{ count: number }>(`SELECT count(*)::int AS count
      FROM agent_backup_admission_work WHERE id = '${WORK_A}'`);
    expect(cascaded.rows).toEqual([{ count: 0 }]);

    await expect(db.exec("TRUNCATE agent_backup_admission_work")).rejects.toThrow(
      /cannot be truncated/i,
    );
    await db.exec(`UPDATE agent_backup_admission_enrollment_shards
      SET scan_cutoff_at = clock_timestamp(), scan_snapshot = pg_current_snapshot(),
        scan_schedule_rpo_ms = 900000,
        active_cohort = nextval('agent_backup_admission_cohort_seq'),
        lease_owner = 'guard-test',
        lease_generation = '92000000-0000-4000-8000-000000000002',
        lease_expires_at = clock_timestamp() + interval '1 minute'
      WHERE work_kind = 'schedule_capture' AND shard_id = 0`);
    await expect(
      db.exec(`UPDATE agent_backup_admission_enrollment_shards
        SET lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL
        WHERE work_kind = 'schedule_capture' AND shard_id = 0`),
    ).rejects.toThrow(/release must commit progress/i);
    await expect(
      db.exec(`UPDATE agent_backup_admission_enrollment_shards
        SET lease_expires_at = lease_expires_at - interval '30 seconds'
        WHERE work_kind = 'schedule_capture' AND shard_id = 0`),
    ).rejects.toThrow(/live lease cannot be replaced/i);
    await expect(
      db.exec(`UPDATE agent_backup_admission_enrollment_shards
        SET scan_cutoff_at = NULL, scan_snapshot = NULL,
          scan_schedule_rpo_ms = NULL, active_cohort = NULL,
          lease_owner = 'lease-thief',
          lease_generation = '92000000-0000-4000-8000-000000000003',
          lease_expires_at = clock_timestamp() + interval '2 minutes'
        WHERE work_kind = 'schedule_capture' AND shard_id = 0`),
    ).rejects.toThrow(/live lease cannot be replaced/i);
    await db.exec(`UPDATE agent_backup_admission_enrollment_shards
      SET scan_cursor_due_at = scan_cutoff_at,
        scan_cursor_id = '00000000-0000-4000-8000-000000000001',
        scan_cursor_ordinal = 0,
        lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL
      WHERE work_kind = 'schedule_capture' AND shard_id = 0`);
    await expect(
      db.exec(`UPDATE agent_backup_admission_enrollment_shards
        SET scan_cutoff_at = NULL, scan_snapshot = NULL,
          scan_schedule_rpo_ms = NULL, active_cohort = NULL
        WHERE work_kind = 'schedule_capture' AND shard_id = 0`),
    ).rejects.toThrow(/requires an unexpired lease/i);
    await expect(
      db.exec(`DELETE FROM agent_backup_admission_enrollment_shards
        WHERE work_kind = 'schedule_capture' AND shard_id = 1`),
    ).rejects.toThrow(/cannot be removed/i);
    await expect(db.exec("TRUNCATE agent_backup_admission_enrollment_shards")).rejects.toThrow(
      /cannot be removed/i,
    );
  });
});
