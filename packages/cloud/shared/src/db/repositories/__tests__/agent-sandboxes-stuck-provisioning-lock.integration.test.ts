/**
 * Proves cloud lifecycle and sandbox-replacement authorities serialize on
 * real PostgreSQL, including reconciliation, execution quiescence, and the
 * sandbox-to-attempt-to-node lock order used by replacement attempts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pushSchema } from "drizzle-kit/api";
import { and, eq, sql } from "drizzle-orm";
import { Client } from "pg";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import type { DbTransaction } from "../../client";
import { agentBackupRestoreLeases } from "../../schemas/agent-backup-catalog";
import { agentNodeIncarnationHistories } from "../../schemas/agent-node-incarnation-histories";
import { agentSandboxReplacementAttempts } from "../../schemas/agent-sandbox-replacement-attempts";
import {
  agentBackupCatalogAuthorities,
  agentSandboxBackups,
  agentSandboxes,
} from "../../schemas/agent-sandboxes";
import { apiKeys } from "../../schemas/api-keys";
import { dockerNodes } from "../../schemas/docker-nodes";
import { generations } from "../../schemas/generations";
import { jobExecutionLeases } from "../../schemas/job-execution-leases";
import { jobs } from "../../schemas/jobs";
import { organizations } from "../../schemas/organizations";
import { usageRecords } from "../../schemas/usage-records";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import type {
  AgentSandboxReplacementAttemptReference,
  AgentSandboxReplacementLocatorInput,
  CommitAgentSandboxReplacementLifecycleAdoptionInput,
  StartAgentSandboxReplacementAttemptInput,
} from "../agent-sandbox-replacement-attempts";

const SKIP_REASON =
  "[cloud lifecycle locks] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  SKIP_AGENT_SANDBOX_ENSURE: process.env.SKIP_AGENT_SANDBOX_ENSURE,
  MOCK_REDIS: process.env.MOCK_REDIS,
};
const SWEEP_CUTOFF = new Date("2026-07-28T12:20:00.000Z");
const STALE_UPDATED_AT = new Date(SWEEP_CUTOFF.getTime() - 1);
const EXECUTION_OWNER_ID = "00000000-0000-4000-8000-00000000a712";

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
let isolatedDatabaseName: string | null = null;
let isolatedDsn: string | null = null;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | undefined;
let dbWrite: typeof import("../../client").dbWrite | undefined;
let agentSandboxesRepository:
  | typeof import("../agent-sandboxes").agentSandboxesRepository
  | undefined;
let provisioningJobService:
  | typeof import("../../../lib/services/provisioning-jobs").provisioningJobService
  | undefined;
let ProvisioningJobService:
  | typeof import("../../../lib/services/provisioning-jobs").ProvisioningJobService
  | undefined;
let jobsRepository: typeof import("../jobs").jobsRepository | undefined;
let replacementAttemptsRepository:
  | typeof import("../agent-sandbox-replacement-attempts")
  | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function createIsolatedDatabase(baseDsn: string): Promise<{
  databaseName: string;
  dsn: string;
}> {
  const databaseName = `eliza_sweep_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseDsn);
  url.pathname = `/${databaseName}`;
  return { databaseName, dsn: url.toString() };
}

async function dropIsolatedDatabase(baseDsn: string, databaseName: string): Promise<void> {
  const admin = new Client({ connectionString: baseDsn });
  await admin.connect();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end();
  }
}

async function waitForAdvisoryWaiters(observer: Client, minimum: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_locks " +
        "WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) " +
        "AND NOT granted",
    );
    if (Number(result.rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} advisory-lock waiter(s)`);
}

interface BlockingRelation {
  waiterApplicationName: string;
  blockerApplicationName: string;
}

interface ActivityLockRow {
  pid: number;
  application_name: string;
  wait_event_type: string | null;
  wait_event: string | null;
  blocking_pids: number[];
}

async function waitForApplicationBlockingRelations(
  observer: Client,
  relations: readonly BlockingRelation[],
): Promise<void> {
  const applicationNames = [
    ...new Set(
      relations.flatMap(({ waiterApplicationName, blockerApplicationName }) => [
        waiterApplicationName,
        blockerApplicationName,
      ]),
    ),
  ];
  const deadline = Date.now() + 8_000;
  let lastRows: ActivityLockRow[] = [];
  while (Date.now() < deadline) {
    const result = await observer.query<ActivityLockRow>(
      `SELECT pid, application_name, wait_event_type, wait_event,
              pg_blocking_pids(pid) AS blocking_pids
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name = ANY($1::text[])`,
      [applicationNames],
    );
    lastRows = result.rows;
    const byApplicationName = new Map(lastRows.map((row) => [row.application_name, row]));
    if (
      relations.every(({ waiterApplicationName, blockerApplicationName }) => {
        const waiter = byApplicationName.get(waiterApplicationName);
        const blocker = byApplicationName.get(blockerApplicationName);
        return (
          waiter?.wait_event_type === "Lock" &&
          blocker !== undefined &&
          waiter.blocking_pids.includes(blocker.pid)
        );
      })
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out observing PostgreSQL blocking relations: ${JSON.stringify({ relations, lastRows })}`,
  );
}

interface DirectTransactionBlockRow {
  waiting_transaction_id: string;
  blocker_transaction_id: string;
}

async function waitForDirectTransactionIdBlock(
  observer: Client,
  waiterApplicationName: string,
  blockerApplicationName: string,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  let lastRows: DirectTransactionBlockRow[] = [];
  while (Date.now() < deadline) {
    const result = await observer.query<DirectTransactionBlockRow>(
      `SELECT waiting.transactionid::text AS waiting_transaction_id,
              blocker.backend_xid::text AS blocker_transaction_id
       FROM pg_stat_activity AS waiter
       JOIN pg_locks AS waiting
         ON waiting.pid = waiter.pid
        AND NOT waiting.granted
       JOIN pg_stat_activity AS blocker
         ON blocker.datid = waiter.datid
        AND blocker.application_name = $2
       WHERE waiter.datname = current_database()
         AND waiter.application_name = $1
         AND waiter.wait_event_type = 'Lock'
         AND waiter.wait_event = 'transactionid'
         AND waiting.locktype = 'transactionid'
         AND waiting.mode = 'ShareLock'
         AND waiting.transactionid = blocker.backend_xid`,
      [waiterApplicationName, blockerApplicationName],
    );
    lastRows = result.rows;
    if (lastRows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out observing a direct PostgreSQL transaction-ID block: ${JSON.stringify({ waiterApplicationName, blockerApplicationName, lastRows })}`,
  );
}

async function grantedRelationWriteLocks(
  observer: Client,
  applicationName: string,
  relationName: string,
): Promise<Array<{ relation_name: string; mode: string }>> {
  const result = await observer.query<{ relation_name: string; mode: string }>(
    `SELECT relation_class.relname AS relation_name, relation_lock.mode
     FROM pg_stat_activity AS activity
     JOIN pg_locks AS relation_lock
       ON relation_lock.pid = activity.pid
      AND relation_lock.locktype = 'relation'
      AND relation_lock.granted
     JOIN pg_class AS relation_class ON relation_class.oid = relation_lock.relation
     WHERE activity.datname = current_database()
       AND activity.application_name = $1
       AND relation_class.oid = to_regclass($2)
       AND relation_lock.mode IN (
         'RowExclusiveLock',
         'ShareRowExclusiveLock',
         'ExclusiveLock',
         'AccessExclusiveLock'
       )`,
    [applicationName, relationName],
  );
  return result.rows;
}

interface ApplicationTargetLock {
  locktype: string;
  mode: string;
  granted: boolean;
}

async function applicationLocksTargetingRelation(
  observer: Client,
  applicationName: string,
  relationName: string,
): Promise<ApplicationTargetLock[]> {
  const result = await observer.query<ApplicationTargetLock>(
    `SELECT target_lock.locktype, target_lock.mode, target_lock.granted
     FROM pg_stat_activity AS activity
     JOIN pg_locks AS target_lock ON target_lock.pid = activity.pid
     WHERE activity.datname = current_database()
       AND activity.application_name = $1
       AND target_lock.database = activity.datid
       AND target_lock.relation = to_regclass($2)
     ORDER BY target_lock.locktype, target_lock.mode, target_lock.granted`,
    [applicationName, relationName],
  );
  return result.rows;
}

async function connectNamedClient(dsn: string, applicationName: string): Promise<Client> {
  const client = new Client({ connectionString: dsn });
  try {
    await client.connect();
    await client.query("SELECT set_config('application_name', $1, false)", [applicationName]);
    return client;
  } catch (error) {
    // error-policy:J6 Failed test setup still releases any opened client.
    await client.end().catch(() => undefined);
    throw error;
  }
}

async function connectNamedClients<const Names extends readonly string[]>(
  dsn: string,
  applicationNames: Names,
): Promise<{ [Index in keyof Names]: Client }> {
  const clients: Client[] = [];
  try {
    for (const applicationName of applicationNames) {
      clients.push(await connectNamedClient(dsn, applicationName));
    }
    return clients as { [Index in keyof Names]: Client };
  } catch (error) {
    // error-policy:J6 A later setup failure still closes every earlier client.
    await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
    throw error;
  }
}

async function rollbackQuietly(client: Client): Promise<void> {
  // error-policy:J6 Teardown tolerates an already-ended or aborted transaction.
  await client.query("ROLLBACK").catch(() => undefined);
}

async function endQuietly(client: Client): Promise<void> {
  // error-policy:J6 Teardown continues after an already-closed test connection.
  await client.end().catch(() => undefined);
}

async function inNamedTransaction<T>(
  applicationName: string,
  operation: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (!dbWrite) throw new Error("real PostgreSQL harness was not initialized");
  return await dbWrite.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('application_name', ${applicationName}, true)`);
    return await operation(tx);
  });
}

interface ReplacementAttemptFixture {
  organizationId: string;
  agentId: string;
  nodeRecordId: string;
  startInput: StartAgentSandboxReplacementAttemptInput;
  locator: AgentSandboxReplacementLocatorInput;
}

async function createReplacementAttemptFixture(): Promise<ReplacementAttemptFixture> {
  if (!dbWrite) throw new Error("real PostgreSQL harness was not initialized");
  const organizationId = randomUUID();
  const userId = randomUUID();
  const agentId = randomUUID();
  const nodeRecordId = randomUUID();
  const attemptId = randomUUID();
  const activationGeneration = randomUUID();
  const lifecycleJobId = randomUUID();
  const lifecycleExecutionGeneration = randomUUID();
  const suffix = randomUUID();
  const nodeId = `replacement-node-${suffix}`;
  const nodeHostname = `replacement-${suffix}.internal`;
  const nodeHostKeyFingerprint = `SHA256:replacement-${suffix}`;
  const containerName = `agent-${agentId}`;

  await dbWrite.insert(organizations).values({
    id: organizationId,
    name: "Replacement lock proof",
    slug: `replacement-lock-${suffix}`,
  });
  await dbWrite.insert(users).values({
    id: userId,
    organization_id: organizationId,
    steward_user_id: `replacement-lock-${suffix}`,
  });
  await dbWrite.insert(agentSandboxes).values({
    id: agentId,
    organization_id: organizationId,
    user_id: userId,
    status: "provisioning",
    lifecycle_job_id: lifecycleJobId,
    lifecycle_execution_generation: lifecycleExecutionGeneration,
    activation_generation: activationGeneration,
    activation_lifecycle_revision: 7n,
    activation_purpose: "provision",
    activation_phase: "container_pending",
    activation_token_hash: "1".repeat(64),
    activation_token_ciphertext: "test-only-replacement-activation-token",
    execution_tier: "dedicated-always",
    sandbox_id: `old-sandbox-${suffix}`,
    node_id: `old-node-${suffix}`,
    container_name: `old-container-${suffix}`,
    lifecycle_revision: 7,
  });
  await dbWrite.insert(dockerNodes).values({
    id: nodeRecordId,
    node_id: nodeId,
    hostname: nodeHostname,
    ssh_port: 22,
    capacity: 8,
    allocated_count: 1,
    status: "healthy",
    ssh_user: "root",
    host_key_fingerprint: nodeHostKeyFingerprint,
  });

  return {
    organizationId,
    agentId,
    nodeRecordId,
    startInput: {
      attemptId,
      organizationId,
      agentId,
      operationKind: "upgrade",
      lifecycleRevision: "7",
      activationGeneration,
      lifecycleJobId,
      lifecycleExecutionGeneration,
      restoreAuthority: null,
    },
    locator: {
      replacementAttemptId: attemptId,
      sandboxId: containerName,
      nodeId,
      containerName,
      nodeRecordId,
      nodeHostname,
      nodeSshPort: 22,
      nodeSshUser: "root",
      nodeHostKeyFingerprint,
      replacementSecretCleanupVersion: 1,
      allocationCounted: true,
      vpnNodeName: containerName,
      vpnRegistrationStartedAt: "2026-08-24T12:00:00.000Z",
      previousVpnNodeId: "41",
      containerId: "a".repeat(64),
      vpnNodeId: "42",
    },
  };
}

function replacementReference(
  input: StartAgentSandboxReplacementAttemptInput,
): AgentSandboxReplacementAttemptReference {
  return {
    attemptId: input.attemptId,
    organizationId: input.organizationId,
    agentId: input.agentId,
  };
}

async function seedProviderSucceededReplacementAttempt(
  fixture: ReplacementAttemptFixture,
): Promise<void> {
  if (!dbWrite || !replacementAttemptsRepository) {
    throw new Error("real PostgreSQL harness was not initialized");
  }
  const reference = replacementReference(fixture.startInput);
  await dbWrite.transaction((tx) =>
    replacementAttemptsRepository!.startAgentSandboxReplacementAttemptInTransaction(
      tx,
      fixture.startInput,
    ),
  );
  await dbWrite.transaction((tx) =>
    replacementAttemptsRepository!.recordAgentSandboxReplacementIntentInTransaction(tx, reference, {
      ...fixture.locator,
      containerId: null,
      vpnNodeId: null,
    }),
  );
  await replacementAttemptsRepository.recordAgentSandboxReplacementCreated(reference, {
    ...fixture.locator,
    vpnNodeId: null,
  });
  await replacementAttemptsRepository.recordAgentSandboxReplacementVpnRegistered(
    reference,
    fixture.locator,
  );
  await replacementAttemptsRepository.recordAgentSandboxReplacementProviderSucceeded(
    reference,
    fixture.locator,
    "b".repeat(64),
  );
}

if (!postgres) {
  console.warn(SKIP_REASON);
} else {
  const isolated = await createIsolatedDatabase(postgres.dsn);
  isolatedDatabaseName = isolated.databaseName;
  isolatedDsn = isolated.dsn;
  process.env.DATABASE_URL = isolated.dsn;
  process.env.TEST_DATABASE_URL = isolated.dsn;
  process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
  process.env.MOCK_REDIS = "1";

  const [clientModule, repositoryModule, jobModule, jobsModule, replacementAttemptsModule] =
    await Promise.all([
      import("../../client"),
      import("../agent-sandboxes"),
      import("../../../lib/services/provisioning-jobs"),
      import("../jobs"),
      import("../agent-sandbox-replacement-attempts"),
    ]);
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  dbWrite = clientModule.dbWrite;
  agentSandboxesRepository = repositoryModule.agentSandboxesRepository;
  provisioningJobService = jobModule.provisioningJobService;
  ProvisioningJobService = jobModule.ProvisioningJobService;
  jobsRepository = jobsModule.jobsRepository;
  replacementAttemptsRepository = replacementAttemptsModule;
}

// 60s like the schema-push beforeAll: teardown drains live pool connections,
// terminates straggler backends, drops the isolated database, and stops the
// server — the final lease/quiescence test leaves real in-flight work behind,
// and on an I/O-loaded CI host that sequence routinely blows the 5s default
// hook budget, failing the whole suite as "(unnamed)" after every test passed.
afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  if (postgres && isolatedDatabaseName) {
    await dropIsolatedDatabase(postgres.dsn, isolatedDatabaseName);
  }
  await postgres?.stop();
  postgres = null;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  }
}, 60_000);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("cloud lifecycle lock proofs", () => {
  beforeAll(async () => {
    if (!dbWrite) throw new Error("isolated database was not initialized");
    const schema = {
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      agentNodeIncarnationHistories,
      dockerNodes,
      agentSandboxBackups,
      agentBackupCatalogAuthorities,
      agentBackupRestoreLeases,
      agentSandboxReplacementAttempts,
      apiKeys,
      usageRecords,
      generations,
      jobs,
      jobExecutionLeases,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
    if (!isolatedDsn) throw new Error("isolated database was not initialized");
    const migrationClient = new Client({ connectionString: isolatedDsn });
    await migrationClient.connect();
    try {
      await migrationClient.query(
        await readFile(
          new URL("../../migrations/0183_lifecycle_execution_fence.sql", import.meta.url),
          "utf8",
        ),
      );
    } finally {
      await migrationClient.end();
    }
  }, 60_000);

  test("an enqueue holding the agent lock commits before the sweep rechecks ownership", async () => {
    if (!isolatedDsn || !dbWrite || !agentSandboxesRepository || !provisioningJobService) {
      throw new Error("real PostgreSQL harness was not initialized");
    }

    const suffix = randomUUID();
    const [organization] = await dbWrite
      .insert(organizations)
      .values({ name: "Sweep Lock Org", slug: `sweep-lock-${suffix}` })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: `sweep-lock-${suffix}`,
        organization_id: organization.id,
      })
      .returning();
    const [sandbox] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: organization.id,
        user_id: user.id,
        agent_name: `sweep-lock-${suffix}`,
        status: "provisioning",
        execution_tier: "dedicated-always",
        sandbox_id: `sandbox-${suffix}`,
        node_id: `node-${suffix}`,
        container_name: `container-${suffix}`,
        updated_at: STALE_UPDATED_AT,
      })
      .returning();

    const gateKeyOne = `sweep-gate-${suffix}`;
    const gateKeyTwo = `job-insert-${suffix}`;
    const control = new Client({ connectionString: isolatedDsn });
    const setup = new Client({ connectionString: isolatedDsn });
    await Promise.all([control.connect(), setup.connect()]);
    try {
      await setup.query(`
        CREATE FUNCTION block_test_job_insert() RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext(TG_ARGV[0]), hashtext(TG_ARGV[1]));
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await setup.query(
        `CREATE TRIGGER block_test_job_insert_trigger
         BEFORE INSERT ON jobs
         FOR EACH ROW
         EXECUTE FUNCTION block_test_job_insert('${gateKeyOne}', '${gateKeyTwo}')`,
      );

      await control.query("BEGIN");
      await control.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        gateKeyOne,
        gateKeyTwo,
      ]);

      const enqueue = provisioningJobService.enqueueAgentProvisionOnce({
        agentId: sandbox.id,
        organizationId: organization.id,
        userId: user.id,
        agentName: sandbox.agent_name ?? sandbox.id,
        expectedLifecycleRevision: sandbox.lifecycle_revision,
      });
      await waitForAdvisoryWaiters(control, 1);

      const sweep =
        agentSandboxesRepository.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);
      const firstSweep = await sweep;
      expect(firstSweep.deferred).toBe(1);
      expect(firstSweep.updated.map((row) => row.agentId)).not.toContain(sandbox.id);
      await control.query("COMMIT");

      const enqueueResult = await enqueue;
      expect(enqueueResult.created).toBe(true);

      const [persistedSandbox] = await dbWrite
        .select({ status: agentSandboxes.status })
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, sandbox.id));
      const activeJobs = await dbWrite
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.organization_id, organization.id),
            eq(jobs.agent_id, sandbox.id),
            eq(jobs.status, "pending"),
          ),
        );
      expect(persistedSandbox?.status).toBe("provisioning");
      expect(activeJobs).toHaveLength(1);
    } finally {
      await control.query("ROLLBACK");
      await Promise.allSettled([control.end(), setup.end()]);
    }
  }, 30_000);

  test("an enqueue holding the agent lock commits before exact restore admission rechecks jobs", async () => {
    if (!isolatedDsn || !dbWrite || !agentSandboxesRepository || !provisioningJobService) {
      throw new Error("real PostgreSQL harness was not initialized");
    }

    const suffix = randomUUID();
    const identifierSuffix = suffix.replaceAll("-", "").slice(0, 12);
    const [organization] = await dbWrite
      .insert(organizations)
      .values({ name: "Restore Admission Lock Org", slug: `restore-admission-lock-${suffix}` })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: `restore-admission-lock-${suffix}`,
        organization_id: organization.id,
      })
      .returning();
    const [sandbox] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: organization.id,
        user_id: user.id,
        agent_name: `restore-admission-lock-${suffix}`,
        status: "stopped",
        execution_tier: "dedicated-lazy",
      })
      .returning();
    const capture = {
      id: sandbox.id,
      organization_id: sandbox.organization_id,
      status: sandbox.status,
      lifecycle_job_id: sandbox.lifecycle_job_id,
      lifecycle_execution_generation: sandbox.lifecycle_execution_generation,
      execution_tier: sandbox.execution_tier,
      pool_status: sandbox.pool_status,
      deleted_at: sandbox.deleted_at,
      deletion_attempt_id: sandbox.deletion_attempt_id,
      lifecycle_revision: sandbox.lifecycle_revision,
    };

    const gateKeyOne = `restore_gate_${identifierSuffix}`;
    const gateKeyTwo = `job_insert_${identifierSuffix}`;
    const functionName = `block_restore_insert_${identifierSuffix}`;
    const triggerName = `block_restore_insert_trigger_${identifierSuffix}`;
    const control = new Client({ connectionString: isolatedDsn });
    const setup = new Client({ connectionString: isolatedDsn });
    await Promise.all([control.connect(), setup.connect()]);
    try {
      await setup.query(`
        CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(hashtext(TG_ARGV[0]), hashtext(TG_ARGV[1]));
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await setup.query(
        `CREATE TRIGGER ${triggerName}
         BEFORE INSERT ON jobs
         FOR EACH ROW
         EXECUTE FUNCTION ${functionName}('${gateKeyOne}', '${gateKeyTwo}')`,
      );

      await control.query("BEGIN");
      await control.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        gateKeyOne,
        gateKeyTwo,
      ]);

      const enqueue = provisioningJobService.enqueueAgentProvisionOnce({
        agentId: sandbox.id,
        organizationId: organization.id,
        userId: user.id,
        agentName: sandbox.agent_name ?? sandbox.id,
        expectedLifecycleRevision: sandbox.lifecycle_revision,
      });
      await waitForAdvisoryWaiters(control, 1);

      const admission = agentSandboxesRepository.trySetProvisioningFromRestoreCapture(capture);
      await waitForAdvisoryWaiters(control, 2);
      await control.query("COMMIT");

      const [enqueueResult, admitted] = await Promise.all([enqueue, admission]);
      expect(enqueueResult.created).toBe(true);
      expect(admitted).toBeUndefined();

      const [persistedSandbox] = await dbWrite
        .select({
          status: agentSandboxes.status,
          lifecycleRevision: agentSandboxes.lifecycle_revision,
        })
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, sandbox.id));
      const activeJobs = await dbWrite
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.organization_id, organization.id),
            eq(jobs.agent_id, sandbox.id),
            eq(jobs.status, "pending"),
          ),
        );
      expect(persistedSandbox).toEqual({
        status: "stopped",
        lifecycleRevision: sandbox.lifecycle_revision,
      });
      expect(activeJobs).toHaveLength(1);
    } finally {
      await control.query("ROLLBACK");
      await Promise.allSettled([control.end(), setup.end()]);
    }
  }, 30_000);

  test("lock contention defers one stuck row without blocking later candidates", async () => {
    if (!isolatedDsn || !dbWrite || !agentSandboxesRepository) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const suffix = randomUUID();
    const [organization] = await dbWrite
      .insert(organizations)
      .values({ name: "Bounded Sweep Org", slug: `bounded-sweep-${suffix}` })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: `bounded-sweep-${suffix}`,
        organization_id: organization.id,
      })
      .returning();
    const [blocked, later] = await dbWrite
      .insert(agentSandboxes)
      .values([
        {
          organization_id: organization.id,
          user_id: user.id,
          agent_name: `blocked-${suffix}`,
          status: "provisioning",
          execution_tier: "dedicated-always",
          updated_at: new Date(STALE_UPDATED_AT.getTime() - 1_000),
        },
        {
          organization_id: organization.id,
          user_id: user.id,
          agent_name: `later-${suffix}`,
          status: "provisioning",
          execution_tier: "dedicated-always",
          updated_at: STALE_UPDATED_AT,
        },
      ])
      .returning();
    const lock = new Client({ connectionString: isolatedDsn });
    await lock.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        organization.id,
        blocked.id,
      ]);
      const batch =
        await agentSandboxesRepository.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);
      expect(batch.deferred).toBe(1);
      expect(batch.updated.map((row) => row.agentId)).toContain(later.id);
      expect(batch.updated.map((row) => row.agentId)).not.toContain(blocked.id);
      await lock.query("COMMIT");

      const retry =
        await agentSandboxesRepository.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);
      expect(retry.updated.map((row) => row.agentId)).toContain(blocked.id);
    } finally {
      await lock.query("ROLLBACK");
      await lock.end();
    }
  }, 30_000);

  test("orphan-pending and markRunning defer lock owners without aborting", async () => {
    if (!isolatedDsn || !dbWrite || !agentSandboxesRepository) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const suffix = randomUUID();
    const [organization] = await dbWrite
      .insert(organizations)
      .values({ name: "Other Paths Org", slug: `other-paths-${suffix}` })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: `other-paths-${suffix}`,
        organization_id: organization.id,
      })
      .returning();
    const oldCreatedAt = new Date(SWEEP_CUTOFF.getTime() - 30 * 60 * 1000);
    const [orphan] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: organization.id,
        user_id: user.id,
        agent_name: `orphan-${suffix}`,
        status: "pending",
        execution_tier: "dedicated-always",
        created_at: oldCreatedAt,
      })
      .returning();
    const [wedged] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: organization.id,
        user_id: user.id,
        agent_name: `wedged-${suffix}`,
        status: "provisioning",
        execution_tier: "dedicated-always",
        sandbox_id: `sandbox-${suffix}`,
        node_id: `node-${suffix}`,
        container_name: `container-${suffix}`,
        updated_at: STALE_UPDATED_AT,
      })
      .returning();
    const lock = new Client({ connectionString: isolatedDsn });
    await lock.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        organization.id,
        orphan.id,
      ]);
      const orphanBatch =
        await agentSandboxesRepository.markOrphanedPendingWithoutJobAsError(SWEEP_CUTOFF);
      expect(orphanBatch.deferred).toBe(1);
      expect(await agentSandboxesRepository.markRunningFromProvisioning(wedged.id)).toMatchObject({
        id: wedged.id,
        status: "running",
      });
      await lock.query("COMMIT");

      const orphanRetry =
        await agentSandboxesRepository.markOrphanedPendingWithoutJobAsError(SWEEP_CUTOFF);
      expect(orphanRetry.updated.map((row) => row.agentId)).toContain(orphan.id);

      await dbWrite
        .update(agentSandboxes)
        .set({ status: "provisioning", updated_at: STALE_UPDATED_AT })
        .where(eq(agentSandboxes.id, wedged.id));
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
        organization.id,
        wedged.id,
      ]);
      expect(await agentSandboxesRepository.markRunningFromProvisioning(wedged.id)).toBeUndefined();
      await lock.query("COMMIT");
      expect(await agentSandboxesRepository.markRunningFromProvisioning(wedged.id)).toMatchObject({
        id: wedged.id,
        status: "running",
      });
    } finally {
      await lock.query("ROLLBACK");
      await lock.end();
    }
  }, 30_000);

  test("two replacement starts wait on the sandbox row and admit exactly one effect", async () => {
    if (!isolatedDsn || !dbWrite || !replacementAttemptsRepository) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const fixture = await createReplacementAttemptFixture();
    const tag = randomUUID().slice(0, 8);
    const holderApplicationName = `s1-sandbox-holder-${tag}`;
    const firstStartApplicationName = `s1-start-a-${tag}`;
    const secondStartApplicationName = `s1-start-b-${tag}`;
    const [holder, observer] = await connectNamedClients(isolatedDsn, [
      holderApplicationName,
      `s1-observer-${tag}`,
    ]);
    let startPromises: Promise<unknown>[] = [];
    try {
      await holder.query("BEGIN");
      const held = await holder.query(
        `SELECT id FROM agent_sandboxes
         WHERE id = $1 AND organization_id = $2
         FOR SHARE`,
        [fixture.agentId, fixture.organizationId],
      );
      expect(held.rowCount).toBe(1);

      const firstInput = fixture.startInput;
      const secondInput = { ...fixture.startInput, attemptId: randomUUID() };
      startPromises = [
        inNamedTransaction(firstStartApplicationName, (tx) =>
          replacementAttemptsRepository!.startAgentSandboxReplacementAttemptInTransaction(
            tx,
            firstInput,
          ),
        ),
      ];
      await waitForApplicationBlockingRelations(observer, [
        {
          waiterApplicationName: firstStartApplicationName,
          blockerApplicationName: holderApplicationName,
        },
      ]);
      expect(
        await grantedRelationWriteLocks(
          observer,
          firstStartApplicationName,
          "agent_sandbox_replacement_attempts",
        ),
      ).toEqual([]);
      startPromises.push(
        inNamedTransaction(secondStartApplicationName, (tx) =>
          replacementAttemptsRepository!.startAgentSandboxReplacementAttemptInTransaction(
            tx,
            secondInput,
          ),
        ),
      );
      await waitForApplicationBlockingRelations(observer, [
        {
          waiterApplicationName: firstStartApplicationName,
          blockerApplicationName: holderApplicationName,
        },
        {
          waiterApplicationName: secondStartApplicationName,
          blockerApplicationName: firstStartApplicationName,
        },
      ]);

      await holder.query("COMMIT");
      const results = await Promise.allSettled(startPromises);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        status: "rejected",
        reason: { code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" },
      });
      const attempts = await dbWrite
        .select({
          id: agentSandboxReplacementAttempts.id,
          state: agentSandboxReplacementAttempts.state,
        })
        .from(agentSandboxReplacementAttempts)
        .where(
          and(
            eq(agentSandboxReplacementAttempts.organization_id, fixture.organizationId),
            eq(agentSandboxReplacementAttempts.agent_id, fixture.agentId),
          ),
        );
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.state).toBe("in_flight_unresolved");
    } finally {
      await rollbackQuietly(holder);
      await Promise.allSettled(startPromises);
      await Promise.all([endQuietly(holder), endQuietly(observer)]);
    }
  }, 30_000);

  test("cleanup and the next replacement start preserve sandbox-to-attempt lock order", async () => {
    if (!isolatedDsn || !dbWrite || !replacementAttemptsRepository) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const fixture = await createReplacementAttemptFixture();
    await dbWrite.transaction((tx) =>
      replacementAttemptsRepository!.startAgentSandboxReplacementAttemptInTransaction(
        tx,
        fixture.startInput,
      ),
    );
    const tag = randomUUID().slice(0, 8);
    const attemptHolderApplicationName = `s1-attempt-holder-${tag}`;
    const cleanupApplicationName = `s1-cleanup-${tag}`;
    const nextStartApplicationName = `s1-next-start-${tag}`;
    const [holder, observer, sandboxProbe] = await connectNamedClients(isolatedDsn, [
      attemptHolderApplicationName,
      `s1-observer-${tag}`,
      `s1-sandbox-probe-${tag}`,
    ]);
    let cleanupPromise: Promise<unknown> | undefined;
    let nextStartPromise: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      const held = await holder.query(
        `SELECT id FROM agent_sandbox_replacement_attempts
         WHERE id = $1 AND organization_id = $2 AND agent_id = $3
         FOR SHARE`,
        [fixture.startInput.attemptId, fixture.organizationId, fixture.agentId],
      );
      expect(held.rowCount).toBe(1);

      cleanupPromise = inNamedTransaction(cleanupApplicationName, (tx) =>
        replacementAttemptsRepository!.recordAgentSandboxReplacementCleanupProvenInTransaction(
          tx,
          replacementReference(fixture.startInput),
          "d".repeat(64),
        ),
      );
      await waitForDirectTransactionIdBlock(
        observer,
        cleanupApplicationName,
        attemptHolderApplicationName,
      );

      await sandboxProbe.query("BEGIN");
      let sandboxNowaitError: unknown;
      try {
        await sandboxProbe.query(
          `SELECT id FROM agent_sandboxes
           WHERE id = $1 AND organization_id = $2
           FOR KEY SHARE NOWAIT`,
          [fixture.agentId, fixture.organizationId],
        );
      } catch (error) {
        // error-policy:J1 The test boundary retains PostgreSQL's exact NOWAIT code.
        sandboxNowaitError = error;
      } finally {
        await rollbackQuietly(sandboxProbe);
      }
      expect(sandboxNowaitError).toMatchObject({ code: "55P03" });

      const nextStartInput = { ...fixture.startInput, attemptId: randomUUID() };
      nextStartPromise = inNamedTransaction(nextStartApplicationName, (tx) =>
        replacementAttemptsRepository!.startAgentSandboxReplacementAttemptInTransaction(
          tx,
          nextStartInput,
        ),
      );
      await waitForDirectTransactionIdBlock(
        observer,
        nextStartApplicationName,
        cleanupApplicationName,
      );
      // pg_blocking_pids() may report cleanup as a soft blocker ahead in the
      // attempt-row queue. The direct XID wait above plus this complete relation
      // footprint rules out that attempt-first counterexample.
      expect(
        await applicationLocksTargetingRelation(
          observer,
          nextStartApplicationName,
          "agent_sandbox_replacement_attempts",
        ),
      ).toEqual([]);
      expect(
        await applicationLocksTargetingRelation(
          observer,
          nextStartApplicationName,
          "agent_sandboxes",
        ),
      ).toContainEqual({ locktype: "relation", mode: "RowShareLock", granted: true });

      await holder.query("COMMIT");
      const [cleanupResult, nextStartResult] = await Promise.allSettled([
        cleanupPromise,
        nextStartPromise,
      ]);
      expect(cleanupResult).toMatchObject({
        status: "fulfilled",
        value: { replayed: false, attempt: { state: "cleanup_proven" } },
      });
      expect(nextStartResult).toMatchObject({
        status: "fulfilled",
        value: { replayed: false, attempt: { state: "in_flight_unresolved" } },
      });
      const attempts = await dbWrite
        .select({
          id: agentSandboxReplacementAttempts.id,
          state: agentSandboxReplacementAttempts.state,
        })
        .from(agentSandboxReplacementAttempts)
        .where(
          and(
            eq(agentSandboxReplacementAttempts.organization_id, fixture.organizationId),
            eq(agentSandboxReplacementAttempts.agent_id, fixture.agentId),
          ),
        );
      expect(attempts.find(({ id }) => id === fixture.startInput.attemptId)?.state).toBe(
        "cleanup_proven",
      );
      expect(attempts.find(({ id }) => id === nextStartInput.attemptId)?.state).toBe(
        "in_flight_unresolved",
      );
    } finally {
      await rollbackQuietly(holder);
      await Promise.allSettled(
        [cleanupPromise, nextStartPromise].filter(
          (promise): promise is Promise<unknown> => promise !== undefined,
        ),
      );
      await Promise.all([endQuietly(holder), endQuietly(observer), endQuietly(sandboxProbe)]);
    }
  }, 30_000);

  test("lifecycle adoption holds sandbox then attempt while waiting on node authority", async () => {
    if (!isolatedDsn || !dbWrite || !replacementAttemptsRepository) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const fixture = await createReplacementAttemptFixture();
    await seedProviderSucceededReplacementAttempt(fixture);
    const adoptionInput: CommitAgentSandboxReplacementLifecycleAdoptionInput = {
      ...fixture.startInput,
      locator: fixture.locator,
      providerReceiptDigest: "b".repeat(64),
      lifecycleReceiptDigest: "c".repeat(64),
    };
    const tag = randomUUID().slice(0, 8);
    const nodeHolderApplicationName = `s1-node-holder-${tag}`;
    const attemptHolderApplicationName = `s1-attempt-holder-${tag}`;
    const adoptionApplicationName = `s1-adoption-${tag}`;
    const sameGenerationStartApplicationName = `s1-same-gen-start-${tag}`;
    const [nodeHolder, attemptHolder, observer, nowait] = await connectNamedClients(isolatedDsn, [
      nodeHolderApplicationName,
      attemptHolderApplicationName,
      `s1-observer-${tag}`,
      `s1-nowait-${tag}`,
    ]);
    let adoptionPromise: Promise<unknown> | undefined;
    let sameGenerationStartPromise: Promise<unknown> | undefined;
    try {
      await nodeHolder.query("BEGIN");
      const held = await nodeHolder.query(
        `SELECT id FROM docker_nodes
         WHERE id = $1
         FOR SHARE`,
        [fixture.nodeRecordId],
      );
      expect(held.rowCount).toBe(1);

      await attemptHolder.query("BEGIN");
      const heldAttempt = await attemptHolder.query(
        `SELECT id FROM agent_sandbox_replacement_attempts
         WHERE id = $1 AND organization_id = $2 AND agent_id = $3
         FOR SHARE`,
        [fixture.startInput.attemptId, fixture.organizationId, fixture.agentId],
      );
      expect(heldAttempt.rowCount).toBe(1);

      adoptionPromise = inNamedTransaction(adoptionApplicationName, (tx) =>
        replacementAttemptsRepository!.commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput,
        ),
      );
      await waitForApplicationBlockingRelations(observer, [
        {
          waiterApplicationName: adoptionApplicationName,
          blockerApplicationName: attemptHolderApplicationName,
        },
      ]);

      const sameGenerationStartInput = { ...fixture.startInput, attemptId: randomUUID() };
      sameGenerationStartPromise = inNamedTransaction(sameGenerationStartApplicationName, (tx) =>
        replacementAttemptsRepository!.startAgentSandboxReplacementAttemptInTransaction(
          tx,
          sameGenerationStartInput,
        ),
      );
      await waitForApplicationBlockingRelations(observer, [
        {
          waiterApplicationName: adoptionApplicationName,
          blockerApplicationName: attemptHolderApplicationName,
        },
        {
          waiterApplicationName: sameGenerationStartApplicationName,
          blockerApplicationName: adoptionApplicationName,
        },
      ]);

      await attemptHolder.query("COMMIT");
      await waitForApplicationBlockingRelations(observer, [
        {
          waiterApplicationName: adoptionApplicationName,
          blockerApplicationName: nodeHolderApplicationName,
        },
        {
          waiterApplicationName: sameGenerationStartApplicationName,
          blockerApplicationName: adoptionApplicationName,
        },
      ]);

      await nowait.query("BEGIN");
      let nowaitError: unknown;
      try {
        await nowait.query(
          `SELECT id FROM agent_sandbox_replacement_attempts
           WHERE id = $1 AND organization_id = $2 AND agent_id = $3
           FOR UPDATE NOWAIT`,
          [fixture.startInput.attemptId, fixture.organizationId, fixture.agentId],
        );
      } catch (error) {
        // error-policy:J1 The test boundary retains PostgreSQL's exact NOWAIT code.
        nowaitError = error;
      } finally {
        await rollbackQuietly(nowait);
      }
      expect(nowaitError).toMatchObject({ code: "55P03" });

      await nodeHolder.query("COMMIT");
      const [adoptionResult, sameGenerationStartResult] = await Promise.allSettled([
        adoptionPromise,
        sameGenerationStartPromise,
      ]);
      expect(adoptionResult).toMatchObject({
        status: "fulfilled",
        value: { replayed: false, attempt: { state: "lifecycle_committed" } },
      });
      expect(sameGenerationStartResult).toMatchObject({
        status: "rejected",
        reason: { code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" },
      });
      if (sameGenerationStartResult.status === "rejected") {
        expect((sameGenerationStartResult.reason as { code?: string }).code).not.toBe("40P01");
      }
      const attempts = await dbWrite
        .select({
          id: agentSandboxReplacementAttempts.id,
          state: agentSandboxReplacementAttempts.state,
        })
        .from(agentSandboxReplacementAttempts)
        .where(
          and(
            eq(agentSandboxReplacementAttempts.organization_id, fixture.organizationId),
            eq(agentSandboxReplacementAttempts.agent_id, fixture.agentId),
          ),
        );
      expect(attempts).toEqual([
        { id: fixture.startInput.attemptId, state: "lifecycle_committed" },
      ]);
    } finally {
      await rollbackQuietly(nodeHolder);
      await rollbackQuietly(attemptHolder);
      await rollbackQuietly(nowait);
      await Promise.allSettled(
        [adoptionPromise, sameGenerationStartPromise].filter(
          (promise): promise is Promise<unknown> => promise !== undefined,
        ),
      );
      await Promise.all([
        endQuietly(nodeHolder),
        endQuietly(attemptHolder),
        endQuietly(observer),
        endQuietly(nowait),
      ]);
    }
  }, 30_000);

  test("a timed-out attempt retries only after quiescence and cannot settle the next generation", async () => {
    if (!dbWrite || !ProvisioningJobService || !jobsRepository || !agentSandboxesRepository) {
      throw new Error("real PostgreSQL harness was not initialized");
    }
    const suffix = randomUUID();
    const [organization] = await dbWrite
      .insert(organizations)
      .values({ name: "Execution Fence Org", slug: `execution-fence-${suffix}` })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: `execution-fence-${suffix}`,
        organization_id: organization.id,
      })
      .returning();
    const [sandbox] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: organization.id,
        user_id: user.id,
        agent_name: `execution-fence-${suffix}`,
        status: "provisioning",
        execution_tier: "dedicated-always",
      })
      .returning();
    await dbWrite.insert(jobs).values({
      type: "agent_wake",
      status: "pending",
      data: {
        agentId: sandbox.id,
        organizationId: organization.id,
        userId: user.id,
      },
      agent_id: sandbox.id,
      organization_id: organization.id,
      user_id: user.id,
      scheduled_for: new Date("2020-01-01T00:00:00.000Z"),
      max_attempts: 3,
    });

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    let timeoutResolution = 0;
    let firstClaim: typeof jobs.$inferSelect | undefined;
    let secondClaim: typeof jobs.$inferSelect | undefined;
    const service = new ProvisioningJobService({
      executionOwnerId: EXECUTION_OWNER_ID,
      executionTimeoutMs: () => (++timeoutResolution === 1 ? 20 : 5_000),
      executeJob: async (job) => {
        call++;
        if (call === 1) {
          firstClaim = job;
          await firstGate;
          throw new Error("late detached failure");
        }
        secondClaim = job;
        await jobsRepository!.settleExecution(
          job,
          "completed",
          {
            result: { generation: job.execution_generation },
          },
          EXECUTION_OWNER_ID,
        );
      },
    });
    expect(
      await dbWrite
        .select({
          id: jobs.id,
          type: jobs.type,
          status: jobs.status,
          scheduledFor: jobs.scheduled_for,
          claimable: sql<boolean>`${jobs.scheduled_for} <= NOW()`,
        })
        .from(jobs)
        .where(and(eq(jobs.agent_id, sandbox.id), eq(jobs.type, "agent_wake"))),
    ).toEqual([
      expect.objectContaining({
        type: "agent_wake",
        status: "pending",
        claimable: true,
      }),
    ]);

    const timedOut = await service.processPendingJobs(1, {
      jobTypes: ["agent_wake"],
    });
    expect(timedOut).toMatchObject({ claimed: 1, failed: 1 });
    const claimDeadline = Date.now() + 5_000;
    while (!firstClaim && Date.now() < claimDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(firstClaim?.execution_generation).toBeTruthy();
    const duringTimeout = await jobsRepository.findByIdForWrite(firstClaim!.id);
    expect(duringTimeout).toMatchObject({
      status: "in_progress",
      execution_generation: firstClaim!.execution_generation,
      execution_quiesced_at: null,
    });

    releaseFirst();
    const deadline = Date.now() + 5_000;
    let afterQuiescence = await jobsRepository.findByIdForWrite(firstClaim!.id);
    while (afterQuiescence?.status !== "pending" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      afterQuiescence = await jobsRepository.findByIdForWrite(firstClaim!.id);
    }
    expect(afterQuiescence?.status).toBe("pending");
    expect(afterQuiescence?.execution_quiesced_at).not.toBeNull();
    await dbWrite
      .update(jobs)
      .set({ scheduled_for: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(jobs.id, firstClaim!.id));

    const completed = await service.processPendingJobs(1, {
      jobTypes: ["agent_wake"],
    });
    expect(completed.succeeded).toBe(1);
    expect(secondClaim?.execution_generation).toBeTruthy();
    expect(secondClaim?.execution_generation).not.toBe(firstClaim?.execution_generation);
    await expect(
      jobsRepository.settleExecution(
        firstClaim!,
        "completed",
        {
          result: { stale: true },
        },
        EXECUTION_OWNER_ID,
      ),
    ).rejects.toThrow(/generation is no longer current/);
    expect(await jobsRepository.findByIdForWrite(firstClaim!.id)).toMatchObject({
      status: "completed",
      execution_generation: secondClaim!.execution_generation,
    });
  }, 30_000);
});
