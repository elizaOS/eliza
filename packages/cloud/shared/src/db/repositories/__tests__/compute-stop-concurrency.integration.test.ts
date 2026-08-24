/**
 * Proves compute-stop funding and lifecycle fences with independent real
 * PostgreSQL sessions; PGlite cannot establish cross-session lock blocking.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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
import { agentComputeStopIntents } from "../../schemas/agent-compute-stop-intents";
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
let enqueueContainerUserStopInTx:
  | typeof import("../../../lib/services/container-stop-job-service").enqueueContainerUserStopInTx
  | undefined;
let getHetznerContainersClient:
  | typeof import("../../../lib/services/containers/hetzner-client/client").getHetznerContainersClient
  | undefined;
let listRecoverableAgentComputeStopIntents:
  | typeof import("../../../lib/services/provisioning-jobs").listRecoverableAgentComputeStopIntents
  | undefined;
let BillingCancellationsService:
  | typeof import("../../../lib/services/billing-resource-cancellations").BillingResourceCancellationsService
  | undefined;
let lockBillingCancellationTargetInTx:
  | typeof import("../../../lib/services/billing-resource-cancellations").lockBillingCancellationTargetInTx
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

async function waitUntilBlocked(observer: Client): Promise<{
  pid: number;
  blockingPids: number[];
  query: string;
}> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{
      pid: number;
      blocking_pids: number[];
      query: string;
    }>(`
      SELECT activity.pid, pg_blocking_pids(activity.pid) AS blocking_pids, activity.query
      FROM pg_stat_activity activity
      WHERE activity.datname = current_database()
        AND activity.pid <> pg_backend_pid()
        AND cardinality(pg_blocking_pids(activity.pid)) > 0
      ORDER BY activity.pid
      LIMIT 1
    `);
    const blocked = result.rows[0];
    if (blocked) {
      return {
        pid: blocked.pid,
        blockingPids: blocked.blocking_pids,
        query: blocked.query,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a PostgreSQL lock waiter");
}

async function waitForUserExpiry(observer: Client, userId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ expired: boolean }>(
      `SELECT expires_at <= (clock_timestamp() AT TIME ZONE 'UTC') AS expired
       FROM users
       WHERE id = $1`,
      [userId],
    );
    if (result.rows[0]?.expired) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the billing manager identity to expire");
}

async function seedContainer(params: {
  organizationId: string;
  userId: string;
  containerId: string;
  lifecycleRevision: number;
}): Promise<void> {
  if (!dbWrite) throw new Error("real PostgreSQL harness was not initialized");
  const periodStart = new Date(Date.now() - 60 * 60 * 1000);
  const scheduledShutdownAt = new Date(Date.now() - 60 * 1000);
  await dbWrite.execute(sql`INSERT INTO containers
      (id, organization_id, user_id, status, billing_status, scheduled_shutdown_at,
       last_billed_at, lifecycle_revision, created_at, updated_at)
      VALUES (${params.containerId}, ${params.organizationId}, ${params.userId},
        'running', 'shutdown_pending', ${scheduledShutdownAt},
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
  enqueueContainerUserStopInTx = serviceModule.enqueueContainerUserStopInTx;
  getHetznerContainersClient = providerModule.getHetznerContainersClient;
  listRecoverableAgentComputeStopIntents =
    provisioningModule.listRecoverableAgentComputeStopIntents;
  BillingCancellationsService = billingCancellationsModule.BillingResourceCancellationsService;
  lockBillingCancellationTargetInTx = billingCancellationsModule.lockBillingCancellationTargetInTx;
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
        id uuid PRIMARY KEY, organization_id uuid NOT NULL,
        steward_user_id text NOT NULL UNIQUE, role text NOT NULL DEFAULT 'member',
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
      CREATE TABLE agent_sandboxes (
        id uuid PRIMARY KEY, organization_id uuid NOT NULL
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
  test("manual and billing stop admission converge without a lock-order deadlock", async () => {
    if (
      !isolatedDsn ||
      !dbWrite ||
      !stopService ||
      !enqueueContainerUserStopInTx ||
      !BillingCancellationsService
    ) {
      throw new Error("harness unavailable");
    }
    const organizationId = randomUUID();
    const userId = randomUUID();
    const containerId = randomUUID();
    const stewardUserId = `steward:${userId}`;
    await dbWrite.execute(
      sql`INSERT INTO organizations(id, credit_balance) VALUES (${organizationId}, 0)`,
    );
    await dbWrite.execute(
      sql`INSERT INTO users(id, organization_id, steward_user_id, role)
          VALUES (${userId}, ${organizationId}, ${stewardUserId}, 'owner')`,
    );
    await seedContainer({ organizationId, userId, containerId, lifecycleRevision: 3 });

    const seeded = await stopService.enqueueContainerStopOnce({
      containerId,
      organizationId,
      userId,
    });
    if (!seeded.requested) throw new Error("expected seeded billing stop request");

    const enqueueEntered = Promise.withResolvers<void>();
    const releaseEnqueue = Promise.withResolvers<void>();
    const service: BillingResourceCancellationsService = new BillingCancellationsService({
      transact: (callback) => dbWrite!.transaction(callback),
      // The fallback lets this exact regression execute against the vulnerable
      // parent commit, where the dependency did not exist and PostgreSQL must
      // expose the 40P01 cycle instead of failing at module setup.
      lockTarget: lockBillingCancellationTargetInTx ?? (async () => {}),
      enqueueStop: async (
        tx: DbTransaction,
        options: RequestBillingCancellationOptions,
      ): Promise<{ jobId: string }> => {
        // The barrier begins after target + authority admission. On the
        // vulnerable order the manual transaction owns only the organization,
        // so billing owns the target and waits for that organization. With the
        // fixed order, billing waits behind the already-owned target instead.
        enqueueEntered.resolve();
        await releaseEnqueue.promise;
        const result = await enqueueContainerUserStopInTx!(tx, {
          containerId: options.resourceId,
          organizationId: options.organizationId,
          userId: options.requestedByUserId,
          expectedLifecycleRevision: options.expectedLifecycleRevision,
        });
        if (!result.requested) throw new Error("manual stop unexpectedly became stale");
        return { jobId: result.jobId };
      },
      triggerImmediate: async () => {},
    });
    const observer = new Client({ connectionString: isolatedDsn });
    await observer.connect();
    try {
      const manual = service.request({
        organizationId,
        requestedByUserId: userId,
        resourceType: "container",
        resourceId: containerId,
        expectedLifecycleRevision: 3,
        idempotencyKey: "cancel-lock-order-convergence-0001",
        authorizeInfrastructureMutation: async () => stewardUserId,
      });
      const observedManual = manual.then(
        (value) => ({ status: "resolved" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await enqueueEntered.promise;

      const billing = stopService.enqueueContainerStopOnce({
        containerId,
        organizationId,
        userId,
      });
      const observedBilling = billing.then(
        (value) => ({ status: "resolved" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      const blocked = await waitUntilBlocked(observer);
      expect(blocked.blockingPids.length).toBeGreaterThan(0);
      expect(blocked.blockingPids).not.toContain(blocked.pid);
      releaseEnqueue.resolve();

      const [manualOutcome, billingOutcome] = await Promise.all([observedManual, observedBilling]);
      expect(manualOutcome).toMatchObject({
        status: "resolved",
        value: {
          disposition: "accepted",
          receipt: { jobId: seeded.id, status: "accepted" },
        },
      });
      expect(billingOutcome).toEqual({
        status: "resolved",
        value: { requested: true, id: seeded.id, created: false },
      });
      expect(blocked.query).toContain("pg_advisory_xact_lock");
      if (manualOutcome.status !== "resolved") {
        throw new Error("manual cancellation unexpectedly rejected after convergence");
      }

      const durable = await observer.query(
        `SELECT
          (SELECT count(*)::int FROM jobs WHERE organization_id = $1) AS jobs,
          (SELECT count(*)::int FROM container_compute_stop_intents
             WHERE organization_id = $1 AND container_id = $2) AS intents,
          (SELECT count(*)::int FROM billing_cancel_commands
             WHERE organization_id = $1 AND resource_id = $2) AS commands,
          (SELECT count(*)::int FROM billing_cancel_command_keys
             WHERE organization_id = $1) AS keys,
          (SELECT id FROM billing_cancel_commands
             WHERE organization_id = $1 AND resource_id = $2) AS command_id,
          (SELECT job_id FROM billing_cancel_commands
             WHERE organization_id = $1 AND resource_id = $2) AS command_job_id,
          (SELECT command_id FROM billing_cancel_command_keys
             WHERE organization_id = $1) AS key_command_id,
          (SELECT "authorization" FROM container_compute_stop_intents
             WHERE organization_id = $1 AND container_id = $2) AS authorization,
          (SELECT job_id FROM container_compute_stop_intents
             WHERE organization_id = $1 AND container_id = $2) AS job_id`,
        [organizationId, containerId],
      );
      expect(durable.rows[0]).toEqual({
        jobs: 1,
        intents: 1,
        commands: 1,
        keys: 1,
        command_id: manualOutcome.value.receipt.receiptId,
        command_job_id: manualOutcome.value.receipt.jobId,
        key_command_id: manualOutcome.value.receipt.receiptId,
        authorization: "user_request",
        job_id: seeded.id,
      });
    } finally {
      releaseEnqueue.resolve();
      await observer.end();
    }
  }, 15_000);

  test("manual cancellation and agent billing execution share lifecycle-first order", async () => {
    if (!isolatedDsn || !dbWrite || !BillingCancellationsService) {
      throw new Error("harness unavailable");
    }
    const organizationId = randomUUID();
    const userId = randomUUID();
    const agentId = randomUUID();
    const stewardUserId = `steward:${userId}`;
    await dbWrite.execute(
      sql`INSERT INTO organizations(id, credit_balance) VALUES (${organizationId}, 0)`,
    );
    await dbWrite.execute(
      sql`INSERT INTO users(id, organization_id, steward_user_id, role)
          VALUES (${userId}, ${organizationId}, ${stewardUserId}, 'owner')`,
    );
    await dbWrite.execute(
      sql`INSERT INTO agent_sandboxes(id, organization_id) VALUES (${agentId}, ${organizationId})`,
    );
    const [seededJob] = await dbWrite
      .insert(jobsTable)
      .values({
        type: "agent_suspend",
        status: "pending",
        data: {
          agentId,
          organizationId,
          userId,
          authorization: "billing_request",
          lifecycleRevision: 5,
        },
        organization_id: organizationId,
        user_id: userId,
        agent_id: agentId,
      })
      .returning({ id: jobsTable.id });
    if (!seededJob) throw new Error("expected seeded agent billing job");
    await dbWrite.insert(agentComputeStopIntents).values({
      organization_id: organizationId,
      agent_id: agentId,
      lifecycle_revision: 5,
      authorization: "billing_request",
      job_id: seededJob.id,
    });

    const enqueueEntered = Promise.withResolvers<void>();
    const releaseEnqueue = Promise.withResolvers<void>();
    const service: BillingResourceCancellationsService = new BillingCancellationsService({
      transact: (callback) => dbWrite!.transaction(callback),
      lockTarget: lockBillingCancellationTargetInTx ?? (async () => {}),
      enqueueStop: async (
        tx: DbTransaction,
        options: RequestBillingCancellationOptions,
      ): Promise<{ jobId: string }> => {
        enqueueEntered.resolve();
        await releaseEnqueue.promise;
        // Mirror enqueueLifecycleJobInTx's root locks before promoting the
        // already-queued billing intent. Re-acquisition is transaction-local
        // and proves the same cycle against the vulnerable parent commit.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(
            hashtext(${options.organizationId}), hashtext(${options.resourceId})
          )`,
        );
        await tx.execute(sql`SELECT id FROM agent_sandboxes
          WHERE id = ${options.resourceId} AND organization_id = ${options.organizationId}
          FOR UPDATE`);
        const [intent] = await tx
          .select()
          .from(agentComputeStopIntents)
          .where(
            and(
              eq(agentComputeStopIntents.organization_id, options.organizationId),
              eq(agentComputeStopIntents.agent_id, options.resourceId),
              eq(agentComputeStopIntents.lifecycle_revision, options.expectedLifecycleRevision),
            ),
          )
          .for("update")
          .limit(1);
        if (!intent?.job_id) throw new Error("seeded agent stop intent was not bound");
        await tx
          .update(agentComputeStopIntents)
          .set({ authorization: "user_request", updated_at: new Date() })
          .where(eq(agentComputeStopIntents.id, intent.id));
        return { jobId: intent.job_id };
      },
      triggerImmediate: async () => {},
    });
    const executor = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([executor.connect(), observer.connect()]);
    try {
      const manual = service.request({
        organizationId,
        requestedByUserId: userId,
        resourceType: "agent_sandbox",
        resourceId: agentId,
        expectedLifecycleRevision: 5,
        idempotencyKey: "cancel-agent-lock-order-0001",
        authorizeInfrastructureMutation: async () => stewardUserId,
      });
      const observedManual = manual.then(
        (value) => ({ status: "resolved" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await enqueueEntered.promise;

      const execution = (async () => {
        await executor.query("BEGIN");
        await executor.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
          organizationId,
          agentId,
        ]);
        await executor.query(
          "SELECT id FROM agent_sandboxes WHERE id = $1 AND organization_id = $2 FOR UPDATE",
          [agentId, organizationId],
        );
        const intent = await executor.query<{ authorization: string }>(
          `SELECT "authorization" FROM agent_compute_stop_intents
           WHERE agent_id = $1 AND organization_id = $2 AND job_id = $3
           FOR UPDATE`,
          [agentId, organizationId, seededJob.id],
        );
        const authorization = intent.rows[0]?.authorization;
        if (authorization === "billing_request") {
          await executor.query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", [
            organizationId,
          ]);
        }
        await executor.query("COMMIT");
        return authorization;
      })();
      const observedExecution = execution.then(
        (authorization) => ({ status: "resolved" as const, authorization }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      const blocked = await waitUntilBlocked(observer);
      expect(blocked.blockingPids.length).toBeGreaterThan(0);
      expect(blocked.blockingPids).not.toContain(blocked.pid);
      releaseEnqueue.resolve();

      const [manualOutcome, executionOutcome] = await Promise.all([
        observedManual,
        observedExecution,
      ]);
      expect(manualOutcome).toMatchObject({
        status: "resolved",
        value: {
          disposition: "accepted",
          receipt: { jobId: seededJob.id, status: "accepted" },
        },
      });
      expect(executionOutcome).toEqual({
        status: "resolved",
        authorization: "user_request",
      });
      expect(blocked.query).toContain("pg_advisory_xact_lock");
      if (manualOutcome.status !== "resolved") {
        throw new Error("agent cancellation unexpectedly rejected after convergence");
      }

      const durable = await observer.query(
        `SELECT
          (SELECT count(*)::int FROM jobs
             WHERE organization_id = $1 AND agent_id = $2::text) AS jobs,
          (SELECT count(*)::int FROM agent_compute_stop_intents
             WHERE organization_id = $1 AND agent_id = $2::uuid) AS intents,
          (SELECT count(*)::int FROM billing_cancel_commands
             WHERE organization_id = $1 AND resource_id = $2::uuid) AS commands,
          (SELECT count(*)::int FROM billing_cancel_command_keys
             WHERE organization_id = $1) AS keys,
          (SELECT "authorization" FROM agent_compute_stop_intents
             WHERE organization_id = $1 AND agent_id = $2::uuid) AS authorization,
          (SELECT job_id FROM agent_compute_stop_intents
             WHERE organization_id = $1 AND agent_id = $2::uuid) AS intent_job_id,
          (SELECT job_id FROM billing_cancel_commands
             WHERE organization_id = $1 AND resource_id = $2::uuid) AS command_job_id,
          (SELECT id FROM billing_cancel_commands
             WHERE organization_id = $1 AND resource_id = $2::uuid) AS command_id,
          (SELECT command_id FROM billing_cancel_command_keys
             WHERE organization_id = $1) AS key_command_id`,
        [organizationId, agentId],
      );
      expect(durable.rows[0]).toEqual({
        jobs: 1,
        intents: 1,
        commands: 1,
        keys: 1,
        authorization: "user_request",
        intent_job_id: seededJob.id,
        command_job_id: manualOutcome.value.receipt.jobId,
        command_id: manualOutcome.value.receipt.receiptId,
        key_command_id: manualOutcome.value.receipt.receiptId,
      });
    } finally {
      releaseEnqueue.resolve();
      await executor.query("ROLLBACK").catch(() => undefined);
      await Promise.all([executor.end(), observer.end()]);
    }
  }, 15_000);

  test("billing cancellation waits for an interleaved role revocation and then refuses it", async () => {
    if (!isolatedDsn || !dbWrite || !BillingCancellationsService) {
      throw new Error("harness unavailable");
    }
    const organizationId = randomUUID();
    const userId = randomUUID();
    const resourceId = randomUUID();
    const stewardUserId = `steward:${userId}`;
    await dbWrite.execute(
      sql`INSERT INTO organizations(id, credit_balance) VALUES (${organizationId}, 0)`,
    );
    await dbWrite.execute(
      sql`INSERT INTO users(id, organization_id, steward_user_id, role)
          VALUES (${userId}, ${organizationId}, ${stewardUserId}, 'owner')`,
    );

    let enqueueCount = 0;
    const service: BillingResourceCancellationsService = new BillingCancellationsService({
      transact: (callback) => dbWrite!.transaction(callback),
      lockTarget: async () => {},
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
          return stewardUserId;
        },
      });

      await waitUntilBlocked(observer);
      await revoker.query("COMMIT");
      await expect(admission).rejects.toMatchObject({ status: 403, code: "access_denied" });
      expect(enqueueCount).toBe(0);
      const durable = await observer.query(
        `SELECT
          (SELECT count(*)::int FROM jobs WHERE organization_id = $1) AS jobs,
          (SELECT count(*)::int FROM billing_cancel_commands WHERE organization_id = $1) AS commands,
          (SELECT count(*)::int FROM billing_cancel_command_keys WHERE organization_id = $1) AS keys`,
        [organizationId],
      );
      expect(durable.rows[0]).toEqual({ jobs: 0, commands: 0, keys: 0 });
    } finally {
      await revoker.query("ROLLBACK").catch(() => undefined);
      await Promise.all([revoker.end(), observer.end()]);
    }
  }, 15_000);

  test("billing cancellation waits for a steward rebinding and rejects the old credential", async () => {
    if (!isolatedDsn || !dbWrite || !BillingCancellationsService) {
      throw new Error("harness unavailable");
    }
    const organizationId = randomUUID();
    const userId = randomUUID();
    const resourceId = randomUUID();
    const oldStewardUserId = `steward:${userId}`;
    const newStewardUserId = `steward:rebound:${userId}`;
    await dbWrite.execute(
      sql`INSERT INTO organizations(id, credit_balance) VALUES (${organizationId}, 0)`,
    );
    await dbWrite.execute(
      sql`INSERT INTO users(id, organization_id, steward_user_id, role)
          VALUES (${userId}, ${organizationId}, ${oldStewardUserId}, 'owner')`,
    );

    let enqueueCount = 0;
    const service: BillingResourceCancellationsService = new BillingCancellationsService({
      transact: (callback) => dbWrite!.transaction(callback),
      lockTarget: async () => {},
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
    const rebinder = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([rebinder.connect(), observer.connect()]);
    try {
      const admission = service.request({
        organizationId,
        requestedByUserId: userId,
        resourceType: "container",
        resourceId,
        expectedLifecycleRevision: 1,
        idempotencyKey: "cancel-concurrent-steward-rebind-0001",
        authorizeInfrastructureMutation: async () => {
          // The old credential was freshly valid, but its primary identity is
          // rebound before admission can acquire the matching user lock.
          await rebinder.query("BEGIN");
          await rebinder.query("UPDATE users SET steward_user_id = $1 WHERE id = $2", [
            newStewardUserId,
            userId,
          ]);
          return oldStewardUserId;
        },
      });

      await waitUntilBlocked(observer);
      await rebinder.query("COMMIT");
      await expect(admission).rejects.toMatchObject({ status: 403, code: "access_denied" });
      expect(enqueueCount).toBe(0);
      const durable = await observer.query(
        `SELECT
          (SELECT count(*)::int FROM jobs WHERE organization_id = $1) AS jobs,
          (SELECT count(*)::int FROM billing_cancel_commands WHERE organization_id = $1) AS commands,
          (SELECT count(*)::int FROM billing_cancel_command_keys WHERE organization_id = $1) AS keys`,
        [organizationId],
      );
      expect(durable.rows[0]).toEqual({ jobs: 0, commands: 0, keys: 0 });
      const rebound = await observer.query<{ steward_user_id: string }>(
        "SELECT steward_user_id FROM users WHERE id = $1",
        [userId],
      );
      expect(rebound.rows[0]?.steward_user_id).toBe(newStewardUserId);
    } finally {
      await rebinder.query("ROLLBACK").catch(() => undefined);
      await Promise.all([rebinder.end(), observer.end()]);
    }
  }, 15_000);

  test("billing cancellation rejects an identity that expires while waiting for its user lock", async () => {
    if (!isolatedDsn || !dbWrite || !BillingCancellationsService) {
      throw new Error("harness unavailable");
    }
    const organizationId = randomUUID();
    const userId = randomUUID();
    const resourceId = randomUUID();
    const stewardUserId = `steward:${userId}`;
    await dbWrite.execute(
      sql`INSERT INTO organizations(id, credit_balance) VALUES (${organizationId}, 0)`,
    );
    await dbWrite.execute(
      sql`INSERT INTO users(id, organization_id, steward_user_id, role, expires_at)
          VALUES (${userId}, ${organizationId}, ${stewardUserId}, 'owner',
            (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '4 seconds')`,
    );

    let enqueueCount = 0;
    const service: BillingResourceCancellationsService = new BillingCancellationsService({
      transact: (callback) =>
        dbWrite!.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
          return callback(tx);
        }),
      lockTarget: async () => {},
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
    const blocker = new Client({ connectionString: isolatedDsn });
    const observer = new Client({ connectionString: isolatedDsn });
    await Promise.all([blocker.connect(), observer.connect()]);
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE users SET created_at = created_at WHERE id = $1", [userId]);

      const admission = service.request({
        organizationId,
        requestedByUserId: userId,
        resourceType: "container",
        resourceId,
        expectedLifecycleRevision: 1,
        idempotencyKey: "cancel-concurrent-session-expiry-0001",
        authorizeInfrastructureMutation: async () => stewardUserId,
      });
      const observedAdmission = admission.then(
        (value) => ({ status: "resolved" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );

      await waitUntilBlocked(observer);
      const beforeExpiry = await observer.query<{ unexpired: boolean }>(
        `SELECT expires_at > (clock_timestamp() AT TIME ZONE 'UTC') AS unexpired
         FROM users
         WHERE id = $1`,
        [userId],
      );
      expect(beforeExpiry.rows[0]?.unexpired).toBe(true);
      await waitForUserExpiry(observer, userId);
      await blocker.query("COMMIT");
      expect(await observedAdmission).toMatchObject({
        status: "rejected",
        error: { status: 403, code: "access_denied" },
      });
      expect(enqueueCount).toBe(0);
      const durable = await observer.query(
        `SELECT
          (SELECT count(*)::int FROM jobs WHERE organization_id = $1) AS jobs,
          (SELECT count(*)::int FROM billing_cancel_commands WHERE organization_id = $1) AS commands,
          (SELECT count(*)::int FROM billing_cancel_command_keys WHERE organization_id = $1) AS keys`,
        [organizationId],
      );
      expect(durable.rows[0]).toEqual({ jobs: 0, commands: 0, keys: 0 });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await Promise.all([blocker.end(), observer.end()]);
    }
  }, 15_000);

  test("a top-up holding the organization lock wins before stop eligibility is revalidated", async () => {
    if (!isolatedDsn || !dbWrite || !stopService) throw new Error("harness unavailable");
    const organizationId = randomUUID();
    const userId = randomUUID();
    const containerId = randomUUID();
    const stewardUserId = `steward:${userId}`;
    await dbWrite.execute(
      sql`INSERT INTO organizations(id, credit_balance) VALUES (${organizationId}, 0)`,
    );
    await dbWrite.execute(
      sql`INSERT INTO users(id, organization_id, steward_user_id)
          VALUES (${userId}, ${organizationId}, ${stewardUserId})`,
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
      const jobs = await observer.query("SELECT id FROM jobs WHERE organization_id = $1", [
        organizationId,
      ]);
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
    const stewardUserId = `steward:${userId}`;
    await dbWrite.execute(
      sql`INSERT INTO organizations(id, credit_balance) VALUES (${organizationId}, 0)`,
    );
    await dbWrite.execute(
      sql`INSERT INTO users(id, organization_id, steward_user_id)
          VALUES (${userId}, ${organizationId}, ${stewardUserId})`,
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
