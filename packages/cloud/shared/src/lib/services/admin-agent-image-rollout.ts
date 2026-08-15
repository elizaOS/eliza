/**
 * Plans and atomically enqueues super-admin image canaries for named agents.
 * All mutable preconditions are read from the primary database; rollback pairs
 * come only from durable successful canary jobs, never from caller input.
 */

import type { Job } from "../../db/repositories/jobs";
import { jobsRepository } from "../../db/repositories/jobs";
import { ApiError, NotFoundError, ValidationError } from "../api/cloud-worker-errors";
import {
  type AdminCanaryImageJobData,
  type AdminCanaryPlannedTarget,
  type AdminCanaryRolloutInput,
  assertAdminCanaryCanonicalOrDemoPair,
  assertAdminCanaryImageJobData,
  assertAdminCanaryRequestId,
  assertAdminCanaryRolloutInput,
  assertRecoverableAdminCanaryImageJobData,
  assertUuid,
  fingerprintAdminCanaryPlan,
  hashAdminCanaryRequest,
  isCompletedAdminCanaryJobResult,
  parseAdminCanaryDemoImage,
} from "./admin-canary-image";
import { elizaSandboxService } from "./eliza-sandbox";
import { JOB_TYPES } from "./provisioning-job-types";
import { provisioningJobService, readAdminCanaryImageJobData } from "./provisioning-jobs";
import { hasReadyWarmClaimCredential } from "./warm-claim-key-push";

export interface AdminCanaryRolloutTargetResponse extends AdminCanaryPlannedTarget {
  jobId?: string;
  status?: string;
}

export interface AdminCanaryRolloutResponse {
  dryRun: boolean;
  operation: "upgrade" | "rollback";
  requestId: string;
  planFingerprint: string;
  rolloutId: string | null;
  decisionAt: string;
  targets: AdminCanaryRolloutTargetResponse[];
}

function conflict(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(409, "session_not_ready", message, details);
}

function requestConflict(requestId: string): ApiError {
  return conflict("requestId was already used for a different canary request", { requestId });
}

async function responseFromRecoverableJobs(
  jobs: Job[],
  actorUserId: string,
  requestId: string,
  expected?: {
    canonicalRequestHash: string;
    planFingerprint: string;
  },
): Promise<AdminCanaryRolloutResponse> {
  const firstJob = jobs[0];
  if (!firstJob) {
    throw new Error(`Admin canary request ${requestId} has no durable jobs`);
  }
  const firstData = readAdminCanaryImageJobData(firstJob);
  assertRecoverableAdminCanaryImageJobData(firstData);

  const targets = jobs.map((job) => {
    const data = readAdminCanaryImageJobData(job);
    assertRecoverableAdminCanaryImageJobData(data);
    if (
      job.type !== JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE ||
      job.user_id !== actorUserId ||
      data.actorUserId !== actorUserId ||
      data.userId !== actorUserId ||
      data.requestId !== requestId ||
      data.organizationId !== job.organization_id ||
      data.agentId !== job.agent_id
    ) {
      throw new Error(`Admin canary request ${requestId} has inconsistent job identity`);
    }
    if (
      data.operation !== firstData.operation ||
      data.rolloutId !== firstData.rolloutId ||
      data.decisionAt !== firstData.decisionAt ||
      data.planFingerprint !== firstData.planFingerprint ||
      data.canonicalRequestHash !== firstData.canonicalRequestHash
    ) {
      throw new Error(`Admin canary request ${requestId} has inconsistent durable metadata`);
    }
    if (
      expected &&
      (data.canonicalRequestHash !== expected.canonicalRequestHash ||
        data.planFingerprint !== expected.planFingerprint)
    ) {
      throw requestConflict(requestId);
    }
    return {
      operation: data.operation,
      agentId: data.agentId,
      organizationId: data.organizationId,
      targetOwnerUserId: data.targetOwnerUserId,
      sourceImage: data.sourceImage,
      sourceDigest: data.sourceDigest,
      targetImage: data.targetImage,
      targetDigest: data.targetDigest,
      ...(data.sourceRolloutId ? { sourceRolloutId: data.sourceRolloutId } : {}),
      ...(data.sourceJobId ? { sourceJobId: data.sourceJobId } : {}),
      jobId: job.id,
      status: job.status,
    };
  });
  const uniqueTargets = new Set(
    targets.map((target) => `${target.organizationId}:${target.agentId}`),
  );
  if (uniqueTargets.size !== targets.length) {
    throw new Error(`Admin canary request ${requestId} has duplicate durable targets`);
  }
  const durablePlanFingerprint = await fingerprintAdminCanaryPlan({
    actorUserId,
    requestId,
    operation: firstData.operation,
    targets,
  });
  if (durablePlanFingerprint !== firstData.planFingerprint) {
    throw new Error(`Admin canary request ${requestId} has an incomplete or changed target set`);
  }

  targets.sort((left, right) =>
    `${left.organizationId}:${left.agentId}`.localeCompare(
      `${right.organizationId}:${right.agentId}`,
    ),
  );
  return {
    dryRun: false,
    operation: firstData.operation,
    requestId,
    planFingerprint: firstData.planFingerprint,
    rolloutId: firstData.rolloutId,
    decisionAt: firstData.decisionAt,
    targets,
  };
}

