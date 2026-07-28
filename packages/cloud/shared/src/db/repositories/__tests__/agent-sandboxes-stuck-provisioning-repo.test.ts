/**
 * Exercises stuck-provisioning ownership, lease recovery, and cutoff races
 * against the real Drizzle schema on in-process PGlite.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  MOCK_REDIS: process.env.MOCK_REDIS,
};
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import {
  JOB_TYPES,
  PROVISIONING_RECONCILIATION_BATCH_SIZE,
  PROVISIONING_STATUS_OWNER_JOB_TYPES,
  type ProvisioningJobType,
} from "../../../lib/services/provisioning-job-types";
import { agentSandboxes } from "../../schemas/agent-sandboxes";
import { apiKeys } from "../../schemas/api-keys";
import { generations } from "../../schemas/generations";
import { jobExecutionLeases } from "../../schemas/job-execution-leases";
import { jobs } from "../../schemas/jobs";
import { organizations } from "../../schemas/organizations";
import { usageRecords } from "../../schemas/usage-records";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";

const [
  { closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests },
  { AgentSandboxesRepository },
  { jobsRepository },
] = await Promise.all([import("../../client"), import("../agent-sandboxes"), import("../jobs")]);

const PGLITE_TIMEOUT = 60_000;
const EXECUTION_OWNER_ID = "00000000-0000-4000-8000-00000000a711";
const SWEEP_CUTOFF = new Date("2026-07-28T12:20:00.000Z");
const BEFORE_CUTOFF = new Date(SWEEP_CUTOFF.getTime() - 1);
const EXACTLY_AT_CUTOFF = new Date(SWEEP_CUTOFF);
const STALE_JOB_STARTED_AT = new Date(Date.now() - 30 * 60 * 1000);
let pgliteReady = true;
let seq = 0;

const repo = new AgentSandboxesRepository();

function restoreEnv(name: keyof typeof ORIGINAL_ENV, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedOrgAndUser(): Promise<{
  organizationId: string;
  userId: string;
}> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Provisioning Sweep Org", slug: uniq("sweep-org") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: uniq("steward"),
      organization_id: org.id,
    })
    .returning();
  return { organizationId: org.id, userId: user.id };
}

async function seedProvisioningAgent(
  organizationId: string,
  userId: string,
  updatedAt: Date = BEFORE_CUTOFF,
): Promise<string> {
  const [row] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: organizationId,
      user_id: userId,
      agent_name: uniq("agent"),
      status: "provisioning",
      execution_tier: "dedicated-always",
      sandbox_id: uniq("sandbox"),
      node_id: uniq("node"),
      container_name: uniq("container"),
      updated_at: updatedAt,
    })
    .returning();
  return row.id;
}

async function seedAndClaimJob(params: {
  organizationId: string;
  userId: string;
  agentId: string;
  type: ProvisioningJobType;
  maxAttempts?: number;
}) {
  const [inserted] = await dbWrite
    .insert(jobs)
    .values({
      organization_id: params.organizationId,
      user_id: params.userId,
      agent_id: params.agentId,
      type: params.type,
      status: "pending",
      data: {},
      max_attempts: params.maxAttempts ?? 3,
      scheduled_for: new Date(Date.now() - 60_000),
    })
    .returning();

  const claimed = await jobsRepository.claimPendingJobs({
    type: params.type,
    organizationId: params.organizationId,
    limit: 1,
    executionOwnerId: EXECUTION_OWNER_ID,
  });
  expect(claimed).toHaveLength(1);
  expect(claimed[0]?.id).toBe(inserted.id);
  expect(claimed[0]?.status).toBe("in_progress");
  expect(claimed[0]?.started_at).not.toBeNull();
  expect(Number.isNaN(new Date(claimed[0]!.started_at!).getTime())).toBe(false);
  return claimed[0]!;
}

async function sandboxStatus(agentId: string): Promise<string> {
  const row = await repo.findById(agentId);
  if (!row) throw new Error(`Sandbox ${agentId} disappeared`);
  return row.status;
}

async function jobStatus(jobId: string): Promise<{
  status: string;
  attempts: number;
  executionGeneration: string | null;
  executionQuiescedAt: Date | null;
}> {
  const [row] = await dbWrite
    .select({
      status: jobs.status,
      attempts: jobs.attempts,
      executionGeneration: jobs.execution_generation,
      executionQuiescedAt: jobs.execution_quiesced_at,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  if (!row) throw new Error(`Job ${jobId} disappeared`);
  return row;
}

async function activateLifecycleExecution(agentId: string, job: typeof jobs.$inferSelect) {
  if (!job.execution_generation) throw new Error(`Job ${job.id} was not assigned a generation`);
  await dbWrite
    .update(agentSandboxes)
    .set({
      lifecycle_job_id: job.id,
      lifecycle_execution_generation: job.execution_generation,
    })
    .where(eq(agentSandboxes.id, agentId));
}

async function backdateClaim(jobId: string): Promise<void> {
  await dbWrite.update(jobs).set({ started_at: STALE_JOB_STARTED_AT }).where(eq(jobs.id, jobId));
}

beforeAll(async () => {
  try {
    const schema = {
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      apiKeys,
      usageRecords,
      generations,
      jobs,
      jobExecutionLeases,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
    await getPgliteClientForTests().exec(
      await readFile(
        new URL("../../migrations/0183_lifecycle_execution_fence.sql", import.meta.url),
        "utf8",
      ),
    );
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[agent-sandboxes-stuck-provisioning-repo.test] PGlite schema setup failed",
      error,
    );
  }
}, PGLITE_TIMEOUT);

beforeEach(() => {
  if (!pgliteReady) throw new Error("PGlite harness unavailable");
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    restoreEnv(name as keyof typeof ORIGINAL_ENV, value);
  }
});

describe("stuck-provisioning owner predicates", () => {
  for (const ownerType of PROVISIONING_STATUS_OWNER_JOB_TYPES) {
    test(`a production-claimed ${ownerType} protects the provisioning row`, async () => {
      const { organizationId, userId } = await seedOrgAndUser();
      const agentId = await seedProvisioningAgent(organizationId, userId);
      await seedAndClaimJob({
        organizationId,
        userId,
        agentId,
        type: ownerType,
      });

      const swept = await repo.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);

      expect(swept.updated.map((row) => row.agentId)).not.toContain(agentId);
      expect(await sandboxStatus(agentId)).toBe("provisioning");
    });
  }

  test("an image-swap job does not claim ownership of a provisioning row", async () => {
    const { organizationId, userId } = await seedOrgAndUser();
    const agentId = await seedProvisioningAgent(organizationId, userId);
    await seedAndClaimJob({
      organizationId,
      userId,
      agentId,
      type: JOB_TYPES.AGENT_UPGRADE,
    });

    const swept = await repo.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);

    expect(swept.updated.map((row) => row.agentId)).toContain(agentId);
    expect(await sandboxStatus(agentId)).toBe("error");
  });

  test("uses a strict cutoff boundary", async () => {
    const { organizationId, userId } = await seedOrgAndUser();
    const exactId = await seedProvisioningAgent(organizationId, userId, EXACTLY_AT_CUTOFF);
    const olderId = await seedProvisioningAgent(organizationId, userId, BEFORE_CUTOFF);

    const swept = await repo.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);
    const sweptIds = new Set(swept.updated.map((row) => row.agentId));

    expect(sweptIds.has(exactId)).toBe(false);
    expect(sweptIds.has(olderId)).toBe(true);
    expect(await sandboxStatus(exactId)).toBe("provisioning");
    expect(await sandboxStatus(olderId)).toBe("error");
  });

  test("processes the oldest deterministic bounded batch", async () => {
    const { organizationId, userId } = await seedOrgAndUser();
    const oldest = new Date(SWEEP_CUTOFF.getTime() - 10_000);
    const inserted = await dbWrite
      .insert(agentSandboxes)
      .values(
        Array.from({ length: PROVISIONING_RECONCILIATION_BATCH_SIZE + 1 }, (_, index) => ({
          organization_id: organizationId,
          user_id: userId,
          agent_name: uniq("bounded-agent"),
          status: "provisioning" as const,
          execution_tier: "dedicated-always" as const,
          updated_at: new Date(oldest.getTime() + index),
        })),
      )
      .returning({ id: agentSandboxes.id });

    const batch = await repo.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);
    const updatedIds = new Set(batch.updated.map((row) => row.agentId));

    expect(batch.updated).toHaveLength(PROVISIONING_RECONCILIATION_BATCH_SIZE);
    expect(updatedIds.has(inserted[0]!.id)).toBe(true);
    expect(updatedIds.has(inserted.at(-1)!.id)).toBe(false);
    expect(await sandboxStatus(inserted.at(-1)!.id)).toBe("provisioning");
  });

  test("timeout retains ownership until settlement and stale generations cannot complete", async () => {
    const { organizationId, userId } = await seedOrgAndUser();
    const agentId = await seedProvisioningAgent(organizationId, userId);
    const firstClaim = await seedAndClaimJob({
      organizationId,
      userId,
      agentId,
      type: JOB_TYPES.AGENT_WAKE,
      maxAttempts: 2,
    });
    await activateLifecycleExecution(agentId, firstClaim);
    await backdateClaim(firstClaim.id);

    const firstRecovery = await jobsRepository.recoverStaleJobs({
      type: JOB_TYPES.AGENT_WAKE,
      organizationId,
      staleThresholdMs: 15 * 60 * 1000,
    });
    expect(firstRecovery).toBe(0);
    expect(await jobStatus(firstClaim.id)).toMatchObject({
      status: "in_progress",
      attempts: 0,
      executionGeneration: firstClaim.execution_generation,
      executionQuiescedAt: null,
    });
    expect(
      (await repo.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF)).updated.map(
        (row) => row.agentId,
      ),
    ).not.toContain(agentId);

    const requeued = await jobsRepository.incrementAttempt(
      firstClaim.id,
      "detached execution rejected after timeout",
      firstClaim.max_attempts,
      undefined,
      firstClaim.execution_generation ?? undefined,
      EXECUTION_OWNER_ID,
    );
    expect(requeued?.status).toBe("pending");
    expect(requeued?.execution_quiesced_at).not.toBeNull();
    await dbWrite
      .update(jobs)
      .set({ scheduled_for: new Date(Date.now() - 1_000) })
      .where(eq(jobs.id, firstClaim.id));

    const [secondClaim] = await jobsRepository.claimPendingJobs({
      type: JOB_TYPES.AGENT_WAKE,
      organizationId,
      limit: 1,
      executionOwnerId: EXECUTION_OWNER_ID,
    });
    expect(secondClaim?.id).toBe(firstClaim.id);
    expect(secondClaim?.execution_generation).not.toBe(firstClaim.execution_generation);
    await activateLifecycleExecution(agentId, secondClaim!);
    expect(secondClaim?.started_at).not.toBeNull();
    expect(Number.isNaN(new Date(secondClaim!.started_at!).getTime())).toBe(false);
    await expect(
      jobsRepository.settleExecution(
        firstClaim,
        "completed",
        {
          result: { stale: true },
        },
        EXECUTION_OWNER_ID,
      ),
    ).rejects.toThrow(/generation is no longer current/);
    expect(await jobStatus(firstClaim.id)).toMatchObject({
      status: "in_progress",
      attempts: 1,
      executionGeneration: secondClaim?.execution_generation,
      executionQuiescedAt: null,
    });

    const stillOwned = await repo.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);
    expect(stillOwned.updated.map((row) => row.agentId)).not.toContain(agentId);
    expect(await sandboxStatus(agentId)).toBe("provisioning");

    const failed = await jobsRepository.incrementAttempt(
      secondClaim!.id,
      "second execution rejected",
      secondClaim!.max_attempts,
      undefined,
      secondClaim!.execution_generation ?? undefined,
      EXECUTION_OWNER_ID,
    );
    expect(failed?.status).toBe("failed");
    expect(failed?.execution_quiesced_at).not.toBeNull();

    const sweptAfterQuiescence =
      await repo.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);
    expect(sweptAfterQuiescence.updated.map((row) => row.agentId)).toContain(agentId);
    expect(await sandboxStatus(agentId)).toBe("error");
  });

  test("cancelled owner jobs become ownerless only after acknowledged settlement", async () => {
    const { organizationId, userId } = await seedOrgAndUser();
    const agentId = await seedProvisioningAgent(organizationId, userId);
    const job = await seedAndClaimJob({
      organizationId,
      userId,
      agentId,
      type: JOB_TYPES.AGENT_RESTART,
    });
    await activateLifecycleExecution(agentId, job);
    await jobsRepository.settleExecution(
      job,
      "cancelled",
      {
        error: "awaiter cancelled while executor unwinds",
      },
      EXECUTION_OWNER_ID,
    );

    const swept = await repo.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);

    expect(swept.updated.map((row) => row.agentId)).toContain(agentId);
    expect(await sandboxStatus(agentId)).toBe("error");
  });

  test("list and recovery CAS both unblock after the owner settles", async () => {
    const { organizationId, userId } = await seedOrgAndUser();
    const agentId = await seedProvisioningAgent(organizationId, userId);
    const job = await seedAndClaimJob({
      organizationId,
      userId,
      agentId,
      type: JOB_TYPES.AGENT_RESUME,
    });
    await activateLifecycleExecution(agentId, job);

    expect(
      (await repo.listStuckProvisioningWithContainer(SWEEP_CUTOFF, 500)).map((row) => row.id),
    ).not.toContain(agentId);
    expect(await repo.markRunningFromProvisioning(agentId)).toBeUndefined();

    await jobsRepository.settleExecution(job, "completed", undefined, EXECUTION_OWNER_ID);

    expect(
      (await repo.listStuckProvisioningWithContainer(SWEEP_CUTOFF, 500)).map((row) => row.id),
    ).toContain(agentId);
    expect((await repo.markRunningFromProvisioning(agentId))?.id).toBe(agentId);
    expect(await sandboxStatus(agentId)).toBe("running");
  });
});
