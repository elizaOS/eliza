/**
 * Exercises lease renewal through the public provisioning-worker loop while
 * the repository suite proves transactional renewal outcomes against PGlite.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

import { jobsRepository } from "../../db/repositories/jobs";
import type { Job } from "../../db/schemas/jobs";
import {
  COLD_BOOT_STALE_JOB_THRESHOLD_MS,
  JOB_TYPES,
  type ProvisioningJobType,
} from "./provisioning-job-types";
import { ProvisioningJobService } from "./provisioning-jobs";

const JOB_ID = "00000000-0000-4000-8000-000000000001";
const GENERATION_ID = "00000000-0000-4000-8000-000000000002";
const ORG_ID = "00000000-0000-4000-8000-000000000003";

function claimedJob(type: ProvisioningJobType = JOB_TYPES.AGENT_LOGS): Job {
  const now = new Date("2026-07-29T00:00:00.000Z");
  return {
    id: JOB_ID,
    type,
    status: "in_progress",
    data: {},
    data_storage: "inline",
    data_key: null,
    agent_id: null,
    character_id: null,
    result: null,
    result_storage: "inline",
    result_key: null,
    error: null,
    error_storage: "inline",
    error_key: null,
    attempts: 0,
    max_attempts: 3,
    execution_generation: GENERATION_ID,
    execution_quiesced_at: null,
    organization_id: ORG_ID,
    user_id: null,
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

function stubLaneClaim(job: Job | undefined) {
  const claim = spyOn(jobsRepository, "claimPendingJobs").mockResolvedValue(job ? [job] : []);
  spyOn(jobsRepository, "recoverStaleJobs").mockResolvedValue(0);
  return claim;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

afterEach(() => {
  mock.restore();
});

describe("execution-lease heartbeat", () => {
  test("cold-boot claims outlive both execution and stale-recovery windows", async () => {
    const claim = stubLaneClaim(undefined);
    const service = new ProvisioningJobService();

    await service.processPendingJobs(1, { jobTypes: [JOB_TYPES.AGENT_PROVISION] });

    expect(claim).toHaveBeenCalledWith(
      expect.objectContaining({
        type: JOB_TYPES.AGENT_PROVISION,
        executionLeaseMs: 930_000,
      }),
    );
    expect(930_000).toBeGreaterThan(COLD_BOOT_STALE_JOB_THRESHOLD_MS);
  });

  test("rejects a heartbeat interval that cannot renew before expiry", () => {
    expect(
      () =>
        new ProvisioningJobService({
          executionLeaseMs: 1_000,
          executionLeaseHeartbeatMs: 1_000,
        }),
    ).toThrow("Execution lease heartbeat must be positive and shorter than the lease");
  });

  test("renews while execution is active and stops after success", async () => {
    const job = claimedJob();
    stubLaneClaim(job);
    let observeSecondRenewal: (() => void) | undefined;
    const secondRenewal = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Execution lease did not renew twice while the job was active")),
        5_000,
      );
      observeSecondRenewal = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    const renew = spyOn(jobsRepository, "renewExecutionLease").mockImplementation(async () => {
      if (renew.mock.calls.length >= 2) observeSecondRenewal?.();
      return "renewed";
    });
    const service = new ProvisioningJobService({
      executeJob: async () => secondRenewal,
      executionLeaseMs: 60_000,
      executionLeaseHeartbeatMs: 20,
    });

    const result = await service.processPendingJobs(1, { jobTypes: [JOB_TYPES.AGENT_LOGS] });
    const renewalsBeforeReturn = renew.mock.calls.length;

    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(renewalsBeforeReturn).toBeGreaterThanOrEqual(2);
    await wait(60);
    expect(renew.mock.calls).toHaveLength(renewalsBeforeReturn);
  });

  test("stops quietly when the transaction observes normal settlement", async () => {
    const job = claimedJob();
    stubLaneClaim(job);
    const renew = spyOn(jobsRepository, "renewExecutionLease").mockResolvedValue("settled");
    const { logger } = await import("../utils/logger");
    const warn = spyOn(logger, "warn");
    const service = new ProvisioningJobService({
      executeJob: async () => wait(90),
      executionLeaseMs: 60_000,
      executionLeaseHeartbeatMs: 20,
    });

    await service.processPendingJobs(1, { jobTypes: [JOB_TYPES.AGENT_LOGS] });

    expect(renew.mock.calls).toHaveLength(1);
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes("ownership was lost")),
    ).toHaveLength(0);
  });

  test("warns exactly once when the transaction observes ownership loss", async () => {
    const job = claimedJob();
    stubLaneClaim(job);
    const renew = spyOn(jobsRepository, "renewExecutionLease").mockResolvedValue("lost");
    const { logger } = await import("../utils/logger");
    const warn = spyOn(logger, "warn");
    const service = new ProvisioningJobService({
      executeJob: async () => wait(90),
      executionLeaseMs: 60_000,
      executionLeaseHeartbeatMs: 20,
    });

    await service.processPendingJobs(1, { jobTypes: [JOB_TYPES.AGENT_LOGS] });

    expect(renew.mock.calls).toHaveLength(1);
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes("ownership was lost")),
    ).toHaveLength(1);
  });
});
