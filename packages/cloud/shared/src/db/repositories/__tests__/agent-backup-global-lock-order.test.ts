/** Statically guards the sandbox-before-catalogue-authority order across backup writers. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPOSITORIES_DIR = join(import.meta.dir, "..");

function source(name: string): string {
  return readFileSync(join(REPOSITORIES_DIR, name), "utf8");
}

function exportedFunction(sourceText: string, name: string, nextName?: string): string {
  const start = sourceText.indexOf(`export async function ${name}`);
  expect(start, `${name} must remain present`).toBeGreaterThanOrEqual(0);
  const end = nextName ? sourceText.indexOf(`export async function ${nextName}`, start + 1) : -1;
  return sourceText.slice(start, end >= 0 ? end : undefined);
}

function expectOrder(body: string, first: string, second: string, label: string): void {
  const firstIndex = body.indexOf(first);
  const secondIndex = body.indexOf(second);
  expect(firstIndex, `${label}: missing first lock anchor`).toBeGreaterThanOrEqual(0);
  expect(secondIndex, `${label}: missing second lock anchor`).toBeGreaterThanOrEqual(0);
  expect(firstIndex, `${label}: ${first} must precede ${second}`).toBeLessThan(secondIndex);
}

function expectRestoreWriterOrder(body: string, label: string): void {
  const anchors = [
    ".from(agentSandboxBackups)",
    "lockExactRestoreOperationTarget(tx",
    ".from(agentBackupRestoreLeases)",
    ".from(agentSandboxes)",
    "lockCurrentNodeHistory(tx",
    "lockAgentBackupCatalogAuthority(",
  ];
  let previous = -1;
  for (const anchor of anchors) {
    const index = body.indexOf(anchor, previous + 1);
    expect(index, `${label}: missing ordered lock anchor ${anchor}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("agent backup global lock order", () => {
  test("exact restore settlement and cleanup preserve the full authority order", () => {
    const operations = source("agent-backup-restore-operations.ts");
    const boundaryStart = operations.indexOf(
      "async function runAgentSandboxExactRestoreProviderBoundary",
    );
    const boundaryEnd = operations.indexOf(
      "export async function markAgentSandboxExactRestoreProviderStarted",
      boundaryStart,
    );
    expect(boundaryStart).toBeGreaterThanOrEqual(0);
    expect(boundaryEnd).toBeGreaterThan(boundaryStart);
    const boundary = operations.slice(boundaryStart, boundaryEnd);
    const anchors = [
      ".from(organizations)",
      ".from(agentSandboxBackups)",
      ".from(agentBackupRestoreOperations)",
      ".from(agentBackupRestoreLeases)",
      ".from(agentSandboxes)",
      ".from(dockerNodes)",
      "proveExactAgentNodeOccurrenceForLockedNode(",
      "lockAgentBackupCatalogAuthority(",
      ".from(agentSandboxReplacementAttempts)",
      "readPostLockDatabaseNow(tx)",
    ];
    let previous = -1;
    for (const anchor of anchors) {
      const index = boundary.indexOf(anchor, previous + 1);
      expect(
        index,
        `exact restore boundary: missing ordered lock anchor ${anchor}`,
      ).toBeGreaterThan(previous);
      previous = index;
    }

    const cleanupClaim = exportedFunction(
      operations,
      "claimAgentSandboxExactRestoreCleanup",
      "releaseAgentSandboxExactRestoreCleanupClaim",
    );
    expectOrder(
      cleanupClaim,
      ".from(agentBackupRestoreOperations)",
      ".from(agentSandboxReplacementAttempts)",
      "cleanup claim",
    );
    expectOrder(
      cleanupClaim,
      ".from(agentSandboxReplacementAttempts)",
      "readPostLockDatabaseNow(tx)",
      "cleanup claim clock",
    );
  });

  test("restore publication follows backup-to-catalogue lock order", () => {
    const history = source("agent-backup-restore-history.ts");
    const start = history.indexOf("async function recordRestoreActivationPublication");
    const end = history.indexOf("export async function recordAgentActivationPublication", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expectRestoreWriterOrder(history.slice(start, end), "restore publication");
  });

  test("vault-seed receipt follows backup-to-catalogue lock order", () => {
    const history = source("agent-backup-restore-history.ts");
    const seed = exportedFunction(
      history,
      "recordAgentVaultKeySeedReceipt",
      "commitAgentBackupRestore",
    );
    const anchors = [
      ".from(agentSandboxBackups)",
      ".from(agentBackupRestoreOperations)",
      ".from(agentBackupRestoreLeases)",
      ".from(agentSandboxes)",
      ".from(dockerNodes)",
      "proveExactAgentNodeOccurrenceForLockedNode(",
      "lockAgentBackupCatalogAuthority(",
      "lockExactVaultSeedReplacementIntent(",
      "readPostLockDatabaseNow(tx)",
    ];
    let previous = -1;
    for (const anchor of anchors) {
      const index = seed.indexOf(anchor, previous + 1);
      expect(index, `vault-seed receipt: missing ordered lock anchor ${anchor}`).toBeGreaterThan(
        previous,
      );
      previous = index;
    }
    const attemptLockStart = history.indexOf("async function lockExactVaultSeedReplacementIntent");
    const attemptLockEnd = history.indexOf(
      "function hasCommonAgentBackupRestoreQuarantineAuthority",
      attemptLockStart,
    );
    expect(attemptLockStart).toBeGreaterThanOrEqual(0);
    expect(attemptLockEnd).toBeGreaterThan(attemptLockStart);
    const attemptLock = history.slice(attemptLockStart, attemptLockEnd);
    expect(attemptLock).toContain(".from(agentSandboxReplacementAttempts)");
    expect(attemptLock).toContain('.for("update")');
  });

  test("restore finalizer follows backup-to-catalogue lock order", () => {
    const history = source("agent-backup-restore-history.ts");
    const finalizer = exportedFunction(history, "commitAgentBackupRestore");
    expectRestoreWriterOrder(finalizer, "restore finalizer");
    expectOrder(
      finalizer,
      "lockAgentBackupCatalogAuthority(",
      "lockExactAdoptedRestoreReplacement(tx",
      "restore finalizer adopted replacement",
    );
    expectOrder(
      finalizer,
      "lockExactAdoptedRestoreReplacement(tx",
      "readPostLockDatabaseNow(tx)",
      "restore finalizer clock",
    );
  });

  test("reservation, capture, and vault rotation preserve the same order", () => {
    const catalog = source("agent-backup-catalog.ts");
    const vault = source("agent-vault-key-authority.ts");
    const reservation = exportedFunction(
      catalog,
      "reserveAgentBackupOperationInTransaction",
      "claimDueAgentBackupOperations",
    );
    const capture = exportedFunction(
      catalog,
      "recordCapturedAgentBackupManifest",
      "transitionAgentBackupOperation",
    );
    const rotation = exportedFunction(
      vault,
      "createOrRotateAgentVaultKeyGeneration",
      "loadCurrentAgentVaultKeyAuthority",
    );

    expectOrder(
      reservation,
      ".from(agentSandboxes)",
      "createAndLockCatalogAuthority(",
      "reservation",
    );
    expectOrder(capture, ".from(agentSandboxes)", "lockAgentBackupCatalogAuthority(", "capture");
    expectOrder(
      rotation,
      ".from(agentSandboxes)",
      "lockAgentBackupCatalogAuthority(",
      "vault rotation",
    );
  });

  test("scheduler reservation locks replay then organization before its outer sandbox lock", () => {
    const scheduler = source("agent-backup-scheduler.ts");
    const reservation = exportedFunction(
      scheduler,
      "reserveClaimedAgentBackupSchedule",
      "deferClaimedAgentBackupSchedule",
    );

    expectOrder(
      reservation,
      "lockAgentBackupReservationReplayInTransaction(tx",
      ".from(organizations)",
      "scheduler reservation replay/organization",
    );
    expectOrder(
      reservation,
      ".from(organizations)",
      '.for("update")',
      "scheduler reservation organization lock",
    );
    expectOrder(
      reservation,
      '.for("update")',
      "lockClaimedSandbox(tx",
      "scheduler reservation organization/sandbox",
    );
  });
});
