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
  test("claims and heartbeats lock operation, lease, then required sandbox runtime", () => {
    const operations = source("agent-backup-restore-operations.ts");
    const claim = exportedFunction(
      operations,
      "claimAgentBackupRestoreOperation",
      "reserveAgentBackupRestoreTarget",
    );
    const heartbeat = exportedFunction(
      operations,
      "heartbeatAgentBackupRestoreOperation",
      "failAgentBackupRestoreOperation",
    );

    for (const [label, body] of [
      ["restore claim", claim],
      ["restore heartbeat", heartbeat],
    ] as const) {
      expectOrder(
        body,
        ".from(agentBackupRestoreOperations)",
        ".from(agentBackupRestoreLeases)",
        `${label} operation-to-lease`,
      );
      expectOrder(
        body,
        ".from(agentBackupRestoreLeases)",
        "lockRequiredRestoreEndpointRuntime(tx",
        `${label} lease-to-sandbox`,
      );
      expectOrder(
        body,
        "lockRequiredRestoreEndpointRuntime(tx",
        "readPostLockDatabaseNow(tx)",
        `${label} sandbox-to-clock`,
      );
    }
  });

  test("post-container restore advance locks operation, lease, then sandbox runtime", () => {
    const operations = source("agent-backup-restore-operations.ts");
    const advance = exportedFunction(
      operations,
      "advanceAgentBackupRestoreOperation",
      "heartbeatAgentBackupRestoreOperation",
    );
    expectOrder(
      advance,
      ".from(agentBackupRestoreOperations)",
      ".from(agentBackupRestoreLeases)",
      "restore advance operation-to-lease",
    );
    expectOrder(
      advance,
      ".from(agentBackupRestoreLeases)",
      "lockExactRestoreEndpointRuntime(tx",
      "restore advance lease-to-sandbox",
    );
    expectOrder(
      advance,
      "lockExactRestoreEndpointRuntime(tx",
      "readPostLockDatabaseNow(tx)",
      "restore advance sandbox-to-clock",
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
});
