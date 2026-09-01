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
  runInfraMaintenanceCycle,
} from "./provisioning-worker";

type WorkerLogger = Parameters<typeof runInfraMaintenanceCycle>[0];
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

function install(latestJobCreatedAt: Date | null | Error) {
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
    jobsRepository: {
      findLatestCreatedAt: mock(async () => {
        if (latestJobCreatedAt instanceof Error) throw latestJobCreatedAt;
        return latestJobCreatedAt;
      }),
    },
    readCloudApiDbHeartbeatAt: mock(async () => null),
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

describe("runInfraMaintenanceCycle orphan DB-authority gate", () => {
  test("runs both orphan reconcilers when recent jobs prove the live API database", async () => {
    const log = logger();
    const reconcilers = install(new Date());

    await runInfraMaintenanceCycle(log, config());

    expect(reconcilers.reconcileOrphanContainersOnNodes).toHaveBeenCalledTimes(
      1,
    );
    expect(
      reconcilers.reconcileOrphanAppContainersOnNodes,
    ).toHaveBeenCalledTimes(1);
  });

  test("skips destructive cleanup when the database has no live API authority", async () => {
    const log = logger();
    const reconcilers = install(null);

    await runInfraMaintenanceCycle(log, config());

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
    const reconcilers = install(new Error("database unavailable"));

    await runInfraMaintenanceCycle(log, config());

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
