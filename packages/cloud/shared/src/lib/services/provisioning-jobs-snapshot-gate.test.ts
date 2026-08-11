/**
 * Fail-closed gate for the memory-intensive agent_snapshot lane (#16639):
 * claim and startup recovery skip the lane unless ELIZA_SNAPSHOT_JOBS_ENABLED
 * is exactly "true"; every other lifecycle lane stays independently operable;
 * a restart cannot resurrect snapshot jobs while the gate is off.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { jobsRepository } from "../../db/repositories/jobs";
import { JOB_TYPES } from "./provisioning-job-types";
import { ProvisioningJobService, provisioningJobService } from "./provisioning-jobs";

const EMPTY_RECOVERY = {
  scanned: 0,
  retried: 0,
  permanentlyFailed: 0,
  unchanged: 0,
  failures: [],
};

const prevGate = process.env.ELIZA_SNAPSHOT_JOBS_ENABLED;
afterEach(() => {
  if (prevGate === undefined) delete process.env.ELIZA_SNAPSHOT_JOBS_ENABLED;
  else process.env.ELIZA_SNAPSHOT_JOBS_ENABLED = prevGate;
});

describe("snapshotJobsEnabled — exact-match env gate", () => {
  test("only the exact string 'true' enables the lane", () => {
    delete process.env.ELIZA_SNAPSHOT_JOBS_ENABLED;
    expect(ProvisioningJobService.snapshotJobsEnabled()).toBe(false);
    for (const value of ["1", "TRUE", "yes", "on", ""]) {
      process.env.ELIZA_SNAPSHOT_JOBS_ENABLED = value;
      expect(ProvisioningJobService.snapshotJobsEnabled()).toBe(false);
    }
    process.env.ELIZA_SNAPSHOT_JOBS_ENABLED = "true";
    expect(ProvisioningJobService.snapshotJobsEnabled()).toBe(true);
  });
});

describe("claim path", () => {
  test("gate off: agent_snapshot is never claimed; every other lane still is", async () => {
    delete process.env.ELIZA_SNAPSHOT_JOBS_ENABLED;
    const claimSpy = spyOn(jobsRepository, "claimPendingJobs").mockResolvedValue([]);
    const sharedClaimSpy = spyOn(
      jobsRepository,
      "claimPendingJobsWithinSharedRunningLimit",
    ).mockResolvedValue([]);
    const recoverSpy = spyOn(jobsRepository, "recoverStaleJobs").mockResolvedValue(EMPTY_RECOVERY);
    try {
      await provisioningJobService.processPendingJobs(1);
      const claimedTypes = claimSpy.mock.calls.map((c) => c[0].type);
      expect(claimedTypes).not.toContain(JOB_TYPES.AGENT_SNAPSHOT);
      expect(claimedTypes).toContain(JOB_TYPES.AGENT_PROVISION);
      expect(claimedTypes).toContain(JOB_TYPES.AGENT_DELETE);
    } finally {
      claimSpy.mockRestore();
      sharedClaimSpy.mockRestore();
      recoverSpy.mockRestore();
    }
  });

  test("gate on: agent_snapshot is claimed with batch forced to 1 (sequential)", async () => {
    process.env.ELIZA_SNAPSHOT_JOBS_ENABLED = "true";
    const claimSpy = spyOn(jobsRepository, "claimPendingJobs").mockResolvedValue([]);
    const sharedClaimSpy = spyOn(
      jobsRepository,
      "claimPendingJobsWithinSharedRunningLimit",
    ).mockResolvedValue([]);
    const recoverSpy = spyOn(jobsRepository, "recoverStaleJobs").mockResolvedValue(EMPTY_RECOVERY);
    try {
      await provisioningJobService.processPendingJobs(5);
      const snapshotCall = claimSpy.mock.calls.find((c) => c[0].type === JOB_TYPES.AGENT_SNAPSHOT);
      expect(snapshotCall).toBeDefined();
      expect(snapshotCall?.[0].limit).toBe(1);
      // Other lanes keep the requested batch.
      const provisionCall = claimSpy.mock.calls.find(
        (c) => c[0].type === JOB_TYPES.AGENT_PROVISION,
      );
      expect(provisionCall?.[0].limit).toBe(5);
    } finally {
      claimSpy.mockRestore();
      sharedClaimSpy.mockRestore();
      recoverSpy.mockRestore();
    }
  });
});

describe("startup recovery", () => {
  test("gate off: a restart cannot resurrect snapshot jobs; gate on: it can", async () => {
    const recoverSpy = spyOn(
      jobsRepository,
      "recoverInProgressJobsStartedBefore",
    ).mockResolvedValue(EMPTY_RECOVERY);
    try {
      delete process.env.ELIZA_SNAPSHOT_JOBS_ENABLED;
      await provisioningJobService.recoverInterruptedJobsOnStartup(new Date());
      const typesOff = recoverSpy.mock.calls.map((c) => c[0].type);
      expect(typesOff).not.toContain(JOB_TYPES.AGENT_SNAPSHOT);
      expect(typesOff).toContain(JOB_TYPES.AGENT_PROVISION);

      recoverSpy.mockClear();
      process.env.ELIZA_SNAPSHOT_JOBS_ENABLED = "true";
      await provisioningJobService.recoverInterruptedJobsOnStartup(new Date());
      const typesOn = recoverSpy.mock.calls.map((c) => c[0].type);
      expect(typesOn).toContain(JOB_TYPES.AGENT_SNAPSHOT);
    } finally {
      recoverSpy.mockRestore();
    }
  });
});
