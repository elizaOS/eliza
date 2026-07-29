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
import { JOB_TYPES, type ProvisioningJobType } from "./provisioning-job-types";
import { provisioningJobService } from "./provisioning-jobs";

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
});

describe("recovery failure-writeback wiring (#17253 §3)", () => {
  test("both recovery paths hand the repository the REAL permanent-failure builder", async () => {
    const { ProvisioningJobService } = await import("./provisioning-jobs");
    const { jobsRepository } = await import("../../db/repositories/jobs");
    const svc = new ProvisioningJobService();

    const captured: Array<Record<string, unknown>> = [];
    const stale = spyOn(jobsRepository, "recoverStaleJobs").mockImplementation(
      async (filters: Record<string, unknown>) => {
        captured.push(filters);
        return 0;
      },
    );
    const startup = spyOn(jobsRepository, "recoverInProgressJobsStartedBefore").mockImplementation(
      async (filters: Record<string, unknown>) => {
        captured.push(filters);
        return 0;
      },
    );
    try {
      await (svc as unknown as { recoverStaleJobs: () => Promise<void> }).recoverStaleJobs();
      await svc.recoverInterruptedJobsOnStartup();

      expect(captured.length).toBeGreaterThanOrEqual(2);
      for (const filters of captured) {
        expect(typeof filters.buildFailureWriteback).toBe("function");
        expect(typeof filters.onPermanentFailure).toBe("function");
        // The builder is the real one: for an APP_DEPLOY job it produces a
        // writeback closure; for a type with no dependent row it produces
        // undefined — the exact contract of buildPermanentFailureWriteback.
        const build = filters.buildFailureWriteback as (
          job: Record<string, unknown>,
          error: string,
        ) => unknown;
        const appDeployJob = {
          id: "00000000-0000-4000-8000-000000000001",
          type: "app_deploy",
          data: { appId: "00000000-0000-4000-8000-000000000002" },
          data_storage: "inline",
          max_attempts: 3,
        };
        expect(typeof build(appDeployJob, "boom")).toBe("function");
        const inertJob = { ...appDeployJob, type: "agent_message", data: {} };
        expect(build(inertJob, "boom")).toBeUndefined();
      }
    } finally {
      stale.mockRestore();
      startup.mockRestore();
    }
  });
});
