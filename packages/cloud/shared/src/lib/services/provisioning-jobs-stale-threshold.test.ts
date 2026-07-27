/**
 * Stale-job recovery threshold sizing — the cold-boot provision-flapping fix.
 *
 * `recoverStaleJobs` resets a job stuck `in_progress` past a threshold back to
 * `pending`. A cold dedicated-agent provision legitimately takes up to ~11 min
 * (image pull 5m + health check 6m) before `/api/health` answers. At the old
 * flat 5-min threshold a slow cold provision was reset mid-flight, re-claimed,
 * and the second provision force-removed the still-booting container (flapping +
 * orphans on the exact cold-start path every new user hits). This pins that the
 * cold-boot job types now outlast that worst case while fast ops keep the tight
 * 5-min backstop.
 */
import { describe, expect, spyOn, test } from "bun:test";

import { jobsRepository } from "../../db/repositories/jobs";
import type { Job } from "../../db/schemas/jobs";
import { elizaSandboxService, RestoreValidationRetryLaterError } from "./eliza-sandbox";
import { JOB_TYPES, type ProvisioningJobType } from "./provisioning-job-types";
import {
  ADMIN_CANARY_RESTORE_VALIDATION_STALE_LEASE_MARGIN_MS,
  provisioningJobService,
  resolvePerJobTimeoutMs,
  resolveStaleJobThresholdMs,
} from "./provisioning-jobs";

const COLD_BOOT_TYPES = [
  JOB_TYPES.AGENT_PROVISION,
  JOB_TYPES.AGENT_RESUME,
  JOB_TYPES.AGENT_WAKE,
  JOB_TYPES.AGENT_RESTART,
  JOB_TYPES.AGENT_UPGRADE,
  JOB_TYPES.AGENT_ADMIN_CANARY_IMAGE,
  JOB_TYPES.AGENT_DOWNGRADE,
] as const;

const FAST_TYPES = [JOB_TYPES.AGENT_DELETE, JOB_TYPES.AGENT_SUSPEND] as const;

const COLD_BOOT_WORST_CASE_MS = 11 * 60 * 1000; // PULL 5m + HEALTH_CHECK 6m

