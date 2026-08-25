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
    expectRestoreWriterOrder(seed, "vault-seed receipt");
  });

  test("restore finalizer follows backup-to-catalogue lock order", () => {
    const history = source("agent-backup-restore-history.ts");
    const finalizer = exportedFunction(history, "commitAgentBackupRestore");
    expectRestoreWriterOrder(finalizer, "restore finalizer");
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

  test("scheduler reservation joins backup order before its outer sandbox lock", () => {
    const scheduler = source("agent-backup-scheduler.ts");
    const reservation = exportedFunction(
      scheduler,
      "reserveClaimedAgentBackupSchedule",
      "deferClaimedAgentBackupSchedule",
    );

    expectOrder(
      reservation,
      "lockAgentBackupReservationReplayInTransaction(tx",
      "lockClaimedSandbox(tx",
      "scheduler reservation",
    );
  });

  test("capture admission locks the global lane before its exact source authority", () => {
    const admission = source("agent-backup-operation-admission.ts");
    const sourceLockStart = admission.indexOf(
      "async function lockExactSourceAuthorityInTransaction",
    );
    const sourceLockEnd = admission.indexOf("function assertCatalogueReplay", sourceLockStart);
    expect(sourceLockStart).toBeGreaterThanOrEqual(0);
    expect(sourceLockEnd).toBeGreaterThan(sourceLockStart);
    const sourceLocks = admission.slice(sourceLockStart, sourceLockEnd);
    const sourceAnchors = [
      ".from(agentSandboxes)",
      ".from(organizations)",
      ".from(agentActivationPublications)",
      ".from(dockerNodes)",
      ".from(agentNodeIncarnationHistories)",
    ];
    let previous = -1;
    for (const anchor of sourceAnchors) {
      const index = sourceLocks.indexOf(anchor, previous + 1);
      expect(index, `capture admission: missing ordered lock anchor ${anchor}`).toBeGreaterThan(
        previous,
      );
      previous = index;
    }
    const publicationReadStart = sourceLocks.indexOf(".from(agentActivationPublications)");
    const nodeLockStart = sourceLocks.indexOf(".from(dockerNodes)", publicationReadStart);
    expect(
      sourceLocks.slice(publicationReadStart, nodeLockStart),
      "immutable activation publication must not be row-locked after the sandbox",
    ).not.toContain('.for("');

    const claim = exportedFunction(
      admission,
      "claimNextAgentBackupOperationAdmission",
      "renewAgentBackupOperationAdmission",
    );
    expectOrder(
      claim,
      "lockAgentBackupOperationLaneInTransaction(tx)",
      "lockNextDueBackupInTransaction(tx)",
      "capture admission",
    );
    const renew = exportedFunction(admission, "renewAgentBackupOperationAdmission");
    expectOrder(
      renew,
      "renewAgentBackupOperationLaneInTransaction(tx",
      "lockBackupByTargetInTransaction(tx",
      "capture admission renewal",
    );
  });

  test("detached publication admission locks the lane before immutable source authority", () => {
    const admission = source("agent-backup-publication-admission.ts");
    const sourceLockStart = admission.indexOf(
      "async function lockDetachedSourceAuthorityInTransaction",
    );
    const sourceLockEnd = admission.indexOf("function assertCatalogueReplay", sourceLockStart);
    expect(sourceLockStart).toBeGreaterThanOrEqual(0);
    expect(sourceLockEnd).toBeGreaterThan(sourceLockStart);
    const sourceLocks = admission.slice(sourceLockStart, sourceLockEnd);
    const sourceAnchors = [
      ".from(organizations)",
      ".from(agentActivationPublications)",
      ".from(agentNodeIncarnationHistories)",
    ];
    let previous = -1;
    for (const anchor of sourceAnchors) {
      const index = sourceLocks.indexOf(anchor, previous + 1);
      expect(index, `publication admission: missing ordered authority ${anchor}`).toBeGreaterThan(
        previous,
      );
      previous = index;
    }

    expect(admission, "detached publication must not read the mutable sandbox row").not.toContain(
      ".from(agentSandboxes)",
    );
    expect(admission, "detached publication must not read the mutable node row").not.toContain(
      ".from(dockerNodes)",
    );

    const publicationReadStart = sourceLocks.indexOf(".from(agentActivationPublications)");
    const historyReadStart = sourceLocks.indexOf(
      ".from(agentNodeIncarnationHistories)",
      publicationReadStart,
    );
    expect(
      sourceLocks.slice(publicationReadStart, historyReadStart),
      "immutable activation publication must not be row-locked",
    ).not.toContain('.for("');
    expect(
      sourceLocks.slice(historyReadStart),
      "append-only node history must not be row-locked",
    ).not.toContain('.for("');

    const claim = exportedFunction(
      admission,
      "claimNextAgentBackupPublicationAdmission",
      "renewAgentBackupPublicationAdmission",
    );
    expectOrder(
      claim,
      "lockAgentBackupOperationLaneInTransaction(tx)",
      "lockNextDuePublicationInTransaction(tx)",
      "publication admission",
    );
    const renew = exportedFunction(admission, "renewAgentBackupPublicationAdmission");
    expectOrder(
      renew,
      "renewAgentBackupOperationLaneInTransaction(tx",
      "lockBackupByTargetInTransaction(tx",
      "publication admission renewal",
    );
  });
});
