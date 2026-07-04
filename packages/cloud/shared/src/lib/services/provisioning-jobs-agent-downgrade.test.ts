// Exercises provisioning jobs agent downgrade behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, spyOn, test } from "bun:test";

import { jobsRepository } from "../../db/repositories/jobs";
import type { Job } from "../../db/schemas/jobs";
import { elizaSandboxService } from "./eliza-sandbox";
import { JOB_TYPES, type ProvisioningJobType } from "./provisioning-job-types";
import { provisioningJobService } from "./provisioning-jobs";

const ORG = "22222222-2222-4222-8222-222222222222";
const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
const USER = "33333333-3333-4333-8333-333333333333";
const DOCKER_IMAGE = "ghcr.io/elizaos/eliza-agent:latest";
const FROM_DIGEST = "sha256:postupgrade";

function makeDowngradeJob(): Job {
  const now = new Date("2026-06-20T00:00:00.000Z");
  return {
    id: "44444444-4444-4444-8444-444444444444",
    type: JOB_TYPES.AGENT_DOWNGRADE,
    status: "in_progress",
    data: {
      agentId: AGENT,
      organizationId: ORG,
      userId: USER,
      dockerImage: DOCKER_IMAGE,
      fromDigest: FROM_DIGEST,
    },
    data_storage: "inline",
    data_key: null,
    agent_id: AGENT,
    character_id: null,
    result: null,
    result_storage: "inline",
    result_key: null,
    error: null,
    error_storage: "inline",
    error_key: null,
    attempts: 1,
    max_attempts: 1,
    organization_id: ORG,
    user_id: USER,
    api_key_id: null,
    generation_id: null,
    webhook_url: null,
    webhook_status: null,
    estimated_completion_at: null,
    scheduled_for: now,
    started_at: now,
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
}

function withClaimedDowngradeJob() {
  const job = makeDowngradeJob();
  const claimSpy = spyOn(jobsRepository, "claimPendingJobs").mockImplementation(
    async (filters: { type: ProvisioningJobType }) =>
      filters.type === JOB_TYPES.AGENT_DOWNGRADE ? [job] : [],
  );
  const recoverSpy = spyOn(jobsRepository, "recoverStaleJobs").mockResolvedValue(0);
  const updateStatusSpy = spyOn(jobsRepository, "updateStatus").mockResolvedValue(undefined);
  const incrementSpy = spyOn(jobsRepository, "incrementAttempt").mockResolvedValue(undefined);
  return {
    job,
    updateStatusSpy,
    incrementSpy,
    restore() {
      claimSpy.mockRestore();
      recoverSpy.mockRestore();
      updateStatusSpy.mockRestore();
      incrementSpy.mockRestore();
    },
  };
}

describe("ProvisioningJobService agent_downgrade", () => {
  test("executes rollback through the daemon job and persists the swap result", async () => {
    const ctx = withClaimedDowngradeJob();
    const svcSpy = spyOn(elizaSandboxService, "executeDowngrade").mockResolvedValue({
      success: true,
      oldNodeId: "node-new",
      oldContainerName: "agent-current",
      newNodeId: "node-prev",
      newContainerName: "agent-rollback",
      newDigest: "sha256:previous",
    });

    try {
      const result = await provisioningJobService.processPendingJobs(1, {
        jobTypes: [JOB_TYPES.AGENT_DOWNGRADE],
      });

      expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
      expect(svcSpy).toHaveBeenCalledWith(AGENT, ORG, DOCKER_IMAGE, FROM_DIGEST);
      const completed = ctx.updateStatusSpy.mock.calls.find((call) => call[1] === "completed");
      expect(completed?.[2]?.result).toMatchObject({
        oldNodeId: "node-new",
        oldContainerName: "agent-current",
        newNodeId: "node-prev",
        newContainerName: "agent-rollback",
        newDigest: "sha256:previous",
      });
      expect(ctx.incrementSpy).not.toHaveBeenCalled();
    } finally {
      svcSpy.mockRestore();
      ctx.restore();
    }
  });

  test("treats rollback refusal as a failed attempt, not a silent no-op", async () => {
    const ctx = withClaimedDowngradeJob();
    const svcSpy = spyOn(elizaSandboxService, "executeDowngrade").mockResolvedValue({
      success: false,
      error: "No pre-upgrade snapshot found; refusing rollback without restore point",
    } as never);

    try {
      const result = await provisioningJobService.processPendingJobs(1, {
        jobTypes: [JOB_TYPES.AGENT_DOWNGRADE],
      });

      expect(result.claimed).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);
      expect(ctx.updateStatusSpy).not.toHaveBeenCalledWith(
        ctx.job.id,
        "completed",
        expect.anything(),
      );
      expect(ctx.incrementSpy).toHaveBeenCalledWith(
        ctx.job.id,
        "No pre-upgrade snapshot found; refusing rollback without restore point",
        ctx.job.max_attempts,
        undefined,
      );
    } finally {
      svcSpy.mockRestore();
      ctx.restore();
    }
  });
});
