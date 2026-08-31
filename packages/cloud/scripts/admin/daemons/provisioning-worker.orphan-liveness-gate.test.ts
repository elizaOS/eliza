/**
 * Destructive orphan cleanup must never run from a worker whose database is
 * split from the Cloud API authority. A split makes every real workload look
 * rowless, so this gate is the last defense before `docker rm -f`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { withTimeout } from "@elizaos/cloud-shared/lib/utils/with-timeout";
import {
  __setDepsForTests,
  readWorkerConfig,
  runOrphanReconciliationCycle,
} from "./provisioning-worker";

type WorkerLogger = Parameters<typeof runOrphanReconciliationCycle>[0];
type WorkerDeps = Parameters<typeof __setDepsForTests>[0];

function logger(): WorkerLogger {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  } as unknown as WorkerLogger;
}

function config() {
  return readWorkerConfig(
    { ORPHAN_RECONCILER_ENABLED: "1" } as NodeJS.ProcessEnv,
    [],
  );
}

function install() {
  const reconcileOrphanContainersOnNodes = mock(async () => ({
    nodesScanned: 1,
    nodesSkipped: 0,
    reaped: 0,
    reapFailed: 0,
  }));
  const reconcileOrphanAppContainersOnNodes = mock(async () => ({
    nodesScanned: 1,
    nodesSkipped: 0,
    reaped: 0,
    reapFailed: 0,
  }));
  const deps = {
    withTimeout,
    reconcileOrphanContainersOnNodes,
    reconcileOrphanAppContainersOnNodes,
  } as unknown as Exclude<WorkerDeps, null>;
  __setDepsForTests(deps);
  return {
    reconcileOrphanContainersOnNodes,
    reconcileOrphanAppContainersOnNodes,
  };
}

afterEach(() => {
  __setDepsForTests(null);
});

describe("orphan reconciliation DB-authority gate", () => {
  test("runs both orphan reconcilers when recent jobs prove the live API database", async () => {
    const log = logger();
    const reconcilers = install();

    await runOrphanReconciliationCycle(log, config(), {
      stale: false,
      ageHours: 0,
      maxAgeHours: 24,
      latestJobCreatedAt: new Date(),
      verdict: "healthy",
      heartbeatAt: null,
      heartbeatAgeMinutes: null,
      heartbeatMaxAgeMinutes: 15,
    });

    expect(reconcilers.reconcileOrphanContainersOnNodes).toHaveBeenCalledTimes(
      1,
    );
    expect(
      reconcilers.reconcileOrphanAppContainersOnNodes,
    ).toHaveBeenCalledTimes(1);
  });

  test("skips destructive cleanup when the database has no live API authority", async () => {
    const log = logger();
    const reconcilers = install();

    await runOrphanReconciliationCycle(log, config(), {
      stale: true,
      ageHours: null,
      maxAgeHours: 24,
      latestJobCreatedAt: null,
      verdict: "stale-unknown",
      heartbeatAt: null,
      heartbeatAgeMinutes: null,
      heartbeatMaxAgeMinutes: 15,
    });

    expect(reconcilers.reconcileOrphanContainersOnNodes).not.toHaveBeenCalled();
    expect(
      reconcilers.reconcileOrphanAppContainersOnNodes,
    ).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "[provisioning-worker] orphan reconciliation skipped: live Cloud API database authority is not proven",
      {
        event: "orphan_reconciler.database_authority_unproven",
        dbLivenessVerdict: "stale-unknown",
      },
    );
  });

  test("fails closed when the liveness query itself fails", async () => {
    const log = logger();
    const reconcilers = install();

    await runOrphanReconciliationCycle(log, config(), undefined);

    expect(reconcilers.reconcileOrphanContainersOnNodes).not.toHaveBeenCalled();
    expect(
      reconcilers.reconcileOrphanAppContainersOnNodes,
    ).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "[provisioning-worker] orphan reconciliation skipped: live Cloud API database authority is not proven",
      {
        event: "orphan_reconciler.database_authority_unproven",
        dbLivenessVerdict: "check_failed",
      },
    );
  });
});
