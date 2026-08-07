/**
 * Daemon-phase wiring for the backup restorability verification cycle
 * (#15603 B5): `processBackupVerificationCycle` must delegate to the shared
 * `runBackupVerificationCycle` service and surface its summary unchanged. The
 * verification behavior itself (real PGlite + real KMS) is pinned in
 * `packages/cloud/shared/src/lib/services/agent-backup-verifier.test.ts`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  __setDepsForTests,
  processBackupVerificationCycle,
} from "./provisioning-worker";

afterEach(() => {
  __setDepsForTests(null);
});

describe("processBackupVerificationCycle (daemon phase wiring)", () => {
  test("delegates to runBackupVerificationCycle and returns its summary", async () => {
    const summary = {
      enabled: true,
      sampled: 3,
      verified: 2,
      failed: 1,
      errored: 0,
      oversizeSkipped: 0,
      budgetDeferred: 0,
      escalated: false,
      failures: [
        {
          backupId: "b-1",
          sandboxRecordId: "s-1",
          kind: "key-unavailable" as const,
          message: "key not found: org:x/dek v1",
        },
      ],
    };
    const runBackupVerificationCycle = mock(async () => summary);
    __setDepsForTests({ runBackupVerificationCycle } as unknown as Parameters<
      typeof __setDepsForTests
    >[0]);

    const result = await processBackupVerificationCycle();

    expect(runBackupVerificationCycle).toHaveBeenCalledTimes(1);
    expect(result).toEqual(summary);
  });

  test("propagates a service throw so runBoundedPhase can log-and-isolate it", async () => {
    const runBackupVerificationCycle = mock(async () => {
      throw new Error("database unreachable");
    });
    __setDepsForTests({ runBackupVerificationCycle } as unknown as Parameters<
      typeof __setDepsForTests
    >[0]);

    await expect(processBackupVerificationCycle()).rejects.toThrow(
      "database unreachable",
    );
  });
});
