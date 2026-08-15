/**
 * Daemon-phase wiring for the deletion reconciliation cycle: the infra
 * maintenance sweep must drive `provisioningJobService.reEnqueueFailedDeletions`
 * with the bounded phase args, gate itself on `DELETION_RECONCILE_ENABLED`,
 * log the summary only when the sweep found work, and stay error-isolated so a
 * reconciler failure never aborts the rest of the sweep. Deterministic: worker
 * deps are injected via `__setDepsForTests`; the sweep's own DB behavior is
 * pinned in `provisioning-jobs-delete-enqueue.test.ts`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { withTimeout } from "@elizaos/cloud-shared/lib/utils/with-timeout";
import {
  __setDepsForTests,
  processDeletionReconcileCycle,
  readWorkerConfig,
  runInfraMaintenanceCycle,
} from "./provisioning-worker";

type WorkerConfig = ReturnType<typeof readWorkerConfig>;
type WorkerLogger = Parameters<typeof runInfraMaintenanceCycle>[0];

const EXPECTED_ARGS = { minAgeMs: 10 * 60_000, maxAgents: 200 };

function makeLogger(): WorkerLogger {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  } as unknown as WorkerLogger;
}

function makeConfig(
  env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv,
): WorkerConfig {
  return readWorkerConfig(env, []);
}

/**
 * Minimal deps bag: real `withTimeout` (so phase bounding is exercised), a
 * mock logger, and a provisioningJobService whose reconciler is the mock under
 * test. Every OTHER maintenance phase finds its dependency missing, throws,
 * and is isolated by runBoundedPhase — the cycle completing anyway is itself
 * part of the contract under test.
 */
function fakeDeps(
  reEnqueueImpl: () => Promise<{
    scanned: number;
    reEnqueued: number;
    failed: number;
    abandoned: number;
  }>,
) {
  const reEnqueueFailedDeletions = mock(reEnqueueImpl);
  const logger = makeLogger();
  const deps = {
    logger,
    withTimeout,
    provisioningJobService: { reEnqueueFailedDeletions },
  } as unknown as Parameters<typeof __setDepsForTests>[0];
  return { deps, logger, reEnqueueFailedDeletions };
}

function summaryLogCalls(logger: WorkerLogger): unknown[][] {
  const info = logger.info as unknown as { mock: { calls: unknown[][] } };
  return info.mock.calls.filter(
    (call) =>
      call[0] ===
      "[provisioning-worker] deletion reconciliation cycle complete",
  );
}

afterEach(() => {
  __setDepsForTests(null);
});

describe("readWorkerConfig (deletion reconcile gate)", () => {
  test("defaults ON; DELETION_RECONCILE_ENABLED=0/false opts out", () => {
    expect(makeConfig().deletionReconcileEnabled).toBe(true);
    expect(
      makeConfig({ DELETION_RECONCILE_ENABLED: "1" } as NodeJS.ProcessEnv)
        .deletionReconcileEnabled,
    ).toBe(true);
    expect(
      makeConfig({ DELETION_RECONCILE_ENABLED: "0" } as NodeJS.ProcessEnv)
        .deletionReconcileEnabled,
    ).toBe(false);
    expect(
      makeConfig({ DELETION_RECONCILE_ENABLED: "false" } as NodeJS.ProcessEnv)
        .deletionReconcileEnabled,
    ).toBe(false);
  });
});