function assertRunningDedicatedAgent(
  agent: Awaited<ReturnType<typeof elizaSandboxService.getAgentForWrite>>,
  target: { agentId: string; organizationId: string },
) {
  if (!agent) {
    throw NotFoundError(
      `Agent ${target.agentId} was not found in organization ${target.organizationId}`,
    );
  }
  if (agent.status !== "running" || !agent.node_id || !agent.container_name || !agent.sandbox_id) {
    throw conflict(`Agent ${target.agentId} is not a running dedicated sandbox`);
  }
  if (!agent.user_id) {
    throw conflict(`Agent ${target.agentId} has no durable owner`);
  }
  if (!agent.docker_image || !agent.image_digest) {
    throw conflict(`Agent ${target.agentId} has no authoritative source image pair`);
  }
  if (!hasReadyWarmClaimCredential(agent)) {
    throw conflict(`Agent ${target.agentId} warm-claim credential handoff is not ready`);
  }
  return agent;
}

function readSuccessfulUpgradeAudit(job: Job): AdminCanaryImageJobData {
  if (job.type !== JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE) {
    throw ValidationError(`Job ${job.id} is not an admin canary image job`);
  }
  if (job.status !== "completed" || !job.completed_at) {
    throw conflict(`Canary job ${job.id} is not durably completed`);
  }

  const data = readAdminCanaryImageJobData(job);
  assertAdminCanaryImageJobData(data);
  if (data.operation !== "upgrade") {
    throw ValidationError(`Canary job ${job.id} is not an upgrade and cannot be rolled back`);
  }
  if (!isCompletedAdminCanaryJobResult(job.result)) {
    throw conflict(`Canary job ${job.id} has no successful durable result`);
  }
  const result = job.result;
  if (
    result.jobId !== job.id ||
    result.operation !== data.operation ||
    result.rolloutId !== data.rolloutId ||
    result.actorUserId !== data.actorUserId ||
    result.decisionAt !== data.decisionAt ||
    result.agentId !== data.agentId ||
    result.organizationId !== data.organizationId ||
    result.targetOwnerUserId !== data.targetOwnerUserId ||
    result.sourceImage !== data.sourceImage ||
    result.sourceDigest !== data.sourceDigest ||
    result.targetImage !== data.targetImage ||
    result.targetDigest !== data.targetDigest ||
    !Number.isFinite(Date.parse(result.startedAt)) ||
    !Number.isFinite(Date.parse(result.finishedAt))
  ) {
    throw conflict(`Canary job ${job.id} audit fields are incomplete or inconsistent`);
  }
  return data;
}

export class AdminAgentImageRolloutService {
  private async readReplay(
    input: AdminCanaryRolloutInput,
    actorUserId: string,
    canonicalRequestHash: string,
  ): Promise<AdminCanaryRolloutResponse | undefined> {
    const jobs = await jobsRepository.findAdminCanaryRequestForWrite(
      JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
      actorUserId,
      input.requestId,
    );
    if (jobs.length === 0) return undefined;
    if (input.dryRun) {
      throw requestConflict(input.requestId);
    }
    return await responseFromRecoverableJobs(jobs, actorUserId, input.requestId, {
      canonicalRequestHash,
      planFingerprint: input.expectedPlanFingerprint,
    });
  }

  private async planUpgrade(
    input: Extract<AdminCanaryRolloutInput, { operation: "upgrade" }>,
  ): Promise<AdminCanaryPlannedTarget[]> {
    const target = parseAdminCanaryDemoImage(input.targetImage);
    const plans: AdminCanaryPlannedTarget[] = [];

    for (const requested of input.targets) {
      const agent = assertRunningDedicatedAgent(
        await elizaSandboxService.getAgentForWrite(requested.agentId, requested.organizationId),
        requested,
      );
      if (
        agent.docker_image !== requested.expectedSourceImage ||
        agent.image_digest !== requested.expectedSourceDigest
      ) {
        throw conflict(
          `Agent ${requested.agentId} does not match the requested source image pair`,
          {
            agentId: requested.agentId,
            organizationId: requested.organizationId,
          },
        );
      }

      plans.push({
        operation: "upgrade",
        agentId: requested.agentId,
        organizationId: requested.organizationId,
        targetOwnerUserId: agent.user_id,
        sourceImage: agent.docker_image,
        sourceDigest: agent.image_digest,
        targetImage: input.targetImage,
        targetDigest: target.digest,
      });
    }

    return plans;
  }

  private async readRollbackSource(
    input: Extract<AdminCanaryRolloutInput, { operation: "rollback" }>,
  ): Promise<Job[]> {
    if (input.source.jobId) {
      const job = await jobsRepository.findByIdForWrite(input.source.jobId);
      if (!job) throw NotFoundError(`Canary job ${input.source.jobId} was not found`);
      return [job];
    }
    if (!input.source.rolloutId) {
      throw ValidationError("rollback source identifier is required");
    }
    const jobs = await jobsRepository.findAdminCanaryRolloutForWrite(
      JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
      input.source.rolloutId,
    );
    if (jobs.length === 0) {
      throw NotFoundError(`Canary rollout ${input.source.rolloutId} was not found`);
    }
    return jobs;
  }

