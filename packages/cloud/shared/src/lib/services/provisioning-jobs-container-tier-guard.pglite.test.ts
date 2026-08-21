/**
 * Exercises container-tier admission and pre-dispatch rejection against real
 * PGlite state. The harness drives the lifecycle enqueue transaction, worker
 * claim/lease path, locked sandbox authority read, and exact terminal
 * settlement; only the final resource handler is replaced with an explicit
 * completion callback for the two shared-runtime exemptions.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { jobsRepository } from "../../db/repositories/jobs";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { jobExecutionLeases } from "../../db/schemas/job-execution-leases";
import type { Job } from "../../db/schemas/jobs";
import { jobs } from "../../db/schemas/jobs";
import { organizations } from "../../db/schemas/organizations";
import { users } from "../../db/schemas/users";
import { PROVISIONING_JOB_TEST_TABLES } from "./__tests__/tier-upgrade-pglite-schema";
import { JOB_TYPES, type ProvisioningJobType } from "./provisioning-job-types";
import { ProvisioningJobService } from "./provisioning-jobs";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const PGLITE_TIMEOUT = 300_000;
const OWNER_ID = "00000000-0000-4000-8000-000000229470";
const OTHER_OWNER_ID = "00000000-0000-4000-8000-000000229471";
const OTHER_GENERATION = "00000000-0000-4000-8000-000000229472";
const REQUIRED_JOB_TYPES = [
  JOB_TYPES.AGENT_PROVISION,
  JOB_TYPES.AGENT_SUSPEND,
  JOB_TYPES.AGENT_RESUME,
  JOB_TYPES.AGENT_SLEEP,
  JOB_TYPES.AGENT_WAKE,
  JOB_TYPES.AGENT_RESTART,
  JOB_TYPES.AGENT_UPGRADE,
  JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
  JOB_TYPES.AGENT_DOWNGRADE,
  JOB_TYPES.AGENT_LOGS,
  JOB_TYPES.AGENT_SNAPSHOT,
] as const satisfies readonly ProvisioningJobType[];

let pgliteReady = true;
let sequence = 0;

function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedOwner(): Promise<{ organizationId: string; userId: string }> {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Container Tier Guard", slug: unique("tier-guard") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ organization_id: organization.id, steward_user_id: unique("steward") })
    .returning();
  return { organizationId: organization.id, userId: user.id };
}

async function seedSandbox(executionTier: string): Promise<{
  agentId: string;
  organizationId: string;
  userId: string;
}> {
  const owner = await seedOwner();
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: owner.organizationId,
      user_id: owner.userId,
      agent_name: unique("agent"),
      execution_tier: executionTier as never,
      status: "running",
    })
    .returning();
  return { agentId: sandbox.id, ...owner };
}

function agentJobData(
  type: ProvisioningJobType,
  identity: { agentId: string; organizationId: string; userId: string },
): Record<string, unknown> {
  const common = {
    agentId: identity.agentId,
    organizationId: identity.organizationId,
    userId: identity.userId,
  };
  switch (type) {
    case JOB_TYPES.AGENT_PROVISION:
      return { ...common, agentName: "Tier Guard Agent" };
    case JOB_TYPES.AGENT_DELETE:
      return common;
    case JOB_TYPES.AGENT_SUSPEND:
      return { ...common, authorization: "user_request" };
    case JOB_TYPES.AGENT_RESUME:
    case JOB_TYPES.AGENT_SLEEP:
      return common;
    case JOB_TYPES.AGENT_WAKE:
      return { ...common, forceFreshBoot: false };
    case JOB_TYPES.AGENT_RESTART:
      return { ...common, stateLossAcknowledged: false };
    case JOB_TYPES.AGENT_UPGRADE:
      return {
        ...common,
        dockerImage: "ghcr.io/elizaos/eliza:develop",
        fromDigest: null,
        toDigest: `sha256:${"b".repeat(64)}`,
      };
    case JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE:
      return {
        ...common,
        operation: "upgrade",
        rolloutId: crypto.randomUUID(),
        actorUserId: identity.userId,
        targetOwnerUserId: identity.userId,
        decisionAt: new Date().toISOString(),
        sourceImage: "ghcr.io/elizaos/eliza:develop",
        sourceDigest: `sha256:${"a".repeat(64)}`,
        targetImage: `ghcr.io/elizaos/eliza-demo@sha256:${"b".repeat(64)}`,
        targetDigest: `sha256:${"b".repeat(64)}`,
      };
    case JOB_TYPES.AGENT_DOWNGRADE:
      return {
        ...common,
        dockerImage: "ghcr.io/elizaos/eliza:develop",
        fromDigest: `sha256:${"b".repeat(64)}`,
      };
    case JOB_TYPES.AGENT_LOGS:
      return { ...common, tail: 100 };
    case JOB_TYPES.AGENT_MESSAGE:
      return { ...common, text: "hello", nonce: crypto.randomUUID() };
    case JOB_TYPES.AGENT_SNAPSHOT:
      return { ...common, snapshotType: "manual" };
    default:
      throw new Error(`Unsupported agent job fixture type ${type}`);
  }
}

async function seedPendingAgentJob(
  type: ProvisioningJobType,
  identity: { agentId: string; organizationId: string; userId: string },
  data = agentJobData(type, identity),
): Promise<Job> {
  const [job] = await dbWrite
    .insert(jobs)
    .values({
      type,
      status: "pending",
      data,
      data_storage: "inline",
      agent_id: identity.agentId,
      organization_id: identity.organizationId,
      user_id: identity.userId,
      max_attempts: 1,
    })
    .returning();
  return job;
}

async function claim(job: Job, ownerId = OWNER_ID): Promise<Job> {
  const [claimed] = await jobsRepository.claimPendingJobs({
    type: job.type,
    organizationId: job.organization_id,
    limit: 1,
    executionOwnerId: ownerId,
    executionLeaseMs: 60_000,
  });
  if (!claimed) throw new Error(`Job ${job.id} was not claimed`);
  return claimed;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    for (const ddl of PROVISIONING_JOB_TEST_TABLES) {
      await dbWrite.execute(sql.raw(ddl));
    }
  } catch {
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  process.env.ELIZA_SNAPSHOT_JOBS_ENABLED = "true";
  await dbWrite.delete(jobExecutionLeases);
  await dbWrite.delete(jobs);
  await dbWrite.delete(agentSandboxes);
});

afterAll(async () => {
  delete process.env.ELIZA_SNAPSHOT_JOBS_ENABLED;
  await closeDatabaseConnectionsForTests();
});

describe("container-backed enqueue admission", () => {
  test("admits a dedicated provision and rejects Shared before insert or reuse", async () => {
    const service = new ProvisioningJobService();
    const dedicated = await seedSandbox("dedicated-lazy");
    const first = await service.enqueueAgentProvisionOnce({
      ...dedicated,
      agentName: "Dedicated Agent",
    });
    expect(first).toMatchObject({ created: true, job: { status: "pending" } });

    await dbWrite
      .update(agentSandboxes)
      .set({ execution_tier: "shared" })
      .where(eq(agentSandboxes.id, dedicated.agentId));
    await expect(
      service.enqueueAgentProvisionOnce({ ...dedicated, agentName: "Dedicated Agent" }),
    ).rejects.toMatchObject({ status: 409, code: "session_not_ready" });
    const active = await dbWrite
      .select()
      .from(jobs)
      .where(and(eq(jobs.agent_id, dedicated.agentId), eq(jobs.type, JOB_TYPES.AGENT_PROVISION)));
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ id: first.job.id, status: "pending" });

    const shared = await seedSandbox("shared");
    await expect(
      dbWrite.transaction((tx) =>
        service.enqueueAgentProvisionOnceInTx(tx, {
          ...shared,
          agentName: "Shared Agent",
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: "session_not_ready" });
    const sharedJobs = await dbWrite.select().from(jobs).where(eq(jobs.agent_id, shared.agentId));
    expect(sharedJobs).toHaveLength(0);
  });
});

describe("worker container-tier and identity preflight", () => {
  test(
    "terminally rejects all eleven Shared container jobs before handlers and remains idempotent",
    async () => {
      const shared = await seedSandbox("shared");
      for (const type of REQUIRED_JOB_TYPES) {
        await seedPendingAgentJob(type, shared);
      }
      const before = await dbWrite
        .select({
          status: agentSandboxes.status,
          executionTier: agentSandboxes.execution_tier,
          error: agentSandboxes.error_message,
          lifecycleJobId: agentSandboxes.lifecycle_job_id,
          lifecycleGeneration: agentSandboxes.lifecycle_execution_generation,
          lifecycleRevision: agentSandboxes.lifecycle_revision,
        })
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, shared.agentId));
      const handlerCalls: string[] = [];
      const service = new ProvisioningJobService({
        executionOwnerId: OWNER_ID,
        executeJob: async (job) => {
          handlerCalls.push(job.type);
        },
      });
      const ordinaryFailure = spyOn(jobsRepository, "incrementAttempt");
      try {
        const result = await service.processPendingJobs(1, { jobTypes: REQUIRED_JOB_TYPES });
        expect(result).toMatchObject({ claimed: 11, succeeded: 0, retried: 0, failed: 11 });
        expect(result.errors).toHaveLength(11);
        expect(handlerCalls).toEqual([]);
        expect(ordinaryFailure).not.toHaveBeenCalled();

        const rejected = await dbWrite
          .select()
          .from(jobs)
          .where(eq(jobs.organization_id, shared.organizationId));
        expect(rejected).toHaveLength(11);
        for (const row of rejected) {
          expect(row).toMatchObject({
            status: "failed",
            attempts: 1,
            execution_quiesced_at: expect.anything(),
            completed_at: expect.anything(),
          });
          expect(row.error).toContain(CONTAINER_BACKED_TARGET_REQUIRED_MESSAGE_FOR_TEST);
        }
        const [misaligned] = await dbWrite
          .select({ count: sql<number>`count(*)::int` })
          .from(jobs)
          .where(
            and(
              eq(jobs.organization_id, shared.organizationId),
              sql`(
                ${jobs.completed_at} IS DISTINCT FROM ${jobs.execution_quiesced_at}
                OR ${jobs.completed_at} IS DISTINCT FROM ${jobs.updated_at}
              )`,
            ),
          );
        expect(misaligned?.count).toBe(0);
        expect(await dbWrite.select().from(jobExecutionLeases)).toHaveLength(0);

        const after = await dbWrite
          .select({
            status: agentSandboxes.status,
            executionTier: agentSandboxes.execution_tier,
            error: agentSandboxes.error_message,
            lifecycleJobId: agentSandboxes.lifecycle_job_id,
            lifecycleGeneration: agentSandboxes.lifecycle_execution_generation,
            lifecycleRevision: agentSandboxes.lifecycle_revision,
          })
          .from(agentSandboxes)
          .where(eq(agentSandboxes.id, shared.agentId));
        expect(after).toEqual(before);

        const secondPass = await service.processPendingJobs(1, { jobTypes: REQUIRED_JOB_TYPES });
        expect(secondPass).toMatchObject({ claimed: 0, succeeded: 0, retried: 0, failed: 0 });
        const afterReplay = await dbWrite
          .select({ attempts: jobs.attempts })
          .from(jobs)
          .where(eq(jobs.organization_id, shared.organizationId));
        expect(new Set(afterReplay.map(({ attempts }) => attempts))).toEqual(new Set([1]));
      } finally {
        ordinaryFailure.mockRestore();
      }
    },
    PGLITE_TIMEOUT,
  );

  test("rejects forged payload identity before a dedicated target handler", async () => {
    const dedicated = await seedSandbox("dedicated-always");
    const forged = {
      ...agentJobData(JOB_TYPES.AGENT_LOGS, dedicated),
      agentId: crypto.randomUUID(),
    };
    await seedPendingAgentJob(JOB_TYPES.AGENT_LOGS, dedicated, forged);
    let handlerCalls = 0;
    const service = new ProvisioningJobService({
      executionOwnerId: OWNER_ID,
      executeJob: async () => {
        handlerCalls += 1;
      },
    });

    const result = await service.processPendingJobs(1, { jobTypes: [JOB_TYPES.AGENT_LOGS] });

    expect(result).toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });
    expect(handlerCalls).toBe(0);
    const [rejected] = await dbWrite.select().from(jobs);
    expect(rejected).toMatchObject({ status: "failed", attempts: 1 });
    expect(rejected.error).toContain("identity does not match indexed columns");
    const [sandbox] = await dbWrite
      .select({ status: agentSandboxes.status, error: agentSandboxes.error_message })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, dedicated.agentId));
    expect(sandbox).toEqual({ status: "running", error: null });
  });

  test("fails closed when a container-required target row disappeared before dispatch", async () => {
    const owner = await seedOwner();
    const missing = { agentId: crypto.randomUUID(), ...owner };
    await seedPendingAgentJob(JOB_TYPES.AGENT_LOGS, missing);
    let handlerCalls = 0;
    const service = new ProvisioningJobService({
      executionOwnerId: OWNER_ID,
      executeJob: async () => {
        handlerCalls += 1;
      },
    });

    const result = await service.processPendingJobs(1, { jobTypes: [JOB_TYPES.AGENT_LOGS] });

    expect(result).toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });
    expect(handlerCalls).toBe(0);
    const [rejected] = await dbWrite.select().from(jobs);
    expect(rejected).toMatchObject({ status: "failed", attempts: 1 });
    expect(rejected.error).toContain(CONTAINER_BACKED_TARGET_REQUIRED_MESSAGE_FOR_TEST);
    expect(await dbWrite.select().from(agentSandboxes)).toHaveLength(0);
  });

  test("allows Shared message delivery and logical deletion through the common preflight", async () => {
    const shared = await seedSandbox("shared");
    await seedPendingAgentJob(JOB_TYPES.AGENT_MESSAGE, shared);
    await seedPendingAgentJob(JOB_TYPES.AGENT_DELETE, shared);
    const handlerCalls: string[] = [];
    const service = new ProvisioningJobService({
      executionOwnerId: OWNER_ID,
      executeJob: async (job) => {
        handlerCalls.push(job.type);
        await jobsRepository.settleExecution(
          job,
          "completed",
          { completed_at: new Date() },
          OWNER_ID,
        );
      },
    });

    const result = await service.processPendingJobs(1, {
      jobTypes: [JOB_TYPES.AGENT_MESSAGE, JOB_TYPES.AGENT_DELETE],
    });

    expect(result).toMatchObject({ claimed: 2, succeeded: 2, failed: 0 });
    expect(new Set(handlerCalls)).toEqual(
      new Set([JOB_TYPES.AGENT_MESSAGE, JOB_TYPES.AGENT_DELETE]),
    );
    const completed = await dbWrite.select().from(jobs);
    expect(completed.map(({ status }) => status)).toEqual(["completed", "completed"]);
  });
});

describe("jobsRepository.rejectClaimedExecution", () => {
  test("rejects once, reconstructs an ambiguous acknowledgement, and stops lease renewal", async () => {
    const shared = await seedSandbox("shared");
    const pending = await seedPendingAgentJob(JOB_TYPES.AGENT_MESSAGE, shared);
    const claimed = await claim(pending);

    expect(await jobsRepository.rejectClaimedExecution(claimed, "invalid target", OWNER_ID)).toBe(
      "rejected",
    );
    expect(await jobsRepository.rejectClaimedExecution(claimed, "invalid target", OWNER_ID)).toBe(
      "already-terminal",
    );
    expect(await jobsRepository.renewExecutionLease(claimed, OWNER_ID)).toBe("settled");

    const [persisted] = await dbWrite.select().from(jobs).where(eq(jobs.id, claimed.id));
    expect(persisted).toMatchObject({ status: "failed", attempts: 1, error: "invalid target" });
    const [misaligned] = await dbWrite
      .select({ count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(
        and(
          eq(jobs.id, claimed.id),
          sql`(
            ${jobs.completed_at} IS DISTINCT FROM ${jobs.execution_quiesced_at}
            OR ${jobs.completed_at} IS DISTINCT FROM ${jobs.updated_at}
          )`,
        ),
      );
    expect(misaligned?.count).toBe(0);
    expect(await dbWrite.select().from(jobExecutionLeases)).toHaveLength(0);
  });

  test("classifies terminal, stale, missing, wrong-owner, and expired authority without mutation", async () => {
    const shared = await seedSandbox("shared");

    const terminalClaim = await claim(
      await seedPendingAgentJob(JOB_TYPES.AGENT_MESSAGE, shared),
      OWNER_ID,
    );
    await dbWrite
      .update(jobs)
      .set({ status: "completed", completed_at: new Date(), execution_quiesced_at: new Date() })
      .where(eq(jobs.id, terminalClaim.id));
    await dbWrite.delete(jobExecutionLeases).where(eq(jobExecutionLeases.job_id, terminalClaim.id));
    expect(
      await jobsRepository.rejectClaimedExecution(terminalClaim, "must not replace", OWNER_ID),
    ).toBe("already-terminal");

    const staleClaim = await claim(await seedPendingAgentJob(JOB_TYPES.AGENT_MESSAGE, shared));
    await dbWrite
      .update(jobs)
      .set({ execution_generation: OTHER_GENERATION })
      .where(eq(jobs.id, staleClaim.id));
    expect(await jobsRepository.rejectClaimedExecution(staleClaim, "stale", OWNER_ID)).toBe(
      "stale",
    );

    const wrongOwnerClaim = await claim(await seedPendingAgentJob(JOB_TYPES.AGENT_MESSAGE, shared));
    expect(
      await jobsRepository.rejectClaimedExecution(wrongOwnerClaim, "wrong owner", OTHER_OWNER_ID),
    ).toBe("lost");

    const expiredClaim = await claim(await seedPendingAgentJob(JOB_TYPES.AGENT_MESSAGE, shared));
    await dbWrite
      .update(jobExecutionLeases)
      .set({ expires_at: new Date(0) })
      .where(eq(jobExecutionLeases.job_id, expiredClaim.id));
    expect(await jobsRepository.rejectClaimedExecution(expiredClaim, "expired", OWNER_ID)).toBe(
      "lost",
    );

    const missingClaim = await claim(await seedPendingAgentJob(JOB_TYPES.AGENT_MESSAGE, shared));
    await dbWrite.delete(jobExecutionLeases).where(eq(jobExecutionLeases.job_id, missingClaim.id));
    await dbWrite.delete(jobs).where(eq(jobs.id, missingClaim.id));
    expect(await jobsRepository.rejectClaimedExecution(missingClaim, "missing", OWNER_ID)).toBe(
      "lost",
    );

    const rows = await dbWrite.select().from(jobs);
    expect(rows.find(({ id }) => id === terminalClaim.id)).toMatchObject({
      status: "completed",
      attempts: 0,
      error: null,
    });
    expect(rows.find(({ id }) => id === staleClaim.id)).toMatchObject({
      status: "in_progress",
      attempts: 0,
      error: null,
    });
    expect(rows.find(({ id }) => id === wrongOwnerClaim.id)).toMatchObject({
      status: "in_progress",
      attempts: 0,
      error: null,
    });
    expect(rows.find(({ id }) => id === expiredClaim.id)).toMatchObject({
      status: "in_progress",
      attempts: 0,
      error: null,
    });
  });
});

const CONTAINER_BACKED_TARGET_REQUIRED_MESSAGE_FOR_TEST =
  "Agent job requires a container-backed execution tier";
