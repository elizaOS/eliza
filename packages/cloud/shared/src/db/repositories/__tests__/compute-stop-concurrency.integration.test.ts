/**
 * Proves compute-stop funding and lifecycle fences with independent real
 * PostgreSQL sessions; PGlite cannot establish cross-session lock blocking.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import type {
  BillingResourceCancellationsService,
  RequestBillingCancellationOptions,
} from "../../../lib/services/billing-resource-cancellations";
import {
  acquireEphemeralPostgres,
  type EphemeralPostgres,
} from "../../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import type { DbTransaction } from "../../client";
import { jobs as jobsTable } from "../../schemas/jobs";

const SKIP_REASON =
  "[compute stop concurrency] SKIPPED - no real PostgreSQL available. " +
  "Set APPS_TENANT_DB_EPHEMERAL=1 with Docker, or provide APPS_TENANT_DB_TEST_DSN.";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
};

let postgres: EphemeralPostgres | null = await acquireEphemeralPostgres();
let databaseName: string | null = null;
let isolatedDsn: string | null = null;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | undefined;
let dbWrite: typeof import("../../client").dbWrite | undefined;
let stopService: typeof import("../../../lib/services/container-stop-job-service") | undefined;
let getHetznerContainersClient:
  | typeof import("../../../lib/services/containers/hetzner-client/client").getHetznerContainersClient
  | undefined;
let listRecoverableAgentComputeStopIntents:
  | typeof import("../../../lib/services/provisioning-jobs").listRecoverableAgentComputeStopIntents
  | undefined;
let BillingCancellationsService:
  | typeof import("../../../lib/services/billing-resource-cancellations").BillingResourceCancellationsService
  | undefined;

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function createIsolatedDatabase(baseDsn: string): Promise<string> {
  databaseName = `eliza_compute_stop_${randomUUID().replaceAll("-", "")}`;
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

async function waitUntilBlocked(observer: Client): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ blocked: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity activity
        WHERE activity.datname = current_database()
          AND activity.pid <> pg_backend_pid()
          AND cardinality(pg_blocking_pids(activity.pid)) > 0
      ) AS blocked
    `);
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a PostgreSQL lock waiter");
}

async function seedContainer(params: {
  organizationId: string;
  userId: string;
  containerId: string;
  lifecycleRevision: number;
}): Promise<void> {
  if (!dbWrite) throw new Error("real PostgreSQL harness was not initialized");
  const periodStart = new Date(Date.now() - 60 * 60 * 1000);
  await dbWrite.execute(sql`INSERT INTO containers
      (id, organization_id, user_id, status, billing_status, scheduled_shutdown_at,
       last_billed_at, lifecycle_revision, created_at, updated_at)
      VALUES (${params.containerId}, ${params.organizationId}, ${params.userId},
        'running', 'shutdown_pending', NOW() - interval '1 minute',
        ${periodStart}, ${params.lifecycleRevision}, ${periodStart}, ${periodStart})`);
  await dbWrite.execute(sql`INSERT INTO compute_billing_rate_segments
      (organization_id, workload_kind, workload_id, lifecycle_revision,
       billing_state, rate_per_hour, effective_at)
      VALUES (${params.organizationId}, 'container', ${params.containerId},
        ${params.lifecycleRevision}, 'running', 0.027917, ${periodStart})`);
}

if (!postgres) {
  console.warn(SKIP_REASON);
} else {
  isolatedDsn = await createIsolatedDatabase(postgres.dsn);
  process.env.DATABASE_URL = isolatedDsn;
  process.env.TEST_DATABASE_URL = isolatedDsn;
  const [
    clientModule,
    serviceModule,
    providerModule,
    provisioningModule,
    billingCancellationsModule,
  ] = await Promise.all([
    import("../../client"),
    import("../../../lib/services/container-stop-job-service"),
    import("../../../lib/services/containers/hetzner-client/client"),
    import("../../../lib/services/provisioning-jobs"),
    import("../../../lib/services/billing-resource-cancellations"),
  ]);
  closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
  dbWrite = clientModule.dbWrite;
  stopService = serviceModule;
  getHetznerContainersClient = providerModule.getHetznerContainersClient;
  listRecoverableAgentComputeStopIntents =
    provisioningModule.listRecoverableAgentComputeStopIntents;
  BillingCancellationsService = billingCancellationsModule.BillingResourceCancellationsService;
}

beforeAll(async () => {
  if (!dbWrite) return;
  await dbWrite.execute(
    sql.raw(`
      CREATE TABLE organizations (
        id uuid PRIMARY KEY, credit_balance numeric(16,6) NOT NULL,
        pay_as_you_go_from_earnings boolean NOT NULL DEFAULT false,
        is_active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE users (
        id uuid PRIMARY KEY, organization_id uuid NOT NULL, role text NOT NULL DEFAULT 'member',
        is_active boolean NOT NULL DEFAULT true,
        is_anonymous boolean NOT NULL DEFAULT false,
        expires_at timestamp, deleted_at timestamp,
        created_at timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE redeemable_earnings (
        user_id uuid PRIMARY KEY, available_balance numeric(16,6) NOT NULL DEFAULT 0
      );
      CREATE TABLE jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text NOT NULL,
        status text NOT NULL DEFAULT 'pending', data jsonb NOT NULL,
        data_storage text NOT NULL DEFAULT 'inline', data_key text,
        agent_id text, character_id text, result jsonb,
        result_storage text NOT NULL DEFAULT 'inline', result_key text,
        error text, error_storage text NOT NULL DEFAULT 'inline', error_key text,
        attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3,
        execution_interruptions integer NOT NULL DEFAULT 0,
        retryable_requeues integer NOT NULL DEFAULT 0,
        organization_id uuid NOT NULL, user_id uuid, api_key_id uuid, generation_id uuid,
        webhook_url text, webhook_status text, estimated_completion_at timestamp,
        scheduled_for timestamp NOT NULL DEFAULT now(), started_at timestamp,
        execution_generation uuid, execution_quiesced_at timestamp, completed_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE containers (
        id uuid PRIMARY KEY, organization_id uuid NOT NULL, user_id uuid NOT NULL,
        status text NOT NULL, billing_status text NOT NULL,
        scheduled_shutdown_at timestamp, shutdown_warning_sent_at timestamp,
        last_billed_at timestamp, next_billing_at timestamp,
        lifecycle_revision bigint NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL, updated_at timestamp NOT NULL
      );
      CREATE TABLE compute_billing_rate_segments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        workload_kind text NOT NULL, workload_id uuid NOT NULL,
        lifecycle_revision bigint NOT NULL, billing_state text NOT NULL,
        rate_per_hour numeric(16,6) NOT NULL, effective_at timestamp NOT NULL,
        created_at timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE container_compute_stop_intents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        container_id uuid NOT NULL, lifecycle_revision bigint NOT NULL,
        "authorization" text NOT NULL DEFAULT 'billing_request',
        status text NOT NULL DEFAULT 'pending', job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
        attempts integer NOT NULL DEFAULT 0, last_error text,
        next_attempt_at timestamp NOT NULL DEFAULT now(), provider_started_at timestamp,
        provider_confirmed_at timestamp, provider_node_id text, slot_released_at timestamp,
        superseded_at timestamp, created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX container_compute_stop_intents_active_unique
        ON container_compute_stop_intents (organization_id, container_id)
        WHERE status IN ('pending', 'dispatching', 'retry', 'terminal_attention');
      CREATE UNIQUE INDEX container_compute_stop_intents_user_generation_unique
        ON container_compute_stop_intents (organization_id, container_id, lifecycle_revision)
        WHERE "authorization" = 'user_request';
      CREATE TABLE agent_compute_stop_intents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        agent_id uuid NOT NULL, lifecycle_revision bigint NOT NULL,
        "authorization" text NOT NULL DEFAULT 'billing_request',
        status text NOT NULL DEFAULT 'pending', job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
        attempts integer NOT NULL DEFAULT 0, last_error text,
        next_attempt_at timestamptz NOT NULL DEFAULT now(), provider_started_at timestamptz,
        provider_confirmed_at timestamptz, superseded_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX agent_compute_stop_intents_active_unique
        ON agent_compute_stop_intents (organization_id, agent_id)
        WHERE status IN ('pending', 'dispatching', 'retry', 'terminal_attention');
      CREATE UNIQUE INDEX agent_compute_stop_intents_user_request_unique
        ON agent_compute_stop_intents (organization_id, agent_id, lifecycle_revision)
        WHERE "authorization" = 'user_request';
      CREATE TABLE billing_cancel_commands (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        requested_by_user_id uuid NOT NULL, resource_type text NOT NULL,
        resource_id uuid NOT NULL, expected_lifecycle_revision bigint NOT NULL,
        action text NOT NULL DEFAULT 'stop', job_id uuid NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT billing_cancel_commands_id_org_unique UNIQUE (id, organization_id),
        CONSTRAINT billing_cancel_commands_logical_unique UNIQUE
          (organization_id, resource_type, resource_id, expected_lifecycle_revision, action)
      );
      CREATE TABLE billing_cancel_command_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        idempotency_key_hash text NOT NULL, request_digest text NOT NULL,
        command_id uuid NOT NULL, requested_by_user_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT billing_cancel_command_keys_org_key_unique
          UNIQUE (organization_id, idempotency_key_hash),
        CONSTRAINT billing_cancel_command_keys_command_tenant_fkey
          FOREIGN KEY (command_id, organization_id)
          REFERENCES billing_cancel_commands(id, organization_id) ON DELETE RESTRICT
      );
    `),
  );
}, 30_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  if (postgres && databaseName) {
    const admin = new Client({ connectionString: postgres.dsn });
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
  await postgres?.stop();
  postgres = null;
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  }
}, 30_000);

const realPostgres = postgres ? describe : describe.skip;

realPostgres("compute stop concurrency", () => {
  test("billing cancellation waits for an interleaved role revocation and then refuses it", async () => {
    if (!isolatedDsn || !dbWrite || !BillingCancellationsService) {
      throw new Error("harness unavailable");
    }
    const organizationId = randomUUID();
    const userId = randomUUID();
    const resourceId = randomUUID();
    await dbWrite.execute(
      sql`INSERT INTO organizations(id, credit_balance) VALUES (${organizationId}, 0)`,
    );
    await dbWrite.execute(
      sql`INSERT INTO users(id, organization_id, role)
          VALUES (${userId}, ${organizationId}, 'owner')`,
    );

    let enqueueCount = 0;
    const service: BillingResourceCancellationsService = new BillingCancellationsService({
      transact: (callback) => dbWrite!.transaction(callback),
      enqueueStop: async (
        tx: DbTransaction,
        options: RequestBillingCancellationOptions,
      ): Promise<{ jobId: string }> => {
        enqueueCount += 1;
        const [job] = await tx
          .insert(jobsTable)
          .values({
            type: "container_stop",
            status: "pending",
            data: { resourceId: options.resourceId },
            organization_id: options.organizationId,
            user_id: options.requestedByUserId,
          })
          .returning({ id: jobsTable.id });
        if (!job) throw new Error("test job insert returned no row");
        return { jobId: job.id };
      },
      triggerImmediate: async () => {},
    });
    const revoker = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([revoker.connect(), observer.connect()]);
    try {
      const admission = service.request({
        organizationId,
        requestedByUserId: userId,
        resourceType: "container",
        resourceId,
        expectedLifecycleRevision: 1,
        idempotencyKey: "cancel-concurrent-revocation-0001",
        authorizeInfrastructureMutation: async () => {
          // Simulate the fresh session check succeeding immediately before a
          // primary membership revocation commits on another connection.
          await revoker.query("BEGIN");
          await revoker.query("UPDATE users SET role = 'member' WHERE id = $1", [userId]);
        },
      });

      await waitUntilBlocked(observer);
      await revoker.query("COMMIT");
      await expect(admission).rejects.toMatchObject({ status: 403, code: "access_denied" });
      expect(enqueueCount).toBe(0);
      const durable = await observer.query(`SELECT
        (SELECT count(*)::int FROM jobs) AS jobs,
        (SELECT count(*)::int FROM billing_cancel_commands) AS commands,
        (SELECT count(*)::int FROM billing_cancel_command_keys) AS keys`);
      expect(durable.rows[0]).toEqual({ jobs: 0, commands: 0, keys: 0 });
    } finally {
      await revoker.query("ROLLBACK").catch(() => undefined);
      await Promise.all([revoker.end(), observer.end()]);
    }
  }, 15_000);

  test("a top-up holding the organization lock wins before stop eligibility is revalidated", async () => {
    if (!isolatedDsn || !dbWrite || !stopService) throw new Error("harness unavailable");
    const organizationId = randomUUID();
    const userId = randomUUID();
    const containerId = randomUUID();
    await dbWrite.execute(
      sql`INSERT INTO organizations(id, credit_balance) VALUES (${organizationId}, 0)`,
    );
    await dbWrite.execute(
      sql`INSERT INTO users(id, organization_id) VALUES (${userId}, ${organizationId})`,
    );
    await seedContainer({ organizationId, userId, containerId, lifecycleRevision: 4 });
    const holder = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([holder.connect(), observer.connect()]);
    try {
      await holder.query("BEGIN");
      await holder.query("UPDATE organizations SET credit_balance = 10 WHERE id = $1", [
        organizationId,
      ]);
      const enqueue = stopService.enqueueContainerStopOnce({ containerId, organizationId });
      await waitUntilBlocked(observer);
      await holder.query("COMMIT");
      await expect(enqueue).resolves.toMatchObject({
        requested: false,
        reason: "funding_restored",
      });
      const jobs = await observer.query("SELECT id FROM jobs");
      expect(jobs.rows).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await Promise.all([holder.end(), observer.end()]);
    }
  }, 15_000);

  test("daemon rechecks lifecycle after blocking and never calls the provider for a redeploy", async () => {
    if (!isolatedDsn || !dbWrite || !stopService || !getHetznerContainersClient) {
      throw new Error("harness unavailable");
    }
    const organizationId = randomUUID();
    const userId = randomUUID();
    const containerId = randomUUID();
    await dbWrite.execute(
      sql`INSERT INTO organizations(id, credit_balance) VALUES (${organizationId}, 0)`,
    );
    await dbWrite.execute(
      sql`INSERT INTO users(id, organization_id) VALUES (${userId}, ${organizationId})`,
    );
    await seedContainer({ organizationId, userId, containerId, lifecycleRevision: 7 });
    const requested = await stopService.enqueueContainerStopOnce({ containerId, organizationId });
    if (!requested.requested) throw new Error("expected stop request");
    const jobResult = await dbWrite.execute(
      sql`SELECT id, organization_id, data FROM jobs WHERE id = ${requested.id}`,
    );
    const job = jobResult.rows[0] as { id: string; organization_id: string; data: unknown };
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockResolvedValue({ nodeId: null });
    const holder = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([holder.connect(), observer.connect()]);
    try {
      await holder.query("BEGIN");
      await holder.query(
        "UPDATE containers SET lifecycle_revision = 8, status = 'deploying' WHERE id = $1",
        [containerId],
      );
      const dispatch = stopService.dispatchContainerStopJob(job);
      await waitUntilBlocked(observer);
      await holder.query("COMMIT");
      await expect(dispatch).resolves.toMatchObject({ reason: "stale-lifecycle-generation" });
      expect(providerStop).not.toHaveBeenCalled();
    } finally {
      providerStop.mockRestore();
      await holder.query("ROLLBACK").catch(() => undefined);
      await Promise.all([holder.end(), observer.end()]);
    }
  }, 15_000);

  test("terminal agent stop authority remains visible to the independent recovery scan", async () => {
    if (!dbWrite || !listRecoverableAgentComputeStopIntents) {
      throw new Error("harness unavailable");
    }
    const organizationId = randomUUID();
    const agentId = randomUUID();
    await dbWrite.execute(
      sql`INSERT INTO organizations(id, credit_balance) VALUES (${organizationId}, 0)`,
    );
    await dbWrite.execute(sql`INSERT INTO agent_compute_stop_intents
      (organization_id, agent_id, lifecycle_revision, status, attempts, next_attempt_at)
      VALUES (${organizationId}, ${agentId}, 5, 'terminal_attention', 3, NOW() - interval '1 minute')`);
    const recovery = await listRecoverableAgentComputeStopIntents(new Date());
    expect(recovery).toContainEqual(
      expect.objectContaining({
        organization_id: organizationId,
        agent_id: agentId,
        status: "terminal_attention",
        attempts: 3,
      }),
    );
  });
});
