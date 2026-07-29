/**
 * Pins for the execution-lease heartbeat layer (#17266 / audit #17253 §2).
 *
 * The repository layer (claim CTE, renew, recovery guards) is covered by
 * jobs-recovery.test.ts against real PGlite; what was UNpinned is the service
 * layer that makes the lease renewable in practice: the heartbeat interval,
 * its teardown, the per-type lease arithmetic that keeps a cold boot claimable
 * longer than its worst case, and the settlement/lost distinction in the
 * renewal-failed path (a fully successful provision must not WARN).
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

import { jobsRepository } from "../../db/repositories/jobs";
import { COLD_BOOT_STALE_JOB_THRESHOLD_MS } from "./provisioning-job-types";
import { ProvisioningJobService } from "./provisioning-jobs";

type LeaseInternals = {
  leaseDurationForJobType: (jobType: string) => number;
  startExecutionLeaseHeartbeat: (job: {
    id: string;
    type: string;
    execution_generation: string | null;
  }) => () => void;
};

afterEach(() => {
  mock.restore();
});

describe("execution-lease heartbeat (service layer)", () => {
  test("cold-boot lease outlives both the execution timeout and the stale threshold", () => {
    const svc = new ProvisioningJobService() as unknown as LeaseInternals;
    const lease = svc.leaseDurationForJobType("agent_provision");
    // 900s execution timeout + 2 heartbeats of headroom.
    expect(lease).toBe(930_000);
    // The property #17253 §2 was about: a live cold boot can never be
    // out-lived by the sweep window that would re-claim it.
    expect(lease).toBeGreaterThan(COLD_BOOT_STALE_JOB_THRESHOLD_MS);
  });

  test("the heartbeat<lease constructor invariant throws", () => {
    expect(
      () =>
        new ProvisioningJobService({
          executionLeaseMs: 1_000,
          executionLeaseHeartbeatMs: 1_000,
        }),
    ).toThrow();
  });

  test("the heartbeat renews on its interval and stops renewing once cleared", async () => {
    const renew = spyOn(jobsRepository, "renewExecutionLease").mockResolvedValue(true);
    const svc = new ProvisioningJobService({
      executionLeaseMs: 60_000,
      executionLeaseHeartbeatMs: 20,
    }) as unknown as LeaseInternals;

    const stop = svc.startExecutionLeaseHeartbeat({
      id: "00000000-0000-4000-8000-000000000001",
      type: "agent_provision",
      execution_generation: "00000000-0000-4000-8000-000000000002",
    });
    await new Promise((r) => setTimeout(r, 90));
    stop();
    const renewsWhileRunning = renew.mock.calls.length;
    expect(renewsWhileRunning).toBeGreaterThanOrEqual(2);

    await new Promise((r) => setTimeout(r, 60));
    // Cleared means CLEARED: not one more renewal after stop().
    expect(renew.mock.calls.length).toBe(renewsWhileRunning);
  });

  test("a renewal refused AFTER settlement logs no ownership-lost WARN", async () => {
    // renewExecutionLease guards on status='in_progress', so it returns false
    // on every fully successful job the moment the executor self-settles.
    // That is not a lost lease — the follow-up read tells them apart.
    const renew = spyOn(jobsRepository, "renewExecutionLease").mockResolvedValue(false);
    const findById = spyOn(jobsRepository, "findById").mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      status: "completed",
    } as never);
    const { logger } = await import("../utils/logger");
    const warn = spyOn(logger, "warn");

    const svc = new ProvisioningJobService({
      executionLeaseMs: 60_000,
      executionLeaseHeartbeatMs: 20,
    }) as unknown as LeaseInternals;
    const stop = svc.startExecutionLeaseHeartbeat({
      id: "00000000-0000-4000-8000-000000000001",
      type: "agent_provision",
      execution_generation: "00000000-0000-4000-8000-000000000002",
    });
    await new Promise((r) => setTimeout(r, 90));
    stop();

    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(findById).toHaveBeenCalled();
    const ownershipWarns = warn.mock.calls.filter(([msg]) =>
      String(msg).includes("ownership was lost"),
    );
    expect(ownershipWarns).toHaveLength(0);
  });

  test("a renewal refused while the job is STILL in_progress warns exactly once", async () => {
    const renew = spyOn(jobsRepository, "renewExecutionLease").mockResolvedValue(false);
    spyOn(jobsRepository, "findById").mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      status: "in_progress",
    } as never);
    const { logger } = await import("../utils/logger");
    const warn = spyOn(logger, "warn");

    const svc = new ProvisioningJobService({
      executionLeaseMs: 60_000,
      executionLeaseHeartbeatMs: 20,
    }) as unknown as LeaseInternals;
    const stop = svc.startExecutionLeaseHeartbeat({
      id: "00000000-0000-4000-8000-000000000001",
      type: "agent_provision",
      execution_generation: "00000000-0000-4000-8000-000000000002",
    });
    await new Promise((r) => setTimeout(r, 90));
    stop();

    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(1);
    const ownershipWarns = warn.mock.calls.filter(([msg]) =>
      String(msg).includes("ownership was lost"),
    );
    // The interval self-clears on the first refusal, so exactly one WARN.
    expect(ownershipWarns).toHaveLength(1);
  });
});
