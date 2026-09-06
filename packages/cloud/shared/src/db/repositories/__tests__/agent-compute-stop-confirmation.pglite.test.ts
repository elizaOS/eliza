/**
 * Exercises stop receipt writes and the additive upgrade on real PGlite.
 * The pre-upgrade fixture contains the columns consumed by this boundary;
 * production lifecycle SQL supplies the generation trigger.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { agentComputeStopIntents } from "../../schemas/agent-compute-stop-intents";
import {
  confirmAgentComputeStopInTransaction,
  listAgentPaymentResumeCandidates,
  lockAgentPaymentResumeAuthorityInTransaction,
  releaseAgentLifecycleBindingInTransaction,
} from "../agent-compute-stop-intents";

const agentId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000002";
const intentId = "00000000-0000-4000-8000-000000000003";
const otherOrganizationId = "00000000-0000-4000-8000-000000000004";
const confirmedAt = new Date("2026-09-05T12:00:00Z");
const input = { agentId, organizationId, intentId, confirmedAt, retainedBackupRatePerHour: null };

beforeAll(async () => {
  await dbWrite.execute(
    sql.raw(`CREATE TABLE jobs (
    id uuid PRIMARY KEY, type text, agent_id text, organization_id uuid,
    user_id uuid, status text, execution_quiesced_at timestamptz, completed_at timestamptz
  )`),
  );
  await dbWrite.execute(
    sql.raw(`CREATE TABLE job_execution_leases (
    job_id uuid, expires_at timestamptz
  )`),
  );
  await dbWrite.execute(
    sql.raw(`
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL,
      status text NOT NULL, lifecycle_revision bigint NOT NULL,
      user_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000005',
      execution_tier text NOT NULL DEFAULT 'dedicated-always', pool_status text,
      deletion_attempt_id uuid, deletion_started_at timestamptz, deleted_at timestamptz,
      replacement_cleanup_sandbox_id text, replacement_cleanup_attempt_id uuid,
      replacement_cleanup_container_id text, lifecycle_job_id uuid, lifecycle_execution_generation uuid
    );
  `),
  );
  await dbWrite.execute(
    sql.raw(`
    CREATE TABLE agent_compute_stop_intents (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, agent_id uuid NOT NULL,
      status text NOT NULL, provider_confirmed_at timestamptz, job_id uuid,
      "authorization" text NOT NULL DEFAULT 'billing_request', lifecycle_revision bigint NOT NULL DEFAULT 0,
      retained_backup_billing boolean NOT NULL DEFAULT false,
      retained_backup_rate_per_hour numeric(18,6), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `),
  );
  const migration = await readFile(
    new URL("../../migrations/0362_agent_compute_stop_confirmed_revision.sql", import.meta.url),
    "utf8",
  );
  await dbWrite.execute(sql`INSERT INTO agent_compute_stop_intents
    (id, organization_id, agent_id, status, provider_confirmed_at)
    VALUES (${intentId}, ${organizationId}, ${agentId}, 'provider_confirmed', ${confirmedAt})`);
  for (let replay = 0; replay < 2; replay++) {
    for (const statement of migration.split("--> statement-breakpoint")) {
      await dbWrite.execute(sql.raw(statement));
    }
  }
  const [legacy] = await dbWrite
    .select({ revision: agentComputeStopIntents.provider_confirmed_lifecycle_revision })
    .from(agentComputeStopIntents)
    .where(eq(agentComputeStopIntents.id, intentId));
  expect(legacy?.revision).toBeNull();
  const retentionMigration = await readFile(
    new URL("../../migrations/0363_agent_local_state_retention.sql", import.meta.url),
    "utf8",
  );
  await dbWrite.execute(sql.raw(retentionMigration));
  const lifecycleMigration = await readFile(
    new URL("../../migrations/0189_agent_sandbox_lifecycle_revision_scope.sql", import.meta.url),
    "utf8",
  );
  for (const statement of lifecycleMigration.split("--> statement-breakpoint")) {
    await dbWrite.execute(sql.raw(statement));
  }
}, 60_000);

beforeEach(async () => {
  await dbWrite.execute(sql`DELETE FROM agent_compute_stop_intents`);
  await dbWrite.execute(sql`DELETE FROM agent_sandboxes`);
  await dbWrite.execute(sql`INSERT INTO agent_sandboxes (id, organization_id, status, lifecycle_revision)
    VALUES (${agentId}, ${organizationId}, 'running', 9007199254740993)`);
  await dbWrite.execute(sql`INSERT INTO agent_compute_stop_intents (id, organization_id, agent_id, status)
    VALUES (${intentId}, ${organizationId}, ${agentId}, 'dispatching')`);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function receipt() {
  const [row] = await dbWrite
    .select({
      status: agentComputeStopIntents.status,
      revision: agentComputeStopIntents.provider_confirmed_lifecycle_revision,
      retained: agentComputeStopIntents.retained_backup_billing,
      rate: agentComputeStopIntents.retained_backup_rate_per_hour,
    })
    .from(agentComputeStopIntents)
    .where(eq(agentComputeStopIntents.id, intentId));
  return row;
}

test("captures the post-stop trigger revision without a number round trip", async () => {
  await dbWrite.transaction(async (tx) => {
    await tx.execute(sql`UPDATE agent_sandboxes SET status = 'stopped' WHERE id = ${agentId}`);
    await confirmAgentComputeStopInTransaction(tx, {
      ...input,
      retainedBackupRatePerHour: "0.001",
    });
  });
  expect(await receipt()).toEqual({
    status: "provider_confirmed",
    revision: 9007199254740994n,
    retained: true,
    rate: "0.001000",
  });
  await dbWrite.execute(sql`UPDATE agent_sandboxes SET status = 'running' WHERE id = ${agentId}`);
  await dbWrite.execute(sql`UPDATE agent_sandboxes SET status = 'stopped' WHERE id = ${agentId}`);
  await expect(
    dbWrite.transaction((tx) => confirmAgentComputeStopInTransaction(tx, input)),
  ).rejects.toMatchObject({ code: "AGENT_STOP_CONFIRMATION_CONFLICT" });
  expect((await receipt())?.revision).toBe(9007199254740994n);
});

test("does not confirm a running agent", async () => {
  await expect(
    dbWrite.transaction((tx) => confirmAgentComputeStopInTransaction(tx, input)),
  ).rejects.toMatchObject({ code: "AGENT_STOP_CONFIRMATION_CONFLICT" });
  expect((await receipt())?.status).toBe("dispatching");
  expect((await receipt())?.revision).toBeNull();
});

test("rejects a different tenant and rolls back the attempted stop", async () => {
  await expect(
    dbWrite.transaction(async (tx) => {
      await tx.execute(sql`UPDATE agent_sandboxes SET status = 'stopped' WHERE id = ${agentId}`);
      await confirmAgentComputeStopInTransaction(tx, {
        ...input,
        organizationId: otherOrganizationId,
      });
    }),
  ).rejects.toMatchObject({ code: "AGENT_STOP_CONFIRMATION_CONFLICT" });
  const state = await dbWrite.execute(
    sql`SELECT status FROM agent_sandboxes WHERE id = ${agentId}`,
  );
  expect(state.rows[0]?.status).toBe("running");
  expect((await receipt())?.revision).toBeNull();
});

test("does not resurrect superseded stop authority", async () => {
  await dbWrite.execute(sql`UPDATE agent_sandboxes SET status = 'stopped' WHERE id = ${agentId}`);
  await dbWrite.execute(
    sql`UPDATE agent_compute_stop_intents SET status = 'superseded' WHERE id = ${intentId}`,
  );
  await expect(
    dbWrite.transaction((tx) => confirmAgentComputeStopInTransaction(tx, input)),
  ).rejects.toMatchObject({ code: "AGENT_STOP_CONFIRMATION_CONFLICT" });
  expect((await receipt())?.status).toBe("superseded");
});

test("rejects a claimed generation without a confirmed provider outcome", async () => {
  await expect(
    Promise.resolve(
      dbWrite.execute(sql`UPDATE agent_compute_stop_intents
    SET provider_confirmed_lifecycle_revision = 7 WHERE id = ${intentId}`),
    ),
  ).rejects.toThrow();
  expect((await receipt())?.revision).toBeNull();
});

test("discovers an exact payment stop and excludes later manual stops without a revision change", async () => {
  await dbWrite.transaction(async (tx) => {
    await tx.execute(sql`UPDATE agent_sandboxes SET status = 'stopped' WHERE id = ${agentId}`);
    await confirmAgentComputeStopInTransaction(tx, input);
  });
  const firstPage = await listAgentPaymentResumeCandidates({ limit: 1 });
  expect(firstPage).toEqual([
    {
      intentId,
      agentId,
      organizationId,
      userId: "00000000-0000-4000-8000-000000000005",
      lifecycleRevision: "9007199254740994",
    },
  ]);
  expect(await listAgentPaymentResumeCandidates({ limit: 1, afterIntentId: intentId })).toEqual([]);
  const manualId = "00000000-0000-4000-8000-000000000006";
  await dbWrite.execute(sql`INSERT INTO agent_compute_stop_intents
    (id, organization_id, agent_id, "authorization", status, lifecycle_revision)
    VALUES (${manualId}, ${organizationId}, ${agentId}, 'user_request', 'provider_confirmed', 9007199254740994)`);
  expect(await listAgentPaymentResumeCandidates({ limit: 10 })).toEqual([]);
});

test("keeps legacy unknown and replaced generations out of automatic discovery", async () => {
  await dbWrite.execute(sql`UPDATE agent_sandboxes SET status = 'stopped' WHERE id = ${agentId}`);
  await dbWrite.execute(sql`UPDATE agent_compute_stop_intents SET status = 'provider_confirmed',
    provider_confirmed_at = ${confirmedAt} WHERE id = ${intentId}`);
  expect(await listAgentPaymentResumeCandidates({ limit: 10 })).toEqual([]);
  await dbWrite.execute(sql`UPDATE agent_compute_stop_intents
    SET provider_confirmed_lifecycle_revision = 9007199254740993 WHERE id = ${intentId}`);
  expect(await listAgentPaymentResumeCandidates({ limit: 10 })).toEqual([]);
});

test("retains deletion and replacement cleanup fences during discovery", async () => {
  await dbWrite.transaction(async (tx) => {
    await tx.execute(sql`UPDATE agent_sandboxes SET status = 'stopped',
      replacement_cleanup_sandbox_id = 'retained-candidate' WHERE id = ${agentId}`);
    await confirmAgentComputeStopInTransaction(tx, input);
  });
  expect(await listAgentPaymentResumeCandidates({ limit: 10 })).toEqual([]);
});

test("locked admission rejects a manual stop arriving after discovery", async () => {
  await dbWrite.transaction(async (tx) => {
    await tx.execute(sql`UPDATE agent_sandboxes SET status = 'stopped' WHERE id = ${agentId}`);
    await confirmAgentComputeStopInTransaction(tx, input);
  });
  const [candidate] = await listAgentPaymentResumeCandidates({ limit: 1 });
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Expected a confirmed payment suspension fixture");
  expect(
    await dbWrite.transaction((tx) => lockAgentPaymentResumeAuthorityInTransaction(tx, candidate)),
  ).toEqual(candidate);
  await dbWrite.execute(sql`INSERT INTO agent_compute_stop_intents
    (id, organization_id, agent_id, "authorization", status, lifecycle_revision)
    VALUES ('00000000-0000-4000-8000-000000000007', ${organizationId}, ${agentId}, 'user_request', 'pending', 9007199254740994)`);
  expect(
    await dbWrite.transaction((tx) => lockAgentPaymentResumeAuthorityInTransaction(tx, candidate)),
  ).toBeUndefined();
});

test("locked admission refuses changed owner identity and noncanonical revision input", async () => {
  await dbWrite.transaction(async (tx) => {
    await tx.execute(sql`UPDATE agent_sandboxes SET status = 'stopped' WHERE id = ${agentId}`);
    await confirmAgentComputeStopInTransaction(tx, input);
  });
  const [candidate] = await listAgentPaymentResumeCandidates({ limit: 1 });
  if (!candidate) throw new Error("Expected a confirmed payment suspension fixture");
  expect(
    await dbWrite.transaction((tx) =>
      lockAgentPaymentResumeAuthorityInTransaction(tx, {
        ...candidate,
        userId: otherOrganizationId,
      }),
    ),
  ).toBeUndefined();
  for (const lifecycleRevision of ["01", "1e2", "-1", "9223372036854775808"]) {
    await expect(
      dbWrite.transaction((tx) =>
        lockAgentPaymentResumeAuthorityInTransaction(tx, {
          ...candidate,
          lifecycleRevision,
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_PAYMENT_RESUME_REVISION" });
  }
});

const stopJobId = "00000000-0000-4000-8000-000000000008";
const stopExecutionGeneration = "00000000-0000-4000-8000-000000000009";
const releaseInput = {
  agentId,
  organizationId,
  jobId: stopJobId,
  executionGeneration: stopExecutionGeneration,
  preserveConfirmedStop: true,
};

async function confirmOwnedStop() {
  await dbWrite.transaction(async (tx) => {
    await tx.execute(sql`UPDATE agent_sandboxes SET status = 'stopped', lifecycle_job_id = ${stopJobId},
      lifecycle_execution_generation = ${stopExecutionGeneration} WHERE id = ${agentId}`);
    await tx.execute(
      sql`UPDATE agent_compute_stop_intents SET job_id = ${stopJobId} WHERE id = ${intentId}`,
    );
    await confirmAgentComputeStopInTransaction(tx, input);
  });
}

test("completed stop remains discoverable after its execution binding is released", async () => {
  await confirmOwnedStop();
  const before = await receipt();
  await dbWrite.transaction((tx) => releaseAgentLifecycleBindingInTransaction(tx, releaseInput));
  const [candidate] = await listAgentPaymentResumeCandidates({ limit: 1 });
  expect(candidate?.intentId).toBe(intentId);
  expect(candidate?.lifecycleRevision).not.toBe(String(before?.revision));
  const state = await dbWrite.execute<{ revision: string; lifecycle_job_id: string | null }>(
    sql`SELECT lifecycle_revision::text AS revision, lifecycle_job_id FROM agent_sandboxes WHERE id = ${agentId}`,
  );
  expect(candidate?.lifecycleRevision).toBe(state.rows[0]?.revision);
  expect(state.rows[0]?.lifecycle_job_id).toBeNull();
});

test("release cannot refresh a receipt across a real lifecycle change", async () => {
  await confirmOwnedStop();
  const before = await receipt();
  await dbWrite.execute(sql`UPDATE agent_sandboxes SET status = 'running' WHERE id = ${agentId}`);
  await dbWrite.execute(sql`UPDATE agent_sandboxes SET status = 'stopped' WHERE id = ${agentId}`);
  await dbWrite.transaction((tx) => releaseAgentLifecycleBindingInTransaction(tx, releaseInput));
  expect((await receipt())?.revision).toBe(before?.revision);
  expect(await listAgentPaymentResumeCandidates({ limit: 1 })).toEqual([]);
});

test("a stale worker cannot release a newer execution binding", async () => {
  await confirmOwnedStop();
  await dbWrite.transaction((tx) =>
    releaseAgentLifecycleBindingInTransaction(tx, {
      ...releaseInput,
      executionGeneration: otherOrganizationId,
    }),
  );
  const state = await dbWrite.execute(
    sql`SELECT lifecycle_job_id FROM agent_sandboxes WHERE id = ${agentId}`,
  );
  expect(state.rows[0]?.lifecycle_job_id).toBe(stopJobId);
});

test("manual stop intent remains authoritative across billing job release", async () => {
  await confirmOwnedStop();
  const confirmed = await receipt();
  await dbWrite.execute(sql`INSERT INTO agent_compute_stop_intents
    (id, organization_id, agent_id, "authorization", status, lifecycle_revision)
    VALUES ('00000000-0000-4000-8000-000000000010', ${organizationId}, ${agentId}, 'user_request', 'provider_confirmed', ${String(confirmed?.revision)}::bigint)`);
  await dbWrite.transaction((tx) => releaseAgentLifecycleBindingInTransaction(tx, releaseInput));
  expect(await listAgentPaymentResumeCandidates({ limit: 1 })).toEqual([]);
});
