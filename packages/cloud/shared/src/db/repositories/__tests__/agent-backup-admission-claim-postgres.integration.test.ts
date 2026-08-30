/**
 * Proves bounded backup-admission claiming with independent real PostgreSQL sessions.
 *
 * The harness applies the shipped admission migrations and their PL/pgSQL guards,
 * then exercises row-lock skipping, cross-shard lane serialization, and expired
 * lease recovery through the production repository. Its deliberately minimal
 * schema has no provider client; job and node-capacity sentinels prove claiming
 * remains a database-only operation with no provisioning or autoscale mutation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import { MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS } from "../../schemas/agent-backup-admission";

const SKIP_REASON =
  "[backup admission claim PostgreSQL] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const REQUIRE_REAL_POSTGRES =
  process.env.REQUIRE_REAL_POSTGRES_BACKUP_ADMISSION_CLAIM_TESTS === "1";
const APPLICATION_NAME = "backup-admission-claim-postgres-test";
const IMAGE = `sha256:${"9".repeat(64)}`;
const HOST_KEY = "SHA256:backup-admission-postgres-test-host";
const OWNER_A = "schedule-real-pg-worker-a";
const OWNER_B = "schedule-real-pg-worker-b";
const TEST_TIMEOUT = 120_000;
const TEN_THOUSAND_TIMEOUT = 600_000;

const MIGRATIONS = [
  "0346_agent_backup_admission_sandbox_source_stamp",
  "0347_agent_backup_admission_node_source_stamp",
  "0348_agent_backup_admission_snapshot_visibility",
  "0349_agent_backup_admission_cohort_authority",
  "0350_agent_backup_admission_cohort_seed",
  "0351_agent_backup_admission_work_table",
  "0352_agent_backup_admission_work_shapes",
  "0353_agent_backup_admission_work_state_shapes",
  "0354_agent_backup_admission_work_stage_policy",
  "0355_agent_backup_admission_work_indexes",
  "0356_agent_backup_admission_work_identity_guard",
  "0357_agent_backup_admission_work_state_guard",
  "0358_agent_backup_admission_work_delete_guard",
  "0359_agent_backup_admission_shard_guard",
  "0360_agent_backup_admission_claim_authority",
  "0361_agent_backup_admission_claim_seed",
  "0362_agent_backup_admission_claim_indexes",
  "0363_agent_backup_admission_claim_guard",
  "0364_agent_backup_admission_claim_eligibility",
  "0365_agent_backup_admission_unsettled_schedule_index",
  "0369_agent_backup_admission_recovery_cursor",
] as const;

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  LOCAL_PG_POOL_MAX: process.env.LOCAL_PG_POOL_MAX,
  RAILWAY_SERVICE_NAME: process.env.RAILWAY_SERVICE_NAME,
  DISABLE_LOCAL_PGLITE_FALLBACK: process.env.DISABLE_LOCAL_PGLITE_FALLBACK,
  NODE_ENV: process.env.NODE_ENV,
  MOCK_REDIS: process.env.MOCK_REDIS,
  SKIP_AGENT_SANDBOX_ENSURE: process.env.SKIP_AGENT_SANDBOX_ENSURE,
};

type ClaimRepository = typeof import("../agent-backup-admission-claim");
type AdmissionClaim = Awaited<ReturnType<ClaimRepository["claimAgentBackupAdmissionWork"]>>[number];
type ClaimRequest = Parameters<ClaimRepository["claimAgentBackupAdmissionWork"]>[0];

interface SeedOptions {
  start: number;
  count: number;
  fixedShard?: number;
  sharedOrganizationId?: string;
  priorityClass?: "lifecycle_safety" | "active_rpo" | "drain_recovery" | "periodic_capture";
  basePriority?: 0 | 1 | 2 | 3;
}

interface CapacitySnapshot {
  jobs: number;
  nodes: number;
  capacityTotal: number;
  capacityMin: number;
  capacityMax: number;
  allocated: number;
  mutatedNodes: number;
  autoscaledNodes: number;
}

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
let databaseName: string | null = null;
let isolatedDsn: string | null = null;
let control: Client | null = null;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | undefined;
let claimRepository: ClaimRepository | undefined;
let cleanupPromise: Promise<void> | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function testUuid(scope: number, ordinal: number, shard = 0): string {
  if (!Number.isSafeInteger(scope) || scope < 0 || scope > 0xffffff) {
    throw new Error("test UUID scope must fit in 24 bits");
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > 0xffffffffffff) {
    throw new Error("test UUID ordinal must fit in 48 bits");
  }
  if (!Number.isSafeInteger(shard) || shard < 0 || shard > 63) {
    throw new Error("test UUID shard must be between zero and 63");
  }
  return `${shard.toString(16).padStart(2, "0")}${scope
    .toString(16)
    .padStart(6, "0")}-0000-4000-8000-${ordinal.toString(16).padStart(12, "0")}`;
}

function workId(ordinal: number, sourceShard = 0): string {
  return testUuid(8, ordinal, (sourceShard + 17) % 64);
}

function fence(claim: AdmissionClaim) {
  return {
    workId: claim.workId,
    ownerId: claim.ownerId,
    generation: claim.generation,
    workAttempt: claim.workAttempt,
    claimCycleStartTurn: claim.claimCycleStartTurn,
    claimProofTurn: claim.claimProofTurn,
    claimProofXid: claim.claimProofXid,
    claimProofPriorityPass: claim.claimProofPriorityPass,
  };
}

async function claimNextBatch(
  params: ClaimRequest,
  maxProgressTurns = 128,
): Promise<AdmissionClaim[]> {
  const repository = claimRepository;
  if (!repository) throw new Error("real PostgreSQL claim repository was not initialized");
  for (let turn = 0; turn < maxProgressTurns; turn += 1) {
    const claims = await repository.claimAgentBackupAdmissionWork(params);
    if (claims.length > 0) return claims;
  }
  throw new Error(`No backup admission claim after ${maxProgressTurns} bounded progress turns`);
}

async function createIsolatedDatabase(baseDsn: string): Promise<{
  databaseName: string;
  dsn: string;
}> {
  const createdName = `eliza_backup_claim_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${createdName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${createdName}`;
  return { databaseName: createdName, dsn: url.toString() };
}

async function applyMigration(client: Client, migration: (typeof MIGRATIONS)[number]) {
  const source = await readFile(
    new URL(`../../migrations/${migration}.sql`, import.meta.url),
    "utf8",
  );
  const statements = source
    .split("--> statement-breakpoint")
    .filter((statement) => statement.trim());
  if (source.startsWith("-- migrate-with-diagnostics: nontransactional-concurrent-indexes")) {
    for (const statement of statements) await client.query(statement);
    return;
  }
  await client.query("BEGIN");
  try {
    for (const statement of statements) await client.query(statement);
    await client.query("COMMIT");
  } catch (cause) {
    // error-policy:J2 Preserve the migration failure after restoring transaction state.
    await client.query("ROLLBACK");
    throw cause;
  }
}

async function applyAdmissionMigrations(client: Client): Promise<void> {
  for (const migration of MIGRATIONS) await applyMigration(client, migration);
}

async function createPreAdmissionSchema(client: Client): Promise<void> {
  await client.query(`
    CREATE FUNCTION backup_claim_test_uuid(scope integer, ordinal bigint, shard integer)
    RETURNS uuid LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $uuid$
      SELECT (
        lpad(to_hex(shard), 2, '0') || lpad(to_hex(scope), 6, '0') ||
        '-0000-4000-8000-' || lpad(to_hex(ordinal), 12, '0')
      )::uuid
    $uuid$;

    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      account_lifecycle_state text NOT NULL DEFAULT 'active',
      is_active boolean NOT NULL DEFAULT TRUE,
      account_deletion_request_id uuid
    );

    CREATE TABLE agent_node_incarnation_histories (
      id uuid PRIMARY KEY,
      docker_node_record_id uuid NOT NULL,
      node_id text NOT NULL,
      node_incarnation uuid NOT NULL,
      fleet_kind text NOT NULL,
      infrastructure_provider text NOT NULL,
      provider_server_id text,
      host_key_fingerprint text NOT NULL,
      attested_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, docker_node_record_id, node_incarnation)
    );

    CREATE TABLE docker_nodes (
      id uuid PRIMARY KEY,
      node_id text NOT NULL UNIQUE,
      hostname text NOT NULL,
      capacity integer NOT NULL DEFAULT 8,
      enabled boolean NOT NULL DEFAULT TRUE,
      placement_state text NOT NULL DEFAULT 'open',
      status text NOT NULL DEFAULT 'healthy',
      allocated_count integer NOT NULL DEFAULT 0,
      fleet_kind text,
      infrastructure_provider text,
      provider_server_id text,
      host_key_fingerprint text,
      node_incarnation uuid,
      current_node_history_id uuid,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      status text NOT NULL,
      pool_status text,
      execution_tier text NOT NULL,
      deletion_attempt_id uuid,
      deleted_at timestamptz,
      sandbox_id text,
      node_id text,
      image_digest text,
      lifecycle_revision bigint NOT NULL,
      activation_generation uuid,
      activation_lifecycle_revision bigint,
      activation_phase text,
      activation_receipt_hash text,
      activation_container_id text,
      activation_node_id text,
      activation_image_digest text,
      activation_boot_id uuid,
      activation_authority_published_at timestamptz,
      activation_dispatched_at timestamptz,
      activation_completed_at timestamptz,
      next_backup_at timestamptz,
      backup_schedule_last_protected_at timestamptz,
      UNIQUE (id, organization_id)
    );

    CREATE TABLE agent_sandbox_backups (
      id uuid PRIMARY KEY,
      catalog_organization_id uuid,
      catalog_state text,
      catalog_resume_state text,
      source_node_history_id uuid,
      source_node_record_id uuid,
      source_node_incarnation uuid,
      UNIQUE (id, catalog_organization_id)
    );

    CREATE TABLE agent_backup_objects (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      UNIQUE (id, organization_id)
    );

    CREATE TABLE agent_backup_gc_outbox (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      object_id uuid NOT NULL,
      action text NOT NULL,
      UNIQUE (object_id, action)
    );

    CREATE TABLE agent_backup_organization_admission_cursors (
      organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      cursor_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE agent_backup_node_admission_cursors (
      node_history_id uuid PRIMARY KEY
        REFERENCES agent_node_incarnation_histories(id) ON DELETE RESTRICT,
      cursor_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type text NOT NULL,
      status text NOT NULL DEFAULT 'pending'
    );
  `);
}

async function resetFixture(): Promise<void> {
  if (!control) return;
  await control.query("BEGIN");
  try {
    await control.query(`
      ALTER TABLE agent_backup_admission_work DISABLE TRIGGER USER;
      DELETE FROM agent_backup_admission_work;
      ALTER TABLE agent_backup_admission_work ENABLE TRIGGER USER;
      DELETE FROM agent_backup_node_admission_cursors;
      DELETE FROM agent_backup_organization_admission_cursors;
      DELETE FROM agent_sandbox_backups;
      DELETE FROM agent_sandboxes;
      DELETE FROM docker_nodes;
      DELETE FROM agent_node_incarnation_histories;
      DELETE FROM agent_backup_gc_outbox;
      DELETE FROM agent_backup_objects;
      DELETE FROM jobs;
      DELETE FROM organizations;
      ALTER TABLE agent_backup_admission_claim_shards DISABLE TRIGGER USER;
      UPDATE agent_backup_admission_claim_shards SET
        last_turn = 0,
        recovery_start_turn = NULL,
        recovery_cutoff_at = NULL,
        recovery_cursor_at = NULL,
        recovery_cursor_state = NULL,
        recovery_cursor_id = NULL,
        last_recovery_claim_cycle_start_turn = NULL,
        cycle_start_turn = NULL,
        cycle_observed_at = NULL,
        cycle_max_cohort = NULL,
        cycle_max_ordinal = NULL,
        cycle_max_id = NULL,
        cycle_aging_interval_ms = NULL,
        priority_pass = NULL,
        scan_cursor_cohort = NULL,
        scan_cursor_ordinal = NULL,
        scan_cursor_id = NULL,
        last_admitted_work_id = NULL,
        last_admission_proof_turn = NULL,
        updated_at = now();
      ALTER TABLE agent_backup_admission_claim_shards ENABLE TRIGGER USER;
      ALTER SEQUENCE agent_backup_admission_claim_turn_seq RESTART WITH 1;
      ALTER SEQUENCE agent_backup_admission_cohort_seq RESTART WITH 1000000;
    `);
    await control.query("COMMIT");
  } catch (cause) {
    // error-policy:J2 Preserve fixture-reset failure after restoring transaction state.
    await control.query("ROLLBACK");
    throw cause;
  }
}

async function seedScheduleSources(options: SeedOptions): Promise<void> {
  if (!control) throw new Error("real PostgreSQL control session was not initialized");
  if (!Number.isSafeInteger(options.start) || options.start < 1) {
    throw new Error("seed start must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.count) || options.count < 1 || options.count > 10_000) {
    throw new Error("seed count must be between one and 10,000");
  }
  if (
    options.fixedShard !== undefined &&
    (!Number.isSafeInteger(options.fixedShard) || options.fixedShard < 0 || options.fixedShard > 63)
  ) {
    throw new Error("fixed seed shard must be between zero and 63");
  }
  const priorityClass = options.priorityClass ?? "lifecycle_safety";
  const basePriority = options.basePriority ?? 0;
  const dueAt = new Date(Date.now() - 60_000);
  const values = [
    options.start,
    options.count,
    options.fixedShard ?? null,
    options.sharedOrganizationId ?? null,
    dueAt,
    priorityClass,
    basePriority,
    IMAGE,
    HOST_KEY,
  ];
  const seed = `
    SELECT ordinal,
      COALESCE(seed_input.fixed_shard, mod(ordinal - seed_input.start_ordinal, 64)) AS shard_id,
      COALESCE(
        seed_input.shared_organization_id,
        backup_claim_test_uuid(1, ordinal, 0)
      ) AS organization_id
    FROM (
      SELECT $1::integer AS start_ordinal, $2::integer AS seed_count,
        $3::integer AS fixed_shard, $4::uuid AS shared_organization_id,
        $5::timestamptz AS due_at, $6::text AS priority_class,
        $7::smallint AS base_priority, $8::text AS image_digest,
        $9::text AS host_key_fingerprint
    ) AS seed_input
    CROSS JOIN LATERAL generate_series(
      seed_input.start_ordinal,
      seed_input.start_ordinal + seed_input.seed_count - 1
    ) AS ordinal
  `;

  await control.query(
    `WITH seed AS (${seed})
      INSERT INTO organizations (id)
      SELECT DISTINCT organization_id FROM seed
      ON CONFLICT (id) DO NOTHING`,
    values,
  );
  await control.query(
    `WITH seed AS (${seed})
      INSERT INTO agent_node_incarnation_histories (
        id, docker_node_record_id, node_id, node_incarnation, fleet_kind,
        infrastructure_provider, provider_server_id, host_key_fingerprint
      ) SELECT
        backup_claim_test_uuid(3, ordinal, 0),
        backup_claim_test_uuid(2, ordinal, 0),
        'backup-node-' || ordinal,
        backup_claim_test_uuid(4, ordinal, 0),
        'robot', 'hetzner', NULL, $9
      FROM seed`,
    values,
  );
  await control.query(
    `WITH seed AS (${seed})
      INSERT INTO docker_nodes (
        id, node_id, hostname, capacity, enabled, placement_state, status,
        allocated_count, fleet_kind, infrastructure_provider, provider_server_id,
        host_key_fingerprint, node_incarnation, current_node_history_id, metadata
      ) SELECT
        backup_claim_test_uuid(2, ordinal, 0),
        'backup-node-' || ordinal,
        'backup-node-' || ordinal || '.test.invalid',
        8, TRUE, 'open', 'healthy', 0, 'robot', 'hetzner', NULL, $9,
        backup_claim_test_uuid(4, ordinal, 0),
        backup_claim_test_uuid(3, ordinal, 0),
        '{"managedBy":"operator"}'::jsonb
      FROM seed`,
    values,
  );
  await control.query(
    `WITH seed AS (${seed})
      INSERT INTO agent_sandboxes (
        id, organization_id, status, pool_status, execution_tier, sandbox_id,
        node_id, image_digest, lifecycle_revision, activation_generation,
        activation_lifecycle_revision, activation_phase, activation_container_id,
        activation_node_id, activation_image_digest, activation_boot_id,
        activation_authority_published_at, activation_dispatched_at,
        activation_completed_at, next_backup_at
      ) SELECT
        backup_claim_test_uuid(7, ordinal, shard_id), organization_id,
        'running', NULL, 'dedicated-always', 'provider-handle-' || ordinal,
        'backup-node-' || ordinal, $8, 7,
        backup_claim_test_uuid(6, ordinal, 0), 7, 'active',
        lpad(to_hex(ordinal), 64, 'a'), 'backup-node-' || ordinal, $8,
        backup_claim_test_uuid(4, ordinal, 0),
        $5::timestamptz - INTERVAL '3 seconds',
        $5::timestamptz - INTERVAL '2 seconds',
        $5::timestamptz - INTERVAL '1 second', $5::timestamptz
      FROM seed`,
    values,
  );
  await control.query(
    `WITH seed AS (${seed})
      INSERT INTO agent_backup_organization_admission_cursors (organization_id)
      SELECT DISTINCT organization_id FROM seed
      ON CONFLICT (organization_id) DO NOTHING`,
    values,
  );
  await control.query(
    `WITH seed AS (${seed})
      INSERT INTO agent_backup_node_admission_cursors (node_history_id)
      SELECT backup_claim_test_uuid(3, ordinal, 0) FROM seed`,
    values,
  );
  await control.query(
    `WITH seed AS (${seed})
      INSERT INTO agent_backup_admission_work (
        id, work_kind, work_stage, organization_id, sandbox_id, node_history_id,
        source_activation_generation, source_lifecycle_revision,
        source_provider_handle, source_container_id, source_image_digest,
        source_rpo_ms, requires_node_lane, priority_class, base_priority,
        source_due_at, rpo_deadline_at, state, not_before, ready_cohort,
        cohort_ordinal, shard_id, attempts
      ) SELECT
        backup_claim_test_uuid(8, ordinal, mod(shard_id + 17, 64)),
        'schedule_capture', 'reserve_capture',
        organization_id, backup_claim_test_uuid(7, ordinal, shard_id),
        backup_claim_test_uuid(3, ordinal, 0),
        backup_claim_test_uuid(6, ordinal, 0), 7,
        'provider-handle-' || ordinal, lpad(to_hex(ordinal), 64, 'a'), $8,
        900000, TRUE, $6, $7, $5::timestamptz,
        $5::timestamptz + INTERVAL '15 minutes', 'queued', $5::timestamptz,
        ordinal::bigint, 0, shard_id, 0
      FROM seed`,
    values,
  );
}

async function readCapacitySnapshot(): Promise<CapacitySnapshot> {
  if (!control) throw new Error("real PostgreSQL control session was not initialized");
  const result = await control.query<CapacitySnapshot>(`
    SELECT
      (SELECT count(*)::integer FROM jobs) AS jobs,
      count(*)::integer AS nodes,
      COALESCE(sum(capacity), 0)::integer AS "capacityTotal",
      COALESCE(min(capacity), 0)::integer AS "capacityMin",
      COALESCE(max(capacity), 0)::integer AS "capacityMax",
      COALESCE(sum(allocated_count), 0)::integer AS allocated,
      count(*) FILTER (
        WHERE NOT enabled OR placement_state <> 'open' OR status <> 'healthy'
      )::integer AS "mutatedNodes",
      count(*) FILTER (WHERE metadata->>'autoscaled' = 'true')::integer AS "autoscaledNodes"
    FROM docker_nodes
  `);
  const snapshot = result.rows[0];
  if (!snapshot) throw new Error("PostgreSQL did not return a capacity snapshot");
  return snapshot;
}

async function waitForDatabaseTimeAfter(instant: Date): Promise<void> {
  if (!control) throw new Error("real PostgreSQL control session was not initialized");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await control.query<{ elapsed: boolean }>(
      "SELECT clock_timestamp() > $1::timestamptz AS elapsed",
      [instant],
    );
    if (result.rows[0]?.elapsed) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for database clock to pass ${instant.toISOString()}`);
}

async function proveNormalizationRefillsPastLockedPrefix(
  mode: "deferred" | "expired lease",
): Promise<void> {
  if (!isolatedDsn || !control || !claimRepository) {
    throw new Error("real PostgreSQL claim harness was not initialized");
  }
  const start = mode === "deferred" ? 30_000 : 32_000;
  const lockedPrefixCount = 1_025;
  await seedScheduleSources({ start, count: lockedPrefixCount + 1, fixedShard: 0 });
  if (mode === "deferred") {
    await control.query(`WITH stamp AS MATERIALIZED (
        SELECT date_trunc('second', clock_timestamp())
          - INTERVAL '1 second' + INTERVAL '0.123456 second' AS at
      )
      UPDATE agent_backup_admission_work AS work
      SET state = 'deferred', deferred_reason = 'TEST_BACKPRESSURE',
        not_before = stamp.at, updated_at = clock_timestamp()
      FROM stamp`);
  } else {
    const leased: AdmissionClaim[] = [];
    while (leased.length < lockedPrefixCount + 1) {
      leased.push(
        ...(await claimNextBatch({
          ownerId: "expired-prefix-worker",
          limit: Math.min(100, lockedPrefixCount + 1 - leased.length),
          leaseMs: 15_000,
        })),
      );
    }
    expect(new Set(leased.map(({ workId: id }) => id)).size).toBe(lockedPrefixCount + 1);
    const expiresAt = leased.reduce(
      (latest, claim) => (claim.expiresAt > latest ? claim.expiresAt : latest),
      leased[0]?.expiresAt ?? new Date(0),
    );
    await waitForDatabaseTimeAfter(expiresAt);
  }

  const orderColumn = mode === "deferred" ? "not_before" : "lease_expires_at";
  const locker = new Client({
    connectionString: isolatedDsn,
    application_name: `${APPLICATION_NAME}-${mode.replace(" ", "-")}-prefix`,
  });
  await locker.connect();
  let primaryFailure: unknown;
  try {
    await locker.query("BEGIN");
    const locked = await locker.query<{ id: string }>(`
      SELECT id
      FROM agent_backup_admission_work
      ORDER BY ${orderColumn}, id
      LIMIT ${lockedPrefixCount}
      FOR UPDATE
    `);
    expect(locked.rows).toHaveLength(lockedPrefixCount);
    const seededIds = Array.from({ length: lockedPrefixCount + 1 }, (_, index) =>
      workId(start + index),
    );
    const seededIdSet = new Set(seededIds);
    const lockedIdSet = new Set(locked.rows.map(({ id }) => id));
    expect(lockedIdSet.size).toBe(lockedPrefixCount);
    expect([...lockedIdSet].every((id) => seededIdSet.has(id))).toBe(true);
    const unlockedIds = seededIds.filter((id) => !lockedIdSet.has(id));
    expect(unlockedIds).toHaveLength(1);
    const recoveryPageCursorId = locked.rows.at(-2)?.id;
    if (!recoveryPageCursorId) throw new Error("Expected a full locked recovery page");

    let durableProgress:
      | {
          last_turn: string;
          recovery_cutoff_at: string | null;
          recovery_cursor_state: number | null;
          recovery_cursor_id: string | null;
        }
      | undefined;
    for (let turn = 0; turn < 32; turn += 1) {
      const result = await claimRepository.claimAgentBackupAdmissionWorkTurn({
        ownerId: OWNER_A,
        limit: 1,
        leaseMs: 60_000,
      });
      expect(result).toEqual({ outcome: "progressed", claims: [] });
      const progress = await control.query<{
        last_turn: string;
        recovery_cutoff_at: string | null;
        recovery_cursor_state: number | null;
        recovery_cursor_id: string | null;
      }>(`
        SELECT last_turn::text, recovery_cutoff_at::text,
          recovery_cursor_state, recovery_cursor_id::text
        FROM agent_backup_admission_claim_shards
        WHERE work_kind = 'schedule_capture' AND shard_id = 0
      `);
      durableProgress = progress.rows[0];
      if (durableProgress?.recovery_cursor_id !== null) break;
    }
    expect(durableProgress).toMatchObject({
      recovery_cursor_state: mode === "deferred" ? 0 : 1,
      recovery_cursor_id: recoveryPageCursorId,
    });
    expect(durableProgress?.recovery_cutoff_at).not.toBeNull();
    expect(BigInt(durableProgress?.last_turn ?? "0")).toBeGreaterThan(0n);

    const claims = await claimNextBatch({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });
    expect(claims.map(({ workId: id }) => id)).toEqual(unlockedIds);
  } catch (cause) {
    // error-policy:J2 Preserve the proof failure while releasing deliberate row locks.
    primaryFailure = cause;
  }
  const cleanupErrors: unknown[] = [];
  for (const operation of [() => locker.query("ROLLBACK"), () => locker.end()]) {
    try {
      await operation();
    } catch (cause) {
      // error-policy:J6 Continue lock-session teardown and retain the failure.
      cleanupErrors.push(cause);
    }
  }
  if (primaryFailure !== undefined) cleanupErrors.unshift(primaryFailure);
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, `${mode} normalization refill proof failed`);
  }
}

async function cleanupHarnessOnce(): Promise<void> {
  const acquiredPostgres = postgres;
  const createdDatabase = databaseName;
  const errors: unknown[] = [];
  const capture = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (cause) {
      // error-policy:J6 Continue teardown while retaining every cleanup failure.
      errors.push(cause);
    }
  };

  if (control) await capture(async () => control?.end());
  control = null;
  if (closeDatabaseConnectionsForTests) await capture(closeDatabaseConnectionsForTests);
  closeDatabaseConnectionsForTests = undefined;
  claimRepository = undefined;

  if (acquiredPostgres && createdDatabase) {
    let admin: Client | null = null;
    await capture(async () => {
      admin = new Client({ connectionString: acquiredPostgres.dsn });
      await admin.connect();
    });
    if (admin) {
      await capture(async () => {
        await admin?.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " +
            "WHERE datname = $1 AND pid <> pg_backend_pid()",
          [createdDatabase],
        );
      });
      await capture(async () => {
        await admin?.query(`DROP DATABASE IF EXISTS "${createdDatabase}"`);
      });
      await capture(async () => admin?.end());
    }
  }
  await capture(async () => acquiredPostgres?.stop());
  postgres = null;
  databaseName = null;
  isolatedDsn = null;

  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "backup claim PostgreSQL teardown failed");
}

function cleanupHarness(): Promise<void> {
  cleanupPromise ??= cleanupHarnessOnce();
  return cleanupPromise;
}

async function initializeHarness(): Promise<void> {
  if (!postgres) {
    if (REQUIRE_REAL_POSTGRES) {
      throw new Error("Real PostgreSQL is required for backup admission claim tests");
    }
    process.stderr.write(`${SKIP_REASON}\n`);
    return;
  }
  const isolated = await createIsolatedDatabase(postgres.dsn);
  databaseName = isolated.databaseName;
  isolatedDsn = isolated.dsn;
  process.env.DATABASE_URL = isolated.dsn;
  process.env.TEST_DATABASE_URL = isolated.dsn;
  process.env.LOCAL_PG_POOL_MAX = "24";
  process.env.RAILWAY_SERVICE_NAME = APPLICATION_NAME;
  process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";
  process.env.NODE_ENV = "test";
  process.env.MOCK_REDIS = "1";
  process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

  const [clientModule, repositoryModule] = await Promise.all([
    import("../../client"),
    import("../agent-backup-admission-claim"),
  ]);
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  claimRepository = repositoryModule;
  control = new Client({
    connectionString: isolated.dsn,
    application_name: `${APPLICATION_NAME}-control`,
  });
  await control.connect();
}

try {
  await initializeHarness();
} catch (cause) {
  // error-policy:J2 Preserve initialization failure after best-effort harness teardown.
  let cleanupFailure: unknown;
  try {
    await cleanupHarness();
  } catch (cleanupCause) {
    // error-policy:J6 Retain initialization and teardown failures together.
    cleanupFailure = cleanupCause;
  }
  if (cleanupFailure !== undefined) {
    throw new AggregateError(
      [cause, cleanupFailure],
      "backup claim PostgreSQL initialization and cleanup failed",
    );
  }
  throw cause;
}

const realPostgresTest = postgres ? test : test.skip;

beforeAll(async () => {
  if (!control) return;
  await createPreAdmissionSchema(control);
  await applyAdmissionMigrations(control);
  // Every selected migration is replay-safe in deploys; exercise that exact property here.
  await applyAdmissionMigrations(control);
}, TEST_TIMEOUT);

beforeEach(resetFixture);

afterAll(cleanupHarness, TEST_TIMEOUT);

describe("schedule-capture admission claims on real PostgreSQL", () => {
  realPostgresTest(
    "runs the shipped PL/pgSQL guards and preserves all 192 seeded claim shards",
    async () => {
      if (!control) throw new Error("real PostgreSQL control session was not initialized");
      const authority = await control.query<{ shards: number; guards: number }>(`
        SELECT
          (SELECT count(*)::integer FROM agent_backup_admission_claim_shards) AS shards,
          (SELECT count(*)::integer
            FROM pg_trigger
            WHERE NOT tgisinternal
              AND tgrelid IN (
                'agent_backup_admission_claim_shards'::regclass,
                'agent_backup_admission_work'::regclass
              )) AS guards
      `);
      expect(authority.rows).toEqual([{ shards: 192, guards: 8 }]);

      await expect(
        control.query(`UPDATE agent_backup_admission_claim_shards
          SET last_turn = last_turn
          WHERE work_kind = 'schedule_capture' AND shard_id = 0`),
      ).rejects.toThrow(/claim shard turn must advance/i);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "reports contention when all eligible shard authorities are row-locked",
    async () => {
      if (!isolatedDsn || !control || !claimRepository) {
        throw new Error("real PostgreSQL claim harness was not initialized");
      }
      await seedScheduleSources({ start: 450, count: 1, fixedShard: 0 });
      const locker = new Client({
        connectionString: isolatedDsn,
        application_name: `${APPLICATION_NAME}-claim-shard-lock`,
      });
      await locker.connect();
      let transactionOpen = false;
      try {
        await locker.query("BEGIN");
        transactionOpen = true;
        const locked = await locker.query<{ shard_id: number }>(`
          SELECT shard_id
          FROM agent_backup_admission_claim_shards
          WHERE work_kind = 'schedule_capture' AND shard_id = 0
          FOR UPDATE
        `);
        expect(locked.rows).toEqual([{ shard_id: 0 }]);

        const result = await claimRepository.claimAgentBackupAdmissionWorkTurn({
          ownerId: OWNER_A,
          limit: 1,
          leaseMs: 60_000,
        });
        expect(result).toEqual({ outcome: "contended", claims: [] });

        const queued = await control.query<{ state: string }>(
          `
          SELECT state FROM agent_backup_admission_work WHERE id = $1::uuid
        `,
          [workId(450)],
        );
        expect(queued.rows).toEqual([{ state: "queued" }]);
      } finally {
        if (transactionOpen) await locker.query("ROLLBACK").catch(() => undefined);
        await locker.end();
      }
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "settles future-tier, soft-deleted, and deletion-owned sources before leasing",
    async () => {
      if (!control || !claimRepository) {
        throw new Error("real PostgreSQL claim harness was not initialized");
      }
      const start = 460;
      const validOrdinal = start + 3;
      await seedScheduleSources({ start, count: 4, fixedShard: 0 });
      await control.query(
        `UPDATE agent_sandboxes
        SET execution_tier = 'future-dedicated'
        WHERE id = backup_claim_test_uuid(7, $1, 0)`,
        [start],
      );
      await control.query(
        `UPDATE agent_sandboxes
        SET deleted_at = clock_timestamp()
        WHERE id = backup_claim_test_uuid(7, $1, 0)`,
        [start + 1],
      );
      await control.query(
        `UPDATE agent_sandboxes
        SET deletion_attempt_id = backup_claim_test_uuid(9, $1, 0)
        WHERE id = backup_claim_test_uuid(7, $1, 0)`,
        [start + 2],
      );

      const claims = await claimNextBatch({
        ownerId: OWNER_A,
        limit: 4,
        leaseMs: 60_000,
      });

      expect(claims.map(({ workId: id }) => id)).toEqual([workId(validOrdinal)]);
      const result = await control.query<{
        id: string;
        state: string;
        attempts: number;
        leaseOwner: string | null;
        settledReason: string | null;
      }>(`SELECT id::text AS id, state, attempts,
          lease_owner AS "leaseOwner", settled_reason AS "settledReason"
        FROM agent_backup_admission_work
        ORDER BY id`);
      expect(result.rows).toEqual([
        {
          id: workId(start),
          state: "settled",
          attempts: 0,
          leaseOwner: null,
          settledReason: "SOURCE_SUPERSEDED",
        },
        {
          id: workId(start + 1),
          state: "settled",
          attempts: 0,
          leaseOwner: null,
          settledReason: "SOURCE_SUPERSEDED",
        },
        {
          id: workId(start + 2),
          state: "settled",
          attempts: 0,
          leaseOwner: null,
          settledReason: "SOURCE_SUPERSEDED",
        },
        {
          id: workId(validOrdinal),
          state: "leased",
          attempts: 1,
          leaseOwner: OWNER_A,
          settledReason: null,
        },
      ]);
    },
    TEST_TIMEOUT,
  );

  for (const scenario of [
    {
      label: "active-RPO priority one",
      priorityClass: "active_rpo" as const,
      basePriority: 1 as const,
      progressTurns: 192,
    },
    {
      label: "periodic priority three",
      priorityClass: "periodic_capture" as const,
      basePriority: 3 as const,
      progressTurns: 448,
    },
  ]) {
    realPostgresTest(
      `reports every durable 64-shard transition before ${scenario.label} becomes claimable`,
      async () => {
        if (!claimRepository) {
          throw new Error("real PostgreSQL claim harness was not initialized");
        }
        await seedScheduleSources({
          start: 4_500,
          count: 64,
          priorityClass: scenario.priorityClass,
          basePriority: scenario.basePriority,
        });
        const before = await readCapacitySnapshot();
        const observed: string[] = [];

        for (let turn = 0; turn < scenario.progressTurns; turn += 1) {
          const result = await claimRepository.claimAgentBackupAdmissionWorkTurn({
            ownerId: OWNER_A,
            limit: 1,
            leaseMs: 60_000,
          });
          observed.push(result.outcome);
          expect(result.claims).toEqual([]);
        }
        expect(new Set(observed)).toEqual(new Set(["progressed"]));

        const firstClaim = await claimRepository.claimAgentBackupAdmissionWorkTurn({
          ownerId: OWNER_A,
          limit: 1,
          leaseMs: 60_000,
        });
        expect(firstClaim.outcome).toBe("claimed");
        expect(firstClaim.claims).toHaveLength(1);
        expect(firstClaim.claims[0]?.claimProofPriorityPass).toBe(scenario.basePriority);
        expect(await readCapacitySnapshot()).toEqual(before);
      },
      TEST_TIMEOUT,
    );
  }

  realPostgresTest(
    "refreshes a 100-row lease batch after lane-cursor triggers consume its initial horizon",
    async () => {
      if (!control || !claimRepository) {
        throw new Error("real PostgreSQL claim harness was not initialized");
      }
      await seedScheduleSources({ start: 500, count: 100, fixedShard: 0 });
      await control.query(`
        CREATE FUNCTION delay_backup_admission_lane_cursor_test()
        RETURNS trigger LANGUAGE plpgsql AS $delay$
        BEGIN
          PERFORM pg_sleep(0.015);
          RETURN NEW;
        END
        $delay$;
        CREATE TRIGGER agent_backup_admission_organization_cursor_delay_test
          BEFORE UPDATE ON agent_backup_organization_admission_cursors
          FOR EACH ROW
          EXECUTE FUNCTION delay_backup_admission_lane_cursor_test()
      `);
      try {
        const claims = await claimNextBatch({
          ownerId: OWNER_A,
          limit: 100,
          leaseMs: claimRepository.MIN_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS,
        });
        expect(claims).toHaveLength(100);
        expect(claims.every(({ workAttempt }) => workAttempt === 1)).toBe(true);
        const lease = await control.query<{ live: boolean }>(
          `
          SELECT bool_and(lease_expires_at > clock_timestamp()) AS live
          FROM agent_backup_admission_work
          WHERE id = ANY($1::uuid[])
        `,
          [claims.map(({ workId: id }) => id)],
        );
        expect(lease.rows).toEqual([{ live: true }]);
        const state = await control.query<{ state: string; count: number }>(`
          SELECT state, count(*)::integer AS count
          FROM agent_backup_admission_work
          GROUP BY state
        `);
        expect(state.rows).toEqual([{ state: "leased", count: 100 }]);
      } finally {
        await control.query(`
          DROP TRIGGER IF EXISTS agent_backup_admission_organization_cursor_delay_test
            ON agent_backup_organization_admission_cursors;
          DROP FUNCTION IF EXISTS delay_backup_admission_lane_cursor_test()
        `);
      }
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "skips 256 locked raw keys and refills the bounded claim with the next 100",
    async () => {
      if (!isolatedDsn || !control || !claimRepository) {
        throw new Error("real PostgreSQL claim harness was not initialized");
      }
      await seedScheduleSources({ start: 1, count: 356, fixedShard: 0 });
      const before = await readCapacitySnapshot();
      const locker = new Client({
        connectionString: isolatedDsn,
        application_name: `${APPLICATION_NAME}-locked-prefix`,
      });
      await locker.connect();
      let primaryFailure: unknown;
      try {
        await locker.query("BEGIN");
        const locked = await locker.query<{ id: string }>(`
          SELECT id
          FROM agent_backup_admission_work
          WHERE work_kind = 'schedule_capture' AND shard_id = 0 AND state = 'queued'
          ORDER BY ready_cohort, cohort_ordinal, id
          LIMIT 256
          FOR UPDATE
        `);
        expect(locked.rows).toHaveLength(256);
        expect(locked.rows[0]?.id).toBe(workId(1));
        expect(locked.rows.at(-1)?.id).toBe(workId(256));

        const startedAt = performance.now();
        const claims = await claimNextBatch({
          ownerId: OWNER_A,
          limit: 100,
          leaseMs: 60_000,
        });
        expect(performance.now() - startedAt).toBeLessThan(10_000);
        expect(claims.map(({ workId: id }) => id)).toEqual(
          Array.from({ length: 100 }, (_, index) => workId(index + 257)),
        );
      } catch (cause) {
        // error-policy:J2 Preserve the claim failure while releasing the deliberate row locks.
        primaryFailure = cause;
      }
      const cleanupErrors: unknown[] = [];
      for (const operation of [() => locker.query("ROLLBACK"), () => locker.end()]) {
        try {
          await operation();
        } catch (cause) {
          // error-policy:J6 Continue lock-session teardown and retain the failure.
          cleanupErrors.push(cause);
        }
      }
      if (primaryFailure !== undefined) cleanupErrors.unshift(primaryFailure);
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, "locked-prefix claim proof failed");
      }

      expect(await readCapacitySnapshot()).toEqual(before);
      const states = await control.query<{ state: string; count: number }>(`
        SELECT state, count(*)::integer AS count
        FROM agent_backup_admission_work
        GROUP BY state ORDER BY state
      `);
      expect(states.rows).toEqual([
        { state: "leased", count: 100 },
        { state: "queued", count: 256 },
      ]);
    },
    TEST_TIMEOUT,
  );

  for (const mode of ["deferred", "expired lease"] as const) {
    realPostgresTest(
      `skips a 1,025-row locked ${mode} prefix and normalizes the later eligible peer`,
      async () => proveNormalizationRefillsPastLockedPrefix(mode),
      TEST_TIMEOUT,
    );
  }

  realPostgresTest(
    "advances active-cycle recovery before rotating to the less-served shard",
    async () => {
      if (!control || !claimRepository) {
        throw new Error("real PostgreSQL claim harness was not initialized");
      }
      const recoveryOrdinal = 34_000;
      const otherOrdinal = 35_000;
      await seedScheduleSources({ start: recoveryOrdinal, count: 1, fixedShard: 0 });
      expect(
        await claimRepository.claimAgentBackupAdmissionWork({
          ownerId: OWNER_A,
          limit: 1,
          leaseMs: 60_000,
        }),
      ).toEqual([]);
      await seedScheduleSources({ start: otherOrdinal, count: 1, fixedShard: 1 });
      expect(
        await claimRepository.claimAgentBackupAdmissionWork({
          ownerId: OWNER_B,
          limit: 1,
          leaseMs: 60_000,
        }),
      ).toEqual([]);
      await control.query(
        `UPDATE agent_backup_admission_work
        SET state = 'deferred', deferred_reason = 'TEST_BACKPRESSURE',
          not_before = clock_timestamp() - INTERVAL '1 second',
          updated_at = clock_timestamp()
        WHERE id = $1::uuid`,
        [workId(recoveryOrdinal, 0)],
      );

      expect(
        await claimRepository.claimAgentBackupAdmissionWork({
          ownerId: OWNER_A,
          limit: 1,
          leaseMs: 60_000,
        }),
      ).toEqual([]);
      const otherClaim = await claimRepository.claimAgentBackupAdmissionWork({
        ownerId: OWNER_B,
        limit: 1,
        leaseMs: 60_000,
      });
      expect(otherClaim.map(({ workId: id }) => id)).toEqual([workId(otherOrdinal, 1)]);
      expect(
        await claimRepository.claimAgentBackupAdmissionWork({
          ownerId: OWNER_A,
          limit: 1,
          leaseMs: 60_000,
        }),
      ).toEqual([]);

      const recovered = await control.query<{
        shard_id: number;
        last_turn: string;
        active_cycle: boolean;
        recovery_cursor_id: string | null;
      }>(`
        SELECT shard_id, last_turn::text AS last_turn,
          cycle_observed_at IS NOT NULL AS active_cycle, recovery_cursor_id::text
        FROM agent_backup_admission_claim_shards
        WHERE work_kind = 'schedule_capture' AND shard_id IN (0, 1)
        ORDER BY shard_id
      `);
      const [recoveredShard, lessServedShard] = recovered.rows;
      expect(recoveredShard?.active_cycle).toBe(true);
      expect(recoveredShard?.recovery_cursor_id).toBe(workId(recoveryOrdinal, 0));
      expect(BigInt(recoveredShard?.last_turn ?? "0")).toBeGreaterThan(
        BigInt(lessServedShard?.last_turn ?? "0"),
      );
      await expect(
        control.query(
          `UPDATE agent_backup_admission_claim_shards
          SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
            recovery_cursor_id = $1::uuid
          WHERE work_kind = 'schedule_capture' AND shard_id = 0`,
          [workId(1, 0)],
        ),
      ).rejects.toThrow(/recovery cursor must advance exactly/i);
      await expect(
        control.query(`UPDATE agent_backup_admission_claim_shards
          SET last_turn = nextval('agent_backup_admission_claim_turn_seq'),
            scan_cursor_cohort = cycle_max_cohort,
            scan_cursor_ordinal = cycle_max_ordinal,
            scan_cursor_id = cycle_max_id
          WHERE work_kind = 'schedule_capture' AND shard_id = 0`),
      ).rejects.toThrow(/recovery must advance before claim-cycle authority/i);

      expect(
        await claimRepository.claimAgentBackupAdmissionWork({
          ownerId: OWNER_B,
          limit: 1,
          leaseMs: 60_000,
        }),
      ).toEqual([]);
      const rotated = await control.query<{ shard_id: number; last_turn: string }>(`
        SELECT shard_id, last_turn::text AS last_turn
        FROM agent_backup_admission_claim_shards
        WHERE work_kind = 'schedule_capture' AND shard_id IN (0, 1)
        ORDER BY shard_id
      `);
      expect(rotated.rows[0]?.last_turn).toBe(recoveredShard?.last_turn);
      expect(BigInt(rotated.rows[1]?.last_turn ?? "0")).toBeGreaterThan(
        BigInt(lessServedShard?.last_turn ?? "0"),
      );
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "restarts the frozen priority cycle until 512 old P0 rows precede P1 and a late P0",
    async () => {
      if (!control || !claimRepository) {
        throw new Error("real PostgreSQL claim harness was not initialized");
      }
      await seedScheduleSources({
        start: 40_000,
        count: 512,
        fixedShard: 0,
        priorityClass: "lifecycle_safety",
        basePriority: 0,
      });
      await seedScheduleSources({
        start: 41_000,
        count: 1,
        fixedShard: 0,
        priorityClass: "active_rpo",
        basePriority: 1,
      });

      const first = await claimNextBatch({
        ownerId: OWNER_A,
        limit: 100,
        leaseMs: 60_000,
      });
      expect(first).toHaveLength(100);
      expect(first.every(({ effectivePriority }) => effectivePriority === 0)).toBe(true);
      await seedScheduleSources({
        start: 42_000,
        count: 1,
        fixedShard: 0,
        priorityClass: "lifecycle_safety",
        basePriority: 0,
      });

      for (let batch = 0; batch < 4; batch += 1) {
        const claims = await claimNextBatch({
          ownerId: batch % 2 === 0 ? OWNER_B : OWNER_A,
          limit: 100,
          leaseMs: 60_000,
        });
        expect(claims).toHaveLength(100);
        expect(claims.every(({ effectivePriority }) => effectivePriority === 0)).toBe(true);
      }
      const finalFrozenBatch = await claimNextBatch({
        ownerId: OWNER_B,
        limit: 100,
        leaseMs: 60_000,
      });
      expect(finalFrozenBatch).toHaveLength(12);
      expect(finalFrozenBatch.every(({ effectivePriority }) => effectivePriority === 0)).toBe(true);
      const strictP1Batch = await claimNextBatch({
        ownerId: OWNER_B,
        limit: 100,
        leaseMs: 60_000,
      });
      expect(strictP1Batch.map(({ workId: id }) => id)).toEqual([workId(41_000)]);
      expect(strictP1Batch[0]?.effectivePriority).toBe(1);
      const lateBeforeNextCycle = await control.query<{ state: string; attempts: number }>(`
        SELECT state, attempts FROM agent_backup_admission_work
        WHERE id = '${workId(42_000)}'::uuid
      `);
      expect(lateBeforeNextCycle.rows).toEqual([{ state: "queued", attempts: 0 }]);

      const [late] = await claimNextBatch({
        ownerId: OWNER_A,
        limit: 1,
        leaseMs: 60_000,
      });
      expect(late?.workId).toBe(workId(42_000));
      expect(late?.effectivePriority).toBe(0);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "lets two independent claimers lease 200 distinct rows from separate shards",
    async () => {
      if (!control || !claimRepository) {
        throw new Error("real PostgreSQL claim harness was not initialized");
      }
      await seedScheduleSources({ start: 1_000, count: 100, fixedShard: 0 });
      await seedScheduleSources({ start: 2_000, count: 100, fixedShard: 1 });
      const before = await readCapacitySnapshot();

      expect(
        await claimRepository.claimAgentBackupAdmissionWork({
          ownerId: OWNER_A,
          limit: 100,
          leaseMs: 60_000,
        }),
      ).toEqual([]);
      expect(
        await claimRepository.claimAgentBackupAdmissionWork({
          ownerId: OWNER_B,
          limit: 100,
          leaseMs: 60_000,
        }),
      ).toEqual([]);

      const [left, right] = await Promise.all([
        claimRepository.claimAgentBackupAdmissionWork({
          ownerId: OWNER_A,
          limit: 100,
          leaseMs: 60_000,
        }),
        claimRepository.claimAgentBackupAdmissionWork({
          ownerId: OWNER_B,
          limit: 100,
          leaseMs: 60_000,
        }),
      ]);
      expect(left).toHaveLength(100);
      expect(right).toHaveLength(100);
      expect(new Set([...left, ...right].map(({ workId: id }) => id)).size).toBe(200);
      expect(new Set(left.map(({ ownerId }) => ownerId))).toEqual(new Set([OWNER_A]));
      expect(new Set(right.map(({ ownerId }) => ownerId))).toEqual(new Set([OWNER_B]));

      const leased = await control.query<{ total: number; attempts: number; duplicates: number }>(`
        SELECT count(*)::integer AS total,
          count(*) FILTER (WHERE attempts = 1)::integer AS attempts,
          (count(*) - count(DISTINCT id))::integer AS duplicates
        FROM agent_backup_admission_work
        WHERE state = 'leased'
      `);
      expect(leased.rows).toEqual([{ total: 200, attempts: 200, duplicates: 0 }]);
      expect(await readCapacitySnapshot()).toEqual(before);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "keeps a same-shard arrival beyond frozen high-water for the next claim cycle",
    async () => {
      if (!control || !claimRepository) {
        throw new Error("real PostgreSQL claim harness was not initialized");
      }
      const oldStart = 50_000;
      const oldCount = 1_025;
      const oldHighWaterOrdinal = oldStart + oldCount - 1;
      const oldCursorOrdinal = oldHighWaterOrdinal - 1;
      const arrivalOrdinal = 60_000;
      await seedScheduleSources({ start: oldStart, count: oldCount, fixedShard: 0 });
      await control.query(`UPDATE agent_sandboxes
        SET lifecycle_revision = lifecycle_revision + 1
        WHERE id IN (
          SELECT sandbox_id FROM agent_backup_admission_work
          WHERE work_kind = 'schedule_capture' AND shard_id = 0
        )`);

      expect(
        await claimRepository.claimAgentBackupAdmissionWork({
          ownerId: OWNER_A,
          limit: 100,
          leaseMs: 60_000,
        }),
      ).toEqual([]);
      expect(
        await claimRepository.claimAgentBackupAdmissionWork({
          ownerId: OWNER_A,
          limit: 100,
          leaseMs: 60_000,
        }),
      ).toEqual([]);
      const frozen = await control.query<{
        cycleMaxCohort: string;
        cycleMaxOrdinal: number;
        cycleMaxId: string;
        cursorCohort: string;
        cursorOrdinal: number;
        cursorId: string;
        settled: number;
        queued: number;
      }>(`
        SELECT claim_shard.cycle_max_cohort::text AS "cycleMaxCohort",
          claim_shard.cycle_max_ordinal AS "cycleMaxOrdinal",
          claim_shard.cycle_max_id::text AS "cycleMaxId",
          claim_shard.scan_cursor_cohort::text AS "cursorCohort",
          claim_shard.scan_cursor_ordinal AS "cursorOrdinal",
          claim_shard.scan_cursor_id::text AS "cursorId",
          count(*) FILTER (WHERE work.state = 'settled')::integer AS settled,
          count(*) FILTER (WHERE work.state = 'queued')::integer AS queued
        FROM agent_backup_admission_claim_shards claim_shard
        CROSS JOIN agent_backup_admission_work work
        WHERE claim_shard.work_kind = 'schedule_capture'
          AND claim_shard.shard_id = 0
          AND work.work_kind = 'schedule_capture'
          AND work.shard_id = 0
        GROUP BY claim_shard.work_kind, claim_shard.shard_id
      `);
      expect(frozen.rows).toEqual([
        {
          cycleMaxCohort: String(oldHighWaterOrdinal),
          cycleMaxOrdinal: 0,
          cycleMaxId: workId(oldHighWaterOrdinal),
          cursorCohort: String(oldCursorOrdinal),
          cursorOrdinal: 0,
          cursorId: workId(oldCursorOrdinal),
          settled: 1_024,
          queued: 1,
        },
      ]);

      await seedScheduleSources({ start: arrivalOrdinal, count: 1, fixedShard: 0 });
      const beyondHighWater = await control.query<{
        beyond: boolean;
        state: string;
        attempts: number;
        activeCycle: boolean;
      }>(
        `
        SELECT
          (arrival.ready_cohort, arrival.cohort_ordinal, arrival.id) >
            (claim_shard.cycle_max_cohort, claim_shard.cycle_max_ordinal,
              claim_shard.cycle_max_id) AS beyond,
          arrival.state, arrival.attempts,
          claim_shard.cycle_observed_at IS NOT NULL AS "activeCycle"
        FROM agent_backup_admission_work arrival
        CROSS JOIN agent_backup_admission_claim_shards claim_shard
        WHERE arrival.id = $1::uuid
          AND claim_shard.work_kind = 'schedule_capture'
          AND claim_shard.shard_id = 0
      `,
        [workId(arrivalOrdinal)],
      );
      expect(beyondHighWater.rows).toEqual([
        { beyond: true, state: "queued", attempts: 0, activeCycle: true },
      ]);

      const [arrivalClaim] = await claimNextBatch({
        ownerId: OWNER_B,
        limit: 100,
        leaseMs: 60_000,
      });
      expect(arrivalClaim?.workId).toBe(workId(arrivalOrdinal));
      expect(arrivalClaim?.workAttempt).toBe(1);
      const afterOldCycle = await control.query<{
        state: string;
        attempts: number;
        activeCycle: boolean;
        oldSettled: number;
      }>(
        `
        SELECT arrival.state, arrival.attempts,
          claim_shard.cycle_observed_at IS NOT NULL AS "activeCycle",
          (SELECT count(*)::integer
            FROM agent_backup_admission_work old_work
            WHERE old_work.id <> arrival.id AND old_work.state = 'settled') AS "oldSettled"
        FROM agent_backup_admission_work arrival
        CROSS JOIN agent_backup_admission_claim_shards claim_shard
        WHERE arrival.id = $1::uuid
          AND claim_shard.work_kind = 'schedule_capture'
          AND claim_shard.shard_id = 0
      `,
        [workId(arrivalOrdinal)],
      );
      expect(afterOldCycle.rows).toEqual([
        { state: "leased", attempts: 1, activeCycle: true, oldSettled: oldCount },
      ]);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "serializes one tenant lane shared by candidates on different claim shards",
    async () => {
      if (!control || !claimRepository) {
        throw new Error("real PostgreSQL claim harness was not initialized");
      }
      const organizationId = testUuid(1, 90_000);
      await seedScheduleSources({
        start: 3_000,
        count: 1,
        fixedShard: 0,
        sharedOrganizationId: organizationId,
      });
      await seedScheduleSources({
        start: 3_001,
        count: 1,
        fixedShard: 1,
        sharedOrganizationId: organizationId,
      });
      const before = await readCapacitySnapshot();

      expect(
        await claimRepository.claimAgentBackupAdmissionWork({
          ownerId: OWNER_A,
          limit: 1,
          leaseMs: 60_000,
        }),
      ).toEqual([]);
      expect(
        await claimRepository.claimAgentBackupAdmissionWork({
          ownerId: OWNER_B,
          limit: 1,
          leaseMs: 60_000,
        }),
      ).toEqual([]);

      const results = await Promise.all([
        claimRepository.claimAgentBackupAdmissionWork({
          ownerId: OWNER_A,
          limit: 1,
          leaseMs: 60_000,
        }),
        claimRepository.claimAgentBackupAdmissionWork({
          ownerId: OWNER_B,
          limit: 1,
          leaseMs: 60_000,
        }),
      ]);
      expect(results.flat()).toHaveLength(1);
      expect(results.flat()[0]?.organizationId).toBe(organizationId);

      const laneState = await control.query<{ state: string; count: number }>(`
        SELECT state, count(*)::integer AS count
        FROM agent_backup_admission_work
        GROUP BY state ORDER BY state
      `);
      expect(laneState.rows).toEqual([
        { state: "leased", count: 1 },
        { state: "queued", count: 1 },
      ]);
      expect(await readCapacitySnapshot()).toEqual(before);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "reclaims an expired lease with a new generation and one incremented attempt",
    async () => {
      if (!control || !claimRepository) {
        throw new Error("real PostgreSQL claim harness was not initialized");
      }
      await seedScheduleSources({ start: 4_000, count: 1, fixedShard: 0 });
      const before = await readCapacitySnapshot();
      const [initial] = await claimNextBatch({
        ownerId: OWNER_A,
        limit: 1,
        leaseMs: claimRepository.MIN_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS,
      });
      if (!initial) throw new Error("expected the initial real PostgreSQL claim");
      await waitForDatabaseTimeAfter(initial.expiresAt);

      const [reclaimed] = await claimNextBatch({
        ownerId: OWNER_B,
        limit: 1,
        leaseMs: 60_000,
      });
      expect(reclaimed?.workId).toBe(initial.workId);
      expect(reclaimed?.ownerId).toBe(OWNER_B);
      expect(reclaimed?.workAttempt).toBe(2);
      expect(reclaimed?.generation).not.toBe(initial.generation);
      expect(
        await claimRepository.settleAgentBackupAdmissionClaim({
          fence: fence(initial),
          reason: "STALE_WORKER_MUST_NOT_SETTLE",
        }),
      ).toBe(false);
      expect(await readCapacitySnapshot()).toEqual(before);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "reports retry exhaustion when the final deferral settles the claim",
    async () => {
      if (!control || !claimRepository) {
        throw new Error("real PostgreSQL claim harness was not initialized");
      }
      const ordinal = 4_100;
      await seedScheduleSources({ start: ordinal, count: 1, fixedShard: 0 });

      for (let attempt = 1; attempt <= MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS; attempt += 1) {
        const [claim] = await claimNextBatch({
          ownerId: `retry-exhaustion-real-pg-worker-${attempt}`,
          limit: 1,
          leaseMs: 60_000,
        });
        expect(claim?.workAttempt).toBe(attempt);
        if (!claim) throw new Error(`Expected real PostgreSQL retry claim ${attempt}`);
        expect(
          await claimRepository.deferAgentBackupAdmissionClaim({
            fence: fence(claim),
            retryDelayMs: 1,
            reason: "TEST_RETRY",
          }),
        ).toBe(attempt === MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS ? "retry_exhausted" : "deferred");
        if (attempt < MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS) {
          const deferred = await control.query<{ not_before: Date }>(
            "SELECT not_before FROM agent_backup_admission_work WHERE id = $1::uuid",
            [workId(ordinal)],
          );
          const notBefore = deferred.rows[0]?.not_before;
          if (!notBefore) throw new Error(`Expected deferred retry ${attempt}`);
          await waitForDatabaseTimeAfter(notBefore);
        }
      }

      const exhausted = await control.query<{
        state: string;
        attempts: number;
        settled_reason: string | null;
      }>(
        `SELECT state, attempts, settled_reason
        FROM agent_backup_admission_work WHERE id = $1::uuid`,
        [workId(ordinal)],
      );
      expect(exhausted.rows).toEqual([
        {
          state: "settled",
          attempts: MAX_AGENT_BACKUP_ADMISSION_ATTEMPTS,
          settled_reason: "RETRY_EXHAUSTED",
        },
      ]);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "drains 10,000 mixed-priority rows plus arrivals across all 64 shards without starvation",
    async () => {
      if (!control || !claimRepository) {
        throw new Error("real PostgreSQL claim harness was not initialized");
      }
      await seedScheduleSources({ start: 10_000, count: 2_500 });
      await seedScheduleSources({
        start: 12_500,
        count: 2_500,
        priorityClass: "active_rpo",
        basePriority: 1,
      });
      await seedScheduleSources({
        start: 15_000,
        count: 2_500,
        priorityClass: "drain_recovery",
        basePriority: 2,
      });
      await seedScheduleSources({
        start: 17_500,
        count: 2_500,
        priorityClass: "periodic_capture",
        basePriority: 3,
      });
      const before = await readCapacitySnapshot();
      const initial = await control.query<{
        queued: number;
        attemptZero: number;
        activeCycles: number;
      }>(`
        SELECT
          (SELECT count(*) FILTER (WHERE state = 'queued')::integer
            FROM agent_backup_admission_work) AS queued,
          (SELECT count(*) FILTER (WHERE attempts = 0)::integer
            FROM agent_backup_admission_work) AS "attemptZero",
          (SELECT count(*) FILTER (WHERE cycle_observed_at IS NOT NULL)::integer
            FROM agent_backup_admission_claim_shards
            WHERE work_kind = 'schedule_capture') AS "activeCycles"
      `);
      expect(initial.rows).toEqual([{ queued: 10_000, attemptZero: 10_000, activeCycles: 0 }]);
      const claimed = new Set<string>();
      const duplicateClaims: string[] = [];
      let capacityAfterArrivals = before;

      for (let round = 0; round < 192; round += 1) {
        const results = await Promise.all(
          Array.from({ length: 16 }, (_, worker) =>
            claimRepository?.claimAgentBackupAdmissionWork({
              ownerId: `schedule-10k-worker-${worker}`,
              limit: 100,
              leaseMs: 5 * 60_000,
            }),
          ),
        );
        for (const claim of results.flatMap((batch) => batch ?? [])) {
          if (claimed.has(claim.workId)) duplicateClaims.push(claim.workId);
          claimed.add(claim.workId);
        }
        if (round === 0) {
          expect(await readCapacitySnapshot()).toEqual(before);
          await seedScheduleSources({ start: 30_000, count: 640 });
          capacityAfterArrivals = await readCapacitySnapshot();
        }
        const pending = await control.query<{ queued: number }>(`
          SELECT count(*) FILTER (WHERE state = 'queued')::integer AS queued
          FROM agent_backup_admission_work
        `);
        if (pending.rows[0]?.queued === 0) break;
      }

      expect(duplicateClaims).toEqual([]);
      expect(claimed.size).toBe(10_640);
      const proof = await control.query<{
        queued: number;
        leased: number;
        firstAttempts: number;
        duplicateOrganizations: number;
        duplicateNodes: number;
        progressedShards: number;
      }>(`
        SELECT
          (SELECT count(*) FILTER (WHERE state = 'queued')::integer
            FROM agent_backup_admission_work) AS queued,
          (SELECT count(*) FILTER (WHERE state = 'leased')::integer
            FROM agent_backup_admission_work) AS leased,
          (SELECT count(*) FILTER (WHERE attempts = 1)::integer
            FROM agent_backup_admission_work) AS "firstAttempts",
          (SELECT count(*)::integer FROM (
            SELECT organization_id FROM agent_backup_admission_work
            WHERE state = 'leased' GROUP BY organization_id HAVING count(*) > 1
          ) duplicate_organizations) AS "duplicateOrganizations",
          (SELECT count(*)::integer FROM (
            SELECT node_history_id FROM agent_backup_admission_work
            WHERE state = 'leased' GROUP BY node_history_id HAVING count(*) > 1
          ) duplicate_nodes) AS "duplicateNodes",
          (SELECT count(*) FILTER (WHERE last_turn > 0)::integer
            FROM agent_backup_admission_claim_shards
            WHERE work_kind = 'schedule_capture') AS "progressedShards"
      `);
      expect(proof.rows).toEqual([
        {
          queued: 0,
          leased: 10_640,
          firstAttempts: 10_640,
          duplicateOrganizations: 0,
          duplicateNodes: 0,
          progressedShards: 64,
        },
      ]);
      const priorities = await control.query<{ priorityClass: string; count: number }>(`
        SELECT priority_class AS "priorityClass", count(*)::integer AS count
        FROM agent_backup_admission_work
        WHERE state = 'leased'
        GROUP BY priority_class, base_priority
        ORDER BY base_priority
      `);
      expect(priorities.rows).toEqual([
        { priorityClass: "lifecycle_safety", count: 3_140 },
        { priorityClass: "active_rpo", count: 2_500 },
        { priorityClass: "drain_recovery", count: 2_500 },
        { priorityClass: "periodic_capture", count: 2_500 },
      ]);
      expect(await readCapacitySnapshot()).toEqual(capacityAfterArrivals);
    },
    TEN_THOUSAND_TIMEOUT,
  );
});
