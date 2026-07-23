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
  assertAdminCanaryImageJobData,
  assertAdminCanaryRolloutInput,
  assertUuid,
  isCompletedAdminCanaryJobResult,
  parseAdminCanaryDemoImage,
} from "./admin-canary-image";
import { elizaSandboxService } from "./eliza-sandbox";
import { JOB_TYPES } from "./provisioning-job-types";
import { provisioningJobService, readAdminCanaryImageJobData } from "./provisioning-jobs";

export interface AdminCanaryRolloutTargetResponse extends AdminCanaryPlannedTarget {
  jobId?: string;
  status?: string;
}

export interface AdminCanaryRolloutResponse {
  dryRun: boolean;
  operation: "upgrade" | "rollback";
  rolloutId: string | null;
  decisionAt: string;
  targets: AdminCanaryRolloutTargetResponse[];
}

function conflict(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(409, "session_not_ready", message, details);
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
    const targets =
      input.operation === "upgrade"
        ? await this.planUpgrade(input)
        : await this.planRollback(input);
    const decisionAt = new Date().toISOString();

    if (input.dryRun) {
      return {
        dryRun: true,
        operation: input.operation,
        rolloutId: null,
        decisionAt,
        targets,
      };
    }

    const rolloutId = crypto.randomUUID();
    const jobs = await provisioningJobService.enqueueAdminCanaryImageRollout({
      rolloutId,
      actorUserId,
      decisionAt,
      targets,
    });
    const jobsByAgent = new Map(jobs.map((job) => [job.agent_id, job]));
    return {
      dryRun: false,
      operation: input.operation,
      rolloutId,
      decisionAt,
      targets: targets.map((target) => {
        const job = jobsByAgent.get(target.agentId);
        if (!job) {
          throw new Error(`Atomic canary enqueue omitted agent ${target.agentId}`);
        }
        return {
          ...target,
          jobId: job.id,
          status: job.status,
        };
      }),
    };
  }
}

export const adminAgentImageRolloutService = new AdminAgentImageRolloutService();
