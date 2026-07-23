/**
 * Drives the admin canary planner and atomic enqueue against real PGlite DDL.
 * The suite proves zero-write preview, five-target atomicity, durable rollback
 * derivation, and fleet-reconciler exclusion for the distinct demo repository.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { type Job, jobsRepository } from "../../db/repositories/jobs";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../db/schemas/api-keys";
import { generations } from "../../db/schemas/generations";
import { jobs } from "../../db/schemas/jobs";
import { organizations } from "../../db/schemas/organizations";
import { usageRecords } from "../../db/schemas/usage-records";
import { userCharacters } from "../../db/schemas/user-characters";
import { users } from "../../db/schemas/users";
import { ApiError } from "../api/cloud-worker-errors";
import { adminAgentImageRolloutService } from "./admin-agent-image-rollout";
import { type AdminCanaryTargetExpectation } from "./admin-canary-image";
import { elizaSandboxService } from "./eliza-sandbox";
import { JOB_TYPES } from "./provisioning-job-types";
import { provisioningJobService, readAdminCanaryImageJobData } from "./provisioning-jobs";

const PGLITE_TIMEOUT = 60_000;
const SOURCE_IMAGE = "ghcr.io/elizaos/eliza:sha-production";
const SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;
const TARGET_DIGEST = `sha256:${"b".repeat(64)}`;
const TARGET_IMAGE = `ghcr.io/elizaos/eliza-demo@${TARGET_DIGEST}`;
const NEXT_DIGEST = `sha256:${"c".repeat(64)}`;
let pgliteReady = true;
let seq = 0;

function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedAgents(count: number): Promise<{
  actorUserId: string;
  targets: AdminCanaryTargetExpectation[];
}> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Admin Canary Org", slug: uniq("canary-org") })
    .returning();
  const [actor] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("canary-actor"), organization_id: org.id })
    .returning();
  const targets: AdminCanaryTargetExpectation[] = [];
  for (let index = 1; index <= count; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    await dbWrite.insert(agentSandboxes).values({
      id,
      organization_id: org.id,
      user_id: actor.id,
      agent_name: `Canary ${index}`,
      status: "running",
      sandbox_id: `sandbox-${index}`,
      node_id: `node-${index}`,
      container_name: `agent-${index}`,
      docker_image: SOURCE_IMAGE,
      image_digest: SOURCE_DIGEST,
    });
    targets.push({
      agentId: id,
      organizationId: org.id,
      expectedSourceImage: SOURCE_IMAGE,
      expectedSourceDigest: SOURCE_DIGEST,
    });
  }
  return { actorUserId: actor.id, targets };
}

async function completeUpgradeJob(job: Job): Promise<void> {
  const data = readAdminCanaryImageJobData(job);
  const startedAt = new Date("2026-07-23T00:00:00.000Z");
  const finishedAt = new Date("2026-07-23T00:01:00.000Z");
  await dbWrite
    .update(jobs)
    .set({
      status: "completed",
      started_at: startedAt,
      completed_at: finishedAt,
      result_storage: "inline",
      result: {
        success: true,
        jobId: job.id,
        operation: "upgrade",
        rolloutId: data.rolloutId,
        actorUserId: data.actorUserId,
        decisionAt: data.decisionAt,
        agentId: data.agentId,
        organizationId: data.organizationId,
        targetOwnerUserId: data.targetOwnerUserId,
        sourceImage: data.sourceImage,
        sourceDigest: data.sourceDigest,
        targetImage: data.targetImage,
        targetDigest: data.targetDigest,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      },
    })
    .where(eq(jobs.id, job.id));
  await dbWrite
    .update(agentSandboxes)
    .set({
      docker_image: data.targetImage,
      image_digest: data.targetDigest,
      previous_docker_image: data.sourceImage,
      previous_image_digest: data.sourceDigest,
    })
    .where(eq(agentSandboxes.id, data.agentId));
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const schema = {
      organizations,
      users,
      userCharacters,
      apiKeys,
      usageRecords,
      generations,
      agentSandboxes,
      jobs,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch {
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(jobs);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("admin agent image rollout on primary PGlite", () => {
  test("dry-run preserves requested targets exactly and writes no jobs; execute inserts all five", async () => {
    const seeded = await seedAgents(5);
    const requested = [...seeded.targets].reverse();
    const dryRun = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        dryRun: true,
        targetImage: TARGET_IMAGE,
        targets: requested,
      },
      seeded.actorUserId,
    );

    expect(dryRun.rolloutId).toBeNull();
    expect(dryRun.targets.map((target) => target.agentId)).toEqual(
      requested.map((target) => target.agentId),
    );
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);

    const executed = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        dryRun: false,
        targetImage: TARGET_IMAGE,
        targets: requested,
      },
      seeded.actorUserId,
    );
    expect(executed.rolloutId).toMatch(/^[0-9a-f-]{36}$/);
    expect(executed.targets.map((target) => target.agentId)).toEqual(
      requested.map((target) => target.agentId),
    );
    const persisted = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
    expect(persisted).toHaveLength(5);
    for (const job of persisted) {
      expect(job.status).toBe("pending");
      expect(job.user_id).toBe(seeded.actorUserId);
      expect(job.data_storage).toBe("inline");
      const data = readAdminCanaryImageJobData(job);
      expect(data.rolloutId).toBe(executed.rolloutId);
      expect(data.actorUserId).toBe(seeded.actorUserId);
      expect(data.targetImage).toBe(TARGET_IMAGE);
      expect(data.targetDigest).toBe(TARGET_DIGEST);
    }
  });

  test("one conflicting fifth target rolls back every canary insert", async () => {
    const seeded = await seedAgents(5);
    const blocked = seeded.targets[4]!;
    await dbWrite.insert(jobs).values({
      type: JOB_TYPES.AGENT_RESTART,
      status: "pending",
      organization_id: blocked.organizationId,
      user_id: seeded.actorUserId,
      agent_id: blocked.agentId,
      data_storage: "inline",
      data: {
        agentId: blocked.agentId,
        organizationId: blocked.organizationId,
        userId: seeded.actorUserId,
      },
      max_attempts: 1,
    });

    const attempt = adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        dryRun: false,
        targetImage: TARGET_IMAGE,
        targets: seeded.targets,
      },
      seeded.actorUserId,
    );
    await expect(attempt).rejects.toBeInstanceOf(ApiError);
    const persisted = await dbWrite.select().from(jobs);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.type).toBe(JOB_TYPES.AGENT_RESTART);
    const agents = await dbWrite.select().from(agentSandboxes);
    expect(agents).toHaveLength(5);
    for (const agent of agents) {
      expect(agent.docker_image).toBe(SOURCE_IMAGE);
      expect(agent.image_digest).toBe(SOURCE_DIGEST);
      expect(agent.previous_docker_image).toBeNull();
      expect(agent.previous_image_digest).toBeNull();
    }
  });

  test("concurrent execute requests serialize to exactly one durable rollout", async () => {
    const seeded = await seedAgents(5);
    const input = {
      operation: "upgrade" as const,
      dryRun: false,
      targetImage: TARGET_IMAGE,
      targets: seeded.targets,
    };

    const attempts = await Promise.allSettled([
      adminAgentImageRolloutService.previewOrEnqueue(input, seeded.actorUserId),
      adminAgentImageRolloutService.previewOrEnqueue(input, seeded.actorUserId),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const persisted = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
    expect(persisted).toHaveLength(5);
    expect(new Set(persisted.map((job) => readAdminCanaryImageJobData(job).rolloutId)).size).toBe(
      1,
    );
  });

  test("rollback target pair comes only from one successful durable upgrade audit", async () => {
    const seeded = await seedAgents(1);
    const upgrade = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        dryRun: false,
        targetImage: TARGET_IMAGE,
        targets: seeded.targets,
      },
      seeded.actorUserId,
    );
    const [upgradeJob] = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
    if (!upgradeJob) throw new Error("expected durable upgrade job");
    await completeUpgradeJob(upgradeJob);

    const preview = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "rollback",
        dryRun: true,
        source: { jobId: upgradeJob.id },
      },
      seeded.actorUserId,
    );
    expect(preview.targets).toEqual([
      expect.objectContaining({
        operation: "rollback",
        sourceImage: TARGET_IMAGE,
        sourceDigest: TARGET_DIGEST,
        targetImage: SOURCE_IMAGE,
        targetDigest: SOURCE_DIGEST,
        sourceRolloutId: upgrade.rolloutId,
        sourceJobId: upgradeJob.id,
      }),
    ]);
    expect(await dbWrite.select().from(jobs)).toHaveLength(1);

    const rollback = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "rollback",
        dryRun: false,
        source: { jobId: upgradeJob.id },
      },
      seeded.actorUserId,
    );
    expect(rollback.targets[0]).toMatchObject({
      sourceImage: TARGET_IMAGE,
      targetImage: SOURCE_IMAGE,
      sourceJobId: upgradeJob.id,
    });
    expect(await dbWrite.select().from(jobs)).toHaveLength(2);
  });

  test("rollout rollback resolves every target from primary durable jobs", async () => {
    const seeded = await seedAgents(2);
    const upgrade = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        dryRun: false,
        targetImage: TARGET_IMAGE,
        targets: seeded.targets,
      },
      seeded.actorUserId,
    );
    const upgradeJobs = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
    for (const job of upgradeJobs) {
      await completeUpgradeJob(job);
    }
    if (!upgrade.rolloutId) {
      throw new Error("Expected upgrade rollout ID");
    }

    const rollback = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "rollback",
        dryRun: true,
        source: { rolloutId: upgrade.rolloutId },
      },
      seeded.actorUserId,
    );
    expect(rollback.targets).toHaveLength(2);
    expect(rollback.targets.map((target) => target.agentId).sort()).toEqual(
      seeded.targets.map((target) => target.agentId).sort(),
    );
    for (const target of rollback.targets) {
      expect(target).toMatchObject({
        operation: "rollback",
        sourceImage: TARGET_IMAGE,
        sourceDigest: TARGET_DIGEST,
        targetImage: SOURCE_IMAGE,
        targetDigest: SOURCE_DIGEST,
        sourceRolloutId: upgrade.rolloutId,
      });
      expect(target.sourceJobId).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(await dbWrite.select().from(jobs)).toHaveLength(2);
  });

  test("demo-repository agents stay outside canonical reconcile and re-enter after rollback", async () => {
    const seeded = await seedAgents(1);
    const agentId = seeded.targets[0]!.agentId;
    await dbWrite
      .update(agentSandboxes)
      .set({ docker_image: TARGET_IMAGE, image_digest: TARGET_DIGEST })
      .where(eq(agentSandboxes.id, agentId));

    expect(
      await agentSandboxesRepository.listRunningWithDigestOtherThan(NEXT_DIGEST, SOURCE_IMAGE, 10),
    ).toHaveLength(0);

    await dbWrite
      .update(agentSandboxes)
      .set({ docker_image: SOURCE_IMAGE, image_digest: SOURCE_DIGEST })
      .where(eq(agentSandboxes.id, agentId));
    expect(
      await agentSandboxesRepository.listRunningWithDigestOtherThan(NEXT_DIGEST, SOURCE_IMAGE, 10),
    ).toEqual([
      expect.objectContaining({
        id: agentId,
        docker_image: SOURCE_IMAGE,
        image_digest: SOURCE_DIGEST,
      }),
    ]);
  });

  test("ordinary and canary claims share one transaction-locked three-running budget", async () => {
    const seeded = await seedAgents(5);
    await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        dryRun: false,
        targetImage: TARGET_IMAGE,
        targets: seeded.targets,
      },
      seeded.actorUserId,
    );
    for (let index = 0; index < 2; index += 1) {
      await dbWrite.insert(jobs).values({
        type: JOB_TYPES.AGENT_UPGRADE,
        status: "in_progress",
        organization_id: seeded.targets[index]!.organizationId,
        user_id: seeded.actorUserId,
        data_storage: "inline",
        data: {
          agentId: seeded.targets[index]!.agentId,
          organizationId: seeded.targets[index]!.organizationId,
          userId: seeded.actorUserId,
          dockerImage: SOURCE_IMAGE,
          fromDigest: SOURCE_DIGEST,
          toDigest: NEXT_DIGEST,
        },
        max_attempts: 1,
      });
    }

    const claimed = await jobsRepository.claimPendingJobsWithinSharedRunningLimit({
      type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
      sharedTypes: [JOB_TYPES.AGENT_UPGRADE, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      maxRunning: 3,
      limit: 5,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe("in_progress");

    const secondClaim = await jobsRepository.claimPendingJobsWithinSharedRunningLimit({
      type: JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
      sharedTypes: [JOB_TYPES.AGENT_UPGRADE, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      maxRunning: 3,
      limit: 5,
    });
    expect(secondClaim).toHaveLength(0);
  });

  test("terminal execution failure retains actor, decision, error, and result timestamps", async () => {
    const seeded = await seedAgents(1);
    const rollout = await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        dryRun: false,
        targetImage: TARGET_IMAGE,
        targets: seeded.targets,
      },
      seeded.actorUserId,
    );
    const execution = spyOn(elizaSandboxService, "executeAdminCanaryUpgrade").mockResolvedValue({
      success: false,
      error: "blue digest unavailable",
    });
    try {
      const processed = await provisioningJobService.processPendingJobs(5, {
        jobTypes: [JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      });
      expect(processed.failed).toBe(1);
      const [failed] = await dbWrite
        .select()
        .from(jobs)
        .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
      expect(failed?.status).toBe("failed");
      expect(Date.parse(String(failed?.completed_at))).toBeFinite();
      expect(failed?.error).toContain("blue digest unavailable");
      expect(failed?.result).toMatchObject({
        success: false,
        jobId: failed?.id,
        rolloutId: rollout.rolloutId,
        actorUserId: seeded.actorUserId,
        decisionAt: rollout.decisionAt,
        error: "blue digest unavailable",
      });
      if (!failed?.result) throw new Error("expected failed canary audit result");
      const audit = failed.result as { startedAt: string; finishedAt: string };
      expect(Date.parse(audit.startedAt)).toBeFinite();
      expect(Date.parse(audit.finishedAt)).toBeFinite();
    } finally {
      execution.mockRestore();
    }
  });

  test("successful upgrade commits agent cutover and completed audit in one transaction", async () => {
    const seeded = await seedAgents(1);
    await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        dryRun: false,
        targetImage: TARGET_IMAGE,
        targets: seeded.targets,
      },
      seeded.actorUserId,
    );
    const execution = spyOn(elizaSandboxService, "executeAdminCanaryUpgrade").mockImplementation(
      async (params) => {
        await dbWrite.transaction(async (tx) => {
          await tx
            .update(agentSandboxes)
            .set({
              node_id: "node-blue",
              container_name: "agent-blue",
              docker_image: params.targetImage,
              image_digest: params.targetDigest,
              previous_docker_image: params.sourceImage,
              previous_image_digest: params.sourceDigest,
            })
            .where(eq(agentSandboxes.id, params.agentId));
          await params.onCutoverInTx(tx, {
            oldNodeId: "node-old",
            oldContainerName: "agent-old",
            newNodeId: "node-blue",
            newContainerName: "agent-blue",
            newDigest: params.targetDigest,
          });
        });
        return {
          success: true,
          oldNodeId: "node-old",
          oldContainerName: "agent-old",
          newNodeId: "node-blue",
          newContainerName: "agent-blue",
          newDigest: params.targetDigest,
        };
      },
    );
    try {
      const processed = await provisioningJobService.processPendingJobs(5, {
        jobTypes: [JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      });
      expect(processed).toMatchObject({ succeeded: 1, failed: 0 });
      const [agent] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, seeded.targets[0]!.agentId));
      expect(agent).toMatchObject({
        node_id: "node-blue",
        container_name: "agent-blue",
        docker_image: TARGET_IMAGE,
        image_digest: TARGET_DIGEST,
        previous_docker_image: SOURCE_IMAGE,
        previous_image_digest: SOURCE_DIGEST,
      });
      const [completed] = await dbWrite
        .select()
        .from(jobs)
        .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
      expect(completed).toMatchObject({
        status: "completed",
        result_storage: "inline",
        error: null,
      });
      expect(completed?.result).toMatchObject({
        success: true,
        operation: "upgrade",
        agentId: seeded.targets[0]!.agentId,
        sourceImage: SOURCE_IMAGE,
        sourceDigest: SOURCE_DIGEST,
        targetImage: TARGET_IMAGE,
        targetDigest: TARGET_DIGEST,
        oldNodeId: "node-old",
        newNodeId: "node-blue",
      });
    } finally {
      execution.mockRestore();
    }
  });

  test("upgrade audit CAS failure rolls back agent cutover before terminal failure audit", async () => {
    const seeded = await seedAgents(1);
    await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        dryRun: false,
        targetImage: TARGET_IMAGE,
        targets: seeded.targets,
      },
      seeded.actorUserId,
    );
    let blueTornDown = false;
    const execution = spyOn(elizaSandboxService, "executeAdminCanaryUpgrade").mockImplementation(
      async (params) => {
        try {
          await dbWrite.transaction(async (tx) => {
            await tx
              .update(agentSandboxes)
              .set({
                docker_image: params.targetImage,
                image_digest: params.targetDigest,
                previous_docker_image: params.sourceImage,
                previous_image_digest: params.sourceDigest,
              })
              .where(eq(agentSandboxes.id, params.agentId));
            await tx
              .update(jobs)
              .set({ status: "pending" })
              .where(
                and(
                  eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE),
                  eq(jobs.agent_id, params.agentId),
                  eq(jobs.status, "in_progress"),
                ),
              );
            await params.onCutoverInTx(tx, {
              oldNodeId: "node-old",
              oldContainerName: "agent-old",
              newNodeId: "node-blue",
              newContainerName: "agent-blue",
              newDigest: params.targetDigest,
            });
          });
          return { success: true };
        } catch (error) {
          blueTornDown = true;
          return {
            success: false,
            rolledBack: true,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );
    try {
      const processed = await provisioningJobService.processPendingJobs(5, {
        jobTypes: [JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      });
      expect(processed.failed).toBe(1);
      expect(blueTornDown).toBe(true);
      const [agent] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, seeded.targets[0]!.agentId));
      expect(agent).toMatchObject({
        docker_image: SOURCE_IMAGE,
        image_digest: SOURCE_DIGEST,
        previous_docker_image: null,
        previous_image_digest: null,
      });
      const [failed] = await dbWrite
        .select()
        .from(jobs)
        .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
      expect(failed).toMatchObject({
        status: "failed",
        attempts: 1,
      });
      expect(failed?.result).toMatchObject({
        success: false,
        operation: "upgrade",
      });
    } finally {
      execution.mockRestore();
    }
  });

  test("rollback audit CAS failure preserves demo image and completed upgrade source", async () => {
    const seeded = await seedAgents(1);
    await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "upgrade",
        dryRun: false,
        targetImage: TARGET_IMAGE,
        targets: seeded.targets,
      },
      seeded.actorUserId,
    );
    const [upgradeJob] = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
    if (!upgradeJob) throw new Error("expected source upgrade job");
    await completeUpgradeJob(upgradeJob);
    await adminAgentImageRolloutService.previewOrEnqueue(
      {
        operation: "rollback",
        dryRun: false,
        source: { jobId: upgradeJob.id },
      },
      seeded.actorUserId,
    );

    let blueTornDown = false;
    const execution = spyOn(elizaSandboxService, "executeAdminCanaryRollback").mockImplementation(
      async (params) => {
        try {
          await dbWrite.transaction(async (tx) => {
            await tx
              .update(agentSandboxes)
              .set({
                docker_image: params.targetImage,
                image_digest: params.targetDigest,
                previous_docker_image: null,
                previous_image_digest: null,
              })
              .where(eq(agentSandboxes.id, params.agentId));
            await tx
              .update(jobs)
              .set({ status: "pending" })
              .where(
                and(
                  eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE),
                  eq(jobs.agent_id, params.agentId),
                  eq(jobs.status, "in_progress"),
                ),
              );
            await params.onCutoverInTx(tx, {
              oldNodeId: "node-demo",
              oldContainerName: "agent-demo",
              newNodeId: "node-canonical",
              newContainerName: "agent-canonical",
              newDigest: params.targetDigest,
            });
          });
          return { success: true };
        } catch (error) {
          blueTornDown = true;
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );
    try {
      const processed = await provisioningJobService.processPendingJobs(5, {
        jobTypes: [JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE],
      });
      expect(processed.failed).toBe(1);
      expect(blueTornDown).toBe(true);
      const [agent] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, seeded.targets[0]!.agentId));
      expect(agent).toMatchObject({
        docker_image: TARGET_IMAGE,
        image_digest: TARGET_DIGEST,
        previous_docker_image: SOURCE_IMAGE,
        previous_image_digest: SOURCE_DIGEST,
      });
      const canaryJobs = await dbWrite
        .select()
        .from(jobs)
        .where(eq(jobs.type, JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE));
      expect(canaryJobs.find((job) => job.id === upgradeJob.id)?.status).toBe("completed");
      const rollbackJob = canaryJobs.find((job) => job.id !== upgradeJob.id);
      expect(rollbackJob).toMatchObject({
        status: "failed",
        attempts: 1,
      });
      expect(rollbackJob?.result).toMatchObject({
        success: false,
        operation: "rollback",
      });
    } finally {
      execution.mockRestore();
    }
  });
});
