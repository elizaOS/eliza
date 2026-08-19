/** Static gate: dormant restore authority has no production caller or publication writer. */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const REPOSITORY_ROOT = join(import.meta.dir, "../../../../..");
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "__tests__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "test",
  "tests",
]);

function productionSources(directory = REPOSITORY_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) return [];
      return productionSources(absolute);
    }
    if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) return [];
    return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) ? [] : [absolute];
  });
}

describe("dormant restore API boundary", () => {
  test("keeps restore histories and receipt writers definition-only", () => {
    const sources = productionSources().map((path) => ({
      path,
      source: readFileSync(path, "utf8"),
    }));
    const production = sources.map(({ source }) => source).join("\n");
    for (const forbidden of [
      "queryAgentBackupRestoreCommitOutcome",
      "markAgentBackupRestoreVerified",
      "runAgentBackupRestoreCoordinator",
      "dispatchAgentBackupRestore",
    ]) {
      expect(production, `Unexpected provisional restore surface: ${forbidden}`).not.toContain(
        forbidden,
      );
    }
    for (const symbol of [
      "acquireAgentBackupRestoreLease",
      "renewAgentBackupRestoreLease",
      "releaseAgentBackupRestoreLease",
      "loadAgentBackupRestoreSourceV3",
      "createOrRotateAgentVaultKeyGeneration",
      "loadCurrentAgentVaultKeyAuthority",
      "bindAgentBackupVaultKeyGeneration",
      "recordAgentActivationPublication",
      "authorizeAgentActivationDispatch",
      "recordAgentVaultKeySeedReceipt",
      "commitAgentBackupRestore",
    ]) {
      const occurrences = sources.flatMap(({ path, source }) =>
        source.includes(symbol) ? [path] : [],
      );
      expect(occurrences, `${symbol} must remain definition-only`).toEqual([
        expect.stringContaining("/db/repositories/"),
      ]);
    }
    expect(readFileSync(join(import.meta.dir, "index.ts"), "utf8")).not.toMatch(
      /agent-backup-restore|agent-vault-key-authority/,
    );
  });

  test("contains no coordinator, capacity, billing, or probe migration in the dormant range", () => {
    const restoreMigrations = readdirSync(MIGRATIONS_DIR).filter((name) => {
      const ordinal = Number(name.slice(0, 4));
      return ordinal >= 236 && ordinal <= 250 && name.endsWith(".sql");
    });
    expect(restoreMigrations).toHaveLength(15);
    expect(restoreMigrations.join("\n")).not.toMatch(/capacity|billing|probe|coordinator/i);
    const migrationSource = restoreMigrations
      .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf8"))
      .join("\n");
    expect(migrationSource).toContain("agent_backup_restore_receipts");
    expect(migrationSource).toContain("agent_vault_key_seed_receipts");
  });

  test("locks reservation replay before every sandbox and catalogue authority", () => {
    const catalogSource = readFileSync(
      join(import.meta.dir, "repositories/agent-backup-catalog.ts"),
      "utf8",
    );
    const replayHelper = catalogSource.slice(
      catalogSource.indexOf("export async function lockAgentBackupReservationReplayInTransaction"),
      catalogSource.indexOf("export async function reserveAgentBackupOperationInTransaction"),
    );
    const replayBackup = replayHelper.indexOf(".from(agentSandboxBackups)");
    const replayOperation = replayHelper.indexOf(
      "eq(agentSandboxBackups.backup_operation_id",
      replayBackup,
    );
    const replayForUpdate = replayHelper.indexOf('.for("update")', replayOperation);
    expect(replayBackup).toBeGreaterThanOrEqual(0);
    expect(replayOperation).toBeGreaterThan(replayBackup);
    expect(replayForUpdate).toBeGreaterThan(replayOperation);

    const reservation = catalogSource.slice(
      catalogSource.indexOf("export async function reserveAgentBackupOperationInTransaction"),
      catalogSource.indexOf("export async function claimDueAgentBackupOperations"),
    );
    const reserveReplay = reservation.indexOf(
      "await lockAgentBackupReservationReplayInTransaction(tx, input)",
    );
    const reserveSandbox = reservation.indexOf(".from(agentSandboxes)", reserveReplay);
    const authorityLock = reservation.indexOf("const reservationAuthority");
    expect(reserveReplay).toBeGreaterThanOrEqual(0);
    expect(reserveSandbox).toBeGreaterThan(reserveReplay);
    expect(authorityLock).toBeGreaterThan(reserveSandbox);

    const schedulerSource = readFileSync(
      join(import.meta.dir, "repositories/agent-backup-scheduler.ts"),
      "utf8",
    );
    const scheduleReservation = schedulerSource.slice(
      schedulerSource.indexOf("export async function reserveClaimedAgentBackupSchedule"),
      schedulerSource.indexOf("export async function failClaimedAgentBackupSchedule"),
    );
    const schedulerReplay = scheduleReservation.indexOf(
      "await lockAgentBackupReservationReplayInTransaction(tx, claim)",
    );
    const schedulerSandbox = scheduleReservation.indexOf("await lockClaimedSandbox(tx, claim)");
    expect(schedulerReplay).toBeGreaterThanOrEqual(0);
    expect(schedulerSandbox).toBeGreaterThan(schedulerReplay);
  });
});
