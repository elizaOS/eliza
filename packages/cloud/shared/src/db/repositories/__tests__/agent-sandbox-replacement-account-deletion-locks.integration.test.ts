/**
 * Proves the replacement-attempt start/account-deletion lock order with
 * independent real PostgreSQL sessions. PGlite cannot expose cross-session
 * blockers or PostgreSQL's row-lock deadlock detector.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";

const SKIP_REASON =
  "[replacement attempt account deletion locks] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const REQUIRE_REAL_POSTGRES_REPLACEMENT_LOCK_TESTS =
  process.env.REQUIRE_REAL_POSTGRES_REPLACEMENT_LOCK_TESTS === "1";
const START_APPLICATION_NAME = "replacement-attempt-start-lock-test";
const DELETE_APPLICATION_NAME = "replacement-attempt-delete-lock-test";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  RAILWAY_SERVICE_NAME: process.env.RAILWAY_SERVICE_NAME,
};

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
let databaseName: string | null = null;
let isolatedDsn: string | null = null;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | undefined;
let dbWrite: typeof import("../../client").dbWrite | undefined;
let startAgentSandboxReplacementAttemptInTransaction:
  | typeof import("../agent-sandbox-replacement-attempts").startAgentSandboxReplacementAttemptInTransaction
  | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function createIsolatedDatabase(baseDsn: string): Promise<string> {
  databaseName = `eliza_replacement_locks_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function waitForBlockedSession(
  observer: Client,
  applicationName: string,
  blockerPid: number,
): Promise<number> {
  const deadline = Date.now() + 7_500;
  while (Date.now() < deadline) {
    const result = await observer.query<{
      pid: number;
      blockers: number[];
      wait_event_type: string | null;
    }>(
      `
      SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = $1
    `,
      [applicationName],
    );
    const blocked = result.rows.find(
      (row) => row.wait_event_type === "Lock" && row.blockers.includes(blockerPid),
    );
    if (blocked) {
      return blocked.pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${applicationName} behind PID ${blockerPid}`);
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

if (!postgres) {
  if (REQUIRE_REAL_POSTGRES_REPLACEMENT_LOCK_TESTS) {
    throw new Error(
      "Real PostgreSQL is required for replacement-attempt lock tests, but the harness is unavailable",
    );
  }
  console.warn(SKIP_REASON);
} else {
  isolatedDsn = await createIsolatedDatabase(postgres.dsn);
  process.env.DATABASE_URL = isolatedDsn;
  process.env.TEST_DATABASE_URL = isolatedDsn;
  process.env.RAILWAY_SERVICE_NAME = START_APPLICATION_NAME;
  const [clientModule, repositoryModule] = await Promise.all([
    import("../../client"),
    import("../agent-sandbox-replacement-attempts"),
  ]);
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  dbWrite = clientModule.dbWrite;
  startAgentSandboxReplacementAttemptInTransaction =
    repositoryModule.startAgentSandboxReplacementAttemptInTransaction;
}

beforeAll(async () => {
  if (!isolatedDsn) return;
  const setup = new Client({ connectionString: isolatedDsn });
  await setup.connect();
  try {
    await setup.query(`
      CREATE TABLE organizations (
        id uuid PRIMARY KEY
      );

      CREATE TABLE agent_sandboxes (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        lifecycle_revision numeric(20, 0) NOT NULL,
        activation_generation uuid,
        lifecycle_job_id uuid,
        lifecycle_execution_generation uuid
      );

      CREATE TABLE agent_backup_restore_leases (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        agent_id uuid NOT NULL,
        backup_id uuid NOT NULL,
        operation_id uuid NOT NULL,
        activation_generation uuid NOT NULL,
        lifecycle_revision numeric(20, 0) NOT NULL,
        expected_manifest_sha256 text NOT NULL,
        copy_role text NOT NULL,
        restore_attempt_id uuid NOT NULL,
        owner_id text NOT NULL,
        generation uuid NOT NULL,
        catalog_epoch bigint NOT NULL,
        expires_at timestamptz NOT NULL,
        released_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE agent_sandbox_replacement_attempts (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        agent_id uuid NOT NULL,
        operation_kind text NOT NULL,
        lifecycle_revision numeric(20, 0) NOT NULL,
        activation_generation uuid NOT NULL,
        lifecycle_job_id uuid,
        lifecycle_execution_generation uuid,
        restore_lease_id uuid,
        restore_backup_id uuid,
        restore_attempt_id uuid,
        restore_lease_owner_id text,
        restore_lease_generation uuid,
        restore_catalog_epoch bigint,
        restore_copy_role text,
        restore_operation_id uuid,
        restore_source_activation_generation uuid,
        restore_source_lifecycle_revision numeric(20, 0),
        restore_manifest_sha256 text,
        restore_lease_expires_at timestamptz,
        state text NOT NULL DEFAULT 'in_flight_unresolved',
        locator_sandbox_id text,
        locator_node_id text,
        locator_container_name text,
        locator_node_record_id uuid,
        locator_node_incarnation uuid,
        locator_node_history_id uuid,
        locator_node_hostname text,
        locator_node_ssh_port integer,
        locator_node_ssh_user text,
        locator_node_host_key_fingerprint text,
        locator_secret_cleanup_version integer,
        locator_allocation_counted boolean,
        locator_vpn_node_name text,
        locator_vpn_registration_started_at timestamptz,
        locator_previous_vpn_node_id text,
        locator_recorded_at timestamptz,
        locator_container_id text,
        locator_container_recorded_at timestamptz,
        locator_vpn_node_id text,
        locator_vpn_recorded_at timestamptz,
        provider_started_at timestamptz,
        provider_succeeded_at timestamptz,
        provider_receipt_digest text,
        lifecycle_committed_at timestamptz,
        lifecycle_receipt_digest text,
        cleanup_proven_at timestamptz,
        cleanup_receipt_digest text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX agent_sandbox_replacement_attempts_active_agent_uidx
        ON agent_sandbox_replacement_attempts (organization_id, agent_id)
        WHERE state IN ('in_flight_unresolved', 'provider_succeeded');

      CREATE FUNCTION guard_test_replacement_attempt_delete() RETURNS trigger
      LANGUAGE plpgsql AS $guard$
      BEGIN
        IF pg_trigger_depth() = 2
          AND OLD.state IN ('lifecycle_committed', 'cleanup_proven')
          AND NOT EXISTS (
            SELECT 1 FROM organizations WHERE id = OLD.organization_id
          ) THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'replacement attempts cannot be deleted before terminal owner erasure';
      END;
      $guard$;

      CREATE TRIGGER agent_sandbox_replacement_attempts_guard_delete
        BEFORE DELETE ON agent_sandbox_replacement_attempts
        FOR EACH ROW EXECUTE FUNCTION guard_test_replacement_attempt_delete();
    `);
  } finally {
    await setup.end();
  }
}, 30_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  if (postgres && databaseName) {
    const admin = new Client({ connectionString: postgres.dsn });
    await admin.connect();
    try {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " +
          "WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } finally {
      await admin.end();
    }
  }
  await postgres?.stop();
  postgres = null;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  }
}, 30_000);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("replacement attempt PostgreSQL lock and lease barriers", () => {
  test("orders organization before sandbox and preserves an active attempt", async () => {
    if (!isolatedDsn || !dbWrite || !startAgentSandboxReplacementAttemptInTransaction) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const organizationId = randomUUID();
    const agentId = randomUUID();
    const attemptId = randomUUID();
    const activationGeneration = randomUUID();
    const lifecycleJobId = randomUUID();
    const lifecycleExecutionGeneration = randomUUID();
    const seed = new Client({ connectionString: isolatedDsn });
    const holder = new Client({
      connectionString: isolatedDsn,
      application_name: "replacement-attempt-sandbox-holder-test",
    });
    const deletion = new Client({
      connectionString: isolatedDsn,
      application_name: DELETE_APPLICATION_NAME,
    });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([seed.connect(), holder.connect(), deletion.connect(), observer.connect()]);

    let holderOpen = false;
    let startWork: Promise<unknown> | null = null;
    let deleteWork: Promise<{
      deleted: boolean;
      code: string | null;
      message: string | null;
    }> | null = null;
    try {
      await seed.query("INSERT INTO organizations(id) VALUES ($1)", [organizationId]);
      await seed.query(
        `INSERT INTO agent_sandboxes
          (id, organization_id, lifecycle_revision, activation_generation,
           lifecycle_job_id, lifecycle_execution_generation)
         VALUES ($1, $2, 7, $3, $4, $5)`,
        [
          agentId,
          organizationId,
          activationGeneration,
          lifecycleJobId,
          lifecycleExecutionGeneration,
        ],
      );

      await holder.query("BEGIN");
      holderOpen = true;
      await holder.query("SET LOCAL statement_timeout = '15s'");
      const holderPidResult = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const holderPid = holderPidResult.rows[0]?.pid;
      if (!holderPid) throw new Error("sandbox holder PID is unavailable");
      await holder.query("SELECT id FROM agent_sandboxes WHERE id = $1 FOR UPDATE", [agentId]);

      startWork = dbWrite.transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL statement_timeout = '15s'"));
        return await startAgentSandboxReplacementAttemptInTransaction!(tx, {
          attemptId,
          organizationId,
          agentId,
          operationKind: "upgrade",
          lifecycleRevision: "7",
          activationGeneration,
          lifecycleJobId,
          lifecycleExecutionGeneration,
          restoreAuthority: null,
        });
      });
      const startPid = await waitForBlockedSession(observer, START_APPLICATION_NAME, holderPid);

      deleteWork = (async () => {
        await deletion.query("BEGIN");
        try {
          await deletion.query("SET LOCAL statement_timeout = '15s'");
          await deletion.query("SET LOCAL deadlock_timeout = '50ms'");
          await deletion.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
          await deletion.query("COMMIT");
          return { deleted: true, code: null, message: null };
        } catch (error) {
          await deletion.query("ROLLBACK").catch(() => undefined);
          const postgresError = error as { code?: string; message?: string };
          return {
            deleted: false,
            code: postgresError.code ?? null,
            message: postgresError.message ?? String(error),
          };
        }
      })();
      const deletePid = await waitForBlockedSession(observer, DELETE_APPLICATION_NAME, startPid);
      expect(startPid).not.toBe(deletePid);

      await holder.query("COMMIT");
      holderOpen = false;

      await expect(startWork).resolves.toMatchObject({
        replayed: false,
        attempt: { id: attemptId, state: "in_flight_unresolved" },
      });
      const deleteResult = await deleteWork;
      expect(deleteResult).toMatchObject({
        deleted: false,
        code: "P0001",
      });
      expect(deleteResult.code).not.toBe("40P01");
      expect(deleteResult.code).not.toBe("55P03");
      expect(deleteResult.message).toContain(
        "replacement attempts cannot be deleted before terminal owner erasure",
      );

      const state = await observer.query<{
        organizations: string;
        sandboxes: string;
        attempts: string;
        attempt_state: string | null;
      }>(
        `
        SELECT
          (SELECT count(*)::text FROM organizations WHERE id = $1) AS organizations,
          (SELECT count(*)::text FROM agent_sandboxes WHERE id = $2) AS sandboxes,
          (SELECT count(*)::text FROM agent_sandbox_replacement_attempts
            WHERE id = $3) AS attempts,
          (SELECT state FROM agent_sandbox_replacement_attempts
            WHERE id = $3) AS attempt_state
      `,
        [organizationId, agentId, attemptId],
      );
      expect(state.rows[0]).toEqual({
        organizations: "1",
        sandboxes: "1",
        attempts: "1",
        attempt_state: "in_flight_unresolved",
      });
    } finally {
      if (holderOpen) await holder.query("ROLLBACK").catch(() => undefined);
      await Promise.allSettled(
        [startWork, deleteWork].filter((work): work is Promise<unknown> => work !== null),
      );
      await deletion.query("ROLLBACK").catch(() => undefined);
      await Promise.all([seed.end(), holder.end(), deletion.end(), observer.end()]);
    }
  }, 20_000);

  test("rejects restore authority that expires while waiting for the sandbox lock", async () => {
    if (!isolatedDsn || !dbWrite || !startAgentSandboxReplacementAttemptInTransaction) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const organizationId = randomUUID();
    const agentId = randomUUID();
    const attemptId = randomUUID();
    const restoreAttemptId = randomUUID();
    const activationGeneration = restoreAttemptId;
    const lifecycleJobId = randomUUID();
    const lifecycleExecutionGeneration = randomUUID();
    const leaseId = randomUUID();
    const backupId = randomUUID();
    const fencingToken = randomUUID();
    const operationId = randomUUID();
    const sourceActivationGeneration = randomUUID();
    const ownerId = "replacement-expiry-lock-test";
    const expectedManifestSha256 = "9".repeat(64);
    const seed = new Client({ connectionString: isolatedDsn });
    const holder = new Client({
      connectionString: isolatedDsn,
      application_name: "replacement-attempt-expiry-holder-test",
    });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([seed.connect(), holder.connect(), observer.connect()]);

    let holderOpen = false;
    let startWork: Promise<unknown> | null = null;
    try {
      const expiry = await seed.query<{ expires_at: Date }>(
        "SELECT date_trunc('milliseconds', clock_timestamp()) + interval '5 seconds' AS expires_at",
      );
      const expiresAt = expiry.rows[0]?.expires_at;
      if (!expiresAt) throw new Error("database lease expiry is unavailable");

      await seed.query("INSERT INTO organizations(id) VALUES ($1)", [organizationId]);
      await seed.query(
        `INSERT INTO agent_sandboxes
          (id, organization_id, lifecycle_revision, activation_generation,
           lifecycle_job_id, lifecycle_execution_generation)
         VALUES ($1, $2, 7, $3, $4, $5)`,
        [
          agentId,
          organizationId,
          activationGeneration,
          lifecycleJobId,
          lifecycleExecutionGeneration,
        ],
      );
      await seed.query(
        `INSERT INTO agent_backup_restore_leases
          (id, organization_id, agent_id, backup_id, operation_id,
           activation_generation, lifecycle_revision, expected_manifest_sha256,
           copy_role, restore_attempt_id, owner_id, generation, catalog_epoch,
           expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 6, $7, 'primary', $8, $9, $10, 3, $11)`,
        [
          leaseId,
          organizationId,
          agentId,
          backupId,
          operationId,
          sourceActivationGeneration,
          expectedManifestSha256,
          restoreAttemptId,
          ownerId,
          fencingToken,
          expiresAt,
        ],
      );

      await holder.query("BEGIN");
      holderOpen = true;
      await holder.query("SET LOCAL statement_timeout = '15s'");
      const holderPidResult = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const holderPid = holderPidResult.rows[0]?.pid;
      if (!holderPid) throw new Error("sandbox holder PID is unavailable");
      await holder.query("SELECT id FROM agent_sandboxes WHERE id = $1 FOR UPDATE", [agentId]);

      startWork = dbWrite.transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL statement_timeout = '15s'"));
        return await startAgentSandboxReplacementAttemptInTransaction!(tx, {
          attemptId,
          organizationId,
          agentId,
          operationKind: "provision",
          lifecycleRevision: "7",
          activationGeneration,
          lifecycleJobId,
          lifecycleExecutionGeneration,
          restoreAuthority: {
            leaseId,
            backupId,
            restoreAttemptId,
            ownerId,
            fencingToken,
            catalogEpoch: "3",
            copyRole: "primary",
            operationId,
            sourceActivationGeneration,
            sourceLifecycleRevision: "6",
            expectedManifestSha256,
            expiresAt,
          },
        });
      });
      await waitForBlockedSession(observer, START_APPLICATION_NAME, holderPid);
      await waitForDatabaseTimeAfter(observer, expiresAt);

      await holder.query("COMMIT");
      holderOpen = false;

      const startResult = await startWork.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      expect(startResult).toMatchObject({
        status: "rejected",
        reason: {
          code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
          message: "Restore lease is expired or released",
        },
      });

      const state = await observer.query<{ attempts: string; lease_expired: boolean }>(
        `SELECT
          (SELECT count(*)::text FROM agent_sandbox_replacement_attempts
            WHERE id = $1) AS attempts,
          (SELECT expires_at < clock_timestamp() FROM agent_backup_restore_leases
            WHERE id = $2) AS lease_expired`,
        [attemptId, leaseId],
      );
      expect(state.rows[0]).toEqual({ attempts: "0", lease_expired: true });
    } finally {
      if (holderOpen) await holder.query("ROLLBACK").catch(() => undefined);
      await Promise.allSettled(
        [startWork].filter((work): work is Promise<unknown> => work !== null),
      );
      await Promise.all([seed.end(), holder.end(), observer.end()]);
    }
  }, 20_000);
});
