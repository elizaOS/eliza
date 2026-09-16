/**
 * Real-PostgreSQL proofs for post-lock claim fences and the atomic
 * admission-work to catalogue-reservation handoff.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import { installAgentNodeOccurrenceTriggerForTests } from "../../agent-node-occurrence-test-support";
import {
  agentBackupNodeAdmissionCursors,
  agentBackupOrganizationAdmissionCursors,
} from "../../schemas/agent-backup-admission";
import {
  agentBackupGcOutbox,
  agentBackupObjects,
  agentBackupRestoreLeases,
} from "../../schemas/agent-backup-catalog";
import { agentNodeIncarnationHistories } from "../../schemas/agent-node-incarnation-histories";
import {
  agentBackupCatalogAuthorities,
  agentSandboxBackups,
  agentSandboxes,
} from "../../schemas/agent-sandboxes";
import { dockerNodes } from "../../schemas/docker-nodes";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";

const SKIP_REASON =
  "[backup admission reservation PostgreSQL] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const REQUIRE_REAL_POSTGRES =
  process.env.REQUIRE_REAL_POSTGRES_BACKUP_ADMISSION_RESERVATION_TESTS === "1";
const APPLICATION_NAME = "backup-admission-reservation-postgres-test";
const TEST_TIMEOUT = 120_000;
const TEN_THOUSAND_TIMEOUT = 600_000;
const SCALE_SOURCE_START = 10_000;
const SCALE_INITIAL_COUNT = 10_000;
const SCALE_ARRIVAL_COUNT = 640;
const SCALE_TOTAL_COUNT = SCALE_INITIAL_COUNT + SCALE_ARRIVAL_COUNT;

const ORGANIZATION_ID = "00000000-0000-4000-8000-00000000e001";
const USER_ID = "00000000-0000-4000-8000-00000000e002";
const SANDBOX_ID = "00000000-0000-4000-8000-00000000e003";
const WORK_ID = "11000000-0000-4000-8000-00000000e004";
const NODE_RECORD_ID = "00000000-0000-4000-8000-00000000e005";
const NODE_HISTORY_ID = "00000000-0000-4000-8000-00000000e006";
const NODE_INCARNATION = "00000000-0000-4000-8000-00000000e007";
const ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000e008";
const DELETION_REQUEST_ID = "00000000-0000-4000-8000-00000000e009";
const NODE_ID = "reservation-postgres-node";
const PROVIDER_HANDLE = "reservation-postgres-provider-handle";
const CONTAINER_ID = "d".repeat(64);
const IMAGE_DIGEST = `sha256:${"9".repeat(64)}`;
const RECEIPT_HASH = "a".repeat(64);
const RECEIPT_MAC = "b".repeat(64);
const OWNER = "reservation-postgres-worker";

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

type ClientModule = typeof import("../../client");
type ClaimRepository = typeof import("../agent-backup-admission-claim");
type ReservationRepository = typeof import("../agent-backup-admission-reservation");
type SchedulerRepository = typeof import("../agent-backup-scheduler");
type AdmissionClaim = Awaited<ReturnType<ClaimRepository["claimAgentBackupAdmissionWork"]>>[number];
type LegacyScheduleClaim = Awaited<
  ReturnType<SchedulerRepository["claimDueAgentBackupSchedules"]>
>[number];

interface ScaleWorkSeed {
  start: number;
  count: number;
  priorityClass: "lifecycle_safety" | "active_rpo" | "drain_recovery" | "periodic_capture";
  basePriority: 0 | 1 | 2 | 3;
  dueAt: Date;
}

interface CapacityAndJobsSnapshot {
  jobs: number;
  jobFingerprint: string;
  nodes: number;
  capacityTotal: number;
  capacityMin: number;
  capacityMax: number;
  allocated: number;
  changedNodes: number;
  autoscaledNodes: number;
}

interface ScaleReservationPayloadProof {
  operationId: string;
  organizationId: string;
  sandboxId: string;
  activationGeneration: string;
  lifecycleRevision: string;
  nodeHistoryId: string;
  nodeRecordId: string;
  nodeId: string;
  nodeIncarnation: string;
  sourceProvider: "operator-onboarded" | "hetzner-cloud";
  providerServerId: string | null;
  providerHandle: string;
  containerId: string;
  retentionUntil: Date;
  catalogPayloadDigest: string;
}

function expectedScaleReservationPayloadDigest(row: ScaleReservationPayloadProof): string {
  const canonicalPayload = JSON.stringify({
    organizationId: row.organizationId,
    agentId: row.sandboxId,
    sandboxRecordId: row.sandboxId,
    operationId: row.operationId,
    activationGeneration: row.activationGeneration,
    lifecycleRevision: row.lifecycleRevision,
    snapshotType: "auto",
    backupKind: "full",
    parentBackupId: null,
    baseBackupId: null,
    sourceProvider: row.sourceProvider,
    sourceNodeRecordId: row.nodeRecordId,
    sourceNodeId: row.nodeId,
    sourceNodeIncarnation: row.nodeIncarnation,
    sourceNodeHistoryId: row.nodeHistoryId,
    sourceProviderServerId: row.providerServerId,
    sourceProviderHandle: row.providerHandle,
    sourceContainerId: row.containerId,
    retentionReason: "schedule",
    retentionUntil: row.retentionUntil.toISOString(),
  });
  return createHash("sha256").update(canonicalPayload).digest("hex");
}

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
let databaseName: string | null = null;
let isolatedDsn: string | null = null;
let control: Client | null = null;
let dbWrite: ClientModule["dbWrite"] | undefined;
let closeDatabaseConnectionsForTests: ClientModule["closeDatabaseConnectionsForTests"] | undefined;
let claimRepository: ClaimRepository | undefined;
let reservationRepository: ReservationRepository | undefined;
let schedulerRepository: SchedulerRepository | undefined;
let cleanupPromise: Promise<void> | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function createIsolatedDatabase(baseDsn: string): Promise<{
  databaseName: string;
  dsn: string;
}> {
  const createdName = `eliza_backup_reservation_${randomUUID().replaceAll("-", "")}`;
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
    await client.query("ROLLBACK");
    throw cause;
  }
}

async function applyAdmissionMigrations(client: Client): Promise<void> {
  for (const migration of MIGRATIONS) await applyMigration(client, migration);
}

async function cleanupHarnessOnce(): Promise<void> {
  const acquiredPostgres = postgres;
  const createdDatabase = databaseName;
  const failures: unknown[] = [];
  const capture = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (cause) {
      failures.push(cause);
    }
  };

  if (control) await capture(async () => control?.end());
  control = null;
  if (closeDatabaseConnectionsForTests) await capture(closeDatabaseConnectionsForTests);
  closeDatabaseConnectionsForTests = undefined;
  dbWrite = undefined;
  claimRepository = undefined;
  reservationRepository = undefined;
  schedulerRepository = undefined;

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
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "backup admission reservation PostgreSQL teardown failed");
  }
}

function cleanupHarness(): Promise<void> {
  cleanupPromise ??= cleanupHarnessOnce();
  return cleanupPromise;
}

async function initializeHarness(): Promise<void> {
  if (!postgres) {
    if (REQUIRE_REAL_POSTGRES) {
      throw new Error("Real PostgreSQL is required for backup admission reservation tests");
    }
    process.stderr.write(`${SKIP_REASON}\n`);
    return;
  }
  const isolated = await createIsolatedDatabase(postgres.dsn);
  databaseName = isolated.databaseName;
  isolatedDsn = isolated.dsn;
  process.env.DATABASE_URL = isolated.dsn;
  process.env.TEST_DATABASE_URL = isolated.dsn;
  process.env.LOCAL_PG_POOL_MAX = "2";
  process.env.RAILWAY_SERVICE_NAME = APPLICATION_NAME;
  process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";
  process.env.NODE_ENV = "test";
  process.env.MOCK_REDIS = "1";
  process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

  const [clientModule, claimModule, reservationModule, schedulerModule] = await Promise.all([
    import("../../client"),
    import("../agent-backup-admission-claim"),
    import("../agent-backup-admission-reservation"),
    import("../agent-backup-scheduler"),
  ]);
  dbWrite = clientModule.dbWrite;
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  claimRepository = claimModule;
  reservationRepository = reservationModule;
  schedulerRepository = schedulerModule;
  control = new Client({
    connectionString: isolated.dsn,
    application_name: `${APPLICATION_NAME}-control`,
  });
  await control.connect();
}

async function resetFixture(): Promise<void> {
  if (!control) return;
  await control.query("BEGIN");
  try {
    await control.query(`
      ALTER TABLE agent_backup_admission_work DISABLE TRIGGER USER;
      DELETE FROM agent_backup_admission_work;
      ALTER TABLE agent_backup_admission_work ENABLE TRIGGER USER;
      DELETE FROM jobs;
      DELETE FROM agent_backup_restore_leases;
      DELETE FROM agent_backup_gc_outbox;
      DELETE FROM agent_backup_objects;
      DELETE FROM agent_sandbox_backups;
      DELETE FROM agent_backup_node_admission_cursors;
      DELETE FROM agent_backup_organization_admission_cursors;
      DELETE FROM agent_backup_catalog_authorities;
      DELETE FROM agent_sandboxes;
      DELETE FROM docker_nodes;
      DELETE FROM agent_node_incarnation_histories;
      DELETE FROM user_characters;
      DELETE FROM users;
      DELETE FROM organizations;
      ALTER TABLE agent_backup_admission_claim_shards DISABLE TRIGGER USER;
      UPDATE agent_backup_admission_claim_shards SET
        last_turn = 0,
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
        recovery_start_turn = NULL,
        recovery_cutoff_at = NULL,
        recovery_cursor_at = NULL,
        recovery_cursor_state = NULL,
        recovery_cursor_id = NULL,
        last_recovery_claim_cycle_start_turn = NULL,
        updated_at = now();
      ALTER TABLE agent_backup_admission_claim_shards ENABLE TRIGGER USER;
      ALTER SEQUENCE agent_backup_admission_claim_turn_seq RESTART WITH 1;
      ALTER SEQUENCE agent_backup_admission_cohort_seq RESTART WITH 1000000;
    `);
    await control.query("COMMIT");
  } catch (cause) {
    await control.query("ROLLBACK");
    throw cause;
  }
}

async function seedQueuedWork(): Promise<void> {
  if (!dbWrite) throw new Error("real PostgreSQL reservation harness was not initialized");
  const sourceDueAt = new Date(Date.now() - 60_000);
  await dbWrite.insert(organizations).values({
    id: ORGANIZATION_ID,
    name: "Backup admission reservation PostgreSQL org",
    slug: "backup-admission-reservation-postgres-org",
  });
  await dbWrite.insert(users).values({
    id: USER_ID,
    steward_user_id: "backup-admission-reservation-postgres-user",
    organization_id: ORGANIZATION_ID,
  });
  await dbWrite.insert(agentNodeIncarnationHistories).values({
    id: NODE_HISTORY_ID,
    docker_node_record_id: NODE_RECORD_ID,
    node_id: NODE_ID,
    node_incarnation: NODE_INCARNATION,
    fleet_kind: "robot",
    infrastructure_provider: "hetzner",
    provider_server_id: null,
    host_key_fingerprint: "sha256:reservation-postgres-host-key",
  });
  await dbWrite.insert(dockerNodes).values({
    id: NODE_RECORD_ID,
    node_id: NODE_ID,
    hostname: "reservation-postgres-node.example.test",
    host_key_fingerprint: "sha256:reservation-postgres-host-key",
    fleet_kind: "robot",
    infrastructure_provider: "hetzner",
    provider_server_id: null,
    node_incarnation: NODE_INCARNATION,
    current_node_history_id: NODE_HISTORY_ID,
    status: "healthy",
    enabled: true,
    capacity: 8,
    allocated_count: 2,
  });
  const now = Date.now();
  await dbWrite.insert(agentSandboxes).values({
    id: SANDBOX_ID,
    organization_id: ORGANIZATION_ID,
    user_id: USER_ID,
    agent_name: "Backup admission reservation PostgreSQL agent",
    status: "running",
    execution_tier: "dedicated-always",
    sandbox_id: PROVIDER_HANDLE,
    node_id: NODE_ID,
    container_name: "backup-admission-reservation-postgres-agent",
    image_digest: IMAGE_DIGEST,
    lifecycle_revision: 0,
    activation_generation: ACTIVATION_GENERATION,
    activation_lifecycle_revision: 0n,
    activation_purpose: "provision",
    activation_phase: "active",
    activation_receipt: {
      schemaVersion: 1,
      generation: ACTIVATION_GENERATION,
      purpose: "provision",
      agentId: SANDBOX_ID,
      organizationId: ORGANIZATION_ID,
      lifecycleRevision: "0",
      backupId: null,
      backupHash: null,
      manifestHash: null,
      componentHashes: null,
      freshAuthorization: null,
      containerId: CONTAINER_ID,
      imageDigest: IMAGE_DIGEST,
      receiptId: NODE_INCARNATION,
      receiptHash: RECEIPT_HASH,
      receiptMac: RECEIPT_MAC,
      appliedAt: new Date(now - 4_000).toISOString(),
      restored: true,
      requiresRestart: false,
    },
    activation_receipt_hash: RECEIPT_HASH,
    activation_container_id: CONTAINER_ID,
    activation_node_id: NODE_ID,
    activation_image_digest: IMAGE_DIGEST,
    activation_boot_id: NODE_INCARNATION,
    activation_token_hash: RECEIPT_HASH,
    activation_token_ciphertext: "sealed-activation-token",
    activation_funding_revision: 0n,
    activation_authority_published_at: new Date(now - 3_000),
    activation_dispatched_at: new Date(now - 2_000),
    activation_completed_at: new Date(now - 1_000),
    next_backup_at: sourceDueAt,
  });
  await dbWrite.insert(agentBackupOrganizationAdmissionCursors).values({
    organization_id: ORGANIZATION_ID,
  });
  await dbWrite.insert(agentBackupNodeAdmissionCursors).values({
    node_history_id: NODE_HISTORY_ID,
  });
  await dbWrite.execute(sql`
    INSERT INTO agent_backup_admission_work (
      id, work_kind, work_stage, organization_id, sandbox_id, node_history_id,
      source_activation_generation, source_lifecycle_revision,
      source_provider_handle, source_container_id, source_image_digest,
      source_rpo_ms, requires_node_lane, priority_class, base_priority,
      source_due_at, rpo_deadline_at, state, not_before, ready_cohort,
      cohort_ordinal, shard_id, attempts
    ) VALUES (
      ${WORK_ID}::uuid, 'schedule_capture', 'reserve_capture',
      ${ORGANIZATION_ID}::uuid, ${SANDBOX_ID}::uuid, ${NODE_HISTORY_ID}::uuid,
      ${ACTIVATION_GENERATION}::uuid, 0, ${PROVIDER_HANDLE}, ${CONTAINER_ID},
      ${IMAGE_DIGEST}, 900000, TRUE, 'periodic_capture', 3,
      ${sourceDueAt}, ${new Date(sourceDueAt.getTime() + 900_000)},
      'queued', ${sourceDueAt}, 1, 0, 0, 0
    )
  `);
}

async function seedScaleSources(params: {
  start: number;
  count: number;
  dueAt: Date;
}): Promise<void> {
  if (!control) throw new Error("real PostgreSQL control session was not initialized");
  const values = [
    params.start,
    params.count,
    params.dueAt,
    IMAGE_DIGEST,
    RECEIPT_HASH,
    RECEIPT_MAC,
  ];
  const seed = `
    SELECT ordinal,
      mod(ordinal - seed_input.start_ordinal, 64)::integer AS shard_id,
      backup_reservation_test_uuid(1, ordinal, 0) AS organization_id,
      backup_reservation_test_uuid(2, ordinal, 0) AS user_id,
      backup_reservation_test_uuid(3, ordinal, 0) AS node_record_id,
      backup_reservation_test_uuid(4, ordinal, 0) AS node_history_id,
      backup_reservation_test_uuid(5, ordinal, 0) AS node_incarnation,
      backup_reservation_test_uuid(6, ordinal, 0) AS activation_generation,
      backup_reservation_test_uuid(
        7, ordinal, mod(ordinal - seed_input.start_ordinal, 64)::integer
      ) AS sandbox_id
    FROM (
      SELECT $1::integer AS start_ordinal, $2::integer AS seed_count,
        $3::timestamptz AS due_at, $4::text AS image_digest,
        $5::text AS receipt_hash, $6::text AS receipt_mac
    ) AS seed_input
    CROSS JOIN LATERAL generate_series(
      seed_input.start_ordinal,
      seed_input.start_ordinal + seed_input.seed_count - 1
    ) AS ordinal
  `;

  await control.query("BEGIN");
  try {
    await control.query(
      `WITH seed AS (${seed})
       INSERT INTO organizations (id, name, slug)
       SELECT organization_id, 'Backup reservation scale org ' || ordinal,
         'backup-reservation-scale-org-' || ordinal
       FROM seed`,
      values,
    );
    await control.query(
      `WITH seed AS (${seed})
       INSERT INTO users (id, organization_id, steward_user_id)
       SELECT user_id, organization_id, 'backup-reservation-scale-user-' || ordinal
       FROM seed`,
      values,
    );
    await control.query(
      `WITH seed AS (${seed})
       INSERT INTO agent_node_incarnation_histories (
         id, docker_node_record_id, node_id, node_incarnation, fleet_kind,
         infrastructure_provider, provider_server_id, host_key_fingerprint
       ) SELECT
         node_history_id, node_record_id, 'backup-reservation-scale-node-' || ordinal,
         node_incarnation, 'robot', 'hetzner', NULL,
         'sha256:backup-reservation-scale-host-key-' || ordinal
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
         node_record_id, 'backup-reservation-scale-node-' || ordinal,
         'backup-reservation-scale-node-' || ordinal || '.test.invalid',
         8, TRUE, 'open', 'healthy', 2, 'robot', 'hetzner', NULL,
         'sha256:backup-reservation-scale-host-key-' || ordinal,
         node_incarnation, node_history_id, '{"managedBy":"operator"}'::jsonb
       FROM seed`,
      values,
    );
    await control.query(
      `WITH seed AS (${seed})
       INSERT INTO agent_sandboxes (
         id, organization_id, user_id, sandbox_id, status, activation_generation,
         activation_lifecycle_revision, activation_purpose, activation_phase,
         activation_receipt, activation_receipt_hash, activation_container_id,
         activation_node_id, activation_image_digest, activation_token_hash,
         activation_token_ciphertext, activation_boot_id,
         activation_authority_published_at, activation_funding_revision,
         activation_dispatched_at, activation_completed_at, execution_tier,
         agent_name, lifecycle_revision, node_id, container_name, image_digest,
         next_backup_at
       ) SELECT
         sandbox_id, organization_id, user_id, 'backup-reservation-provider-' || ordinal,
         'running', activation_generation, 7, 'provision', 'active',
         jsonb_build_object(
           'schemaVersion', 1,
           'generation', activation_generation::text,
           'purpose', 'provision',
           'agentId', sandbox_id::text,
           'organizationId', organization_id::text,
           'lifecycleRevision', '7',
           'backupId', NULL,
           'backupHash', NULL,
           'manifestHash', NULL,
           'componentHashes', NULL,
           'freshAuthorization', NULL,
           'containerId', lpad(to_hex(ordinal), 64, 'a'),
           'imageDigest', $4::text,
           'receiptId', node_incarnation::text,
           'receiptHash', $5::text,
           'receiptMac', $6::text,
           'appliedAt', $3::timestamptz - INTERVAL '4 seconds',
           'restored', TRUE,
           'requiresRestart', FALSE
         ),
         $5::text, lpad(to_hex(ordinal), 64, 'a'),
         'backup-reservation-scale-node-' || ordinal, $4::text,
         $5::text, 'sealed-backup-reservation-scale-token', node_incarnation,
         $3::timestamptz - INTERVAL '3 seconds', 0,
         $3::timestamptz - INTERVAL '2 seconds',
         $3::timestamptz - INTERVAL '1 second', 'dedicated-always',
         'Backup reservation scale agent ' || ordinal, 7,
         'backup-reservation-scale-node-' || ordinal,
         'backup-reservation-scale-agent-' || ordinal, $4::text, $3::timestamptz
       FROM seed`,
      values,
    );
    await control.query(
      `WITH seed AS (${seed})
       INSERT INTO agent_backup_organization_admission_cursors (organization_id)
       SELECT organization_id FROM seed`,
      values,
    );
    await control.query(
      `WITH seed AS (${seed})
       INSERT INTO agent_backup_node_admission_cursors (node_history_id)
       SELECT node_history_id FROM seed`,
      values,
    );
    await control.query("COMMIT");
  } catch (cause) {
    await control.query("ROLLBACK");
    throw cause;
  }
}

async function seedScaleWork(params: ScaleWorkSeed): Promise<void> {
  if (!control) throw new Error("real PostgreSQL control session was not initialized");
  await control.query(
    `WITH seed AS (
       SELECT ordinal,
         mod(ordinal - $5::integer, 64)::integer AS shard_id,
         backup_reservation_test_uuid(1, ordinal, 0) AS organization_id,
         backup_reservation_test_uuid(3, ordinal, 0) AS node_record_id,
         backup_reservation_test_uuid(4, ordinal, 0) AS node_history_id,
         backup_reservation_test_uuid(6, ordinal, 0) AS activation_generation,
         backup_reservation_test_uuid(
           7, ordinal, mod(ordinal - $5::integer, 64)::integer
         ) AS sandbox_id
       FROM generate_series($1::integer, $1::integer + $2::integer - 1) AS ordinal
     )
     INSERT INTO agent_backup_admission_work (
       id, work_kind, work_stage, organization_id, sandbox_id, node_history_id,
       source_activation_generation, source_lifecycle_revision,
       source_provider_handle, source_container_id, source_image_digest,
       source_rpo_ms, requires_node_lane, priority_class, base_priority,
       source_due_at, rpo_deadline_at, state, not_before, ready_cohort,
       cohort_ordinal, shard_id, attempts
     ) SELECT
       backup_reservation_test_uuid(8, ordinal, mod(shard_id + 17, 64)),
       'schedule_capture', 'reserve_capture', organization_id, sandbox_id,
       node_history_id, activation_generation, 7,
       'backup-reservation-provider-' || ordinal, lpad(to_hex(ordinal), 64, 'a'),
       $6::text, 900000, TRUE, $3::text, $4::smallint,
       $7::timestamptz, $7::timestamptz + INTERVAL '15 minutes',
       'queued', $7::timestamptz, ordinal::bigint, 0, shard_id, 0
     FROM seed`,
    [
      params.start,
      params.count,
      params.priorityClass,
      params.basePriority,
      SCALE_SOURCE_START,
      IMAGE_DIGEST,
      params.dueAt,
    ],
  );
}

async function readCapacityAndJobsSnapshot(): Promise<CapacityAndJobsSnapshot> {
  if (!control) throw new Error("real PostgreSQL control session was not initialized");
  const snapshot = await control.query<CapacityAndJobsSnapshot>(`
    SELECT
      (SELECT count(*)::integer FROM jobs) AS jobs,
      (SELECT COALESCE(
        string_agg(id::text || ':' || type || ':' || status, ',' ORDER BY id), ''
      ) FROM jobs) AS "jobFingerprint",
      count(*)::integer AS nodes,
      COALESCE(sum(capacity), 0)::integer AS "capacityTotal",
      COALESCE(min(capacity), 0)::integer AS "capacityMin",
      COALESCE(max(capacity), 0)::integer AS "capacityMax",
      COALESCE(sum(allocated_count), 0)::integer AS allocated,
      count(*) FILTER (WHERE
        capacity <> 8 OR allocated_count <> 2 OR NOT enabled
        OR placement_state <> 'open' OR status <> 'healthy'
        OR metadata <> '{"managedBy":"operator"}'::jsonb
      )::integer AS "changedNodes",
      count(*) FILTER (WHERE metadata->>'autoscaled' = 'true')::integer AS "autoscaledNodes"
    FROM docker_nodes
  `);
  const result = snapshot.rows[0];
  if (!result) throw new Error("PostgreSQL did not return the capacity/jobs sentinel");
  return result;
}

function createAsyncGate(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (active < limit) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
  };
  const release = (): void => {
    active -= 1;
    waiters.shift()?.();
  };
  return async <T>(run: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await run();
    } finally {
      release();
    }
  };
}

async function claimOne(leaseMs: number): Promise<AdmissionClaim> {
  if (!claimRepository) throw new Error("real PostgreSQL claim repository was not initialized");
  await seedQueuedWork();
  for (let turn = 0; turn < 128; turn += 1) {
    const [claim] = await claimRepository.claimAgentBackupAdmissionWork({
      ownerId: OWNER,
      limit: 1,
      leaseMs,
    });
    if (claim) return claim;
  }
  throw new Error("No backup admission claim after 128 bounded progress turns");
}

async function claimLegacySchedule(leaseMs: number): Promise<LegacyScheduleClaim> {
  if (!schedulerRepository) {
    throw new Error("real PostgreSQL legacy scheduler repository was not initialized");
  }
  const [claim] = await schedulerRepository.claimDueAgentBackupSchedules({
    ownerId: `${OWNER}-legacy`,
    limit: 1,
    leaseMs,
  });
  if (!claim) throw new Error("Legacy backup scheduler did not claim the due sandbox");
  if (
    claim.organizationId !== ORGANIZATION_ID ||
    claim.agentId !== SANDBOX_ID ||
    claim.operationId === WORK_ID
  ) {
    throw new Error("Legacy backup scheduler returned an unexpected fair-lane identity");
  }
  return claim;
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

async function waitForRepositoryLockWaiters(
  observer: Client,
  blockerPid: number,
  minimum: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ pid: number; blockers: number[] }>(
      `SELECT pid, pg_blocking_pids(pid) AS blockers
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name = $1
         AND state = 'active'
         AND wait_event_type = 'Lock'`,
      [APPLICATION_NAME],
    );
    const blockedPids = new Set(
      result.rows.filter(({ blockers }) => blockers.includes(blockerPid)).map(({ pid }) => pid),
    );
    if (blockedPids.size >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} backup admission repository lock waiter(s)`);
}

async function waitForRepositoryBlockedPid(observer: Client, blockerPid: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ blockers: number[]; pid: number }>(
      `SELECT pid, pg_blocking_pids(pid) AS blockers
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name = $1
         AND state = 'active'
         AND wait_event_type = 'Lock'`,
      [APPLICATION_NAME],
    );
    const blocked = result.rows.filter(({ blockers }) => blockers.includes(blockerPid));
    if (blocked.length === 1 && blocked[0]) return blocked[0].pid;
    if (blocked.length > 1) {
      throw new Error(`More than one repository session is blocked by backend ${blockerPid}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a repository session blocked by backend ${blockerPid}`);
}

function findPostgresErrorCode(cause: unknown): string | null {
  const seen = new Set<unknown>();
  let current = cause;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const code = Reflect.get(current, "code");
    if (typeof code === "string") return code;
    current = Reflect.get(current, "cause");
  }
  return null;
}

async function waitForDatabaseTimeAfter(instant: Date): Promise<void> {
  if (!control) throw new Error("real PostgreSQL control session was not initialized");
  const deadline = Date.now() + 10_000;
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

async function expectNoPartialReservation(): Promise<void> {
  if (!control) throw new Error("real PostgreSQL control session was not initialized");
  const state = await control.query<{
    authorities: number;
    backups: number;
    max_revision: string;
    state: string;
    lease_owner: string | null;
    settled_reason: string | null;
  }>(
    `
    SELECT
      (SELECT count(*)::integer FROM agent_sandbox_backups) AS backups,
      (SELECT count(*)::integer FROM agent_backup_catalog_authorities) AS authorities,
      (SELECT COALESCE(max(catalog_revision), 0)::text
        FROM agent_backup_catalog_authorities) AS max_revision,
      work.state, work.lease_owner, work.settled_reason
    FROM agent_backup_admission_work AS work
    WHERE work.id = $1::uuid
  `,
    [WORK_ID],
  );
  expect(state.rows).toEqual([
    {
      authorities: 0,
      backups: 0,
      max_revision: "0",
      state: "leased",
      lease_owner: OWNER,
      settled_reason: null,
    },
  ]);
}

async function expectOnlyLegacyReservation(legacyOperationId: string): Promise<void> {
  if (!control) throw new Error("real PostgreSQL control session was not initialized");
  const backups = await control.query<{
    catalog_lease_owner: string | null;
    catalog_state: string;
    operation_id: string;
  }>(
    `SELECT backup_operation_id::text AS operation_id, catalog_state,
       catalog_lease_owner
     FROM agent_sandbox_backups
     ORDER BY backup_operation_id`,
  );
  expect(backups.rows).toEqual([
    {
      catalog_lease_owner: null,
      catalog_state: "scheduled",
      operation_id: legacyOperationId,
    },
  ]);
  const work = await control.query<{
    lease_owner: string | null;
    settled_reason: string | null;
    state: string;
  }>(
    `SELECT state, lease_owner, settled_reason
     FROM agent_backup_admission_work
     WHERE id = $1::uuid`,
    [WORK_ID],
  );
  expect(work.rows).toEqual([{ lease_owner: OWNER, settled_reason: null, state: "leased" }]);
  const authority = await control.query<{ catalog_revision: string }>(
    `SELECT catalog_revision::text
     FROM agent_backup_catalog_authorities
     WHERE organization_id = $1::uuid AND agent_id = $2::uuid`,
    [ORGANIZATION_ID, SANDBOX_ID],
  );
  expect(authority.rows).toEqual([{ catalog_revision: "1" }]);
}

async function expectOnlyAdmissionReservation(): Promise<void> {
  if (!control) throw new Error("real PostgreSQL control session was not initialized");
  const backups = await control.query<{
    catalog_lease_owner: string | null;
    catalog_state: string;
    operation_id: string;
  }>(
    `SELECT backup_operation_id::text AS operation_id, catalog_state,
       catalog_lease_owner
     FROM agent_sandbox_backups
     ORDER BY backup_operation_id`,
  );
  expect(backups.rows).toEqual([
    { catalog_lease_owner: null, catalog_state: "scheduled", operation_id: WORK_ID },
  ]);
  const work = await control.query<{
    catalog_revision: string;
    lease_owner: string | null;
    settled_reason: string | null;
    state: string;
  }>(
    `SELECT work.state, work.lease_owner, work.settled_reason,
       authority.catalog_revision::text
     FROM agent_backup_admission_work AS work
     JOIN agent_backup_catalog_authorities AS authority
       ON authority.organization_id = work.organization_id
      AND authority.agent_id = work.sandbox_id
     WHERE work.id = $1::uuid`,
    [WORK_ID],
  );
  expect(work.rows).toEqual([
    {
      catalog_revision: "1",
      lease_owner: null,
      settled_reason: "CAPTURE_RESERVED",
      state: "settled",
    },
  ]);
}

async function withLockedRow<T>(params: {
  selectSql: string;
  selectValues: unknown[];
  run: () => Promise<T>;
  beforeRelease?: (locker: Client) => Promise<void>;
}): Promise<T> {
  if (!isolatedDsn || !control) throw new Error("real PostgreSQL harness was not initialized");
  const locker = new Client({
    connectionString: isolatedDsn,
    application_name: `${APPLICATION_NAME}-blocker`,
  });
  await locker.connect();
  let operation: Promise<T> | undefined;
  let primaryFailure: unknown;
  let result: T | undefined;
  let completed = false;
  try {
    await locker.query("BEGIN");
    await locker.query(params.selectSql, params.selectValues);
    const blockerPid = await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const pid = blockerPid.rows[0]?.pid;
    if (!pid) throw new Error("PostgreSQL blocker PID is unavailable");
    operation = params.run();
    await waitForRepositoryLockWaiters(control, pid, 1);
    await params.beforeRelease?.(locker);
    await locker.query("COMMIT");
    result = await operation;
    completed = true;
  } catch (cause) {
    primaryFailure = cause;
  }
  const failures: unknown[] = [];
  for (const action of [() => locker.query("ROLLBACK").then(() => undefined), () => locker.end()]) {
    try {
      await action();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (operation && primaryFailure !== undefined) await operation.catch(() => undefined);
  if (primaryFailure !== undefined && failures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...failures],
      "backup admission lock proof and teardown both failed",
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "backup admission lock test teardown failed");
  }
  if (!completed) throw new Error("Backup admission lock proof returned no result");
  return result as T;
}

try {
  await initializeHarness();
} catch (cause) {
  let cleanupFailure: unknown;
  try {
    await cleanupHarness();
  } catch (cleanupCause) {
    cleanupFailure = cleanupCause;
  }
  if (cleanupFailure !== undefined) {
    throw new AggregateError(
      [cause, cleanupFailure],
      "backup reservation PostgreSQL initialization and cleanup failed",
    );
  }
  throw cause;
}

const realPostgresTest = postgres ? test : test.skip;

beforeAll(async () => {
  if (!dbWrite || !control) return;
  const { apply } = await pushSchema(
    {
      organizations,
      users,
      userCharacters,
      agentNodeIncarnationHistories,
      dockerNodes,
      agentSandboxes,
      agentSandboxBackups,
      agentBackupCatalogAuthorities,
      agentBackupObjects,
      agentBackupGcOutbox,
      agentBackupRestoreLeases,
      agentBackupOrganizationAdmissionCursors,
      agentBackupNodeAdmissionCursors,
    } as never,
    dbWrite as never,
  );
  await apply();
  await applyAdmissionMigrations(control);
  await control.query(`
    CREATE TABLE jobs (
      id uuid PRIMARY KEY,
      type text NOT NULL,
      status text NOT NULL
    );

    CREATE FUNCTION backup_reservation_test_uuid(scope integer, ordinal bigint, shard integer)
    RETURNS uuid LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $uuid$
      SELECT (
        lpad(to_hex(shard), 2, '0') || lpad(to_hex(scope), 6, '0') ||
        '-0000-4000-8000-' || lpad(to_hex(ordinal), 12, '0')
      )::uuid
    $uuid$;
  `);
}, TEST_TIMEOUT);

beforeEach(resetFixture);
afterAll(cleanupHarness, TEST_TIMEOUT);

describe("backup admission reservation on real PostgreSQL", () => {
  for (const operation of ["heartbeat", "defer", "settle"] as const) {
    realPostgresTest(
      `${operation} rechecks DB time only after the exact work-row lock`,
      async () => {
        if (!claimRepository)
          throw new Error("real PostgreSQL claim repository was not initialized");
        const claim = await claimOne(claimRepository.MIN_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS);
        const result = await withLockedRow<Date | "deferred" | "retry_exhausted" | boolean | null>({
          selectSql: "SELECT id FROM agent_backup_admission_work WHERE id = $1::uuid FOR UPDATE",
          selectValues: [WORK_ID],
          run: () => {
            if (operation === "heartbeat") {
              return claimRepository?.heartbeatAgentBackupAdmissionClaim({
                fence: fence(claim),
                leaseMs: 60_000,
              }) as Promise<Date | null>;
            }
            if (operation === "defer") {
              return claimRepository?.deferAgentBackupAdmissionClaim({
                fence: fence(claim),
                retryDelayMs: 60_000,
                reason: "TEST_BACKPRESSURE",
              }) as Promise<"deferred" | "retry_exhausted" | null>;
            }
            return claimRepository?.settleAgentBackupAdmissionClaim({
              fence: fence(claim),
              reason: "TEST_DONE",
            }) as Promise<boolean>;
          },
          beforeRelease: () => waitForDatabaseTimeAfter(claim.expiresAt),
        });
        expect(result).toBe(operation === "settle" ? false : null);
        await expectNoPartialReservation();
      },
      TEST_TIMEOUT,
    );
  }

  realPostgresTest(
    "rolls back catalogue state if the lease expires while reservation waits for the node lock",
    async () => {
      if (!claimRepository || !reservationRepository) {
        throw new Error("real PostgreSQL reservation repositories were not initialized");
      }
      const claim = await claimOne(claimRepository.MIN_AGENT_BACKUP_ADMISSION_CLAIM_LEASE_MS);
      await expect(
        withLockedRow({
          selectSql: "SELECT id FROM docker_nodes WHERE id = $1::uuid FOR UPDATE",
          selectValues: [NODE_RECORD_ID],
          run: () => reservationRepository!.reserveAndSettleAgentBackupAdmissionClaim({ claim }),
          beforeRelease: () => waitForDatabaseTimeAfter(claim.expiresAt),
        }),
      ).rejects.toThrow(/expired while waiting|lost its final live-fence CAS/i);
      await expectNoPartialReservation();
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "rejects an old claim when a locked node is re-armed to a new same-incarnation occurrence",
    async () => {
      if (!claimRepository || !reservationRepository || !control) {
        throw new Error("real PostgreSQL reservation repositories were not initialized");
      }
      const claim = await claimOne(60_000);
      const structuralAuthority = await control.query<{ conname: string }>(
        `SELECT conname
         FROM pg_constraint
         WHERE conrelid = 'docker_nodes'::regclass
           AND conname IN (
             'docker_nodes_current_node_history_fkey',
             'docker_nodes_node_occurrence_shape_check'
           )
         ORDER BY conname`,
      );
      expect(structuralAuthority.rows).toEqual([
        { conname: "docker_nodes_current_node_history_fkey" },
        { conname: "docker_nodes_node_occurrence_shape_check" },
      ]);

      // pushSchema supplies the live post-0300 structural authority; install
      // the exact function and trigger statements from 0301 that Drizzle
      // cannot derive, then prove its write guard before exercising rearm.
      await installAgentNodeOccurrenceTriggerForTests((statement) => control!.query(statement));
      let rearmedHistoryId: string | null = null;
      try {
        await expect(
          control.query(
            `UPDATE docker_nodes SET current_node_history_id = $2::uuid
             WHERE id = $1::uuid`,
            [NODE_RECORD_ID, DELETION_REQUEST_ID],
          ),
        ).rejects.toThrow(/current node history id is trigger-owned/i);
        await expect(
          withLockedRow({
            selectSql: "SELECT id FROM docker_nodes WHERE id = $1::uuid FOR UPDATE",
            selectValues: [NODE_RECORD_ID],
            run: () => reservationRepository!.reserveAndSettleAgentBackupAdmissionClaim({ claim }),
            beforeRelease: async (locker) => {
              const disarmed = await locker.query<{
                current_node_history_id: string | null;
                node_incarnation: string | null;
              }>(
                `UPDATE docker_nodes
                 SET node_incarnation = NULL, updated_at = clock_timestamp()
                 WHERE id = $1::uuid
                 RETURNING current_node_history_id::text, node_incarnation::text`,
                [NODE_RECORD_ID],
              );
              expect(disarmed.rows).toEqual([
                { current_node_history_id: null, node_incarnation: null },
              ]);

              const rearmed = await locker.query<{
                current_node_history_id: string;
                node_incarnation: string;
              }>(
                `UPDATE docker_nodes
                 SET node_incarnation = $2::uuid, updated_at = clock_timestamp()
                 WHERE id = $1::uuid
                 RETURNING current_node_history_id::text, node_incarnation::text`,
                [NODE_RECORD_ID, NODE_INCARNATION],
              );
              rearmedHistoryId = rearmed.rows[0]?.current_node_history_id ?? null;
              expect(rearmed.rows).toEqual([
                {
                  current_node_history_id: expect.any(String),
                  node_incarnation: NODE_INCARNATION,
                },
              ]);
            },
          }),
        ).rejects.toThrow(/already reserved with a different payload/i);
      } finally {
        await control.query(`
          DROP TRIGGER IF EXISTS docker_nodes_incarnation_history ON docker_nodes;
          DROP FUNCTION IF EXISTS journal_agent_node_incarnation();
        `);
      }
      await expectNoPartialReservation();
      if (!rearmedHistoryId) {
        throw new Error("Production occurrence trigger did not mint a rearm history id");
      }
      expect(rearmedHistoryId).not.toBe(NODE_HISTORY_ID);
      const occurrence = await control.query<{
        current_node_history_id: string;
        history_count: number;
        node_incarnation: string;
      }>(
        `SELECT node.current_node_history_id::text, node.node_incarnation::text,
           count(history.id)::integer AS history_count
         FROM docker_nodes AS node
         JOIN agent_node_incarnation_histories AS history
           ON history.docker_node_record_id = node.id
          AND history.node_incarnation = node.node_incarnation
         WHERE node.id = $1::uuid
         GROUP BY node.current_node_history_id, node.node_incarnation`,
        [NODE_RECORD_ID],
      );
      expect(occurrence.rows).toEqual([
        {
          current_node_history_id: rearmedHistoryId,
          history_count: 2,
          node_incarnation: NODE_INCARNATION,
        },
      ]);
      const productionTrigger = await control.query<{ installed: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_trigger
           WHERE tgrelid = 'docker_nodes'::regclass
             AND tgname = 'docker_nodes_incarnation_history'
             AND NOT tgisinternal
         ) AS installed`,
      );
      expect(productionTrigger.rows).toEqual([{ installed: false }]);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "cannot cross a concurrent account-deletion paid-work fence",
    async () => {
      if (!reservationRepository || !isolatedDsn || !control) {
        throw new Error("real PostgreSQL reservation harness was not initialized");
      }
      const claim = await claimOne(60_000);
      const locker = new Client({
        connectionString: isolatedDsn,
        application_name: `${APPLICATION_NAME}-account-deletion`,
      });
      await locker.connect();
      let reservation: Promise<unknown> | undefined;
      try {
        await locker.query("BEGIN");
        await locker.query("SELECT id FROM organizations WHERE id = $1::uuid FOR UPDATE", [
          ORGANIZATION_ID,
        ]);
        const blockerPid = await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = blockerPid.rows[0]?.pid;
        if (!pid) throw new Error("PostgreSQL blocker PID is unavailable");
        reservation = reservationRepository.reserveAndSettleAgentBackupAdmissionClaim({ claim });
        await waitForRepositoryLockWaiters(control, pid, 1);
        await locker.query(
          `UPDATE organizations SET
             account_lifecycle_state = 'deletion_recovery',
             account_deletion_request_id = $2::uuid,
             paid_work_fenced_at = clock_timestamp(),
             is_active = FALSE
           WHERE id = $1::uuid`,
          [ORGANIZATION_ID, DELETION_REQUEST_ID],
        );
        await locker.query("COMMIT");
        await expect(reservation).rejects.toThrow(/organization no longer permits paid work/i);
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        await locker.end();
        await reservation?.catch(() => undefined);
      }
      await expectNoPartialReservation();
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "rolls back a claimed admission when a legacy reservation wins the same fair lane",
    async () => {
      const reservation = reservationRepository;
      const scheduler = schedulerRepository;
      if (!reservation || !scheduler) {
        throw new Error("real PostgreSQL reservation repositories were not initialized");
      }
      const admissionClaim = await claimOne(60_000);
      const legacyClaim = await claimLegacySchedule(60_000);
      const legacyReservation = await scheduler.reserveClaimedAgentBackupSchedule({
        claim: legacyClaim,
      });
      expect(legacyReservation).toMatchObject({
        organizationId: ORGANIZATION_ID,
        agentId: SANDBOX_ID,
        operationId: legacyClaim.operationId,
      });

      await expect(
        reservation.reserveAndSettleAgentBackupAdmissionClaim({ claim: admissionClaim }),
      ).rejects.toThrow(/fair-lane authority was superseded before settlement/i);
      await expectOnlyLegacyReservation(legacyClaim.operationId);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "crosses new and legacy reservation attempts without a PostgreSQL deadlock",
    async () => {
      const reservation = reservationRepository;
      const scheduler = schedulerRepository;
      if (!reservation || !scheduler || !isolatedDsn || !control) {
        throw new Error("real PostgreSQL reservation harness was not initialized");
      }
      const admissionClaim = await claimOne(60_000);
      const legacyClaim = await claimLegacySchedule(60_000);
      const locker = new Client({
        connectionString: isolatedDsn,
        application_name: `${APPLICATION_NAME}-crossing-blocker`,
      });
      const attempts: Promise<unknown>[] = [];
      let outcomesPromise: Promise<PromiseSettledResult<unknown>[]> | undefined;
      let outcomes: PromiseSettledResult<unknown>[] | undefined;
      await locker.connect();
      try {
        await locker.query("BEGIN");
        await locker.query(
          "SELECT id FROM agent_backup_admission_work WHERE id = $1::uuid FOR UPDATE",
          [WORK_ID],
        );
        const blocker = await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const blockerPid = blocker.rows[0]?.pid;
        if (!blockerPid) throw new Error("PostgreSQL crossing blocker PID is unavailable");

        attempts.push(
          reservation.reserveAndSettleAgentBackupAdmissionClaim({ claim: admissionClaim }),
        );
        const admissionPid = await waitForRepositoryBlockedPid(control, blockerPid);
        attempts.push(scheduler.reserveClaimedAgentBackupSchedule({ claim: legacyClaim }));
        outcomesPromise = Promise.allSettled(attempts);
        const legacyPid = await waitForRepositoryBlockedPid(control, admissionPid);
        expect(legacyPid).not.toBe(admissionPid);
        await locker.query("COMMIT");
        outcomes = await outcomesPromise;
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        await locker.end();
        if (!outcomesPromise && attempts.length > 0) {
          outcomesPromise = Promise.allSettled(attempts);
        }
        await outcomesPromise;
      }

      if (!outcomes) throw new Error("Concurrent reservation attempts returned no outcomes");
      expect(outcomes.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
      const postgresCodes = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [findPostgresErrorCode(outcome.reason)] : [],
      );
      expect(postgresCodes).not.toContain("40P01");
      const legacyOutcome = outcomes[1];
      if (legacyOutcome?.status !== "rejected") {
        throw new Error("The admission reservation did not win the synchronized lock crossing");
      }
      expect(String(legacyOutcome.reason)).toMatch(/fair-lane authority was superseded/i);
      await expectOnlyAdmissionReservation();
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "returns an exact committed replay after the account-deletion paid-work fence",
    async () => {
      if (!reservationRepository || !control) {
        throw new Error("real PostgreSQL reservation harness was not initialized");
      }
      const claim = await claimOne(60_000);
      const first = await reservationRepository.reserveAndSettleAgentBackupAdmissionClaim({
        claim,
      });
      await control.query(
        `UPDATE organizations SET
           account_lifecycle_state = 'deletion_recovery',
           account_deletion_request_id = $2::uuid,
           paid_work_fenced_at = clock_timestamp(),
           is_active = FALSE
         WHERE id = $1::uuid`,
        [ORGANIZATION_ID, DELETION_REQUEST_ID],
      );

      const replay = await reservationRepository.reserveAndSettleAgentBackupAdmissionClaim({
        claim,
      });
      expect(replay).toEqual({ ...first, replayed: true });
      const durable = await control.query<{
        backups: number;
        authorities: number;
        state: string;
        settled_reason: string;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM agent_sandbox_backups) AS backups,
           (SELECT count(*)::integer FROM agent_backup_catalog_authorities) AS authorities,
           work.state, work.settled_reason
         FROM agent_backup_admission_work AS work
         WHERE work.id = $1::uuid`,
        [WORK_ID],
      );
      expect(durable.rows).toEqual([
        { backups: 1, authorities: 1, state: "settled", settled_reason: "CAPTURE_RESERVED" },
      ]);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "fails closed when settled replay catalogue version, digest, or retention is altered",
    async () => {
      if (!reservationRepository || !control) {
        throw new Error("real PostgreSQL reservation harness was not initialized");
      }
      const claim = await claimOne(60_000);
      const first = await reservationRepository.reserveAndSettleAgentBackupAdmissionClaim({
        claim,
      });
      const original = await control.query<{
        catalog_payload_digest: string;
        retention_until: Date;
      }>(
        `SELECT catalog_payload_digest, retention_until
         FROM agent_sandbox_backups WHERE id = $1::uuid`,
        [first.backupId],
      );
      const authority = original.rows[0];
      if (!authority?.catalog_payload_digest || !(authority.retention_until instanceof Date)) {
        throw new Error("Seeded reservation is missing its canonical payload authority");
      }

      await control.query(
        `UPDATE agent_sandbox_backups SET catalog_payload_digest = $2 WHERE id = $1::uuid`,
        [first.backupId, "f".repeat(64)],
      );
      await expect(
        reservationRepository.reserveAndSettleAgentBackupAdmissionClaim({ claim }),
      ).rejects.toThrow(/already reserved with a different payload/i);

      await control.query(
        `UPDATE agent_sandbox_backups
         SET catalog_payload_digest = $2, retention_until = $3::timestamptz
         WHERE id = $1::uuid`,
        [
          first.backupId,
          authority.catalog_payload_digest,
          new Date(authority.retention_until.getTime() + 1_000),
        ],
      );
      await expect(
        reservationRepository.reserveAndSettleAgentBackupAdmissionClaim({ claim }),
      ).rejects.toThrow(/already reserved with a different payload/i);

      await control.query(
        `UPDATE agent_sandbox_backups
         SET catalog_version = 1, catalog_state = 'legacy_unmigrated',
             retention_until = $2::timestamptz
         WHERE id = $1::uuid`,
        [first.backupId, authority.retention_until],
      );
      await expect(
        reservationRepository.reserveAndSettleAgentBackupAdmissionClaim({ claim }),
      ).rejects.toThrow(/already reserved with a different payload/i);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "serializes two callers without deadlock and commits one reservation",
    async () => {
      if (!reservationRepository || !control || !isolatedDsn) {
        throw new Error("real PostgreSQL reservation harness was not initialized");
      }
      const claim = await claimOne(60_000);
      const locker = new Client({
        connectionString: isolatedDsn,
        application_name: `${APPLICATION_NAME}-two-callers`,
      });
      await locker.connect();
      let calls:
        | Promise<
            Awaited<
              ReturnType<ReservationRepository["reserveAndSettleAgentBackupAdmissionClaim"]>
            >[]
          >
        | undefined;
      try {
        await locker.query("BEGIN");
        await locker.query("SELECT id FROM organizations WHERE id = $1::uuid FOR UPDATE", [
          ORGANIZATION_ID,
        ]);
        const blockerPid = await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = blockerPid.rows[0]?.pid;
        if (!pid) throw new Error("PostgreSQL blocker PID is unavailable");
        calls = Promise.all([
          reservationRepository.reserveAndSettleAgentBackupAdmissionClaim({ claim }),
          reservationRepository.reserveAndSettleAgentBackupAdmissionClaim({ claim }),
        ]);
        await waitForRepositoryLockWaiters(control, pid, 2);
        await locker.query("COMMIT");
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        await locker.end();
      }
      if (!calls) throw new Error("Concurrent backup admission calls were not started");
      const results = await calls;
      expect(new Set(results.map(({ backupId }) => backupId)).size).toBe(1);
      expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
      const state = await control.query<{
        backups: number;
        authorities: number;
        revision: string;
        state: string;
        settled_reason: string;
      }>(
        `
        SELECT
          (SELECT count(*)::integer FROM agent_sandbox_backups) AS backups,
          (SELECT count(*)::integer FROM agent_backup_catalog_authorities) AS authorities,
          authority.catalog_revision::text AS revision,
          work.state,
          work.settled_reason
        FROM agent_backup_admission_work AS work
        JOIN agent_backup_catalog_authorities AS authority
          ON authority.organization_id = work.organization_id
         AND authority.agent_id = work.sandbox_id
        WHERE work.id = $1::uuid
      `,
        [WORK_ID],
      );
      expect(state.rows).toEqual([
        {
          backups: 1,
          authorities: 1,
          revision: "1",
          state: "settled",
          settled_reason: "CAPTURE_RESERVED",
        },
      ]);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "round-trips the trigger-owned 0364 xid8 proof through atomic settlement",
    async () => {
      if (!reservationRepository || !control) {
        throw new Error("real PostgreSQL reservation harness was not initialized");
      }
      const claim = await claimOne(60_000);
      const proofBefore = await control.query<{
        claim_proof_xid: string;
        proof_type: string;
        trigger_exists: boolean;
      }>(
        `
        SELECT work.claim_proof_xid::text,
          pg_typeof(work.claim_proof_xid)::text AS proof_type,
          EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgrelid = 'agent_backup_admission_work'::regclass
              AND tgname = 'agent_backup_admission_work_20_state_guard'
              AND NOT tgisinternal
          ) AS trigger_exists
        FROM agent_backup_admission_work AS work
        WHERE work.id = $1::uuid
      `,
        [WORK_ID],
      );
      expect(proofBefore.rows).toEqual([
        { claim_proof_xid: claim.claimProofXid, proof_type: "xid8", trigger_exists: true },
      ]);

      await reservationRepository.reserveAndSettleAgentBackupAdmissionClaim({ claim });
      const proofAfter = await control.query<{ claim_proof_xid: string; attempts: number }>(
        `SELECT claim_proof_xid::text, attempts
         FROM agent_backup_admission_work WHERE id = $1::uuid`,
        [WORK_ID],
      );
      expect(proofAfter.rows).toEqual([{ claim_proof_xid: claim.claimProofXid, attempts: 1 }]);
    },
    TEST_TIMEOUT,
  );

  realPostgresTest(
    "claims and atomically reserves 10,000 mixed-priority rows plus arrivals without starvation",
    async () => {
      if (!claimRepository || !reservationRepository || !control) {
        throw new Error("real PostgreSQL reservation repositories were not initialized");
      }
      const startedAt = Date.now();
      const deadline = startedAt + TEN_THOUSAND_TIMEOUT - 10_000;
      const dueAt = new Date(startedAt - 60_000);

      await closeDatabaseConnectionsForTests?.();
      process.env.LOCAL_PG_POOL_MAX = "1";

      await seedScaleSources({
        start: SCALE_SOURCE_START,
        count: SCALE_TOTAL_COUNT,
        dueAt,
      });
      for (const seed of [
        {
          start: SCALE_SOURCE_START,
          count: 2_500,
          priorityClass: "lifecycle_safety",
          basePriority: 0,
          dueAt,
        },
        {
          start: SCALE_SOURCE_START + 2_500,
          count: 2_500,
          priorityClass: "active_rpo",
          basePriority: 1,
          dueAt,
        },
        {
          start: SCALE_SOURCE_START + 5_000,
          count: 2_500,
          priorityClass: "drain_recovery",
          basePriority: 2,
          dueAt,
        },
        {
          start: SCALE_SOURCE_START + 7_500,
          count: 2_500,
          priorityClass: "periodic_capture",
          basePriority: 3,
          dueAt,
        },
      ] satisfies ScaleWorkSeed[]) {
        await seedScaleWork(seed);
      }
      await control.query(
        `INSERT INTO jobs (id, type, status)
         VALUES ('ff000001-0000-4000-8000-000000000001'::uuid, 'sentinel', 'pending')`,
      );

      const sourceCardinality = await control.query<{
        organizations: number;
        users: number;
        sandboxes: number;
        nodeRecords: number;
        nodeHistories: number;
        queued: number;
        attemptZero: number;
        activeCycles: number;
      }>(`
        SELECT
          (SELECT count(*)::integer FROM organizations) AS organizations,
          (SELECT count(*)::integer FROM users) AS users,
          (SELECT count(*)::integer FROM agent_sandboxes) AS sandboxes,
          (SELECT count(*)::integer FROM docker_nodes) AS "nodeRecords",
          (SELECT count(*)::integer FROM agent_node_incarnation_histories) AS "nodeHistories",
          (SELECT count(*) FILTER (WHERE state = 'queued')::integer
            FROM agent_backup_admission_work) AS queued,
          (SELECT count(*) FILTER (WHERE attempts = 0)::integer
            FROM agent_backup_admission_work) AS "attemptZero",
          (SELECT count(*) FILTER (WHERE cycle_observed_at IS NOT NULL)::integer
            FROM agent_backup_admission_claim_shards
            WHERE work_kind = 'schedule_capture') AS "activeCycles"
      `);
      expect(sourceCardinality.rows).toEqual([
        {
          organizations: SCALE_TOTAL_COUNT,
          users: SCALE_TOTAL_COUNT,
          sandboxes: SCALE_TOTAL_COUNT,
          nodeRecords: SCALE_TOTAL_COUNT,
          nodeHistories: SCALE_TOTAL_COUNT,
          queued: SCALE_INITIAL_COUNT,
          attemptZero: SCALE_INITIAL_COUNT,
          activeCycles: 0,
        },
      ]);
      const sentinel = await readCapacityAndJobsSnapshot();
      expect(sentinel).toEqual({
        jobs: 1,
        jobFingerprint: "ff000001-0000-4000-8000-000000000001:sentinel:pending",
        nodes: SCALE_TOTAL_COUNT,
        capacityTotal: SCALE_TOTAL_COUNT * 8,
        capacityMin: 8,
        capacityMax: 8,
        allocated: SCALE_TOTAL_COUNT * 2,
        changedNodes: 0,
        autoscaledNodes: 0,
      });

      const claimedWorkIds = new Set<string>();
      const reservedWorkIds = new Set<string>();
      const backupIds = new Set<string>();
      const duplicateClaims: string[] = [];
      const duplicateReservations: string[] = [];
      const malformedReservations: string[] = [];
      const reserveWithBoundedPressure = createAsyncGate(1);
      let roundsUsed = 0;
      let claimCalls = 0;
      let arrivalsInserted = false;
      let completed = false;

      for (let round = 0; round < 256; round += 1) {
        if (Date.now() >= deadline) {
          throw new Error(`10,640-row reservation proof exceeded its bounded 600s deadline`);
        }
        const workers = await Promise.all(
          Array.from({ length: 8 }, async (_, worker) => {
            let claims: AdmissionClaim[] = [];
            for (
              let progressTurn = 0;
              progressTurn < 16 && claims.length === 0;
              progressTurn += 1
            ) {
              claimCalls += 1;
              claims = await claimRepository!.claimAgentBackupAdmissionWork({
                ownerId: `schedule-reservation-10k-worker-${worker}`,
                limit: 25,
                leaseMs: 5 * 60_000,
              });
            }
            const reservations = [];
            for (const claim of claims) {
              reservations.push(
                await reserveWithBoundedPressure(() =>
                  reservationRepository!.reserveAndSettleAgentBackupAdmissionClaim({ claim }),
                ),
              );
            }
            return { claims, reservations };
          }),
        );
        roundsUsed = round + 1;
        for (const { claims, reservations } of workers) {
          for (let index = 0; index < claims.length; index += 1) {
            const claim = claims[index];
            const reservation = reservations[index];
            if (!claim || !reservation) {
              malformedReservations.push(`missing-result-${round}-${index}`);
              continue;
            }
            if (claimedWorkIds.has(claim.workId)) duplicateClaims.push(claim.workId);
            claimedWorkIds.add(claim.workId);
            if (reservedWorkIds.has(reservation.workId)) {
              duplicateReservations.push(reservation.workId);
            }
            reservedWorkIds.add(reservation.workId);
            if (backupIds.has(reservation.backupId)) {
              duplicateReservations.push(reservation.backupId);
            }
            backupIds.add(reservation.backupId);
            if (
              reservation.workId !== claim.workId ||
              reservation.operationId !== claim.workId ||
              reservation.replayed
            ) {
              malformedReservations.push(claim.workId);
            }
          }
        }

        if (round === 0) {
          await seedScaleWork({
            start: SCALE_SOURCE_START + SCALE_INITIAL_COUNT,
            count: SCALE_ARRIVAL_COUNT,
            priorityClass: "lifecycle_safety",
            basePriority: 0,
            dueAt,
          });
          arrivalsInserted = true;
          expect(await readCapacityAndJobsSnapshot()).toEqual(sentinel);
        }

        const remaining = await control.query<{ unsettled: number }>(`
          SELECT count(*) FILTER (WHERE state <> 'settled')::integer AS unsettled
          FROM agent_backup_admission_work
        `);
        if (remaining.rows[0]?.unsettled === 0) {
          completed = true;
          break;
        }
        await closeDatabaseConnectionsForTests?.();
      }

      expect(arrivalsInserted).toBe(true);
      expect(completed).toBe(true);
      expect(roundsUsed).toBeLessThanOrEqual(256);
      expect(duplicateClaims).toEqual([]);
      expect(duplicateReservations).toEqual([]);
      expect(malformedReservations).toEqual([]);
      expect(claimedWorkIds.size).toBe(SCALE_TOTAL_COUNT);
      expect(reservedWorkIds.size).toBe(SCALE_TOTAL_COUNT);
      expect(backupIds.size).toBe(SCALE_TOTAL_COUNT);

      const handoffs = await control.query<{
        totalWork: number;
        exactSettled: number;
        firstAttempts: number;
        backups: number;
        scheduledBackups: number;
        authorities: number;
        revisionOneAuthorities: number;
        exactHandoffs: number;
        immutableVectorMismatches: number;
        missingHandoffs: number;
        orphanHandoffs: number;
        duplicateOperations: number;
        brokenAuthorityHandoffs: number;
      }>(`
        WITH immutable_handoffs AS (
          SELECT work.id
          FROM agent_backup_admission_work AS work
          JOIN agent_node_incarnation_histories AS history
            ON history.id = work.node_history_id
          JOIN docker_nodes AS node
            ON node.id = history.docker_node_record_id
           AND node.node_id = history.node_id
           AND node.node_incarnation = history.node_incarnation
           AND node.current_node_history_id = history.id
           AND node.fleet_kind = history.fleet_kind
           AND node.infrastructure_provider = history.infrastructure_provider
           AND node.provider_server_id IS NOT DISTINCT FROM history.provider_server_id
           AND node.host_key_fingerprint = history.host_key_fingerprint
          JOIN agent_sandbox_backups AS backup
            ON backup.backup_operation_id = work.id
           AND backup.catalog_organization_id = work.organization_id
           AND backup.catalog_agent_id = work.sandbox_id
           AND backup.sandbox_record_id = work.sandbox_id
           AND backup.lifecycle_generation = work.source_activation_generation
           AND backup.lifecycle_revision = work.source_lifecycle_revision
           AND backup.source_node_history_id = work.node_history_id
           AND backup.source_node_record_id = history.docker_node_record_id
           AND backup.source_node_id = history.node_id
           AND backup.source_node_incarnation = history.node_incarnation
           AND backup.source_provider_server_id IS NOT DISTINCT FROM history.provider_server_id
           AND backup.source_provider = CASE history.fleet_kind
             WHEN 'robot' THEN 'operator-onboarded'
             WHEN 'cloud' THEN 'hetzner-cloud'
             ELSE NULL
           END
           AND backup.source_provider_handle = work.source_provider_handle
           AND backup.source_container_id = work.source_container_id
          JOIN agent_backup_catalog_authorities AS authority
            ON authority.organization_id = backup.catalog_organization_id
           AND authority.agent_id = backup.catalog_agent_id
           AND authority.catalog_revision = backup.catalog_revision
          WHERE work.state = 'settled'
            AND work.settled_reason = 'CAPTURE_RESERVED'
            AND backup.catalog_version = 2
            AND backup.catalog_state = 'scheduled'
            AND backup.snapshot_type = 'auto'
            AND backup.backup_kind = 'full'
            AND backup.parent_backup_id IS NULL
            AND backup.base_backup_id IS NULL
            AND backup.retention_reason = 'schedule'
            AND backup.retention_until IS NOT NULL
            AND backup.catalog_payload_digest ~ '^[0-9a-f]{64}$'
            AND backup.catalog_revision = 1
            AND authority.restore_generation = 0
        )
        SELECT
          (SELECT count(*)::integer FROM agent_backup_admission_work) AS "totalWork",
          (SELECT count(*)::integer FROM agent_backup_admission_work
            WHERE state = 'settled' AND settled_reason = 'CAPTURE_RESERVED'
              AND settled_at IS NOT NULL AND lease_owner IS NULL
              AND lease_generation IS NULL AND lease_expires_at IS NULL) AS "exactSettled",
          (SELECT count(*)::integer FROM agent_backup_admission_work
            WHERE attempts = 1) AS "firstAttempts",
          (SELECT count(*)::integer FROM agent_sandbox_backups) AS backups,
          (SELECT count(*)::integer FROM agent_sandbox_backups
            WHERE catalog_state = 'scheduled' AND snapshot_type = 'auto'
              AND backup_kind = 'full' AND retention_reason = 'schedule'
              AND catalog_payload_digest IS NOT NULL AND catalog_revision = 1) AS "scheduledBackups",
          (SELECT count(*)::integer FROM agent_backup_catalog_authorities) AS authorities,
          (SELECT count(*)::integer FROM agent_backup_catalog_authorities
            WHERE catalog_revision = 1 AND restore_generation = 0) AS "revisionOneAuthorities",
          (SELECT count(*)::integer FROM immutable_handoffs) AS "exactHandoffs",
          ((SELECT count(*) FROM agent_backup_admission_work)
            - (SELECT count(*) FROM immutable_handoffs))::integer AS "immutableVectorMismatches",
          (SELECT count(*)::integer
            FROM agent_backup_admission_work AS work
            LEFT JOIN agent_sandbox_backups AS backup
              ON backup.backup_operation_id = work.id
             AND backup.catalog_organization_id = work.organization_id
             AND backup.catalog_agent_id = work.sandbox_id
            WHERE backup.id IS NULL) AS "missingHandoffs",
          (SELECT count(*)::integer
            FROM agent_sandbox_backups AS backup
            LEFT JOIN agent_backup_admission_work AS work
              ON work.id = backup.backup_operation_id
             AND work.organization_id = backup.catalog_organization_id
             AND work.sandbox_id = backup.catalog_agent_id
            WHERE work.id IS NULL) AS "orphanHandoffs",
          (SELECT count(*)::integer FROM (
            SELECT backup_operation_id
            FROM agent_sandbox_backups
            GROUP BY backup_operation_id
            HAVING count(*) <> 1
          ) AS duplicate_operation) AS "duplicateOperations",
          (SELECT count(*)::integer
            FROM agent_sandbox_backups AS backup
            LEFT JOIN agent_backup_catalog_authorities AS authority
              ON authority.organization_id = backup.catalog_organization_id
             AND authority.agent_id = backup.catalog_agent_id
            WHERE authority.organization_id IS NULL
               OR authority.catalog_revision <> backup.catalog_revision) AS "brokenAuthorityHandoffs"
      `);
      expect(handoffs.rows).toEqual([
        {
          totalWork: SCALE_TOTAL_COUNT,
          exactSettled: SCALE_TOTAL_COUNT,
          firstAttempts: SCALE_TOTAL_COUNT,
          backups: SCALE_TOTAL_COUNT,
          scheduledBackups: SCALE_TOTAL_COUNT,
          authorities: SCALE_TOTAL_COUNT,
          revisionOneAuthorities: SCALE_TOTAL_COUNT,
          exactHandoffs: SCALE_TOTAL_COUNT,
          immutableVectorMismatches: 0,
          missingHandoffs: 0,
          orphanHandoffs: 0,
          duplicateOperations: 0,
          brokenAuthorityHandoffs: 0,
        },
      ]);

      const payloadProof = await control.query<ScaleReservationPayloadProof>(`
        SELECT
          work.id::text AS "operationId",
          work.organization_id::text AS "organizationId",
          work.sandbox_id::text AS "sandboxId",
          work.source_activation_generation::text AS "activationGeneration",
          work.source_lifecycle_revision::text AS "lifecycleRevision",
          work.node_history_id::text AS "nodeHistoryId",
          history.docker_node_record_id::text AS "nodeRecordId",
          history.node_id AS "nodeId",
          history.node_incarnation::text AS "nodeIncarnation",
          CASE history.fleet_kind
            WHEN 'robot' THEN 'operator-onboarded'
            WHEN 'cloud' THEN 'hetzner-cloud'
          END AS "sourceProvider",
          history.provider_server_id AS "providerServerId",
          work.source_provider_handle AS "providerHandle",
          work.source_container_id AS "containerId",
          backup.retention_until AS "retentionUntil",
          backup.catalog_payload_digest AS "catalogPayloadDigest"
        FROM agent_backup_admission_work AS work
        JOIN agent_node_incarnation_histories AS history
          ON history.id = work.node_history_id
        JOIN agent_sandbox_backups AS backup
          ON backup.backup_operation_id = work.id
         AND backup.catalog_organization_id = work.organization_id
         AND backup.catalog_agent_id = work.sandbox_id
        ORDER BY work.id
      `);
      const payloadDigestMismatches = payloadProof.rows.filter(
        (row) =>
          !(row.retentionUntil instanceof Date) ||
          expectedScaleReservationPayloadDigest(row) !== row.catalogPayloadDigest,
      );
      expect({
        payloadDigestsVerified: payloadProof.rowCount,
        payloadDigestMismatches: payloadDigestMismatches.length,
      }).toEqual({
        payloadDigestsVerified: SCALE_TOTAL_COUNT,
        payloadDigestMismatches: 0,
      });

      const shardProof = await control.query<{
        settledShards: number;
        progressedShards: number;
      }>(`
        SELECT
          (SELECT count(DISTINCT shard_id)::integer
            FROM agent_backup_admission_work
            WHERE state = 'settled') AS "settledShards",
          (SELECT count(*) FILTER (WHERE last_turn > 0)::integer
            FROM agent_backup_admission_claim_shards
            WHERE work_kind = 'schedule_capture') AS "progressedShards"
      `);
      expect(shardProof.rows).toEqual([{ settledShards: 64, progressedShards: 64 }]);

      const priorities = await control.query<{ priorityClass: string; count: number }>(`
        SELECT priority_class AS "priorityClass", count(*)::integer AS count
        FROM agent_backup_admission_work
        WHERE state = 'settled'
        GROUP BY priority_class, base_priority
        ORDER BY base_priority
      `);
      expect(priorities.rows).toEqual([
        { priorityClass: "lifecycle_safety", count: 3_140 },
        { priorityClass: "active_rpo", count: 2_500 },
        { priorityClass: "drain_recovery", count: 2_500 },
        { priorityClass: "periodic_capture", count: 2_500 },
      ]);
      expect(await readCapacityAndJobsSnapshot()).toEqual(sentinel);

      process.stderr.write(
        `[backup admission reservation PostgreSQL] reserved ${SCALE_TOTAL_COUNT} rows in ${
          Date.now() - startedAt
        }ms across ${roundsUsed} bounded rounds and ${claimCalls} claim calls\n`,
      );
    },
    TEN_THOUSAND_TIMEOUT,
  );
});