describe("recoverStaleJobs threshold by job type", () => {
  test("cold-boot types outlast the ~11min cold provision; fast ops keep the 5min backstop", async () => {
    const seen = new Map<string, number>();
    const spy = spyOn(jobsRepository, "recoverStaleJobs").mockImplementation(
      async (filters: { type: string; staleThresholdMs: number }) => {
        seen.set(filters.type, filters.staleThresholdMs);
        return 0;
      },
    );

    try {
      await (
        provisioningJobService as unknown as {
          recoverStaleJobs(types: readonly ProvisioningJobType[]): Promise<number>;
        }
      ).recoverStaleJobs([...COLD_BOOT_TYPES, ...FAST_TYPES]);

      // Cold-boot job types must NOT be reclaimable until well past the worst-case
      // cold boot — otherwise a still-booting provision is reset and double-run.
      for (const type of COLD_BOOT_TYPES) {
        expect(seen.get(type)).toBeGreaterThan(COLD_BOOT_WORST_CASE_MS);
      }
      // Fast lifecycle ops keep the tight 5-min stale backstop (no cold boot).
      for (const type of FAST_TYPES) {
        expect(seen.get(type)).toBe(5 * 60 * 1000);
      }
      // And the two tiers are genuinely different (no accidental uniform value).
      expect(seen.get(JOB_TYPES.AGENT_PROVISION)).toBeGreaterThan(
        seen.get(JOB_TYPES.AGENT_DELETE) as number,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("the public daemon sweep applies the same per-type thresholds (no private-seam drift)", async () => {
    // The test above drives the internal recoverStaleJobs directly; this pins
    // the PUBLIC path — processPendingJobs, the entry the daemon actually
    // calls — so a refactor rewiring the sweep can't silently bypass the
    // per-type threshold table. The agent_provision threshold in particular
    // protects a tier-upgrade target's first cold boot from being reset and
    // double-provisioned mid-flight (#15943).
    const seen = new Map<string, number>();
    const claimSpy = spyOn(jobsRepository, "claimPendingJobs").mockResolvedValue([]);
    const sharedClaimSpy = spyOn(
      jobsRepository,
      "claimPendingJobsWithinSharedRunningLimit",
    ).mockResolvedValue([]);
    const recoverSpy = spyOn(jobsRepository, "recoverStaleJobs").mockImplementation(
      async (filters: { type: string; staleThresholdMs: number }) => {
        seen.set(filters.type, filters.staleThresholdMs);
        return 0;
      },
    );
    try {
      await provisioningJobService.processPendingJobs(1);
      expect(seen.get(JOB_TYPES.AGENT_PROVISION)).toBeGreaterThan(COLD_BOOT_WORST_CASE_MS);
      expect(seen.get(JOB_TYPES.AGENT_DELETE)).toBe(5 * 60 * 1000);
    } finally {
      claimSpy.mockRestore();
      sharedClaimSpy.mockRestore();
      recoverSpy.mockRestore();
    }
  });

  test("restore validation is claimed through the global limit-one lane with its finite stale lease", async () => {
    const type = JOB_TYPES.AGENT_ADMIN_CANARY_RESTORE_VALIDATION;
    const watchdogMs = resolvePerJobTimeoutMs(type);
    const staleLeaseMs = resolveStaleJobThresholdMs(type);
    const claimSpy = spyOn(jobsRepository, "claimPendingJobs").mockResolvedValue([]);
    const sharedClaimSpy = spyOn(
      jobsRepository,
      "claimPendingJobsWithinSharedRunningLimit",
    ).mockResolvedValue([]);
    const recoverSpy = spyOn(jobsRepository, "recoverStaleJobs").mockImplementation(
      async (filters: { type: string; staleThresholdMs: number }) => {
        expect(filters).toEqual({ type, staleThresholdMs: staleLeaseMs });
        return 0;
      },
    );

    try {
      expect(staleLeaseMs).toBe(watchdogMs + ADMIN_CANARY_RESTORE_VALIDATION_STALE_LEASE_MARGIN_MS);
      await provisioningJobService.processPendingJobs(9, { jobTypes: [type] });
      expect(claimSpy).not.toHaveBeenCalled();
      expect(sharedClaimSpy).toHaveBeenCalledTimes(1);
      expect(sharedClaimSpy).toHaveBeenCalledWith({
        type,
        sharedTypes: [type],
        maxRunning: 1,
        limit: 1,
      });
      expect(recoverSpy).toHaveBeenCalledTimes(1);
    } finally {
      claimSpy.mockRestore();
      sharedClaimSpy.mockRestore();
      recoverSpy.mockRestore();
    }
  });

  test("an applying restore candidate requeues without consuming its attempt budget", async () => {
    const type = JOB_TYPES.AGENT_ADMIN_CANARY_RESTORE_VALIDATION;
    const now = new Date("2026-07-27T12:00:00.000Z");
    const restoreValidationId = "00000000-0000-4000-8000-000000000001";
    const organizationId = "00000000-0000-4000-8000-000000000002";
    const agentId = "00000000-0000-4000-8000-000000000003";
    const actorUserId = "00000000-0000-4000-8000-000000000004";
    const digest = `sha256:${"a".repeat(64)}`;
    const job = {
      id: "00000000-0000-4000-8000-000000000005",
      type,
      status: "in_progress",
      data: {
        restoreValidationId,
        backupId: "00000000-0000-4000-8000-000000000006",
        captureNonce: "b".repeat(64),
        sourceJobId: "00000000-0000-4000-8000-000000000007",
        rolloutId: "00000000-0000-4000-8000-000000000008",
        standbyGeneration: "00000000-0000-4000-8000-000000000009",
        actorUserId,
        agentId,
        organizationId,
        targetOwnerUserId: actorUserId,
        sourceEnvironmentRevision: 1,
        sourceImageDigest: digest,
        sourceSandboxId: "00000000-0000-4000-8000-000000000010",
        targetImage: `ghcr.io/elizaos/eliza-demo@${digest}`,
        targetDigest: digest,
        primaryNodeId: "node-primary",
        rollbackStandbyNodeId: "node-standby",
        plannedAt: now.toISOString(),
      },
      data_storage: "inline",
      data_key: null,
      agent_id: agentId,
      character_id: null,
      result: null,
      result_storage: "inline",
      result_key: null,
      error: null,
      error_storage: "inline",
      error_key: null,
      attempts: 4,
      max_attempts: 10,
      organization_id: organizationId,
      user_id: actorUserId,
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
    } satisfies Job;
    const ordinaryClaimSpy = spyOn(jobsRepository, "claimPendingJobs").mockResolvedValue([]);
    const sharedClaimSpy = spyOn(
      jobsRepository,
      "claimPendingJobsWithinSharedRunningLimit",
    ).mockResolvedValue([job]);
    const recoverSpy = spyOn(jobsRepository, "recoverStaleJobs").mockResolvedValue(0);
    const retrySpy = spyOn(
      jobsRepository,
      "retryLaterWithoutIncrementingAttempts",
    ).mockResolvedValue(job);
    const incrementSpy = spyOn(jobsRepository, "incrementAttempt").mockResolvedValue(undefined);
    const executeSpy = spyOn(
      elizaSandboxService,
      "executeAdminCanaryRestoreValidation",
    ).mockRejectedValue(new RestoreValidationRetryLaterError(restoreValidationId));
    const serviceInternals = provisioningJobService as unknown as {
      assertNoConflictingLifecycleExecution: (claimedJob: Job) => Promise<void>;
    };
    const conflictSpy = spyOn(
      serviceInternals,
      "assertNoConflictingLifecycleExecution",
    ).mockResolvedValue();

    try {
      const result = await provisioningJobService.processPendingJobs(8, {
        jobTypes: [type],
      });
      expect(result).toMatchObject({ claimed: 1, succeeded: 0, retried: 1, failed: 0 });
      expect(retrySpy).toHaveBeenCalledWith(
        job,
        `Restore validation ${restoreValidationId} is still applying; retry later`,
        2 * 60 * 1000,
      );
      expect(incrementSpy).not.toHaveBeenCalled();
    } finally {
      conflictSpy.mockRestore();
      executeSpy.mockRestore();
      incrementSpy.mockRestore();
      retrySpy.mockRestore();
      recoverSpy.mockRestore();
      sharedClaimSpy.mockRestore();
      ordinaryClaimSpy.mockRestore();
    }
  });
});
