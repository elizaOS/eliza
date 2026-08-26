/**
 * Proves canonical backup catalogue claims with independent PostgreSQL
 * sessions. PGlite cannot expose cross-session blockers or DB-clock drift
 * while a repository transaction waits behind a relation lock.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pushSchema } from "drizzle-kit/api";
import { asc, eq, sql } from "drizzle-orm";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import { sqlRows } from "../../execute-helpers";
import {
  agentBackupNodeAdmissionCursors,
  agentBackupOrganizationAdmissionCursors,
} from "../../schemas/agent-backup-admission";
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
  "[backup catalogue contention] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const REQUIRE_REAL_POSTGRES = process.env.REQUIRE_REAL_POSTGRES_BACKUP_CATALOG_TESTS === "1";
const APPLICATION_NAME = "backup-catalogue-postgres-test";
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

interface TenantFixture {
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly nodeHistoryId?: string;
  readonly nodeRecordId: string;
  readonly nodeId: string;
  readonly nodeIncarnation: string;
  readonly providerHandle: string;
}

const TENANT_A = {
  organizationId: "10000000-0000-4000-8000-000000000201",
  userId: "20000000-0000-4000-8000-000000000201",
  agentId: "30000000-0000-4000-8000-000000000201",
  nodeHistoryId: "41000000-0000-4000-8000-000000000201",
  nodeRecordId: "40000000-0000-4000-8000-000000000201",
  nodeIncarnation: "50000000-0000-4000-8000-000000000201",
  nodeId: "backup-catalogue-tenant-a-node",
  providerHandle: "backup-catalogue-tenant-a-container",
} as const satisfies TenantFixture;
const TENANT_A2 = {
  organizationId: TENANT_A.organizationId,
  userId: TENANT_A.userId,
  agentId: "30000000-0000-4000-8000-000000000204",
  nodeRecordId: "40000000-0000-4000-8000-000000000204",
  nodeIncarnation: "50000000-0000-4000-8000-000000000204",
  nodeId: "backup-catalogue-tenant-a-second-node",
  providerHandle: "backup-catalogue-tenant-a-second-container",
} as const satisfies TenantFixture;
const TENANT_B = {
  organizationId: "10000000-0000-4000-8000-000000000202",
  userId: "20000000-0000-4000-8000-000000000202",
  agentId: "30000000-0000-4000-8000-000000000202",
  nodeHistoryId: "41000000-0000-4000-8000-000000000202",
  nodeRecordId: "40000000-0000-4000-8000-000000000202",
  nodeIncarnation: "50000000-0000-4000-8000-000000000202",
  nodeId: "backup-catalogue-tenant-b-node",
  providerHandle: "backup-catalogue-tenant-b-container",
} as const satisfies TenantFixture;
const TENANT_C = {
  organizationId: "10000000-0000-4000-8000-000000000203",
  userId: "20000000-0000-4000-8000-000000000203",
  agentId: "30000000-0000-4000-8000-000000000203",
  nodeRecordId: TENANT_A.nodeRecordId,
  nodeIncarnation: TENANT_A.nodeIncarnation,
  nodeId: TENANT_A.nodeId,
  providerHandle: "backup-catalogue-tenant-c-container",
} as const satisfies TenantFixture;
const OPERATION_A1 = "60000000-0000-4000-8000-000000000201";
const OPERATION_A2 = "60000000-0000-4000-8000-000000000202";
const OPERATION_B1 = "60000000-0000-4000-8000-000000000203";
const OPERATION_C1 = "60000000-0000-4000-8000-000000000204";
const ROTATED_NODE_INCARNATION = "50000000-0000-4000-8000-000000000299";
const OWNER_A = "backup-catalogue-postgres-worker-a";
const OWNER_B = "backup-catalogue-postgres-worker-b";
const PAYLOAD_DIGEST = "a".repeat(64);
const CONTAINER_ID = "b".repeat(64);
const BACKUP_ADMISSION_MIGRATIONS = [
  "0341_agent_backup_admission_cursors",
  "0342_retire_agent_backup_admission_protocol_guard",
] as const;

type ClientModule = typeof import("../../client");
type CatalogRepository = typeof import("../agent-backup-catalog");

let postgres: EphemeralPostgres | null = null;
let isolatedDatabaseName: string | null = null;
let isolatedDsn: string | null = null;
let cleanupPromise: Promise<void> | null = null;
let dbWrite: ClientModule["dbWrite"] | undefined;
let closeDatabaseConnectionsForTests: ClientModule["closeDatabaseConnectionsForTests"] | undefined;
let catalogRepository: CatalogRepository | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function expectPostgresFailure(operation: Promise<unknown>, expected: RegExp): Promise<void> {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }

  const details: string[] = [];
  let current = failure;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current instanceof Error) details.push(current.message);
    if (typeof current !== "object") break;
    const record = current as { cause?: unknown; constraint?: unknown };
    if (typeof record.constraint === "string") details.push(record.constraint);
    current = record.cause;
  }
  expect(details.join("\n")).toMatch(expected);
}

async function createIsolatedDatabase(baseDsn: string): Promise<{
  databaseName: string;
  dsn: string;
}> {
  const databaseName = `eliza_backup_catalogue_${randomUUID().replaceAll("-", "")}`;
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
      await capture(async () => {
        await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      });
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
    if (REQUIRE_REAL_POSTGRES) {
      throw new Error("Real PostgreSQL is required for backup catalogue contention tests");
    }
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

  const [client, repository] = await Promise.all([
    import("../../client"),
    import("../agent-backup-catalog"),
  ]);
  dbWrite = client.dbWrite;
  closeDatabaseConnectionsForTests = client.closeDatabaseConnectionsForTests;
  catalogRepository = repository;
}

async function applyBackupAdmissionMigrations(): Promise<void> {
  if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
  for (const tag of BACKUP_ADMISSION_MIGRATIONS) {
    const source = readFileSync(new URL(`../../migrations/${tag}.sql`, import.meta.url), "utf8");
    await dbWrite.transaction(async (transaction) => {
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await transaction.execute(sql.raw(statement));
      }
    });
  }
}

async function waitForRepositoryLockWaiters(
  observer: Client,
  blockerPid: number,
  minimum: number,
): Promise<Array<{ pid: number; transactionStartedAt: Date }>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{
      pid: number;
      xact_start: Date;
      blockers: number[];
    }>(
      `SELECT pid, xact_start, pg_blocking_pids(pid) AS blockers
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name = $1
         AND state = 'active'
         AND wait_event_type = 'Lock'
       ORDER BY pid`,
      [APPLICATION_NAME],
    );
    const blocked = result.rows.filter(
      (row) => row.xact_start && row.blockers.includes(blockerPid),
    );
    if (new Set(blocked.map((row) => row.pid)).size >= minimum) {
      return blocked.map((row) => ({
        pid: row.pid,
        transactionStartedAt: row.xact_start,
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} backup catalogue lock waiter(s)`);
}

async function waitForDatabaseTimeAfter(observer: Client, instant: Date): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ elapsed: boolean }>(
      "SELECT clock_timestamp() > $1::timestamptz AS elapsed",
      [instant],
    );
    if (result.rows[0]?.elapsed) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for database clock to pass ${instant.toISOString()}`);
}

async function resolveWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

interface TeardownOperation {
  readonly label: string;
  readonly run: () => Promise<unknown>;
}

async function settleTeardown(
  primaryFailure: { error: unknown } | null,
  phases: ReadonlyArray<ReadonlyArray<TeardownOperation>>,
): Promise<void> {
  // error-policy:J6 best-effort teardown — rollback must finish before blocked
  // repository calls settle, and those calls must finish before clients close.
  const cleanupFailures: Error[] = [];
  for (const operations of phases) {
    const results = await Promise.allSettled(
      operations.map((operation) => Promise.resolve().then(operation.run)),
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        cleanupFailures.push(
          new Error(`PostgreSQL test teardown failed: ${operations[index]?.label}`, {
            cause: result.reason,
          }),
        );
      }
    }
  }
  if (primaryFailure && cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure.error, ...cleanupFailures],
      "PostgreSQL backup catalogue assertion and teardown both failed",
      { cause: primaryFailure.error },
    );
  }
  if (primaryFailure) throw primaryFailure.error;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "PostgreSQL backup catalogue test teardown failed");
  }
}

async function expectDatabaseCause(
  operation: PromiseLike<unknown>,
  expectedFragment: string,
): Promise<void> {
  try {
    await operation;
    throw new Error("Expected database operation to fail");
  } catch (error) {
    const cause = error instanceof Error && "cause" in error ? error.cause : error;
    expect(String(cause)).toContain(expectedFragment);
  }
}

async function seedSourceAuthority(tenant: TenantFixture): Promise<void> {
  if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
  if (!tenant.nodeHistoryId) throw new Error("Source authority fixture requires a history ID");
  const hostKeyFingerprint = `sha256:${tenant.nodeId}`;
  await dbWrite.insert(agentNodeIncarnationHistories).values({
    id: tenant.nodeHistoryId,
    docker_node_record_id: tenant.nodeRecordId,
    node_id: tenant.nodeId,
    node_incarnation: tenant.nodeIncarnation,
    fleet_kind: "robot",
    infrastructure_provider: "hetzner",
    provider_server_id: null,
    host_key_fingerprint: hostKeyFingerprint,
  });
  await dbWrite.insert(dockerNodes).values({
    id: tenant.nodeRecordId,
    node_id: tenant.nodeId,
    hostname: tenant.nodeId,
    status: "healthy",
    host_key_fingerprint: hostKeyFingerprint,
    fleet_kind: "robot",
    infrastructure_provider: "hetzner",
    provider_server_id: null,
    node_incarnation: tenant.nodeIncarnation,
    current_node_history_id: tenant.nodeHistoryId,
  });
}

async function seedTenant(tenant: TenantFixture, suffix: string): Promise<void> {
  if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
  await dbWrite
    .insert(organizations)
    .values({
      id: tenant.organizationId,
      name: `Backup catalogue ${suffix}`,
      slug: `backup-catalogue-${suffix}`,
    })
    .onConflictDoNothing();
  await dbWrite
    .insert(users)
    .values({
      id: tenant.userId,
      organization_id: tenant.organizationId,
      steward_user_id: `backup-catalogue-${suffix}-user`,
    })
    .onConflictDoNothing();
  await dbWrite
    .insert(dockerNodes)
    .values({
      id: tenant.nodeRecordId,
      node_id: tenant.nodeId,
      hostname: `${tenant.nodeId}.example.test`,
      host_key_fingerprint: `sha256:${tenant.nodeId}-host-key`,
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      node_incarnation: tenant.nodeIncarnation,
      status: "healthy",
      enabled: true,
    })
    .onConflictDoNothing();
  const nodeHistoryId = await requireCurrentNodeHistoryId(tenant);
  await dbWrite
    .insert(agentBackupOrganizationAdmissionCursors)
    .values({ organization_id: tenant.organizationId })
    .onConflictDoNothing();
  await dbWrite
    .insert(agentBackupNodeAdmissionCursors)
    .values({ node_history_id: nodeHistoryId })
    .onConflictDoNothing();
  await dbWrite.insert(agentSandboxes).values({
    id: tenant.agentId,
    organization_id: tenant.organizationId,
    user_id: tenant.userId,
    agent_name: `Backup catalogue ${suffix} agent`,
    status: "running",
    execution_tier: "dedicated-always",
    sandbox_id: tenant.providerHandle,
    node_id: tenant.nodeId,
  });
  await dbWrite.insert(agentBackupCatalogAuthorities).values({
    organization_id: tenant.organizationId,
    agent_id: tenant.agentId,
  });
}

async function requireCurrentNodeHistoryId(tenant: TenantFixture): Promise<string> {
  if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
  const [node] = await dbWrite
    .select({ historyId: dockerNodes.current_node_history_id })
    .from(dockerNodes)
    .where(eq(dockerNodes.id, tenant.nodeRecordId));
  if (!node?.historyId) {
    throw new Error(`Missing exact node occurrence fixture for ${tenant.nodeRecordId}`);
  }
  return node.historyId;
}

async function seedBackup(params: {
  tenant: TenantFixture;
  suffix: string;
  operationId: string;
  dueAt: Date;
}): Promise<string> {
  if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
  const id = randomUUID();
  const nodeHistoryId = await requireCurrentNodeHistoryId(params.tenant);
  await dbWrite.insert(agentSandboxBackups).values({
    id,
    sandbox_record_id: params.tenant.agentId,
    snapshot_type: "auto",
    state_data: { memories: [], config: {}, workspaceFiles: {} },
    state_data_storage: "inline",
    size_bytes: 0,
    backup_kind: "full",
    backup_operation_id: params.operationId,
    catalog_version: 2,
    catalog_state: "scheduled",
    catalog_payload_digest: PAYLOAD_DIGEST,
    catalog_revision: 0n,
    catalog_organization_id: params.tenant.organizationId,
    catalog_agent_id: params.tenant.agentId,
    lifecycle_generation: randomUUID(),
    lifecycle_revision: 0n,
    source_provider: "operator-onboarded",
    source_node_record_id: params.tenant.nodeRecordId,
    source_node_id: params.tenant.nodeId,
    source_node_incarnation: params.tenant.nodeIncarnation,
    source_node_history_id: nodeHistoryId,
    source_provider_server_id: null,
    source_provider_handle: params.tenant.providerHandle,
    source_container_id: CONTAINER_ID,
    retention_reason: "schedule",
    retention_until: new Date("2027-08-26T00:00:00.000Z"),
    catalog_next_attempt_at: params.dueAt,
    catalog_updated_at: new Date("2026-08-26T00:00:00.000Z"),
  });
  return id;
}

async function installBackupMutationGuardForTests(): Promise<void> {
  if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
  await dbWrite.execute(sql`
    CREATE OR REPLACE FUNCTION lock_backup_claim_gate_for_test()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $guard$
    BEGIN
      IF NEW.catalog_organization_id IS NOT NULL AND NEW.catalog_agent_id IS NOT NULL THEN
        PERFORM 1
        FROM agent_backup_catalog_authorities
        WHERE organization_id = NEW.catalog_organization_id
          AND agent_id = NEW.catalog_agent_id
        FOR KEY SHARE;
      END IF;
      RETURN NEW;
    END;
    $guard$
  `);
  await dbWrite.execute(sql`
    CREATE TRIGGER agent_sandbox_backups_claim_guard_test
    BEFORE UPDATE ON agent_sandbox_backups
    FOR EACH ROW EXECUTE FUNCTION lock_backup_claim_gate_for_test()
  `);
}

try {
  await initializeHarness();
} catch (error) {
  try {
    await cleanupHarness();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      "PostgreSQL backup catalogue initialization and cleanup both failed",
    );
  }
  throw error;
}

afterAll(cleanupHarness, 60_000);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("canonical backup catalogue contention", () => {
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
      } as never,
      dbWrite as never,
    );
    await apply();
    await seedSourceAuthority(TENANT_A);
    await seedSourceAuthority(TENANT_B);
    await applyBackupAdmissionMigrations();
    await installBackupMutationGuardForTests();
  }, 60_000);

  beforeEach(async () => {
    if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
    await dbWrite.delete(agentSandboxBackups);
    await dbWrite.delete(agentBackupNodeAdmissionCursors);
    await dbWrite.delete(agentBackupOrganizationAdmissionCursors);
    await dbWrite.delete(agentBackupCatalogAuthorities);
    await dbWrite.delete(agentSandboxes);
    await dbWrite.delete(dockerNodes);
    await dbWrite.delete(agentNodeIncarnationHistories);
    await dbWrite.delete(userCharacters);
    await dbWrite.delete(users);
    await dbWrite.delete(organizations);
    await seedTenant(TENANT_A, "tenant-a");
    await seedTenant(TENANT_A2, "tenant-a-second-lane");
    await seedTenant(TENANT_B, "tenant-b");
    await seedTenant(TENANT_C, "tenant-c");
  });

  test("retires only the protocol guard after the admission migration", async () => {
    if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
    const [migrationState] = await sqlRows<{
      bind_trigger_exists: boolean;
      capture_check_exists: boolean;
      node_cursor_exists: boolean;
      occurrence_fk_exists: boolean;
      organization_cursor_exists: boolean;
      preserve_trigger_exists: boolean;
      protocol_function_exists: boolean;
      protocol_trigger_exists: boolean;
    }>(
      dbWrite,
      sql`
        SELECT
          EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgrelid = 'agent_sandbox_backups'::regclass
              AND tgname = 'agent_sandbox_backups_require_admission_protocol'
              AND NOT tgisinternal
          ) AS protocol_trigger_exists,
          to_regprocedure('public.require_agent_backup_admission_protocol()') IS NOT NULL
            AS protocol_function_exists,
          EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgrelid = 'agent_sandbox_backups'::regclass
              AND tgname = 'agent_sandbox_backups_bind_admission_authorities'
              AND NOT tgisinternal
          ) AS bind_trigger_exists,
          EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgrelid = 'agent_sandbox_backups'::regclass
              AND tgname = 'agent_sandbox_backups_preserve_admission_identity'
              AND NOT tgisinternal
          ) AS preserve_trigger_exists,
          EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'agent_sandbox_backups'::regclass
              AND conname = 'agent_sandbox_backups_source_node_occurrence_fkey'
          ) AS occurrence_fk_exists,
          EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'agent_sandbox_backups'::regclass
              AND conname = 'agent_sandbox_backups_capture_source_occurrence_check'
          ) AS capture_check_exists,
          to_regclass('public.agent_backup_organization_admission_cursors') IS NOT NULL
            AS organization_cursor_exists,
          to_regclass('public.agent_backup_node_admission_cursors') IS NOT NULL
            AS node_cursor_exists
      `,
    );
    expect(migrationState).toEqual({
      bind_trigger_exists: true,
      capture_check_exists: true,
      node_cursor_exists: true,
      occurrence_fk_exists: true,
      organization_cursor_exists: true,
      preserve_trigger_exists: true,
      protocol_function_exists: false,
      protocol_trigger_exists: false,
    });

    const backupId = await seedBackup({
      tenant: TENANT_A,
      suffix: "preserved-authorities",
      operationId: OPERATION_A1,
      dueAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const [bound] = await dbWrite
      .select({
        sourceNodeHistoryId: agentSandboxBackups.source_node_history_id,
        sourceNodeId: agentSandboxBackups.source_node_id,
      })
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, backupId));
    expect(bound).toEqual({
      sourceNodeHistoryId: TENANT_A.nodeHistoryId,
      sourceNodeId: TENANT_A.nodeId,
    });

    await expectPostgresFailure(
      dbWrite
        .update(agentSandboxBackups)
        .set({ source_node_id: TENANT_B.nodeId })
        .where(eq(agentSandboxBackups.id, backupId))
        .execute(),
      /admission identity is immutable/i,
    );
    const [preserved] = await dbWrite
      .select({ sourceNodeId: agentSandboxBackups.source_node_id })
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, backupId));
    expect(preserved?.sourceNodeId).toBe(TENANT_A.nodeId);
    await expectPostgresFailure(
      dbWrite
        .insert(agentSandboxBackups)
        .values({
          id: randomUUID(),
          sandbox_record_id: TENANT_A.agentId,
          snapshot_type: "auto",
          state_data: { memories: [], config: {}, workspaceFiles: {} },
          state_data_storage: "inline",
          size_bytes: 0,
          backup_kind: "full",
          source_node_history_id: TENANT_B.nodeHistoryId,
          source_node_record_id: TENANT_A.nodeRecordId,
          source_node_incarnation: TENANT_A.nodeIncarnation,
        })
        .execute(),
      /source_node_occurrence|foreign key/i,
    );
  });

  test("claims, heartbeats, and releases without the protocol GUC", async () => {
    if (!dbWrite || !catalogRepository) {
      throw new Error("Real PostgreSQL harness was not initialized");
    }
    const [session] = await sqlRows<{ protocol: string | null }>(
      dbWrite,
      sql`SELECT current_setting('eliza.agent_backup_admission_protocol', true) AS protocol`,
    );
    expect(session?.protocol).not.toBe("2");

    const backupId = await seedBackup({
      tenant: TENANT_A,
      suffix: "no-protocol-guc",
      operationId: OPERATION_A1,
      dueAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const [claim] = await catalogRepository.claimDueAgentBackupOperations({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });
    if (!claim?.backup.lifecycle_generation) {
      throw new Error("Expected a claimed backup with lifecycle authority");
    }
    const heartbeat = await catalogRepository.heartbeatAgentBackupOperation({
      organizationId: TENANT_A.organizationId,
      backupId,
      execution: { ownerId: claim.ownerId, generation: claim.generation },
      leaseMs: 60_000,
    });
    expect(heartbeat).toMatchObject({
      id: backupId,
      catalog_lease_owner: claim.ownerId,
      catalog_lease_generation: claim.generation,
    });

    const released = await catalogRepository.failAgentBackupOperation({
      organizationId: TENANT_A.organizationId,
      backupId,
      operationId: OPERATION_A1,
      lifecycleGeneration: claim.backup.lifecycle_generation,
      expectedState: "scheduled",
      terminal: true,
      error: { code: "CAPTURE_TERMINAL", message: "forward migration release proof" },
      execution: { ownerId: claim.ownerId, generation: claim.generation },
    });
    expect(released).toMatchObject({
      catalog_state: "failed_terminal",
      catalog_lease_owner: null,
      catalog_lease_generation: null,
      catalog_lease_expires_at: null,
    });
  });

  test("serves an independent lane without bypassing a blocked tenant or exact node", async () => {
    if (!isolatedDsn || !dbWrite || !catalogRepository) {
      throw new Error("Real PostgreSQL harness was not initialized");
    }
    const firstA = await seedBackup({
      tenant: TENANT_A,
      suffix: "tenant-a-first",
      operationId: OPERATION_A1,
      dueAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const secondA = await seedBackup({
      tenant: TENANT_A2,
      suffix: "tenant-a-second",
      operationId: OPERATION_A2,
      dueAt: new Date("2020-01-02T00:00:00.000Z"),
    });
    const firstC = await seedBackup({
      tenant: TENANT_C,
      suffix: "tenant-c-first",
      operationId: OPERATION_C1,
      dueAt: new Date("2020-01-03T00:00:00.000Z"),
    });
    const firstB = await seedBackup({
      tenant: TENANT_B,
      suffix: "tenant-b-first",
      operationId: OPERATION_B1,
      dueAt: new Date("2020-01-04T00:00:00.000Z"),
    });
    const holder = new Client({
      connectionString: isolatedDsn,
      application_name: "backup-catalogue-contention-holder",
    });
    await holder.connect();
    let holderOpen = false;
    let primaryFailure: { error: unknown } | null = null;
    try {
      await holder.query("BEGIN");
      holderOpen = true;
      await holder.query("SELECT id FROM agent_sandbox_backups WHERE id = $1 FOR UPDATE", [firstA]);

      const independentClaims = await resolveWithin(
        catalogRepository.claimDueAgentBackupOperations({
          ownerId: OWNER_B,
          limit: 4,
          leaseMs: 60_000,
        }),
        5_000,
        "Independent tenant B did not progress while the A1 head remained locked",
      );
      expect(independentClaims).toHaveLength(1);
      expect(independentClaims[0]?.backup.id).toBe(firstB);
      expect(
        await catalogRepository.claimDueAgentBackupOperations({
          ownerId: "backup-catalogue-postgres-locked-head-observer",
          limit: 4,
          leaseMs: 60_000,
        }),
      ).toEqual([]);

      await holder.query("COMMIT");
      holderOpen = false;

      const headClaims = await catalogRepository.claimDueAgentBackupOperations({
        ownerId: OWNER_A,
        limit: 1,
        leaseMs: 60_000,
      });
      expect(headClaims).toHaveLength(1);
      expect(headClaims[0]?.backup.id).toBe(firstA);
      const claimed = [...headClaims, ...independentClaims];
      expect(claimed).toHaveLength(2);
      expect(new Set(claimed.map((claim) => claim.backup.id))).toEqual(new Set([firstA, firstB]));
      expect(new Set(claimed.map((claim) => claim.backup.catalog_organization_id))).toEqual(
        new Set([TENANT_A.organizationId, TENANT_B.organizationId]),
      );
      expect(
        await catalogRepository.claimDueAgentBackupOperations({
          ownerId: "backup-catalogue-postgres-worker-c",
          limit: 3,
          leaseMs: 60_000,
        }),
      ).toEqual([]);

      const rows = await dbWrite
        .select({
          id: agentSandboxBackups.id,
          leaseOwner: agentSandboxBackups.catalog_lease_owner,
        })
        .from(agentSandboxBackups)
        .orderBy(asc(agentSandboxBackups.catalog_next_attempt_at));
      expect(rows).toEqual([
        { id: firstA, leaseOwner: expect.any(String) },
        { id: secondA, leaseOwner: null },
        { id: firstC, leaseOwner: null },
        { id: firstB, leaseOwner: expect.any(String) },
      ]);
      const organizationsWithCursors = await dbWrite
        .select({
          id: agentBackupOrganizationAdmissionCursors.organization_id,
          cursorAt: agentBackupOrganizationAdmissionCursors.cursor_at,
        })
        .from(agentBackupOrganizationAdmissionCursors)
        .orderBy(asc(agentBackupOrganizationAdmissionCursors.organization_id));
      const organizationCursorById = new Map(
        organizationsWithCursors.map((row) => [row.id, row.cursorAt]),
      );
      const tenantACursor = organizationCursorById.get(TENANT_A.organizationId);
      const tenantBCursor = organizationCursorById.get(TENANT_B.organizationId);
      expect(organizationsWithCursors).toHaveLength(3);
      expect(tenantACursor).toBeInstanceOf(Date);
      expect(tenantBCursor).toBeInstanceOf(Date);
      expect(organizationCursorById.get(TENANT_C.organizationId)).toBeNull();
      if (!tenantACursor || !tenantBCursor) throw new Error("Expected advanced tenant cursors");
      expect(tenantACursor.getTime()).toBeGreaterThan(tenantBCursor.getTime());

      const tenantAHistoryId = await requireCurrentNodeHistoryId(TENANT_A);
      const tenantA2HistoryId = await requireCurrentNodeHistoryId(TENANT_A2);
      const tenantBHistoryId = await requireCurrentNodeHistoryId(TENANT_B);
      const nodesWithCursors = await dbWrite
        .select({
          historyId: agentBackupNodeAdmissionCursors.node_history_id,
          cursorAt: agentBackupNodeAdmissionCursors.cursor_at,
        })
        .from(agentBackupNodeAdmissionCursors);
      const nodeCursorByHistoryId = new Map(
        nodesWithCursors.map((row) => [row.historyId, row.cursorAt]),
      );
      expect(nodesWithCursors).toHaveLength(3);
      expect(nodeCursorByHistoryId.get(tenantAHistoryId)).toEqual(tenantACursor);
      expect(nodeCursorByHistoryId.get(tenantA2HistoryId)).toBeNull();
      expect(nodeCursorByHistoryId.get(tenantBHistoryId)).toEqual(tenantBCursor);
    } catch (error) {
      // error-policy:J2 context-adding rethrow — retain the primary assertion
      // so ordered teardown can aggregate cleanup failures without replacing it.
      primaryFailure = { error };
    } finally {
      await settleTeardown(primaryFailure, [
        holderOpen
          ? [{ label: "rollback claim contention holder", run: () => holder.query("ROLLBACK") }]
          : [],
        [{ label: "close claim contention holder", run: () => holder.end() }],
      ]);
    }
  }, 60_000);

  test("starts a claim lease and both cursors from post-trigger database time", async () => {
    if (!isolatedDsn || !dbWrite || !catalogRepository) {
      throw new Error("Real PostgreSQL harness was not initialized");
    }
    await seedBackup({
      tenant: TENANT_A,
      suffix: "clock",
      operationId: OPERATION_A1,
      dueAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const nodeHistoryId = await requireCurrentNodeHistoryId(TENANT_A);
    const holder = new Client({
      connectionString: isolatedDsn,
      application_name: "backup-catalogue-clock-holder",
    });
    const observer = new Client({
      connectionString: isolatedDsn,
      application_name: "backup-catalogue-clock-observer",
    });
    await Promise.all([holder.connect(), observer.connect()]);
    let holderOpen = false;
    let claimPromise: ReturnType<CatalogRepository["claimDueAgentBackupOperations"]> | null = null;
    let primaryFailure: { error: unknown } | null = null;
    try {
      await holder.query("BEGIN");
      holderOpen = true;
      const holderPid = Number(
        (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
      );
      await holder.query(
        `SELECT organization_id
         FROM agent_backup_catalog_authorities
         WHERE organization_id = $1 AND agent_id = $2
         FOR UPDATE`,
        [TENANT_A.organizationId, TENANT_A.agentId],
      );
      claimPromise = catalogRepository.claimDueAgentBackupOperations({
        ownerId: OWNER_A,
        limit: 1,
        leaseMs: 60_000,
      });
      const [waiter] = await waitForRepositoryLockWaiters(observer, holderPid, 1);
      if (!waiter) throw new Error("Expected one blocked backup catalogue claim");
      const staleTransactionThreshold = new Date(waiter.transactionStartedAt.getTime() + 200);
      await waitForDatabaseTimeAfter(observer, staleTransactionThreshold);
      await holder.query("COMMIT");
      holderOpen = false;

      const [claim] = await claimPromise;
      claimPromise = null;
      if (!claim?.backup.catalog_updated_at || !claim.backup.catalog_lease_expires_at) {
        throw new Error("Expected a timestamped backup catalogue lease");
      }
      expect(claim.backup.catalog_updated_at.getTime()).toBeGreaterThan(
        staleTransactionThreshold.getTime(),
      );
      expect(
        claim.backup.catalog_lease_expires_at.getTime() - claim.backup.catalog_updated_at.getTime(),
      ).toBe(60_000);
      const [organization] = await dbWrite
        .select({ cursorAt: agentBackupOrganizationAdmissionCursors.cursor_at })
        .from(agentBackupOrganizationAdmissionCursors)
        .where(
          eq(agentBackupOrganizationAdmissionCursors.organization_id, TENANT_A.organizationId),
        );
      const [node] = await dbWrite
        .select({ cursorAt: agentBackupNodeAdmissionCursors.cursor_at })
        .from(agentBackupNodeAdmissionCursors)
        .where(eq(agentBackupNodeAdmissionCursors.node_history_id, nodeHistoryId));
      expect(organization?.cursorAt).toBeInstanceOf(Date);
      expect(node?.cursorAt).toEqual(organization?.cursorAt);
      expect(organization?.cursorAt?.getTime()).toBeGreaterThan(
        staleTransactionThreshold.getTime(),
      );
      expect(organization?.cursorAt?.getTime()).toBeLessThanOrEqual(
        claim.backup.catalog_updated_at.getTime(),
      );
    } catch (error) {
      // error-policy:J2 context-adding rethrow — preserve the assertion while
      // ordered teardown records any independent cleanup failure.
      primaryFailure = { error };
    } finally {
      await settleTeardown(primaryFailure, [
        holderOpen
          ? [{ label: "rollback claim clock holder", run: () => holder.query("ROLLBACK") }]
          : [],
        claimPromise
          ? [
              {
                label: "settle claim clock operation",
                run: async () => {
                  await claimPromise;
                },
              },
            ]
          : [],
        [
          { label: "close claim clock holder", run: () => holder.end() },
          { label: "close claim clock observer", run: () => observer.end() },
        ],
      ]);
    }
  }, 60_000);

  test("keeps a waiting claim bound to its append-only occurrence when the node rotates", async () => {
    if (!isolatedDsn || !dbWrite || !catalogRepository) {
      throw new Error("Real PostgreSQL harness was not initialized");
    }
    const backupId = await seedBackup({
      tenant: TENANT_A,
      suffix: "node-rotation",
      operationId: OPERATION_A1,
      dueAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const originalNodeHistoryId = await requireCurrentNodeHistoryId(TENANT_A);
    const holder = new Client({
      connectionString: isolatedDsn,
      application_name: "backup-catalogue-node-rotation-holder",
    });
    const observer = new Client({
      connectionString: isolatedDsn,
      application_name: "backup-catalogue-node-rotation-observer",
    });
    await Promise.all([holder.connect(), observer.connect()]);
    let holderOpen = false;
    let claimPromise: ReturnType<CatalogRepository["claimDueAgentBackupOperations"]> | null = null;
    let primaryFailure: { error: unknown } | null = null;
    try {
      await holder.query("BEGIN");
      holderOpen = true;
      const holderPid = Number(
        (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
      );
      await holder.query(
        `SELECT organization_id
         FROM agent_backup_catalog_authorities
         WHERE organization_id = $1 AND agent_id = $2
         FOR UPDATE`,
        [TENANT_A.organizationId, TENANT_A.agentId],
      );
      claimPromise = catalogRepository.claimDueAgentBackupOperations({
        ownerId: "backup-catalogue-node-rotation-worker",
        limit: 1,
        leaseMs: 60_000,
      });
      await waitForRepositoryLockWaiters(observer, holderPid, 1);
      const [rotated] = await dbWrite
        .update(dockerNodes)
        .set({ node_incarnation: ROTATED_NODE_INCARNATION })
        .where(eq(dockerNodes.id, TENANT_A.nodeRecordId))
        .returning({ incarnation: dockerNodes.node_incarnation });
      expect(rotated?.incarnation).toBe(ROTATED_NODE_INCARNATION);
      const rotatedNodeHistoryId = await requireCurrentNodeHistoryId(TENANT_A);
      expect(rotatedNodeHistoryId).not.toBe(originalNodeHistoryId);
      await holder.query("COMMIT");
      holderOpen = false;

      const [claim] = await claimPromise;
      claimPromise = null;
      expect(claim?.backup.id).toBe(backupId);
      const [backup] = await dbWrite
        .select({
          owner: agentSandboxBackups.catalog_lease_owner,
          generation: agentSandboxBackups.catalog_lease_generation,
          expiresAt: agentSandboxBackups.catalog_lease_expires_at,
          nodeHistoryId: agentSandboxBackups.source_node_history_id,
        })
        .from(agentSandboxBackups)
        .where(eq(agentSandboxBackups.id, backupId));
      const [organization] = await dbWrite
        .select({ cursorAt: agentBackupOrganizationAdmissionCursors.cursor_at })
        .from(agentBackupOrganizationAdmissionCursors)
        .where(
          eq(agentBackupOrganizationAdmissionCursors.organization_id, TENANT_A.organizationId),
        );
      const [originalNodeCursor] = await dbWrite
        .select({ cursorAt: agentBackupNodeAdmissionCursors.cursor_at })
        .from(agentBackupNodeAdmissionCursors)
        .where(eq(agentBackupNodeAdmissionCursors.node_history_id, originalNodeHistoryId));
      const [rotatedNodeCursor] = await dbWrite
        .select({ cursorAt: agentBackupNodeAdmissionCursors.cursor_at })
        .from(agentBackupNodeAdmissionCursors)
        .where(eq(agentBackupNodeAdmissionCursors.node_history_id, rotatedNodeHistoryId));
      const [node] = await dbWrite
        .select({
          incarnation: dockerNodes.node_incarnation,
          historyId: dockerNodes.current_node_history_id,
        })
        .from(dockerNodes)
        .where(eq(dockerNodes.id, TENANT_A.nodeRecordId));
      expect(backup).toEqual({
        owner: "backup-catalogue-node-rotation-worker",
        generation: expect.any(String),
        expiresAt: expect.any(Date),
        nodeHistoryId: originalNodeHistoryId,
      });
      expect(organization?.cursorAt).toBeInstanceOf(Date);
      expect(originalNodeCursor?.cursorAt).toEqual(organization?.cursorAt);
      expect(rotatedNodeCursor).toBeUndefined();
      expect(node).toEqual({
        incarnation: ROTATED_NODE_INCARNATION,
        historyId: rotatedNodeHistoryId,
      });
    } catch (error) {
      // error-policy:J2 context-adding rethrow — preserve the assertion while
      // ordered teardown records any independent cleanup failure.
      primaryFailure = { error };
    } finally {
      await settleTeardown(primaryFailure, [
        holderOpen
          ? [{ label: "rollback node rotation holder", run: () => holder.query("ROLLBACK") }]
          : [],
        claimPromise
          ? [
              {
                label: "settle node rotation claim",
                run: async () => {
                  await claimPromise;
                },
              },
            ]
          : [],
        [
          { label: "close node rotation holder", run: () => holder.end() },
          { label: "close node rotation observer", run: () => observer.end() },
        ],
      ]);
    }
  }, 60_000);

  test("rejects nulling or swapping a reserved source occurrence", async () => {
    if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
    const backupId = await seedBackup({
      tenant: TENANT_A,
      suffix: "immutable-occurrence",
      operationId: OPERATION_A1,
      dueAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const originalNodeHistoryId = await requireCurrentNodeHistoryId(TENANT_A);
    await dbWrite
      .update(dockerNodes)
      .set({ node_incarnation: ROTATED_NODE_INCARNATION })
      .where(eq(dockerNodes.id, TENANT_A.nodeRecordId));
    await dbWrite
      .update(dockerNodes)
      .set({ node_incarnation: TENANT_A.nodeIncarnation })
      .where(eq(dockerNodes.id, TENANT_A.nodeRecordId));
    const replacementNodeHistoryId = await requireCurrentNodeHistoryId(TENANT_A);
    expect(replacementNodeHistoryId).not.toBe(originalNodeHistoryId);

    await expectDatabaseCause(
      dbWrite
        .update(agentSandboxBackups)
        .set({ source_node_history_id: null })
        .where(eq(agentSandboxBackups.id, backupId)),
      "catalog v2 backup admission identity is immutable",
    );
    await expectDatabaseCause(
      dbWrite
        .update(agentSandboxBackups)
        .set({ source_node_history_id: replacementNodeHistoryId })
        .where(eq(agentSandboxBackups.id, backupId)),
      "catalog v2 backup admission identity is immutable",
    );

    const [persisted] = await dbWrite
      .select({ nodeHistoryId: agentSandboxBackups.source_node_history_id })
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, backupId));
    expect(persisted?.nodeHistoryId).toBe(originalNodeHistoryId);
  });

  test("renews a heartbeat lease from post-trigger database time", async () => {
    if (!isolatedDsn || !dbWrite || !catalogRepository) {
      throw new Error("Real PostgreSQL harness was not initialized");
    }
    const backupId = await seedBackup({
      tenant: TENANT_A,
      suffix: "heartbeat-clock",
      operationId: OPERATION_A1,
      dueAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const [claim] = await catalogRepository.claimDueAgentBackupOperations({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 60_000,
    });
    if (!claim) throw new Error("Expected an initial backup catalogue claim");

    const holder = new Client({
      connectionString: isolatedDsn,
      application_name: "backup-catalogue-heartbeat-holder",
    });
    const observer = new Client({
      connectionString: isolatedDsn,
      application_name: "backup-catalogue-heartbeat-observer",
    });
    await Promise.all([holder.connect(), observer.connect()]);
    let holderOpen = false;
    let heartbeatPromise: ReturnType<CatalogRepository["heartbeatAgentBackupOperation"]> | null =
      null;
    let primaryFailure: { error: unknown } | null = null;
    try {
      await holder.query("BEGIN");
      holderOpen = true;
      const holderPid = Number(
        (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
      );
      await holder.query(
        `SELECT organization_id
         FROM agent_backup_catalog_authorities
         WHERE organization_id = $1 AND agent_id = $2
         FOR UPDATE`,
        [TENANT_A.organizationId, TENANT_A.agentId],
      );
      heartbeatPromise = catalogRepository.heartbeatAgentBackupOperation({
        organizationId: TENANT_A.organizationId,
        backupId,
        execution: { ownerId: claim.ownerId, generation: claim.generation },
        leaseMs: 60_000,
      });
      const [heartbeatWaiter] = await waitForRepositoryLockWaiters(observer, holderPid, 1);
      if (!heartbeatWaiter) throw new Error("Expected one blocked backup catalogue heartbeat");
      const staleTransactionThreshold = new Date(
        heartbeatWaiter.transactionStartedAt.getTime() + 200,
      );
      await waitForDatabaseTimeAfter(observer, staleTransactionThreshold);
      await holder.query("COMMIT");
      holderOpen = false;

      const heartbeat = await heartbeatPromise;
      heartbeatPromise = null;
      if (!heartbeat.catalog_updated_at || !heartbeat.catalog_lease_expires_at) {
        throw new Error("Expected a timestamped backup catalogue heartbeat");
      }
      expect(heartbeat.catalog_updated_at.getTime()).toBeGreaterThan(
        staleTransactionThreshold.getTime(),
      );
      expect(
        heartbeat.catalog_lease_expires_at.getTime() - heartbeat.catalog_updated_at.getTime(),
      ).toBe(60_000);
      expect(heartbeat).toMatchObject({
        id: backupId,
        catalog_lease_owner: claim.ownerId,
        catalog_lease_generation: claim.generation,
      });
      const [persisted] = await dbWrite
        .select({
          ownerId: agentSandboxBackups.catalog_lease_owner,
          generation: agentSandboxBackups.catalog_lease_generation,
          expiresAt: agentSandboxBackups.catalog_lease_expires_at,
        })
        .from(agentSandboxBackups)
        .where(eq(agentSandboxBackups.id, backupId));
      expect(persisted).toEqual({
        ownerId: claim.ownerId,
        generation: claim.generation,
        expiresAt: heartbeat.catalog_lease_expires_at,
      });
    } catch (error) {
      // error-policy:J2 context-adding rethrow — preserve the assertion while
      // ordered teardown records any independent cleanup failure.
      primaryFailure = { error };
    } finally {
      await settleTeardown(primaryFailure, [
        holderOpen
          ? [{ label: "rollback heartbeat clock holder", run: () => holder.query("ROLLBACK") }]
          : [],
        heartbeatPromise
          ? [
              {
                label: "settle heartbeat clock operation",
                run: async () => {
                  await heartbeatPromise;
                },
              },
            ]
          : [],
        [
          { label: "close heartbeat clock holder", run: () => holder.end() },
          { label: "close heartbeat clock observer", run: () => observer.end() },
        ],
      ]);
    }
  }, 60_000);

  test("prevents an expiring heartbeat from overlapping either capture lane", async () => {
    if (!isolatedDsn || !dbWrite || !catalogRepository) {
      throw new Error("Real PostgreSQL harness was not initialized");
    }
    const backupId = await seedBackup({
      tenant: TENANT_A,
      suffix: "heartbeat-expiry",
      operationId: OPERATION_A1,
      dueAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const sameOrganizationBackupId = await seedBackup({
      tenant: TENANT_A2,
      suffix: "heartbeat-expiry-same-organization",
      operationId: OPERATION_A2,
      dueAt: new Date("2020-01-02T00:00:00.000Z"),
    });
    const sameNodeBackupId = await seedBackup({
      tenant: TENANT_C,
      suffix: "heartbeat-expiry-same-node",
      operationId: OPERATION_C1,
      dueAt: new Date("2020-01-03T00:00:00.000Z"),
    });
    const holder = new Client({
      connectionString: isolatedDsn,
      application_name: "backup-catalogue-heartbeat-expiry-holder",
    });
    const observer = new Client({
      connectionString: isolatedDsn,
      application_name: "backup-catalogue-heartbeat-expiry-observer",
    });
    await Promise.all([holder.connect(), observer.connect()]);

    const [claim] = await catalogRepository.claimDueAgentBackupOperations({
      ownerId: OWNER_A,
      limit: 1,
      leaseMs: 5_000,
    });
    if (!claim?.backup.catalog_lease_expires_at) {
      throw new Error("Expected an initial timestamped backup catalogue claim");
    }

    let holderOpen = false;
    let heartbeatPromise: ReturnType<CatalogRepository["heartbeatAgentBackupOperation"]> | null =
      null;
    let primaryFailure: { error: unknown } | null = null;
    let competingClaimPromise: ReturnType<
      CatalogRepository["claimDueAgentBackupOperations"]
    > | null = null;
    try {
      await holder.query("BEGIN");
      holderOpen = true;
      const holderPid = Number(
        (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
      );
      await holder.query(
        `SELECT organization_id
         FROM agent_backup_catalog_authorities
         WHERE organization_id = $1 AND agent_id = $2
         FOR UPDATE`,
        [TENANT_A.organizationId, TENANT_A.agentId],
      );
      heartbeatPromise = catalogRepository.heartbeatAgentBackupOperation({
        organizationId: TENANT_A.organizationId,
        backupId,
        execution: { ownerId: claim.ownerId, generation: claim.generation },
        leaseMs: 60_000,
      });
      const [heartbeatWaiter] = await waitForRepositoryLockWaiters(observer, holderPid, 1);
      if (!heartbeatWaiter) throw new Error("Expected one blocked backup catalogue heartbeat");
      await waitForDatabaseTimeAfter(observer, claim.backup.catalog_lease_expires_at);
      const visibleExpiry = await observer.query<{ expired: boolean }>(
        `SELECT catalog_lease_expires_at <= clock_timestamp() AS expired
         FROM agent_sandbox_backups
         WHERE id = $1`,
        [backupId],
      );
      expect(visibleExpiry.rows[0]?.expired).toBe(true);

      competingClaimPromise = catalogRepository.claimDueAgentBackupOperations({
        ownerId: OWNER_B,
        limit: 3,
        leaseMs: 60_000,
      });
      const competingWaiters = await waitForRepositoryLockWaiters(observer, heartbeatWaiter.pid, 1);
      expect(competingWaiters).toHaveLength(1);
      const visibleRows = await dbWrite
        .select({
          id: agentSandboxBackups.id,
          ownerId: agentSandboxBackups.catalog_lease_owner,
          expiresAt: agentSandboxBackups.catalog_lease_expires_at,
        })
        .from(agentSandboxBackups)
        .orderBy(asc(agentSandboxBackups.catalog_next_attempt_at));
      expect(visibleRows).toEqual([
        {
          id: backupId,
          ownerId: claim.ownerId,
          expiresAt: claim.backup.catalog_lease_expires_at,
        },
        { id: sameOrganizationBackupId, ownerId: null, expiresAt: null },
        { id: sameNodeBackupId, ownerId: null, expiresAt: null },
      ]);

      await holder.query("COMMIT");
      holderOpen = false;

      await expect(heartbeatPromise).rejects.toThrow(
        "Backup operation lease expired while waiting for post-lock authority",
      );
      heartbeatPromise = null;
      const recoveredClaims = await competingClaimPromise;
      competingClaimPromise = null;
      expect(new Set(recoveredClaims.map((recovered) => recovered.backup.id))).toEqual(
        new Set([sameOrganizationBackupId, sameNodeBackupId]),
      );
      const recoveredGeneration = recoveredClaims[0]?.generation;
      expect(recoveredGeneration).toEqual(expect.any(String));
      expect(recoveredGeneration).not.toBe(claim.generation);
      expect(new Set(recoveredClaims.map((recovered) => recovered.generation))).toEqual(
        new Set([recoveredGeneration]),
      );
      const persisted = await dbWrite
        .select({
          id: agentSandboxBackups.id,
          ownerId: agentSandboxBackups.catalog_lease_owner,
          generation: agentSandboxBackups.catalog_lease_generation,
          expiresAt: agentSandboxBackups.catalog_lease_expires_at,
        })
        .from(agentSandboxBackups)
        .orderBy(asc(agentSandboxBackups.catalog_next_attempt_at));
      expect(persisted).toEqual([
        {
          id: backupId,
          ownerId: claim.ownerId,
          generation: claim.generation,
          expiresAt: claim.backup.catalog_lease_expires_at,
        },
        {
          id: sameOrganizationBackupId,
          ownerId: OWNER_B,
          generation: recoveredGeneration,
          expiresAt: expect.any(Date),
        },
        {
          id: sameNodeBackupId,
          ownerId: OWNER_B,
          generation: recoveredGeneration,
          expiresAt: expect.any(Date),
        },
      ]);

      const recoveredById = new Map(
        recoveredClaims.map((recovered) => [recovered.backup.id, recovered]),
      );
      for (const [recoveredBackupId, operationId] of [
        [sameOrganizationBackupId, OPERATION_A2],
        [sameNodeBackupId, OPERATION_C1],
      ] as const) {
        const recovered = recoveredById.get(recoveredBackupId);
        if (!recovered?.backup.catalog_organization_id || !recovered.backup.lifecycle_generation) {
          throw new Error("Expected an exact recovered fairness claim");
        }
        const settled = await catalogRepository.failAgentBackupOperation({
          organizationId: recovered.backup.catalog_organization_id,
          backupId: recovered.backup.id,
          operationId,
          lifecycleGeneration: recovered.backup.lifecycle_generation,
          expectedState: "scheduled",
          terminal: true,
          error: {
            code: "FINITE_ROTATION_SETTLED",
            message: "Finite fairness rotation fixture settled terminally",
          },
          execution: {
            ownerId: recovered.ownerId,
            generation: recovered.generation,
          },
        });
        expect(settled).toMatchObject({
          id: recoveredBackupId,
          catalog_state: "failed_terminal",
          catalog_lease_owner: null,
          catalog_lease_generation: null,
          catalog_lease_expires_at: null,
        });
      }

      const finalClaims = await catalogRepository.claimDueAgentBackupOperations({
        ownerId: "backup-catalogue-postgres-worker-final",
        limit: 3,
        leaseMs: 60_000,
      });
      expect(finalClaims).toHaveLength(1);
      const [finalClaim] = finalClaims;
      expect(finalClaim?.backup.id).toBe(backupId);
      expect(finalClaim?.generation).not.toBe(claim.generation);
      expect(finalClaim?.backup.catalog_lease_expires_at?.getTime()).toBeGreaterThan(
        claim.backup.catalog_lease_expires_at.getTime(),
      );

      const finalRows = await dbWrite
        .select({
          id: agentSandboxBackups.id,
          state: agentSandboxBackups.catalog_state,
          ownerId: agentSandboxBackups.catalog_lease_owner,
          generation: agentSandboxBackups.catalog_lease_generation,
        })
        .from(agentSandboxBackups);
      const finalRowById = new Map(finalRows.map((row) => [row.id, row]));
      expect(finalRowById.get(backupId)).toEqual({
        id: backupId,
        state: "scheduled",
        ownerId: "backup-catalogue-postgres-worker-final",
        generation: finalClaim?.generation,
      });
      expect(finalRowById.get(sameOrganizationBackupId)).toEqual({
        id: sameOrganizationBackupId,
        state: "failed_terminal",
        ownerId: null,
        generation: null,
      });
      expect(finalRowById.get(sameNodeBackupId)).toEqual({
        id: sameNodeBackupId,
        state: "failed_terminal",
        ownerId: null,
        generation: null,
      });
    } catch (error) {
      // error-policy:J2 context-adding rethrow — preserve the assertion while
      // ordered teardown records any independent cleanup failure.
      primaryFailure = { error };
    } finally {
      await settleTeardown(primaryFailure, [
        holderOpen
          ? [{ label: "rollback heartbeat expiry holder", run: () => holder.query("ROLLBACK") }]
          : [],
        heartbeatPromise
          ? [
              {
                label: "settle heartbeat expiry operation",
                run: async () => {
                  await heartbeatPromise;
                },
              },
            ]
          : [],
        competingClaimPromise
          ? [
              {
                label: "settle competing heartbeat expiry claim",
                run: async () => {
                  await competingClaimPromise;
                },
              },
            ]
          : [],
        [
          { label: "close heartbeat expiry holder", run: () => holder.end() },
          { label: "close heartbeat expiry observer", run: () => observer.end() },
        ],
      ]);
    }
  }, 60_000);
});
