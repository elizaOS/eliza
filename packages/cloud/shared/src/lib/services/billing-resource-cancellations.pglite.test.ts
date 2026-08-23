/**
 * Durable billing-cancellation admission against real PGlite transactions.
 * Provider work is replaced by a transaction-scoped job insert so these tests
 * isolate the receipt/key authority without performing infrastructure I/O.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { sqlRows } from "../../db/execute-helpers";
import { agentComputeStopIntents } from "../../db/schemas/agent-compute-stop-intents";
import { containerComputeStopIntents } from "../../db/schemas/compute-stop-intents";
import { jobs } from "../../db/schemas/jobs";
import { ApiError } from "../api/cloud-worker-errors";
import type {
  BillingResourceCancellationsDependencies,
  BillingResourceCancellationsService,
  RequestBillingCancellationOptions,
} from "./billing-resource-cancellations";

const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const USER_A = "20000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const RESOURCE = "3a000000-0000-4000-8000-000000000001";
const OTHER_RESOURCE = "3b000000-0000-4000-8000-000000000002";
const TERMINAL_RESOURCE = "3c000000-0000-4000-8000-000000000003";

let dbWrite: typeof import("../../db/client").dbWrite;
let closeDb: typeof import("../../db/client").closeDatabaseConnectionsForTests;
let Service: typeof BillingResourceCancellationsService;
let enqueueCount = 0;
const currentRevisions = new Map<string, number>();

beforeAll(async () => {
  process.env.DATABASE_URL = "pglite://memory";
  process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";
  const client = await import("../../db/client");
  dbWrite = client.dbWrite;
  closeDb = client.closeDatabaseConnectionsForTests;
  ({ BillingResourceCancellationsService: Service } = await import(
    "./billing-resource-cancellations"
  ));

  await client.getPgliteClientForTests().exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL UNIQUE
    );
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      CONSTRAINT users_id_org_unique UNIQUE (id, organization_id)
    );
    CREATE TABLE jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      data jsonb NOT NULL,
      data_storage text NOT NULL DEFAULT 'inline',
      data_key text,
      agent_id text,
      character_id text,
      result jsonb,
      result_storage text NOT NULL DEFAULT 'inline',
      result_key text,
      error text,
      error_storage text NOT NULL DEFAULT 'inline',
      error_key text,
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3,
      execution_interruptions integer NOT NULL DEFAULT 0,
      retryable_requeues integer NOT NULL DEFAULT 0,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      user_id uuid REFERENCES users(id),
      api_key_id uuid,
      generation_id uuid,
      webhook_url text,
      webhook_status text,
      estimated_completion_at timestamp,
      scheduled_for timestamp NOT NULL DEFAULT now(),
      started_at timestamp,
      execution_generation uuid,
      execution_quiesced_at timestamp,
      completed_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT jobs_id_org_unique UNIQUE (id, organization_id),
      CONSTRAINT jobs_retryable_requeues_nonnegative_check CHECK (retryable_requeues >= 0)
    );
    CREATE TABLE container_compute_stop_intents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      container_id uuid NOT NULL,
      lifecycle_revision bigint NOT NULL,
      "authorization" text NOT NULL DEFAULT 'billing_request',
      status text NOT NULL DEFAULT 'pending',
      job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      provider_started_at timestamptz,
      provider_confirmed_at timestamptz,
      provider_node_id text,
      slot_released_at timestamptz,
      superseded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX container_compute_stop_intents_user_generation_unique
      ON container_compute_stop_intents (organization_id, container_id, lifecycle_revision)
      WHERE "authorization" = 'user_request';
    CREATE TABLE agent_compute_stop_intents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      agent_id uuid NOT NULL,
      lifecycle_revision bigint NOT NULL,
      "authorization" text NOT NULL DEFAULT 'billing_request',
      status text NOT NULL DEFAULT 'pending',
      job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      provider_started_at timestamptz,
      provider_confirmed_at timestamptz,
      superseded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX agent_compute_stop_intents_user_request_unique
      ON agent_compute_stop_intents (organization_id, agent_id, lifecycle_revision)
      WHERE "authorization" = 'user_request';
    CREATE TABLE billing_cancel_commands (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      requested_by_user_id uuid NOT NULL,
      resource_type text NOT NULL,
      resource_id uuid NOT NULL,
      expected_lifecycle_revision bigint NOT NULL,
      action text NOT NULL DEFAULT 'stop',
      job_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT billing_cancel_commands_id_org_unique UNIQUE (id, organization_id),
      CONSTRAINT billing_cancel_commands_job_unique UNIQUE (job_id),
      CONSTRAINT billing_cancel_commands_requesting_user_tenant_fkey
        FOREIGN KEY (requested_by_user_id, organization_id)
        REFERENCES users(id, organization_id) ON DELETE RESTRICT,
      CONSTRAINT billing_cancel_commands_job_tenant_fkey
        FOREIGN KEY (job_id, organization_id)
        REFERENCES jobs(id, organization_id) ON DELETE RESTRICT,
      CONSTRAINT billing_cancel_commands_shape_check CHECK (
        resource_type IN ('container', 'agent_sandbox')
        AND action = 'stop'
        AND expected_lifecycle_revision >= 0
      )
    );
    CREATE UNIQUE INDEX billing_cancel_commands_logical_unique
      ON billing_cancel_commands (
        organization_id, resource_type, resource_id, expected_lifecycle_revision, action
      );
    CREATE INDEX billing_cancel_commands_org_created_idx
      ON billing_cancel_commands (organization_id, created_at);
    CREATE TABLE billing_cancel_command_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      idempotency_key_hash text NOT NULL,
      request_digest text NOT NULL,
      command_id uuid NOT NULL,
      requested_by_user_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT billing_cancel_command_keys_org_key_unique
        UNIQUE (organization_id, idempotency_key_hash),
      CONSTRAINT billing_cancel_command_keys_command_tenant_fkey
        FOREIGN KEY (command_id, organization_id)
        REFERENCES billing_cancel_commands(id, organization_id) ON DELETE RESTRICT,
      CONSTRAINT billing_cancel_command_keys_requesting_user_tenant_fkey
        FOREIGN KEY (requested_by_user_id, organization_id)
        REFERENCES users(id, organization_id) ON DELETE RESTRICT,
      CONSTRAINT billing_cancel_command_keys_digest_shape_check CHECK (
        idempotency_key_hash ~ '^[a-f0-9]{64}$'
        AND request_digest ~ '^[a-f0-9]{64}$'
      )
    );
    CREATE INDEX billing_cancel_command_keys_command_idx
      ON billing_cancel_command_keys (command_id);
  `);
});

afterAll(async () => closeDb());

beforeEach(async () => {
  await dbWrite.execute(sql`DELETE FROM billing_cancel_command_keys`);
  await dbWrite.execute(sql`DELETE FROM billing_cancel_commands`);
  await dbWrite.execute(sql`DELETE FROM container_compute_stop_intents`);
  await dbWrite.execute(sql`DELETE FROM agent_compute_stop_intents`);
  await dbWrite.execute(sql`DELETE FROM jobs`);
  await dbWrite.execute(sql`DELETE FROM users`);
  await dbWrite.execute(sql`DELETE FROM organizations`);
  await dbWrite.execute(sql`
    INSERT INTO organizations (id, name, slug) VALUES
      (${ORG_A}, 'A', 'a'), (${ORG_B}, 'B', 'b')
  `);
  await dbWrite.execute(sql`
    INSERT INTO users (id, organization_id) VALUES
      (${USER_A}, ${ORG_A}), (${USER_B}, ${ORG_B})
  `);
  currentRevisions.clear();
  currentRevisions.set(`${ORG_A}:${RESOURCE}`, 7);
  currentRevisions.set(`${ORG_A}:${OTHER_RESOURCE}`, 3);
  currentRevisions.set(`${ORG_A}:${TERMINAL_RESOURCE}`, 9);
  currentRevisions.set(`${ORG_B}:${RESOURCE}`, 7);
  enqueueCount = 0;
});

function createService(): BillingResourceCancellationsService {
  const dependencies: BillingResourceCancellationsDependencies = {
    transact: (callback) => dbWrite.transaction(callback),
    enqueueStop: async (tx: DbTransaction, options: RequestBillingCancellationOptions) => {
      const current = currentRevisions.get(`${options.organizationId}:${options.resourceId}`);
      if (current === undefined) {
        throw new ApiError(404, "resource_not_found", "Billable resource not found");
      }
      if (current !== options.expectedLifecycleRevision) {
        throw new ApiError(409, "billing_state_conflict", "Billable resource lifecycle changed", {
          expectedLifecycleRevision: options.expectedLifecycleRevision,
          currentLifecycleRevision: current,
        });
      }
      enqueueCount += 1;
      const [job] = await tx
        .insert(jobs)
        .values({
          type: options.resourceType === "container" ? "container_stop" : "agent_suspend",
          status: "pending",
          data: {
            resourceId: options.resourceId,
            expectedLifecycleRevision: options.expectedLifecycleRevision,
          },
          organization_id: options.organizationId,
          user_id: options.requestedByUserId,
          agent_id: options.resourceType === "agent_sandbox" ? options.resourceId : null,
        })
        .returning({ id: jobs.id });
      if (!job) throw new Error("test job insert returned no row");
      if (options.resourceType === "container") {
        await tx.insert(containerComputeStopIntents).values({
          organization_id: options.organizationId,
          container_id: options.resourceId,
          lifecycle_revision: options.expectedLifecycleRevision,
          authorization: "user_request",
          job_id: job.id,
        });
      } else {
        await tx.insert(agentComputeStopIntents).values({
          organization_id: options.organizationId,
          agent_id: options.resourceId,
          lifecycle_revision: options.expectedLifecycleRevision,
          authorization: "user_request",
          job_id: job.id,
        });
      }
      return { jobId: job.id };
    },
    triggerImmediate: async () => {},
  };
  return new Service(dependencies);
}

function request(
  service: BillingResourceCancellationsService,
  overrides: Partial<RequestBillingCancellationOptions> = {},
) {
  return service.request({
    organizationId: ORG_A,
    requestedByUserId: USER_A,
    resourceType: "container",
    resourceId: RESOURCE,
    expectedLifecycleRevision: 7,
    idempotencyKey: "cancel-request-0001",
    authorizeInfrastructureMutation: async () => {},
    ...overrides,
  });
}

async function authorityCounts() {
  const [counts] = await sqlRows<{
    commands: number;
    keys: number;
    jobs: number;
  }>(
    dbWrite,
    sql`SELECT
      (SELECT count(*)::int FROM billing_cancel_commands) AS commands,
      (SELECT count(*)::int FROM billing_cancel_command_keys) AS keys,
      (SELECT count(*)::int FROM jobs) AS jobs`,
  );
  if (!counts) throw new Error("authority count query returned no row");
  return counts;
}

describe("billing cancellation durable receipt authority", () => {
  test("a retry after a lost response replays the same receipt and job", async () => {
    const service = createService();
    const first = await request(service, { resourceId: RESOURCE.toUpperCase() });
    const replay = await request(service);

    expect(first.disposition).toBe("accepted");
    expect(replay.disposition).toBe("same_key_replay");
    expect(replay.receipt).toEqual(first.receipt);
    expect(first.receipt.resourceId).toBe(RESOURCE);
    expect(enqueueCount).toBe(1);
    expect(await authorityCounts()).toEqual({ commands: 1, keys: 1, jobs: 1 });
  });

  test("one key cannot be rebound to a different request digest", async () => {
    const service = createService();
    const first = await request(service);

    const conflict = request(service, {
      resourceId: OTHER_RESOURCE,
      expectedLifecycleRevision: 3,
    });
    await expect(conflict).rejects.toMatchObject({
      status: 409,
      code: "billing_state_conflict",
      details: { receiptId: first.receipt.receiptId },
    });
    expect(enqueueCount).toBe(1);
    expect(await authorityCounts()).toEqual({ commands: 1, keys: 1, jobs: 1 });
  });

  test("two tabs with distinct keys converge on one logical command", async () => {
    const service = createService();
    const [left, right] = await Promise.all([
      request(service, { idempotencyKey: "cancel-request-left" }),
      request(service, { idempotencyKey: "cancel-request-right" }),
    ]);

    expect(new Set([left.disposition, right.disposition])).toEqual(
      new Set(["accepted", "same_command"]),
    );
    expect(right.receipt.receiptId).toBe(left.receipt.receiptId);
    expect(right.receipt.jobId).toBe(left.receipt.jobId);
    expect(enqueueCount).toBe(1);
    expect(await authorityCounts()).toEqual({ commands: 1, keys: 2, jobs: 1 });
  });

  test("the same client key remains independent across tenants", async () => {
    const service = createService();
    const first = await request(service);
    const second = await request(service, {
      organizationId: ORG_B,
      requestedByUserId: USER_B,
    });

    expect(second.receipt.receiptId).not.toBe(first.receipt.receiptId);
    expect(second.receipt.jobId).not.toBe(first.receipt.jobId);
    expect(enqueueCount).toBe(2);
    expect(await authorityCounts()).toEqual({ commands: 2, keys: 2, jobs: 2 });
  });

  test("a stale lifecycle creates no job, command, or key", async () => {
    const service = createService();
    await expect(request(service, { expectedLifecycleRevision: 6 })).rejects.toMatchObject({
      status: 409,
      code: "billing_state_conflict",
      details: { expectedLifecycleRevision: 6, currentLifecycleRevision: 7 },
    });
    expect(enqueueCount).toBe(0);
    expect(await authorityCounts()).toEqual({ commands: 0, keys: 0, jobs: 0 });
  });

  test("final authority loss rolls back before the durable stop effect", async () => {
    const service = createService();
    await expect(
      request(service, {
        authorizeInfrastructureMutation: async () => {
          throw new ApiError(403, "access_denied", "Billing role changed");
        },
      }),
    ).rejects.toMatchObject({ status: 403, code: "access_denied" });
    expect(enqueueCount).toBe(0);
    expect(await authorityCounts()).toEqual({ commands: 0, keys: 0, jobs: 0 });
  });

  test("receipt replay projects provider confirmation and supersession", async () => {
    const service = createService();
    const confirmed = await request(service);
    await dbWrite
      .update(containerComputeStopIntents)
      .set({ status: "provider_confirmed", provider_confirmed_at: new Date() })
      .where(eq(containerComputeStopIntents.job_id, confirmed.receipt.jobId));
    await dbWrite
      .update(jobs)
      .set({ status: "completed", result: { containerStopped: true }, completed_at: new Date() })
      .where(eq(jobs.id, confirmed.receipt.jobId));
    const confirmedReplay = await request(service);
    expect(confirmedReplay.receipt).toMatchObject({
      status: "provider_confirmed",
      billingStopped: true,
      infrastructureStatus: "provider_confirmed",
    });

    const superseded = await request(service, {
      resourceId: OTHER_RESOURCE,
      expectedLifecycleRevision: 3,
      idempotencyKey: "cancel-request-0002",
    });
    await dbWrite
      .update(containerComputeStopIntents)
      .set({ status: "superseded", superseded_at: new Date() })
      .where(eq(containerComputeStopIntents.job_id, superseded.receipt.jobId));
    await dbWrite
      .update(jobs)
      .set({
        status: "in_progress",
        result: null,
        completed_at: null,
      })
      .where(eq(jobs.id, superseded.receipt.jobId));
    const supersededReplay = await request(service, {
      resourceId: OTHER_RESOURCE,
      expectedLifecycleRevision: 3,
      idempotencyKey: "cancel-request-0002",
    });
    expect(supersededReplay.receipt).toMatchObject({
      status: "conflict",
      billingStopped: false,
      infrastructureStatus: "superseded",
    });

    const terminal = await request(service, {
      resourceType: "agent_sandbox",
      resourceId: TERMINAL_RESOURCE,
      expectedLifecycleRevision: 9,
      idempotencyKey: "cancel-request-0003",
    });
    await dbWrite
      .update(agentComputeStopIntents)
      .set({ status: "terminal_attention", last_error: "provider retries exhausted" })
      .where(eq(agentComputeStopIntents.job_id, terminal.receipt.jobId));
    const terminalReplay = await request(service, {
      resourceType: "agent_sandbox",
      resourceId: TERMINAL_RESOURCE,
      expectedLifecycleRevision: 9,
      idempotencyKey: "cancel-request-0003",
    });
    expect(terminalReplay.receipt).toMatchObject({
      status: "terminal_attention",
      billingStopped: false,
      infrastructureStatus: "terminal_attention",
    });
  });

  test("provider-confirmed intent remains authoritative when job settlement is incomplete", async () => {
    const service = createService();
    const container = await request(service);
    const agent = await request(service, {
      resourceType: "agent_sandbox",
      resourceId: OTHER_RESOURCE,
      expectedLifecycleRevision: 3,
      idempotencyKey: "cancel-request-agent-0001",
    });

    await dbWrite
      .update(containerComputeStopIntents)
      .set({ status: "provider_confirmed", provider_confirmed_at: new Date() })
      .where(eq(containerComputeStopIntents.job_id, container.receipt.jobId));
    await dbWrite
      .update(agentComputeStopIntents)
      .set({ status: "provider_confirmed", provider_confirmed_at: new Date() })
      .where(eq(agentComputeStopIntents.job_id, agent.receipt.jobId));
    await dbWrite
      .update(jobs)
      .set({ status: "in_progress" })
      .where(eq(jobs.id, container.receipt.jobId));
    await dbWrite
      .update(jobs)
      .set({ status: "failed", error: "settlement crashed" })
      .where(eq(jobs.id, agent.receipt.jobId));

    const containerReplay = await request(service);
    const agentReplay = await request(service, {
      resourceType: "agent_sandbox",
      resourceId: OTHER_RESOURCE,
      expectedLifecycleRevision: 3,
      idempotencyKey: "cancel-request-agent-0001",
    });
    for (const replay of [containerReplay, agentReplay]) {
      expect(replay.receipt).toMatchObject({
        status: "provider_confirmed",
        billingStopped: true,
        infrastructureStatus: "provider_confirmed",
      });
    }
  });

  test("invalid keys fail before authorization or durable writes", async () => {
    const service = createService();
    let authorized = false;
    await expect(
      request(service, {
        idempotencyKey: "short",
        authorizeInfrastructureMutation: async () => {
          authorized = true;
        },
      }),
    ).rejects.toMatchObject({ status: 400, code: "validation_error" });
    expect(authorized).toBe(false);
    expect(await authorityCounts()).toEqual({ commands: 0, keys: 0, jobs: 0 });
  });

  test("invalid resource ids fail before database UUID coercion", async () => {
    const service = createService();
    let authorized = false;
    await expect(
      request(service, {
        resourceId: "not-a-uuid",
        authorizeInfrastructureMutation: async () => {
          authorized = true;
        },
      }),
    ).rejects.toMatchObject({ status: 400, code: "validation_error" });
    expect(authorized).toBe(false);
    expect(await authorityCounts()).toEqual({ commands: 0, keys: 0, jobs: 0 });
  });
});
