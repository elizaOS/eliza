/**
 * Verifies the provisioning daemon delegates expired pre-delete backup cleanup
 * to the bounded repository operation and lets failures reach phase isolation.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  __setDepsForTests,
  processPreDeleteBackupCleanupCycle,
} from "./provisioning-worker";

afterEach(() => {
  __setDepsForTests(null);
});

describe("processPreDeleteBackupCleanupCycle", () => {
  test("returns the repository cleanup summary", async () => {
    const cleanupExpiredPreDeleteRecoveryBackups = mock(async () => ({
      deletedRows: 3,
      deletedObjects: 2,
    }));
    __setDepsForTests({
      agentSandboxesRepository: { cleanupExpiredPreDeleteRecoveryBackups },
    } as unknown as Parameters<typeof __setDepsForTests>[0]);

    await expect(processPreDeleteBackupCleanupCycle()).resolves.toEqual({
      deletedRows: 3,
      deletedObjects: 2,
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
});