describe("processDeletionReconcileCycle (daemon phase wiring)", () => {
  test("delegates to reEnqueueFailedDeletions with the bounded sweep args", async () => {
    const summary = { scanned: 47, reEnqueued: 45, failed: 1, abandoned: 1 };
    const { deps, reEnqueueFailedDeletions } = fakeDeps(async () => summary);
    __setDepsForTests(deps);

    const result = await processDeletionReconcileCycle(makeConfig());

    expect(reEnqueueFailedDeletions).toHaveBeenCalledTimes(1);
    expect(reEnqueueFailedDeletions).toHaveBeenCalledWith(EXPECTED_ARGS);
    expect(result).toEqual(summary);
  });

  test("skips the service entirely when the env gate is off", async () => {
    const { deps, reEnqueueFailedDeletions } = fakeDeps(async () => ({
      scanned: 0,
      reEnqueued: 0,
      failed: 0,
      abandoned: 0,
    }));
    __setDepsForTests(deps);

    const result = await processDeletionReconcileCycle(
      makeConfig({ DELETION_RECONCILE_ENABLED: "0" } as NodeJS.ProcessEnv),
    );

    expect(result).toBeNull();
    expect(reEnqueueFailedDeletions).not.toHaveBeenCalled();
  });

  test("propagates a service throw so runBoundedPhase can log-and-isolate it", async () => {
    const { deps } = fakeDeps(async () => {
      throw new Error("database unreachable");
    });
    __setDepsForTests(deps);

    await expect(processDeletionReconcileCycle(makeConfig())).rejects.toThrow(
      "database unreachable",
    );
  });
});

describe("runInfraMaintenanceCycle (deletion reconciliation phase)", () => {
  test("runs the phase during a maintenance sweep and logs the summary", async () => {
    const { deps, logger, reEnqueueFailedDeletions } = fakeDeps(async () => ({
      scanned: 3,
      reEnqueued: 2,
      failed: 0,
      abandoned: 1,
    }));
    __setDepsForTests(deps);

    await runInfraMaintenanceCycle(logger, makeConfig());

    expect(reEnqueueFailedDeletions).toHaveBeenCalledTimes(1);
    expect(reEnqueueFailedDeletions).toHaveBeenCalledWith(EXPECTED_ARGS);
    const logged = summaryLogCalls(logger);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.[1]).toEqual({
      event: "deletion_reconcile.cycle",
      scanned: 3,
      reEnqueued: 2,
      failed: 0,
      abandoned: 1,
    });
  });

  test("stays quiet when the sweep found nothing to re-arm", async () => {
    const { deps, logger } = fakeDeps(async () => ({
      scanned: 0,
      reEnqueued: 0,
      failed: 0,
      abandoned: 0,
    }));
    __setDepsForTests(deps);

    await runInfraMaintenanceCycle(logger, makeConfig());

    expect(summaryLogCalls(logger)).toHaveLength(0);
  });

  test("skips the reconciler for the whole sweep when the env gate is off", async () => {
    const { deps, logger, reEnqueueFailedDeletions } = fakeDeps(async () => ({
      scanned: 5,
      reEnqueued: 5,
      failed: 0,
      abandoned: 0,
    }));
    __setDepsForTests(deps);

    await runInfraMaintenanceCycle(
      logger,
      makeConfig({ DELETION_RECONCILE_ENABLED: "false" } as NodeJS.ProcessEnv),
    );

    expect(reEnqueueFailedDeletions).not.toHaveBeenCalled();
    expect(summaryLogCalls(logger)).toHaveLength(0);
  });

  test("a reconciler failure is isolated: the sweep completes and logs the error", async () => {
    const { deps, logger, reEnqueueFailedDeletions } = fakeDeps(async () => {
      throw new Error("neon stalled");
    });
    __setDepsForTests(deps);

    // Must resolve — a throw escaping here would abort the node-maintenance
    // sweep, which is exactly what runBoundedPhase exists to prevent.
    await runInfraMaintenanceCycle(logger, makeConfig());

    expect(reEnqueueFailedDeletions).toHaveBeenCalledTimes(1);
    expect(summaryLogCalls(logger)).toHaveLength(0);
    const error = logger.error as unknown as { mock: { calls: unknown[][] } };
    const phaseFailures = error.mock.calls.filter(
      (call) =>
        call[0] ===
        "[provisioning-worker] deletion reconciliation cycle failed",
    );
    expect(phaseFailures).toHaveLength(1);
    expect(phaseFailures[0]?.[1]).toEqual({ error: "neon stalled" });
  });
});
