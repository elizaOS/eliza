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
      "withAgentBackupRestoreVaultPassphrase",
      "openAgentBackupRestoreOperation",
      "claimAgentBackupRestoreOperation",
      "reserveAgentBackupRestoreTarget",
      "advanceAgentBackupRestoreOperation",
      "recordAgentActivationPublication",
      "authorizeAgentActivationDispatch",
      "recordAgentVaultKeySeedReceipt",
      "commitAgentBackupRestore",
    ]) {
      const occurrences = sources.flatMap(({ path, source }) =>
        source.includes(symbol) ? [path] : [],
      );
      const expectedOccurrences = symbol === "loadAgentBackupRestoreSourceV3" ? 2 : 1;
      expect(occurrences, `${symbol} must remain definition-only`).toHaveLength(
        expectedOccurrences,
      );
      expect(
        occurrences.every((path) => path.includes("/db/repositories/")),
        `${symbol} must remain inside the dormant repository layer`,
      ).toBe(true);
    }
    expect(readFileSync(join(import.meta.dir, "index.ts"), "utf8")).not.toMatch(
      /agent-backup-restore|agent-vault-key-authority/,
    );
  });

  test("keeps target reservation free of remote effects and generic identity bypasses", () => {
    const operationSource = readFileSync(
      join(import.meta.dir, "repositories/agent-backup-restore-operations.ts"),
      "utf8",
    );
    expect(operationSource).not.toMatch(
      /DockerNodeManager|getAvailableNode|nodeAutoscaler|parseDockerNodes|process\.env|ensureVolumeVaultPassphrase/,
    );
    const genericAdvance = operationSource.slice(
      operationSource.indexOf("export async function advanceAgentBackupRestoreOperation"),
      operationSource.indexOf("export async function heartbeatAgentBackupRestoreOperation"),
    );
    const advanceMutationStart = genericAdvance.indexOf(".set({");
    const advanceMutation = genericAdvance.slice(
      advanceMutationStart,
      genericAdvance.indexOf(".where(", advanceMutationStart),
    );
    expect(advanceMutation).not.toMatch(/expected_node_|expected_image_digest/);
    expect(genericAdvance).toContain(
      "Restore operation cannot leave target reservation without complete target authority",
    );

    const reserveSource = operationSource.slice(
      operationSource.indexOf("export async function reserveAgentBackupRestoreTarget"),
      operationSource.indexOf("export async function advanceAgentBackupRestoreOperation"),
    );
    const transactionalReserve = reserveSource.slice(
      reserveSource.indexOf("return await dbWrite.transaction"),
    );
    const lockAnchors = [
      ".from(agentSandboxBackups)",
      "lockAgentBackupCatalogAuthority(",
      ".from(agentBackupRestoreOperations)",
      ".from(agentBackupRestoreLeases)",
      ".from(dockerNodes)",
      "readPostLockDatabaseNow(tx)",
    ];
    for (let index = 1; index < lockAnchors.length; index += 1) {
      expect(transactionalReserve.indexOf(lockAnchors[index - 1] as string)).toBeLessThan(
        transactionalReserve.indexOf(lockAnchors[index] as string),
      );
    }

    const vaultSource = readFileSync(
      join(import.meta.dir, "repositories/agent-vault-key-authority.ts"),
      "utf8",
    );
    const restoreVaultAuthority = vaultSource.slice(
      vaultSource.indexOf("async function loadAgentBackupRestoreVaultGeneration"),
    );
    expect(restoreVaultAuthority).not.toMatch(
      /agentVaultKeyAuthorities|ensureVolumeVaultPassphrase|buildVolumeVaultPassphraseCommand/,
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
