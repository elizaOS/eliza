/**
 * Exercises the candidate-bound restore receipt against a real filesystem,
 * including concurrent admission, crash replay, and exact idempotency.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSnapshotUpgradeBinding } from "./agent-backup.ts";
import {
  beginCandidateSnapshotRestore,
  commitCandidateSnapshotRestore,
  resolveCandidateSnapshotRestoreBinding,
  verifyCandidateSnapshotRestoreHeaders,
} from "./agent-snapshot-restore-binding.ts";

const ORIGINAL_STATE_DIR = process.env.ELIZA_STATE_DIR;
const roots = new Set<string>();
const BINDING: AgentSnapshotUpgradeBinding = {
  backupId: "11111111-1111-4111-8111-111111111111",
  captureNonce: "01".repeat(32),
  sourceEnvironmentRevision: 7,
  sourceImageDigest: `sha256:${"02".repeat(32)}`,
  sourceSandboxId: "33333333-3333-4333-8333-333333333333",
  targetImageDigest: `sha256:${"03".repeat(32)}`,
  targetReplacementAttemptId: "22222222-2222-4222-8222-222222222222",
  targetSandboxId: "target-sandbox",
};

function environmentFor(
  binding: AgentSnapshotUpgradeBinding = BINDING,
): NodeJS.ProcessEnv {
  return {
    ELIZA_SNAPSHOT_RESTORE_BACKUP_ID: binding.backupId,
    ELIZA_SNAPSHOT_RESTORE_CANDIDATE_ATTEMPT_ID:
      binding.targetReplacementAttemptId,
    ELIZA_SNAPSHOT_RESTORE_NONCE: binding.captureNonce,
    ELIZA_SNAPSHOT_RESTORE_PROVIDER_SANDBOX_ID: binding.targetSandboxId,
    ELIZA_SNAPSHOT_RESTORE_SOURCE_ENVIRONMENT_REVISION: String(
      binding.sourceEnvironmentRevision,
    ),
    ELIZA_SNAPSHOT_RESTORE_SOURCE_IMAGE_DIGEST: binding.sourceImageDigest,
    ELIZA_SNAPSHOT_RESTORE_SOURCE_SANDBOX_ID: binding.sourceSandboxId,
    ELIZA_SNAPSHOT_RESTORE_TARGET_IMAGE_DIGEST: binding.targetImageDigest,
  };
}

function headersFor(
  binding: AgentSnapshotUpgradeBinding = BINDING,
): NodeJS.Dict<string | string[]> {
  return {
    "x-eliza-snapshot-backup-id": binding.backupId,
    "x-eliza-snapshot-capture-nonce": binding.captureNonce,
    "x-eliza-snapshot-source-environment-revision": String(
      binding.sourceEnvironmentRevision,
    ),
    "x-eliza-snapshot-source-image-digest": binding.sourceImageDigest,
    "x-eliza-snapshot-source-sandbox-id": binding.sourceSandboxId,
    "x-eliza-snapshot-target-image-digest": binding.targetImageDigest,
    "x-eliza-snapshot-target-replacement-attempt-id":
      binding.targetReplacementAttemptId,
    "x-eliza-snapshot-target-sandbox-id": binding.targetSandboxId,
  };
}

async function temporaryStateDir(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-candidate-receipt-"),
  );
  roots.add(root);
  process.env.ELIZA_STATE_DIR = root;
  return root;
}

afterEach(async () => {
  if (ORIGINAL_STATE_DIR === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = ORIGINAL_STATE_DIR;
  await Promise.all(
    [...roots].map((root) => fs.rm(root, { force: true, recursive: true })),
  );
  roots.clear();
});

describe.sequential("candidate snapshot restore binding", () => {
  test("requires one complete provider identity and matching request headers", () => {
    expect(resolveCandidateSnapshotRestoreBinding({})).toBeNull();
    expect(() =>
      resolveCandidateSnapshotRestoreBinding({
        ELIZA_SNAPSHOT_RESTORE_BACKUP_ID: BINDING.backupId,
      }),
    ).toThrow("partially configured");
    expect(resolveCandidateSnapshotRestoreBinding(environmentFor())).toEqual(
      BINDING,
    );
    expect(() =>
      resolveCandidateSnapshotRestoreBinding(
        environmentFor({
          ...BINDING,
          sourceImageDigest: "02".repeat(32),
        }),
      ),
    ).toThrow("source image digest is not canonical");
    expect(() =>
      verifyCandidateSnapshotRestoreHeaders(
        {
          ...headersFor(),
          "x-eliza-snapshot-target-sandbox-id": "other-target",
        },
        BINDING,
      ),
    ).toThrow("does not match this replacement candidate");
    expect(() =>
      verifyCandidateSnapshotRestoreHeaders(headersFor(), BINDING),
    ).not.toThrow();
  });

  test("durably creates every receipt ancestor through the stable state root", async () => {
    const stateRoot = await temporaryStateDir();
    const backups = path.join(stateRoot, "backups");
    const receipts = path.join(backups, "restore-receipts");
    const originalOpen = fs.open.bind(fs);
    const syncedTargets: string[] = [];
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const openedPath = String(args[0]);
      return new Proxy(handle, {
        get(targetHandle, property) {
          if (property === "sync") {
            return async () => {
              syncedTargets.push(openedPath);
              await targetHandle.sync();
            };
          }
          const value = Reflect.get(targetHandle, property, targetHandle);
          return typeof value === "function" ? value.bind(targetHandle) : value;
        },
      });
    });
    try {
      await expect(beginCandidateSnapshotRestore(BINDING)).resolves.toBeNull();
    } finally {
      openSpy.mockRestore();
    }

    const backupsSync = syncedTargets.indexOf(backups);
    const stateRootSync = syncedTargets.indexOf(stateRoot);
    const receiptsSync = syncedTargets.indexOf(receipts);
    expect(backupsSync).toBeGreaterThanOrEqual(0);
    expect(stateRootSync).toBeGreaterThan(backupsSync);
    expect(receiptsSync).toBeGreaterThan(stateRootSync);
    expect(syncedTargets.at(-1)).toBe(receipts);
    await expect(fs.stat(backups)).resolves.toMatchObject({
      mode: expect.any(Number),
    });
    expect((await fs.stat(backups)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(receipts)).mode & 0o777).toBe(0o700);
    await expect(
      fs.readFile(path.join(receipts, `${BINDING.backupId}.json`), "utf8"),
    ).resolves.toContain('"status":"applying"');
  });

  test("admits exactly one concurrent apply and fails closed after a crash", async () => {
    await temporaryStateDir();
    const attempts = await Promise.allSettled([
      beginCandidateSnapshotRestore(BINDING),
      beginCandidateSnapshotRestore(BINDING),
    ]);

    expect(
      attempts.filter(
        (result) => result.status === "fulfilled" && result.value === null,
      ),
    ).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected).toBeDefined();
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({
        code: "AGENT_SNAPSHOT_RESTORE_INDETERMINATE",
      });
    }
    await expect(beginCandidateSnapshotRestore(BINDING)).rejects.toMatchObject({
      code: "AGENT_SNAPSHOT_RESTORE_INDETERMINATE",
    });
  });

  test("replays only the exact committed acknowledgement", async () => {
    await temporaryStateDir();
    await expect(beginCandidateSnapshotRestore(BINDING)).resolves.toBeNull();
    const committed = await commitCandidateSnapshotRestore(BINDING, {
      aggregateSha256: "04".repeat(32),
      fileCount: 2,
      requiresRestart: true,
      schemaVersion: 2,
      success: true,
      totalBytes: 64,
      transfer: "chunked-v1",
    });

    await expect(beginCandidateSnapshotRestore(BINDING)).resolves.toEqual(
      committed,
    );
    await expect(
      commitCandidateSnapshotRestore(BINDING, {
        aggregateSha256: "04".repeat(32),
        fileCount: 2,
        requiresRestart: true,
        schemaVersion: 2,
        success: true,
        totalBytes: 64,
        transfer: "chunked-v1",
      }),
    ).resolves.toEqual(committed);
    await expect(
      commitCandidateSnapshotRestore(BINDING, {
        aggregateSha256: "06".repeat(32),
        fileCount: 2,
        requiresRestart: true,
        schemaVersion: 2,
        success: true,
        totalBytes: 64,
        transfer: "chunked-v1",
      }),
    ).rejects.toMatchObject({
      code: "AGENT_SNAPSHOT_RECEIPT_CONFLICT",
    });
    await expect(
      beginCandidateSnapshotRestore({
        ...BINDING,
        captureNonce: "05".repeat(32),
      }),
    ).rejects.toMatchObject({
      code: "AGENT_SNAPSHOT_RECEIPT_CONFLICT",
    });
  });
});
