/**
 * Verifies the provisioning daemon delegates expired pre-delete backup cleanup
 * to the bounded repository operation and lets failures reach phase isolation.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { withTimeout } from "@elizaos/cloud-shared/lib/utils/with-timeout";
import {
  __setDepsForTests,
  processPreDeleteBackupCleanupCycle,
  readWorkerConfig,
  runInfraMaintenanceCycle,
} from "./provisioning-worker";

afterEach(() => {
  __setDepsForTests(null);
});

describe("processPreDeleteBackupCleanupCycle", () => {
  test("returns the repository cleanup summary", async () => {
    const cleanupExpiredPreDeleteRecoveryBackups = mock(async () => ({
      deletedRows: 3,
      deletedObjects: 2,
      failedRows: 1,
      invalidRows: 1,
    }));
    __setDepsForTests({
      agentSandboxesRepository: { cleanupExpiredPreDeleteRecoveryBackups },
    } as unknown as Parameters<typeof __setDepsForTests>[0]);

    await expect(processPreDeleteBackupCleanupCycle()).resolves.toEqual({
      deletedRows: 3,
      deletedObjects: 2,
      failedRows: 1,
      invalidRows: 1,
    });
    expect(cleanupExpiredPreDeleteRecoveryBackups).toHaveBeenCalledTimes(1);
  });

  test("propagates cleanup failures to the bounded phase", async () => {
    const cleanupExpiredPreDeleteRecoveryBackups = mock(async () => {
      throw new Error("R2 delete unavailable");
    });
    __setDepsForTests({
      agentSandboxesRepository: { cleanupExpiredPreDeleteRecoveryBackups },
    } as unknown as Parameters<typeof __setDepsForTests>[0]);

    await expect(processPreDeleteBackupCleanupCycle()).rejects.toThrow(
      "R2 delete unavailable",
    );
  });

  test("is wired into the real infra maintenance cycle with failure accounting", async () => {
    const summary = {
      deletedRows: 2,
      deletedObjects: 1,
      failedRows: 1,
      invalidRows: 1,
    };
    const cleanupExpiredPreDeleteRecoveryBackups = mock(async () => summary);
    const logger = {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    __setDepsForTests({
      agentSandboxesRepository: { cleanupExpiredPreDeleteRecoveryBackups },
      withTimeout,
    } as unknown as Parameters<typeof __setDepsForTests>[0]);

    await runInfraMaintenanceCycle(
      logger as unknown as Parameters<typeof runInfraMaintenanceCycle>[0],
      readWorkerConfig({} as NodeJS.ProcessEnv, []),
    );

    expect(cleanupExpiredPreDeleteRecoveryBackups).toHaveBeenCalledTimes(1);
    const calls = (logger.info as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(calls).toContainEqual([
      "[provisioning-worker] pre-delete backup cleanup cycle complete",
      { event: "pre_delete_backup_cleanup.cycle", ...summary },
    ]);
  });
});
