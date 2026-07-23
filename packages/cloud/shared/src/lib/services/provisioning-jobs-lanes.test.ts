/**
 * Lane-scoping behavior of ProvisioningJobService — the invariant the whole
 * apps-control-plane split exists to provide: a lane-scoped call claims AND
 * stale-recovers ONLY its lane's job types, and the default (no jobTypes) is
 * the complete registered-type behavior.
 *
 * This guards the seam the resolver unit test can't: resolver output → the
 * processPendingJobs/recoverStaleJobs loops → jobsRepository.{claim,recover}
 * with a per-type filter. A future refactor dropping the recoverStaleJobs(jobTypes)
 * scoping would silently let one lane's daemon reset the OTHER lane's stale rows
 * — this test fails loudly if that happens.
 */

import { describe, expect, spyOn, test } from "bun:test";

import { jobsRepository } from "../../db/repositories/jobs";
import { AGENT_JOB_TYPES, APPS_JOB_TYPES, JOB_TYPES } from "./provisioning-job-types";
import { provisioningJobService } from "./provisioning-jobs";

describe("processPendingJobs — lane scoping", () => {
  test("apps lane claims + stale-recovers ONLY apps job types, never an agent type", async () => {
    const claimSpy = spyOn(jobsRepository, "claimPendingJobs").mockResolvedValue([]);
    const sharedClaimSpy = spyOn(
      jobsRepository,
      "claimPendingJobsWithinSharedRunningLimit",
    ).mockResolvedValue([]);
    const recoverSpy = spyOn(jobsRepository, "recoverStaleJobs").mockResolvedValue(0);
    try {
      await provisioningJobService.processPendingJobs(1, {
        jobTypes: APPS_JOB_TYPES,
      });

      const claimedTypes = [...claimSpy.mock.calls, ...sharedClaimSpy.mock.calls].map(
        (call) => call[0].type,
      );
      const recoveredTypes = recoverSpy.mock.calls.map((c) => c[0].type);

      expect(new Set(claimedTypes)).toEqual(new Set(APPS_JOB_TYPES));
      expect(new Set(recoveredTypes)).toEqual(new Set(APPS_JOB_TYPES));
      for (const agentType of AGENT_JOB_TYPES) {
        expect(claimedTypes).not.toContain(agentType);
        expect(recoveredTypes).not.toContain(agentType);
      }
    } finally {
      claimSpy.mockRestore();
      sharedClaimSpy.mockRestore();
      recoverSpy.mockRestore();
    }
  });

  test("default (no jobTypes) claims + recovers every JOB_TYPES entry except the gated snapshot lane", async () => {
    const claimSpy = spyOn(jobsRepository, "claimPendingJobs").mockResolvedValue([]);
    const sharedClaimSpy = spyOn(
      jobsRepository,
      "claimPendingJobsWithinSharedRunningLimit",
    ).mockResolvedValue([]);
    const recoverSpy = spyOn(jobsRepository, "recoverStaleJobs").mockResolvedValue(0);
    // #16639: the memory-intensive agent_snapshot lane is fail-closed by
    // default — it joins the loop only under the explicit env gate (covered
    // in provisioning-jobs-snapshot-gate.test.ts).
    const expected = Object.values(JOB_TYPES).filter((t) => t !== JOB_TYPES.AGENT_SNAPSHOT);
    try {
      await provisioningJobService.processPendingJobs(1);

      const claimedTypes = [...claimSpy.mock.calls, ...sharedClaimSpy.mock.calls].map(
        (call) => call[0].type,
      );
      expect(new Set(claimedTypes)).toEqual(new Set(expected));
      // Count is derived from JOB_TYPES, not hardcoded: CONTAINER_STOP (#8342)
      // grows this from 18 to 19, and a literal would break the moment it lands.
      expect(claimedTypes.length).toBe(expected.length);
    } finally {
      claimSpy.mockRestore();
      sharedClaimSpy.mockRestore();
      recoverSpy.mockRestore();
    }
  });

  test("agent lane never claims an apps job type (no cross-lane leakage)", async () => {
    const claimSpy = spyOn(jobsRepository, "claimPendingJobs").mockResolvedValue([]);
    const sharedClaimSpy = spyOn(
      jobsRepository,
      "claimPendingJobsWithinSharedRunningLimit",
    ).mockResolvedValue([]);
    const recoverSpy = spyOn(jobsRepository, "recoverStaleJobs").mockResolvedValue(0);
    try {
      await provisioningJobService.processPendingJobs(1, {
        jobTypes: AGENT_JOB_TYPES,
      });

      const claimedTypes = [...claimSpy.mock.calls, ...sharedClaimSpy.mock.calls].map(
        (call) => call[0].type,
      );
      // Claim excludes the gated snapshot lane (#16639); the stale sweep
      // below still covers it (DB-only flip, no hydration).
      expect(new Set(claimedTypes)).toEqual(
        new Set(AGENT_JOB_TYPES.filter((t) => t !== JOB_TYPES.AGENT_SNAPSHOT)),
      );
      for (const appsType of APPS_JOB_TYPES) {
        expect(claimedTypes).not.toContain(appsType);
      }
    } finally {
      claimSpy.mockRestore();
      sharedClaimSpy.mockRestore();
      recoverSpy.mockRestore();
    }
  });

  test("the default sweep stale-recovers EVERY job type — no lifecycle job can silently lose its stale backstop", async () => {
    const claimSpy = spyOn(jobsRepository, "claimPendingJobs").mockResolvedValue([]);
    const sharedClaimSpy = spyOn(
      jobsRepository,
      "claimPendingJobsWithinSharedRunningLimit",
    ).mockResolvedValue([]);
    const recoverSpy = spyOn(jobsRepository, "recoverStaleJobs").mockResolvedValue(0);
    try {
      await provisioningJobService.processPendingJobs(1);

      // The claim-side completeness is pinned above; this pins the RECOVER
      // side. A provision job stuck in_progress (e.g. a tier-upgrade target's
      // first boot after a worker died, #15943) relies on this sweep — a type
      // dropped from recovery would strand its jobs in_progress forever.
      const recoveredTypes = recoverSpy.mock.calls.map((c) => c[0].type);
      expect(new Set(recoveredTypes)).toEqual(new Set(Object.values(JOB_TYPES)));
      expect(recoveredTypes).toContain(JOB_TYPES.AGENT_PROVISION);
    } finally {
      claimSpy.mockRestore();
      sharedClaimSpy.mockRestore();
      recoverSpy.mockRestore();
    }
  });

  test("startup interrupted-job recovery is scoped to the daemon lane", async () => {
    const recoverSpy = spyOn(
      jobsRepository,
      "recoverInProgressJobsStartedBefore",
    ).mockResolvedValue(0);
    const startedBefore = new Date("2026-07-08T12:00:00.000Z");
    try {
      await provisioningJobService.recoverInterruptedJobsOnStartup(startedBefore, AGENT_JOB_TYPES);

      const recoveredTypes = recoverSpy.mock.calls.map((c) => c[0].type);
      // Startup recovery excludes the gated snapshot lane (#16639): a restart
      // must not resurrect snapshot jobs before operators re-enable them.
      expect(new Set(recoveredTypes)).toEqual(
        new Set(AGENT_JOB_TYPES.filter((t) => t !== JOB_TYPES.AGENT_SNAPSHOT)),
      );
      for (const appsType of APPS_JOB_TYPES) {
        expect(recoveredTypes).not.toContain(appsType);
      }
      for (const call of recoverSpy.mock.calls) {
        expect(call[0].startedBefore).toBe(startedBefore);
      }
    } finally {
      recoverSpy.mockRestore();
    }
  });
});
