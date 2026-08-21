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

describe("agent backup global lock order", () => {
  test("vault-seed receipt locks sandbox and node before catalogue authority", () => {
    const history = source("agent-backup-restore-history.ts");
    const seed = exportedFunction(
      history,
      "recordAgentVaultKeySeedReceipt",
      "commitAgentBackupRestore",
    );
    expectOrder(
      seed,
      ".from(agentSandboxes)",
      ".from(agentBackupCatalogAuthorities)",
      "vault-seed receipt",
    );
    expectOrder(
      seed,
      "lockCurrentNodeHistory(tx",
      ".from(agentBackupCatalogAuthorities)",
      "vault-seed receipt",
    );
  });

  test("restore finalizer locks sandbox and node before catalogue authority", () => {
    const history = source("agent-backup-restore-history.ts");
    const finalizer = exportedFunction(history, "commitAgentBackupRestore");
    expectOrder(
      finalizer,
      ".from(agentSandboxes)",
      ".from(agentBackupCatalogAuthorities)",
      "restore finalizer",
    );
    expectOrder(
      finalizer,
      "lockCurrentNodeHistory(tx",
      ".from(agentBackupCatalogAuthorities)",
      "restore finalizer",
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
