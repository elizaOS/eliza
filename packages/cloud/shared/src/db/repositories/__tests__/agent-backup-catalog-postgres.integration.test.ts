/**
 * Proves canonical backup catalogue claims with independent PostgreSQL
 * sessions. PGlite cannot expose cross-session blockers or DB-clock drift
 * while a repository transaction waits behind a relation lock.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { pushSchema } from "drizzle-kit/api";
import { asc, eq, sql } from "drizzle-orm";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import {
  agentBackupCatalogAuthorities,
  agentSandboxBackups,
  agentSandboxes,
} from "../../schemas/agent-sandboxes";
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
  readonly nodeRecordId: string;
  readonly nodeIncarnation: string;
}

const TENANT_A = {
  organizationId: "10000000-0000-4000-8000-000000000201",
  userId: "20000000-0000-4000-8000-000000000201",
  agentId: "30000000-0000-4000-8000-000000000201",
  nodeRecordId: "40000000-0000-4000-8000-000000000201",
  nodeIncarnation: "50000000-0000-4000-8000-000000000201",
} as const satisfies TenantFixture;
const TENANT_B = {
  organizationId: "10000000-0000-4000-8000-000000000202",
  userId: "20000000-0000-4000-8000-000000000202",
  agentId: "30000000-0000-4000-8000-000000000202",
  nodeRecordId: "40000000-0000-4000-8000-000000000202",
  nodeIncarnation: "50000000-0000-4000-8000-000000000202",
} as const satisfies TenantFixture;
const OPERATION_A1 = "60000000-0000-4000-8000-000000000201";
const OPERATION_A2 = "60000000-0000-4000-8000-000000000202";
const OPERATION_B1 = "60000000-0000-4000-8000-000000000203";
const OWNER_A = "backup-catalogue-postgres-worker-a";
const OWNER_B = "backup-catalogue-postgres-worker-b";
const PAYLOAD_DIGEST = "a".repeat(64);
const CONTAINER_ID = "b".repeat(64);

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

async function seedTenant(tenant: TenantFixture, suffix: string): Promise<void> {
  if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
  await dbWrite.insert(organizations).values({
    id: tenant.organizationId,
    name: `Backup catalogue ${suffix}`,
    slug: `backup-catalogue-${suffix}`,
  });
  await dbWrite.insert(users).values({
    id: tenant.userId,
    organization_id: tenant.organizationId,
    steward_user_id: `backup-catalogue-${suffix}-user`,
  });
  await dbWrite.insert(agentSandboxes).values({
    id: tenant.agentId,
    organization_id: tenant.organizationId,
    user_id: tenant.userId,
    agent_name: `Backup catalogue ${suffix} agent`,
    status: "running",
    execution_tier: "dedicated-always",
    sandbox_id: `backup-catalogue-${suffix}-container`,
  });
  await dbWrite.insert(agentBackupCatalogAuthorities).values({
    organization_id: tenant.organizationId,
    agent_id: tenant.agentId,
  });
}

async function seedBackup(params: {
  tenant: TenantFixture;
  suffix: string;
  operationId: string;
  dueAt: Date;
}): Promise<string> {
  if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
  const id = randomUUID();
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
    source_node_id: `backup-catalogue-${params.suffix}-node`,
    source_node_incarnation: params.tenant.nodeIncarnation,
    source_provider_server_id: null,
    source_provider_handle: `backup-catalogue-${params.suffix}-container`,
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
    CREATE OR REPLACE FUNCTION lock_backup_claim_sandbox_for_test()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $guard$
    BEGIN
      IF NEW.sandbox_record_id IS NOT NULL THEN
        PERFORM 1
        FROM agent_sandboxes
        WHERE id = NEW.sandbox_record_id
        FOR KEY SHARE;
      END IF;
      RETURN NEW;
    END;
    $guard$
  `);
  await dbWrite.execute(sql`
    CREATE TRIGGER agent_sandbox_backups_claim_guard_test
    BEFORE UPDATE ON agent_sandbox_backups
    FOR EACH ROW EXECUTE FUNCTION lock_backup_claim_sandbox_for_test()
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
        agentSandboxes,
        agentSandboxBackups,
        agentBackupCatalogAuthorities,
      } as never,
      dbWrite as never,
    );
    await apply();
    await installBackupMutationGuardForTests();
  }, 60_000);

  beforeEach(async () => {
    if (!dbWrite) throw new Error("Real PostgreSQL harness was not initialized");
    await dbWrite.delete(agentSandboxBackups);
    await dbWrite.delete(agentBackupCatalogAuthorities);
    await dbWrite.delete(agentSandboxes);
    await dbWrite.delete(userCharacters);
    await dbWrite.delete(users);
    await dbWrite.delete(organizations);
    await seedTenant(TENANT_A, "tenant-a");
    await seedTenant(TENANT_B, "tenant-b");
  });

  test("serves another tenant while preserving one-operation-per-tenant admission", async () => {
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
      tenant: TENANT_A,
      suffix: "tenant-a-second",
      operationId: OPERATION_A2,
      dueAt: new Date("2020-01-02T00:00:00.000Z"),
    });
    const firstB = await seedBackup({
      tenant: TENANT_B,
      suffix: "tenant-b-first",
      operationId: OPERATION_B1,
      dueAt: new Date("2020-01-03T00:00:00.000Z"),
    });
    const holder = new Client({
      connectionString: isolatedDsn,
      application_name: "backup-catalogue-contention-holder",
    });
    const observer = new Client({
      connectionString: isolatedDsn,
      application_name: "backup-catalogue-contention-observer",
    });
    await Promise.all([holder.connect(), observer.connect()]);
    let holderOpen = false;
    let firstClaimPromise: ReturnType<CatalogRepository["claimDueAgentBackupOperations"]> | null =
      null;
    let secondClaimPromise: ReturnType<CatalogRepository["claimDueAgentBackupOperations"]> | null =
      null;
    try {
      await holder.query("BEGIN");
      holderOpen = true;
      const holderPid = Number(
        (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
      );
      await holder.query("SELECT id FROM agent_sandboxes WHERE id = $1 FOR UPDATE", [
        TENANT_A.agentId,
      ]);
      firstClaimPromise = catalogRepository.claimDueAgentBackupOperations({
        ownerId: OWNER_A,
        limit: 1,
        leaseMs: 60_000,
      });
      await waitForRepositoryLockWaiters(observer, holderPid, 1);

      secondClaimPromise = catalogRepository.claimDueAgentBackupOperations({
        ownerId: OWNER_B,
        limit: 1,
        leaseMs: 60_000,
      });
      const secondClaims = await resolveWithin(
        secondClaimPromise,
        5_000,
        "Tenant B did not progress while tenant A remained trigger-blocked",
      );
      expect(secondClaims).toHaveLength(1);
      expect(secondClaims[0]?.backup.id).toBe(firstB);
      await waitForRepositoryLockWaiters(observer, holderPid, 1);

      await holder.query("COMMIT");
      holderOpen = false;

      const firstClaims = await firstClaimPromise;
      expect(firstClaims).toHaveLength(1);
      expect(firstClaims[0]?.backup.id).toBe(firstA);
      const claimed = [...firstClaims, ...secondClaims];
      expect(claimed).toHaveLength(2);
      expect(new Set(claimed.map((claim) => claim.backup.id))).toEqual(new Set([firstA, firstB]));
      expect(new Set(claimed.map((claim) => claim.backup.catalog_organization_id))).toEqual(
        new Set([TENANT_A.organizationId, TENANT_B.organizationId]),
      );

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
        { id: firstB, leaseOwner: expect.any(String) },
      ]);
    } finally {
      if (holderOpen) await holder.query("ROLLBACK").catch(() => {});
      await firstClaimPromise?.catch(() => {});
      await secondClaimPromise?.catch(() => {});
      await Promise.allSettled([holder.end(), observer.end()]);
    }
  }, 60_000);

  test("starts a claim lease from post-trigger database time", async () => {
    if (!isolatedDsn || !catalogRepository) {
      throw new Error("Real PostgreSQL harness was not initialized");
    }
    await seedBackup({
      tenant: TENANT_A,
      suffix: "clock",
      operationId: OPERATION_A1,
      dueAt: new Date("2020-01-01T00:00:00.000Z"),
    });
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
    try {
      await holder.query("BEGIN");
      holderOpen = true;
      const holderPid = Number(
        (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
      );
      await holder.query("SELECT id FROM agent_sandboxes WHERE id = $1 FOR UPDATE", [
        TENANT_A.agentId,
      ]);
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
      if (!claim?.backup.catalog_updated_at || !claim.backup.catalog_lease_expires_at) {
        throw new Error("Expected a timestamped backup catalogue lease");
      }
      expect(claim.backup.catalog_updated_at.getTime()).toBeGreaterThan(
        staleTransactionThreshold.getTime(),
      );
      expect(
        claim.backup.catalog_lease_expires_at.getTime() - claim.backup.catalog_updated_at.getTime(),
      ).toBe(60_000);
    } finally {
      if (holderOpen) await holder.query("ROLLBACK").catch(() => {});
      await claimPromise?.catch(() => {});
      await Promise.allSettled([holder.end(), observer.end()]);
    }
  }, 60_000);

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
    try {
      await holder.query("BEGIN");
      holderOpen = true;
      const holderPid = Number(
        (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
      );
      await holder.query("SELECT id FROM agent_sandboxes WHERE id = $1 FOR UPDATE", [
        TENANT_A.agentId,
      ]);
      heartbeatPromise = catalogRepository.heartbeatAgentBackupOperation({
        organizationId: TENANT_A.organizationId,
        backupId,
        execution: { ownerId: claim.ownerId, generation: claim.generation },
        leaseMs: 60_000,
      });
      const [waiter] = await waitForRepositoryLockWaiters(observer, holderPid, 1);
      if (!waiter) throw new Error("Expected one blocked backup catalogue heartbeat");
      const staleTransactionThreshold = new Date(waiter.transactionStartedAt.getTime() + 200);
      await waitForDatabaseTimeAfter(observer, staleTransactionThreshold);
      await holder.query("COMMIT");
      holderOpen = false;

      const heartbeat = await heartbeatPromise;
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
    } finally {
      if (holderOpen) await holder.query("ROLLBACK").catch(() => {});
      await heartbeatPromise?.catch(() => {});
      await Promise.allSettled([holder.end(), observer.end()]);
    }
  }, 60_000);

  test("does not resurrect a heartbeat lease that expires during trigger contention", async () => {
    if (!isolatedDsn || !dbWrite || !catalogRepository) {
      throw new Error("Real PostgreSQL harness was not initialized");
    }
    const backupId = await seedBackup({
      tenant: TENANT_A,
      suffix: "heartbeat-expiry",
      operationId: OPERATION_A1,
      dueAt: new Date("2020-01-01T00:00:00.000Z"),
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
    try {
      await holder.query("BEGIN");
      holderOpen = true;
      const holderPid = Number(
        (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
      );
      await holder.query("SELECT id FROM agent_sandboxes WHERE id = $1 FOR UPDATE", [
        TENANT_A.agentId,
      ]);
      heartbeatPromise = catalogRepository.heartbeatAgentBackupOperation({
        organizationId: TENANT_A.organizationId,
        backupId,
        execution: { ownerId: claim.ownerId, generation: claim.generation },
        leaseMs: 60_000,
      });
      const [waiter] = await waitForRepositoryLockWaiters(observer, holderPid, 1);
      if (!waiter) throw new Error("Expected one blocked backup catalogue heartbeat");
      await waitForDatabaseTimeAfter(observer, claim.backup.catalog_lease_expires_at);
      await holder.query("COMMIT");
      holderOpen = false;

      await expect(heartbeatPromise).rejects.toThrow(
        "Backup operation lease expired while waiting for post-lock authority",
      );
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
        expiresAt: claim.backup.catalog_lease_expires_at,
      });
    } finally {
      if (holderOpen) await holder.query("ROLLBACK").catch(() => {});
      await heartbeatPromise?.catch(() => {});
      await Promise.allSettled([holder.end(), observer.end()]);
    }
  }, 60_000);
});
