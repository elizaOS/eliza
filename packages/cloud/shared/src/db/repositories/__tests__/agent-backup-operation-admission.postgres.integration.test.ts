/** Real-PostgreSQL proof that backup admission serializes across pool sessions. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { pushSchema } from "drizzle-kit/api";
import { asc, eq } from "drizzle-orm";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import { installAgentNodeOccurrenceTriggerForTests } from "../../agent-node-occurrence-test-support";
import {
  agentBackupOperationLane,
  agentBackupOperationNodeWatermarks,
  agentBackupOperationTenantWatermarks,
} from "../../schemas/agent-backup-operation-lane";
import { agentActivationPublications } from "../../schemas/agent-backup-restore-history";
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
  "[backup operation admission contention] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const APPLICATION_NAME = "backup-operation-admission-postgres-test";
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

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000101";
const USER_ID = "20000000-0000-4000-8000-000000000101";
const AGENT_ID = "30000000-0000-4000-8000-000000000101";
const OPERATION_A = "40000000-0000-4000-8000-000000000101";
const OPERATION_B = "40000000-0000-4000-8000-000000000102";
const ACTIVATION_GENERATION = "50000000-0000-4000-8000-000000000101";
const NODE_RECORD_ID = "60000000-0000-4000-8000-000000000101";
const NODE_INCARNATION = "70000000-0000-4000-8000-000000000101";
const CALLER_GENERATION_A = "80000000-0000-4000-8000-000000000101";
const CALLER_GENERATION_B = "80000000-0000-4000-8000-000000000102";
const ACTIVATION_PUBLICATION_ID = "90000000-0000-4000-8000-000000000101";
const OWNER_A = "backup-admission-postgres-worker-a";
const OWNER_B = "backup-admission-postgres-worker-b";
const NODE_ID = "robot-backup-admission-postgres";
const PROVIDER_HANDLE = "backup-admission-postgres-container";
const CONTAINER_ID = "a".repeat(64);
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const RECEIPT_SHA = "c".repeat(64);
const TOKEN_SHA = "d".repeat(64);
const ACTIVATION_PUBLISHED_AT = new Date("2026-08-17T00:00:00.000Z");
const ACTIVATION_RECEIPT = Object.freeze({
  schemaVersion: 1 as const,
  generation: ACTIVATION_GENERATION,
  purpose: "provision" as const,
  agentId: AGENT_ID,
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
  receiptHash: RECEIPT_SHA,
  receiptMac: TOKEN_SHA,
  appliedAt: "2026-08-17T00:00:00.000Z",
  restored: true,
  requiresRestart: false,
});

type ClientModule = typeof import("../../client");
type AdmissionRepository = typeof import("../agent-backup-operation-admission");
type CatalogRepository = typeof import("../agent-backup-catalog");
type ClaimResult = Awaited<
  ReturnType<AdmissionRepository["claimNextAgentBackupOperationAdmission"]>
>;
type ClaimedResult = Extract<ClaimResult, { kind: "claimed" }>;

let postgres: EphemeralPostgres | null = null;
let isolatedDatabaseName: string | null = null;
let isolatedDsn: string | null = null;
let cleanupPromise: Promise<void> | null = null;
let dbWrite: ClientModule["dbWrite"] | undefined;
let closeDatabaseConnectionsForTests: ClientModule["closeDatabaseConnectionsForTests"] | undefined;
let admissionRepository: AdmissionRepository | undefined;
let catalogRepository: CatalogRepository | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function createIsolatedDatabase(baseDsn: string): Promise<{
  databaseName: string;
  dsn: string;
}> {
  const databaseName = `eliza_backup_admission_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: baseDsn });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${databaseName}`;
  return { databaseName, dsn: url.toString() };
}

async function cleanupHarnessOnce(): Promise<void> {
  const acquiredPostgres = postgres;
  const databaseName = isolatedDatabaseName;
  let firstError: unknown;
  const capture = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      firstError ??= error;
    }
  };

  await capture(async () => closeDatabaseConnectionsForTests?.());
  closeDatabaseConnectionsForTests = undefined;
  dbWrite = undefined;
  admissionRepository = undefined;
  catalogRepository = undefined;

  if (acquiredPostgres && databaseName) {
    let admin: Client | undefined;
    await capture(async () => {
      admin = new Client({ connectionString: acquiredPostgres.dsn });
      await admin.connect();
    });
    if (admin) {
      await capture(async () => {
        await admin?.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " +
            "WHERE datname = $1 AND pid <> pg_backend_pid()",
          [databaseName],
        );
      });
      await capture(async () => admin?.query(`DROP DATABASE IF EXISTS "${databaseName}"`));
      await capture(async () => admin?.end());
    }
  }
  await capture(async () => acquiredPostgres?.stop());
  postgres = null;
  isolatedDatabaseName = null;
  isolatedDsn = null;

  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  }
  if (firstError) throw firstError;
}

function cleanupHarness(): Promise<void> {
  cleanupPromise ??= cleanupHarnessOnce();
  return cleanupPromise;
}

async function initializeHarness(): Promise<void> {
  postgres = await acquireEphemeralPostgres();
  if (!postgres) {
    console.warn(SKIP_REASON);
    return;
  }
  const isolated = await createIsolatedDatabase(postgres.dsn);
  isolatedDatabaseName = isolated.databaseName;
  isolatedDsn = isolated.dsn;
  process.env.DATABASE_URL = isolated.dsn;
  process.env.TEST_DATABASE_URL = isolated.dsn;
  process.env.LOCAL_PG_POOL_MAX = "4";
  process.env.RAILWAY_SERVICE_NAME = APPLICATION_NAME;
  process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";
  process.env.NODE_ENV = "test";
  process.env.MOCK_REDIS = "1";
  process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

  const [client, admission, catalog] = await Promise.all([
    import("../../client"),
    import("../agent-backup-operation-admission"),
    import("../agent-backup-catalog"),
  ]);
  dbWrite = client.dbWrite;
  closeDatabaseConnectionsForTests = client.closeDatabaseConnectionsForTests;
  admissionRepository = admission;
  catalogRepository = catalog;
}

async function waitForRepositoryLockWaiters(observer: Client, minimum: number): Promise<number[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ pid: number }>(
      `SELECT pid
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name = $1
         AND state = 'active'
         AND wait_event_type = 'Lock'
         AND cardinality(pg_blocking_pids(pid)) > 0
       ORDER BY pid`,
      [APPLICATION_NAME],
    );
    if (new Set(result.rows.map((row) => row.pid)).size >= minimum) {
      return result.rows.map((row) => row.pid);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} repository lane-lock waiters`);
}

async function reserveBackup(operationId: string) {
  if (!catalogRepository) throw new Error("PostgreSQL catalogue repository was not initialized");
  return catalogRepository.reserveAgentBackupOperation({
    organizationId: ORGANIZATION_ID,
    agentId: AGENT_ID,
    sandboxRecordId: AGENT_ID,
    operationId,
    activationGeneration: ACTIVATION_GENERATION,
    lifecycleRevision: "0",
    snapshotType: "auto",
    backupKind: "full",
    sourceProvider: "operator-onboarded",
    sourceNodeRecordId: NODE_RECORD_ID,
    sourceNodeId: NODE_ID,
    sourceNodeIncarnation: NODE_INCARNATION,
    sourceProviderServerId: null,
    sourceProviderHandle: PROVIDER_HANDLE,
    sourceContainerId: CONTAINER_ID,
    retentionReason: "schedule",
    retentionUntil: new Date("2027-08-17T00:00:00.000Z"),
  });
}

try {
  await initializeHarness();
} catch (error) {
  try {
    await cleanupHarness();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      "PostgreSQL backup-admission initialization and cleanup both failed",
    );
  }
  throw error;
}

afterAll(cleanupHarness, 60_000);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("backup operation admission contention", () => {
  beforeAll(async () => {
    if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
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
        agentBackupOperationLane,
        agentBackupOperationTenantWatermarks,
        agentBackupOperationNodeWatermarks,
        agentActivationPublications,
      } as never,
      dbWrite as never,
    );
    await apply();
    await installAgentNodeOccurrenceTriggerForTests((statement) => dbWrite?.execute(statement));
  }, 60_000);

  beforeEach(async () => {
    if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
    await dbWrite.delete(agentBackupOperationNodeWatermarks);
    await dbWrite.delete(agentBackupOperationTenantWatermarks);
    await dbWrite.delete(agentBackupOperationLane);
    await dbWrite.delete(agentActivationPublications);
    await dbWrite.delete(agentSandboxBackups);
    await dbWrite.delete(agentBackupCatalogAuthorities);
    await dbWrite.delete(agentSandboxes);
    await dbWrite.delete(dockerNodes);
    await dbWrite.delete(agentNodeIncarnationHistories);
    await dbWrite.delete(userCharacters);
    await dbWrite.delete(users);
    await dbWrite.delete(organizations);

    await dbWrite.insert(organizations).values({
      id: ORGANIZATION_ID,
      name: "Backup admission PostgreSQL organization",
      slug: "backup-admission-postgres-organization",
    });
    await dbWrite.insert(users).values({
      id: USER_ID,
      steward_user_id: "backup-admission-postgres-user",
      organization_id: ORGANIZATION_ID,
    });
    await dbWrite.insert(dockerNodes).values({
      id: NODE_RECORD_ID,
      node_id: NODE_ID,
      hostname: "robot-backup-admission-postgres.example.test",
      host_key_fingerprint: "sha256:backup-admission-postgres-host-key",
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      provider_server_id: null,
      node_incarnation: NODE_INCARNATION,
      status: "healthy",
      enabled: true,
    });
    await dbWrite.insert(agentSandboxes).values({
      id: AGENT_ID,
      organization_id: ORGANIZATION_ID,
      user_id: USER_ID,
      agent_name: "Backup admission PostgreSQL agent",
      status: "running",
      execution_tier: "dedicated-always",
      sandbox_id: PROVIDER_HANDLE,
      node_id: NODE_ID,
      container_name: PROVIDER_HANDLE,
      image_digest: IMAGE_DIGEST,
      lifecycle_revision: 0,
      activation_generation: ACTIVATION_GENERATION,
      activation_lifecycle_revision: 0n,
      activation_purpose: "provision",
      activation_phase: "active",
      activation_receipt: ACTIVATION_RECEIPT,
      activation_receipt_hash: RECEIPT_SHA,
      activation_container_id: CONTAINER_ID,
      activation_node_id: NODE_ID,
      activation_image_digest: IMAGE_DIGEST,
      activation_boot_id: NODE_INCARNATION,
      activation_token_hash: TOKEN_SHA,
      activation_token_ciphertext: "sealed-postgres-admission-token",
      activation_funding_revision: 0n,
      activation_authority_published_at: ACTIVATION_PUBLISHED_AT,
      activation_dispatched_at: new Date("2026-08-17T00:00:01.000Z"),
      activation_completed_at: new Date("2026-08-17T00:00:02.000Z"),
    });
    const [node] = await dbWrite
      .select({ historyId: dockerNodes.current_node_history_id })
      .from(dockerNodes)
      .where(eq(dockerNodes.id, NODE_RECORD_ID));
    if (!node?.historyId) throw new Error("Expected trigger-owned source-node occurrence");
    await dbWrite.insert(agentActivationPublications).values({
      id: ACTIVATION_PUBLICATION_ID,
      organization_id: ORGANIZATION_ID,
      agent_id: AGENT_ID,
      activation_generation: ACTIVATION_GENERATION,
      previous_activation_generation: null,
      lifecycle_revision: 0n,
      purpose: "provision",
      backup_id: null,
      backup_manifest_sha256: null,
      activation_receipt: ACTIVATION_RECEIPT,
      activation_receipt_sha256: RECEIPT_SHA,
      container_id: CONTAINER_ID,
      node_history_id: node.historyId,
      docker_node_record_id: NODE_RECORD_ID,
      node_id: NODE_ID,
      node_incarnation: NODE_INCARNATION,
      image_digest: IMAGE_DIGEST,
      token_sha256: TOKEN_SHA,
      funding_revision: 0n,
      published_at: ACTIVATION_PUBLISHED_AT,
    });
    await dbWrite.insert(agentBackupOperationLane).values({ singleton: true });
  });

  test("admits exactly one winner after two repository sessions contend on the singleton", async () => {
    if (!isolatedDsn || !dbWrite || !admissionRepository) {
      throw new Error("Real PostgreSQL harness was not initialized");
    }
    const [backupA, backupB] = await Promise.all([
      reserveBackup(OPERATION_A),
      reserveBackup(OPERATION_B),
    ]);
    const holder = new Client({
      connectionString: isolatedDsn,
      application_name: "backup-operation-admission-holder",
    });
    const observer = new Client({
      connectionString: isolatedDsn,
      application_name: "backup-operation-admission-observer",
    });
    await Promise.all([holder.connect(), observer.connect()]);
    let holderOpen = false;
    let claims: Promise<[ClaimResult, ClaimResult]> | undefined;
    try {
      await holder.query("BEGIN");
      holderOpen = true;
      await holder.query("SELECT singleton FROM agent_backup_operation_lane FOR UPDATE");
      claims = Promise.all([
        admissionRepository.claimNextAgentBackupOperationAdmission({
          callerToken: { ownerId: OWNER_A, generation: CALLER_GENERATION_A },
          leaseMs: 60_000,
        }),
        admissionRepository.claimNextAgentBackupOperationAdmission({
          callerToken: { ownerId: OWNER_B, generation: CALLER_GENERATION_B },
          leaseMs: 60_000,
        }),
      ]);
      const waiterPids = await waitForRepositoryLockWaiters(observer, 2);
      expect(new Set(waiterPids).size).toBeGreaterThanOrEqual(2);
      await holder.query("COMMIT");
      holderOpen = false;

      const results = await claims;
      const claimed = results.filter(
        (result): result is ClaimedResult => result.kind === "claimed",
      );
      const busy = results.filter((result) => result.kind === "busy");
      expect(claimed).toHaveLength(1);
      expect(busy).toHaveLength(1);

      const winner = claimed[0];
      if (!winner) throw new Error("Expected one claimed backup admission");
      expect(winner.admission.laneExecution.claimSequence).toBe(1n);
      const [lane] = await dbWrite
        .select()
        .from(agentBackupOperationLane)
        .where(eq(agentBackupOperationLane.singleton, true));
      const backups = await dbWrite
        .select()
        .from(agentSandboxBackups)
        .orderBy(asc(agentSandboxBackups.id));
      const tenantWatermarks = await dbWrite.select().from(agentBackupOperationTenantWatermarks);
      const nodeWatermarks = await dbWrite.select().from(agentBackupOperationNodeWatermarks);
      if (!lane?.lease_expires_at) throw new Error("Expected an active global lane");

      expect(lane).toMatchObject({
        owner_id: winner.admission.claim.ownerId,
        generation: winner.admission.claim.generation,
        organization_id: ORGANIZATION_ID,
        backup_id: winner.admission.claim.backup.id,
        operation_id: winner.admission.claim.backup.backup_operation_id,
        operation_phase: "capture",
        released_at: null,
        claim_sequence: 1n,
      });
      const leased = backups.filter((backup) => backup.catalog_lease_owner !== null);
      const untouched = backups.filter((backup) => backup.catalog_lease_owner === null);
      expect(leased).toHaveLength(1);
      expect(untouched).toHaveLength(1);
      expect(new Set(backups.map((backup) => backup.id))).toEqual(
        new Set([backupA.id, backupB.id]),
      );
      expect(leased[0]).toMatchObject({
        id: winner.admission.claim.backup.id,
        backup_operation_id: winner.admission.claim.backup.backup_operation_id,
        catalog_lease_owner: winner.admission.claim.ownerId,
        catalog_lease_generation: winner.admission.claim.generation,
      });
      expect(leased[0]?.catalog_lease_expires_at?.getTime()).toBe(lane.lease_expires_at.getTime());
      expect(untouched[0]).toMatchObject({
        catalog_lease_owner: null,
        catalog_lease_generation: null,
        catalog_lease_expires_at: null,
      });
      expect(tenantWatermarks).toEqual([
        expect.objectContaining({
          organization_id: ORGANIZATION_ID,
          last_backup_id: winner.admission.claim.backup.id,
          last_operation_id: winner.admission.claim.backup.backup_operation_id,
          last_service_sequence: 1n,
          service_count: 1n,
        }),
      ]);
      expect(nodeWatermarks).toEqual([
        expect.objectContaining({
          source_node_history_id: winner.admission.sourceNodeHistoryId,
          source_node_record_id: NODE_RECORD_ID,
          source_node_incarnation: NODE_INCARNATION,
          last_backup_id: winner.admission.claim.backup.id,
          last_operation_id: winner.admission.claim.backup.backup_operation_id,
          last_service_sequence: 1n,
          service_count: 1n,
        }),
      ]);
    } finally {
      if (holderOpen) await holder.query("ROLLBACK").catch(() => {});
      await claims?.catch(() => {});
      await Promise.allSettled([holder.end(), observer.end()]);
    }
  }, 60_000);
});