  private async planRollback(
    input: Extract<AdminCanaryRolloutInput, { operation: "rollback" }>,
  ): Promise<AdminCanaryPlannedTarget[]> {
    const sourceJobs = await this.readRollbackSource(input);
    if (sourceJobs.length > 5) {
      throw conflict("Rollback source exceeds the five-agent canary limit");
    }

    const plans: AdminCanaryPlannedTarget[] = [];
    const seenTargets = new Set<string>();
    for (const job of sourceJobs) {
      const data = readSuccessfulUpgradeAudit(job);
      const key = `${data.organizationId}:${data.agentId}`;
      if (seenTargets.has(key)) {
        throw conflict(`Rollback source contains duplicate agent ${data.agentId}`);
      }
      seenTargets.add(key);

      const agent = assertRunningDedicatedAgent(
        await elizaSandboxService.getAgentForWrite(data.agentId, data.organizationId),
        data,
      );
      if (
        agent.user_id !== data.targetOwnerUserId ||
        agent.docker_image !== data.targetImage ||
        agent.image_digest !== data.targetDigest
      ) {
        throw conflict(`Agent ${data.agentId} no longer matches the completed canary target pair`);
      }
      if (
        !agent.previous_docker_image ||
        !agent.previous_image_digest ||
        agent.previous_docker_image !== data.sourceImage ||
        agent.previous_image_digest !== data.sourceDigest
      ) {
        throw conflict(`Agent ${data.agentId} no longer has the completed canary rollback pair`);
      }
      // Dry runs must validate the same immutable target pair that enqueue and
      // execution will use, including a demo image from an earlier canary.
      assertAdminCanaryCanonicalOrDemoPair(data.sourceImage, data.sourceDigest, "targetImage");

      plans.push({
        operation: "rollback",
        agentId: data.agentId,
        organizationId: data.organizationId,
        targetOwnerUserId: data.targetOwnerUserId,
        sourceImage: data.targetImage,
        sourceDigest: data.targetDigest,
        targetImage: data.sourceImage,
        targetDigest: data.sourceDigest,
        sourceRolloutId: data.rolloutId,
        sourceJobId: job.id,
      });
    }

    return plans;
  }

  async previewOrEnqueue(
    input: AdminCanaryRolloutInput,
    actorUserId: string,
  ): Promise<AdminCanaryRolloutResponse> {
    assertUuid(actorUserId, "actorUserId");
    assertAdminCanaryRolloutInput(input);
    const canonicalRequestHash = await hashAdminCanaryRequest(input, actorUserId);
    const replay = await this.readReplay(input, actorUserId, canonicalRequestHash);
    if (replay) return replay;

    try {
      const targets =
        input.operation === "upgrade"
          ? await this.planUpgrade(input)
          : await this.planRollback(input);
      const planFingerprint = await fingerprintAdminCanaryPlan({
        actorUserId,
        requestId: input.requestId,
        operation: input.operation,
        targets,
      });
      const decisionAt = new Date().toISOString();

      if (input.dryRun) {
        return {
          dryRun: true,
          operation: input.operation,
          requestId: input.requestId,
          planFingerprint,
          rolloutId: null,
          decisionAt,
          targets,
        };
      }
      if (planFingerprint !== input.expectedPlanFingerprint) {
        throw conflict("Canary plan changed after preview", {
          requestId: input.requestId,
          expectedPlanFingerprint: input.expectedPlanFingerprint,
          actualPlanFingerprint: planFingerprint,
        });
      }

      const rolloutId = crypto.randomUUID();
      const enqueued = await provisioningJobService.enqueueAdminCanaryImageRollout({
        rolloutId,
        actorUserId,
        decisionAt,
        requestId: input.requestId,
        planFingerprint,
        canonicalRequestHash,
        targets,
      });
      return await responseFromRecoverableJobs(enqueued.jobs, actorUserId, input.requestId, {
        canonicalRequestHash,
        planFingerprint,
      });
    } catch (error) {
      // error-policy:J1 The idempotency operation boundary accepts a racing
      // fresh-attempt failure only when the actor's durable request now exists.
      const committed = await this.readReplay(input, actorUserId, canonicalRequestHash);
      if (committed) return committed;
      throw error;
    }
  }

  async recoverRequest(
    actorUserId: string,
    requestId: string,
  ): Promise<AdminCanaryRolloutResponse> {
    assertUuid(actorUserId, "actorUserId");
    assertAdminCanaryRequestId(requestId);
    const jobs = await jobsRepository.findAdminCanaryRequestForWrite(
      JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
      actorUserId,
      requestId,
    );
    if (jobs.length === 0) {
      throw NotFoundError("Canary image request not found");
    }
    return await responseFromRecoverableJobs(jobs, actorUserId, requestId);
  }
}

export const adminAgentImageRolloutService = new AdminAgentImageRolloutService();
