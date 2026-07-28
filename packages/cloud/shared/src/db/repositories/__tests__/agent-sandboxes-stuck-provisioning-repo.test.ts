/**
 * Exercises stuck-provisioning ownership, lease recovery, and cutoff races
 * against the real Drizzle schema on in-process PGlite.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import {
  JOB_TYPES,
  PROVISIONING_STATUS_OWNER_JOB_TYPES,
  type ProvisioningJobType,
} from "../../../lib/services/provisioning-job-types";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { agentSandboxes } from "../../schemas/agent-sandboxes";
import { apiKeys } from "../../schemas/api-keys";
import { generations } from "../../schemas/generations";
import { jobs } from "../../schemas/jobs";
import { organizations } from "../../schemas/organizations";
import { usageRecords } from "../../schemas/usage-records";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import { AgentSandboxesRepository } from "../agent-sandboxes";
import { jobsRepository } from "../jobs";

const PGLITE_TIMEOUT = 60_000;
const SWEEP_CUTOFF = new Date("2026-07-28T12:20:00.000Z");
const BEFORE_CUTOFF = new Date(SWEEP_CUTOFF.getTime() - 1);
const EXACTLY_AT_CUTOFF = new Date(SWEEP_CUTOFF);
const STALE_JOB_STARTED_AT = new Date(Date.now() - 30 * 60 * 1000);
let pgliteReady = true;
let seq = 0;

const repo = new AgentSandboxesRepository();

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
}> {
  const [row] = await dbWrite
    .select({ status: jobs.status, attempts: jobs.attempts })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  if (!row) throw new Error(`Job ${jobId} disappeared`);
  return row;
}

async function backdateClaim(jobId: string): Promise<void> {
  await dbWrite.update(jobs).set({ started_at: STALE_JOB_STARTED_AT }).where(eq(jobs.id, jobId));
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[agent-sandboxes-stuck-provisioning-repo.test] Refusing to mutate a non-PGlite DATABASE_URL",
    );
    return;
  }
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
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
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

      expect(swept.map((row) => row.agentId)).not.toContain(agentId);
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

    expect(swept.map((row) => row.agentId)).toContain(agentId);
    expect(await sandboxStatus(agentId)).toBe("error");
  });

  test("uses a strict cutoff boundary", async () => {
    const { organizationId, userId } = await seedOrgAndUser();
    const exactId = await seedProvisioningAgent(organizationId, userId, EXACTLY_AT_CUTOFF);
    const olderId = await seedProvisioningAgent(organizationId, userId, BEFORE_CUTOFF);

    const swept = await repo.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);
    const sweptIds = new Set(swept.map((row) => row.agentId));

    expect(sweptIds.has(exactId)).toBe(false);
    expect(sweptIds.has(olderId)).toBe(true);
    expect(await sandboxStatus(exactId)).toBe("provisioning");
    expect(await sandboxStatus(olderId)).toBe("error");
  });

  test("a retryable stale owner remains protected until stale recovery exhausts it", async () => {
    const { organizationId, userId } = await seedOrgAndUser();
    const agentId = await seedProvisioningAgent(organizationId, userId);
    const firstClaim = await seedAndClaimJob({
      organizationId,
      userId,
      agentId,
      type: JOB_TYPES.AGENT_WAKE,
      maxAttempts: 2,
    });
    await backdateClaim(firstClaim.id);

    const firstRecovery = await jobsRepository.recoverStaleJobs({
      type: JOB_TYPES.AGENT_WAKE,
      organizationId,
      staleThresholdMs: 15 * 60 * 1000,
    });
    expect(firstRecovery).toBe(1);
    expect(await jobStatus(firstClaim.id)).toEqual({
      status: "pending",
      attempts: 1,
    });
    expect(
      (await repo.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF)).map(
        (row) => row.agentId,
      ),
    ).not.toContain(agentId);

    const [secondClaim] = await jobsRepository.claimPendingJobs({
      type: JOB_TYPES.AGENT_WAKE,
      organizationId,
      limit: 1,
    });
    expect(secondClaim?.id).toBe(firstClaim.id);
    expect(secondClaim?.started_at).not.toBeNull();
    expect(Number.isNaN(new Date(secondClaim!.started_at!).getTime())).toBe(false);
    await backdateClaim(firstClaim.id);

    const terminalRecovery = await jobsRepository.recoverStaleJobs({
      type: JOB_TYPES.AGENT_WAKE,
      organizationId,
      staleThresholdMs: 15 * 60 * 1000,
    });
    expect(terminalRecovery).toBe(0);
    expect(await jobStatus(firstClaim.id)).toEqual({
      status: "failed",
      attempts: 2,
    });

    const swept = await repo.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);
    expect(swept.map((row) => row.agentId)).toContain(agentId);
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

    expect(
      (await repo.listStuckProvisioningWithContainer(SWEEP_CUTOFF, 500)).map((row) => row.id),
    ).not.toContain(agentId);
    expect(await repo.markRunningFromProvisioning(agentId)).toBeUndefined();

    await jobsRepository.updateStatus(job.id, "completed");

    expect(
      (await repo.listStuckProvisioningWithContainer(SWEEP_CUTOFF, 500)).map((row) => row.id),
    ).toContain(agentId);
    expect((await repo.markRunningFromProvisioning(agentId))?.id).toBe(agentId);
    expect(await sandboxStatus(agentId)).toBe("running");
  });

  test("concurrent owner settlement and sweep converge without masking the row", async () => {
    const { organizationId, userId } = await seedOrgAndUser();
    const agentId = await seedProvisioningAgent(organizationId, userId);
    const job = await seedAndClaimJob({
      organizationId,
      userId,
      agentId,
      type: JOB_TYPES.AGENT_RESTART,
    });

    await Promise.all([
      jobsRepository.updateStatus(job.id, "failed", {
        error: "worker execution settled",
      }),
      repo.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF),
    ]);

    await repo.markStuckProvisioningWithoutActiveJobAsError(SWEEP_CUTOFF);
    expect(await jobStatus(job.id)).toEqual({
      status: "failed",
      attempts: 0,
    });
    expect(await sandboxStatus(agentId)).toBe("error");
  });
});
