/**
 * Lane-scoping behavior of ProvisioningJobService — the invariant the whole
 * apps-control-plane split exists to provide: a lane-scoped call claims AND
 * stale-recovers ONLY its lane's job types, and the default (no jobTypes) is
 * byte-for-byte the old all-18-types behavior.
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
    const recoverSpy = spyOn(jobsRepository, "recoverStaleJobs").mockResolvedValue(0);
    try {
      await provisioningJobService.processPendingJobs(1, {
        jobTypes: APPS_JOB_TYPES,
      });

      const claimedTypes = claimSpy.mock.calls.map((c) => c[0].type);
      const recoveredTypes = recoverSpy.mock.calls.map((c) => c[0].type);

      expect(new Set(claimedTypes)).toEqual(new Set(APPS_JOB_TYPES));
      expect(new Set(recoveredTypes)).toEqual(new Set(APPS_JOB_TYPES));
      for (const agentType of AGENT_JOB_TYPES) {
        expect(claimedTypes).not.toContain(agentType);
        expect(recoveredTypes).not.toContain(agentType);
      }
    } finally {
      claimSpy.mockRestore();
      recoverSpy.mockRestore();
    }
  });

  test("default (no jobTypes) claims + recovers every JOB_TYPES entry — unchanged behavior", async () => {
    const claimSpy = spyOn(jobsRepository, "claimPendingJobs").mockResolvedValue([]);
    const recoverSpy = spyOn(jobsRepository, "recoverStaleJobs").mockResolvedValue(0);
    try {
      await provisioningJobService.processPendingJobs(1);

      const claimedTypes = claimSpy.mock.calls.map((c) => c[0].type);
      expect(new Set(claimedTypes)).toEqual(new Set(Object.values(JOB_TYPES)));
      // Count is derived from JOB_TYPES, not hardcoded: CONTAINER_STOP (#8342)
      // grows this from 18 to 19, and a literal would break the moment it lands.
      expect(claimedTypes.length).toBe(Object.values(JOB_TYPES).length);
    } finally {
      claimSpy.mockRestore();
      recoverSpy.mockRestore();
    }
  });

  test("agent lane never claims an apps job type (no cross-lane leakage)", async () => {
    const claimSpy = spyOn(jobsRepository, "claimPendingJobs").mockResolvedValue([]);
    const recoverSpy = spyOn(jobsRepository, "recoverStaleJobs").mockResolvedValue(0);
    try {
      await provisioningJobService.processPendingJobs(1, {
        jobTypes: AGENT_JOB_TYPES,
      });

      const claimedTypes = claimSpy.mock.calls.map((c) => c[0].type);
      expect(new Set(claimedTypes)).toEqual(new Set(AGENT_JOB_TYPES));
      for (const appsType of APPS_JOB_TYPES) {
        expect(claimedTypes).not.toContain(appsType);
      }
    } finally {
      claimSpy.mockRestore();
      recoverSpy.mockRestore();
    }
  });
});
