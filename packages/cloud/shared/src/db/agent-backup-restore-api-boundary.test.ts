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
      const invocationLikeOccurrences = production.match(
        new RegExp(`\\b${symbol}(?:<[^>]+>)?\\s*\\(`, "g"),
      );
      const expectedInvocationLikeOccurrences = symbol === "loadAgentBackupRestoreSourceV3" ? 2 : 1;
      expect(
        invocationLikeOccurrences ?? [],
        `${symbol} gained a production call site`,
      ).toHaveLength(expectedInvocationLikeOccurrences);
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

    const openOperation = operationSource.slice(
      operationSource.indexOf("export async function openAgentBackupRestoreOperation"),
      operationSource.indexOf("export async function claimAgentBackupRestoreOperation"),
    );
    const transactionalOpen = openOperation.slice(
      openOperation.indexOf("return await dbWrite.transaction"),
    );
    const openLockAnchors = [
      ".from(agentSandboxBackups)",
      ".from(agentBackupRestoreOperations)",
      ".from(agentBackupRestoreLeases)",
      "lockAgentBackupCatalogAuthority(",
      "readPostLockDatabaseNow(tx)",
    ];
    for (let index = 1; index < openLockAnchors.length; index += 1) {
      expect(transactionalOpen.indexOf(openLockAnchors[index - 1] as string)).toBeLessThan(
        transactionalOpen.indexOf(openLockAnchors[index] as string),
      );
    }

    const reserveSource = operationSource.slice(
      operationSource.indexOf("export async function reserveAgentBackupRestoreTarget"),
      operationSource.indexOf("export async function advanceAgentBackupRestoreOperation"),
    );
    const transactionalReserve = reserveSource.slice(
      reserveSource.indexOf("return await dbWrite.transaction"),
    );
    const lockAnchors = [
      ".from(agentSandboxBackups)",
      ".from(agentBackupRestoreOperations)",
      ".from(agentBackupRestoreLeases)",
      ".from(dockerNodes)",
      "proveUnambiguousAgentNodeIncarnationForLockedNode(",
      "lockAgentBackupCatalogAuthority(",
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
    for (const requiredAuthorityField of [
      "restoreOperationId",
      "restoreClaimGeneration",
      "targetNodeRecordId",
      "targetNodeIncarnation",
    ]) {
      expect(restoreVaultAuthority).toContain(requiredAuthorityField);
    }

    const targetProof = restoreVaultAuthority.slice(
      restoreVaultAuthority.indexOf("async function proveAgentBackupRestoreVaultTargetAuthority"),
      restoreVaultAuthority.indexOf("export async function withAgentBackupRestoreVaultPassphrase"),
    );
    const vaultLockAnchors = [
      ".from(agentSandboxBackups)",
      ".from(agentBackupRestoreOperations)",
      ".from(agentBackupRestoreLeases)",
      ".from(dockerNodes)",
      "proveUnambiguousAgentNodeIncarnationForLockedNode(",
      "lockAgentBackupCatalogAuthority(",
      "readPostLockDatabaseNow(tx)",
    ];
    for (let index = 1; index < vaultLockAnchors.length; index += 1) {
      expect(targetProof.indexOf(vaultLockAnchors[index - 1] as string)).toBeLessThan(
        targetProof.indexOf(vaultLockAnchors[index] as string),
      );
    }
    const finalClock = targetProof.indexOf("readPostLockDatabaseNow(tx)");
    const lockedHandoff = targetProof.indexOf(
      "runBoundedAgentBackupRestoreVaultTargetHandoff(",
      finalClock,
    );
    const postHandoffClock = targetProof.indexOf(
      "const afterHandoffDatabaseNow = await readPostLockDatabaseNow(tx)",
      lockedHandoff,
    );
    expect(finalClock).toBeGreaterThanOrEqual(0);
    expect(lockedHandoff).toBeGreaterThan(finalClock);
    expect(postHandoffClock).toBeGreaterThan(lockedHandoff);
    expect(targetProof.indexOf("return await dbWrite.transaction")).toBeGreaterThanOrEqual(0);
    expect(vaultSource).toContain("MAX_RESTORE_VAULT_HANDOFF_TIMEOUT_MS = 60_000");
    expect(vaultSource).toContain("RESTORE_VAULT_HANDOFF_AUTHORITY_MARGIN_MS = 1_000");
    expect(vaultSource).toContain("return await Promise.race([");
    expect(vaultSource).toContain("controller.abort(timeoutError)");

    const historySource = readFileSync(
      join(import.meta.dir, "repositories/agent-backup-restore-history.ts"),
      "utf8",
    );
    const incarnationProof = historySource.slice(
      historySource.indexOf(
        "export async function proveUnambiguousAgentNodeIncarnationForLockedNode",
      ),
      historySource.indexOf("async function lockCurrentNodeHistory"),
    );
    expect(incarnationProof).toContain(
      "ne(agentNodeIncarnationHistories.node_incarnation, expectedIncarnation)",
    );
    expect(incarnationProof).toContain("node.created_at > history.attested_at");
    expect(incarnationProof).not.toMatch(/\bxmin\b|\bage\s*\(|\bgte\s*\(/);

    const vaultCallback = restoreVaultAuthority.slice(
      restoreVaultAuthority.indexOf("export async function withAgentBackupRestoreVaultPassphrase"),
    );
    const preKmsSource = vaultCallback.indexOf(
      "const beforeKms = await loadAgentBackupRestoreVaultGeneration(input)",
    );
    const preKmsTargetProof = vaultCallback.indexOf(
      "await proveAgentBackupRestoreVaultTargetAuthority(",
      preKmsSource,
    );
    const kmsDecrypt = vaultCallback.indexOf("await decryptGeneration(", preKmsTargetProof);
    const postKmsSource = vaultCallback.indexOf(
      "const afterKms = await loadAgentBackupRestoreVaultGeneration(input)",
      kmsDecrypt,
    );
    const postKmsTargetProof = vaultCallback.indexOf(
      "await proveAgentBackupRestoreVaultTargetAuthority(",
      preKmsTargetProof + 1,
    );
    const secretUse = vaultCallback.indexOf("secret.withPassphrase(", postKmsTargetProof);
    expect(preKmsSource).toBeGreaterThanOrEqual(0);
    expect(preKmsTargetProof).toBeGreaterThan(preKmsSource);
    expect(kmsDecrypt).toBeGreaterThan(preKmsTargetProof);
    expect(postKmsSource).toBeGreaterThan(kmsDecrypt);
    expect(postKmsTargetProof).toBeGreaterThan(postKmsSource);
    expect(secretUse).toBeGreaterThan(postKmsTargetProof);
    expect(vaultCallback.slice(preKmsTargetProof, kmsDecrypt)).not.toContain(
      "secret.withPassphrase",
    );
    expect(vaultCallback.slice(postKmsTargetProof, secretUse + 90)).toContain(
      "secret.withPassphrase((passphrase) => use(passphrase, signal), signal)",
    );
  });

  test("keeps cross-backup attempt mismatches out of the blocking lease lock", () => {
    const leaseSource = readFileSync(
      join(import.meta.dir, "repositories/agent-backup-restore-lease.ts"),
      "utf8",
    );
    const acquireSource = leaseSource.slice(
      leaseSource.indexOf("export async function acquireAgentBackupRestoreLease"),
      leaseSource.indexOf("export async function renewAgentBackupRestoreLease"),
    );
    const attemptLock = acquireSource.slice(
      acquireSource.indexOf("const [existingAttempt]"),
      acquireSource.indexOf("const [unreleased]"),
    );
    const blockingLookup = attemptLock.slice(0, attemptLock.indexOf("if (!existingAttempt)"));
    expect(blockingLookup).toContain("eq(agentBackupRestoreLeases.backup_id, params.backupId)");
    expect(blockingLookup).toContain('.for("update")');

    const divergentLookup = attemptLock.slice(attemptLock.indexOf("const [divergentAttempt]"));
    expect(divergentLookup).toContain(
      "eq(agentBackupRestoreLeases.restore_attempt_id, params.restoreAttemptId)",
    );
    expect(divergentLookup).not.toContain('.for("update")');
    expect(divergentLookup).toContain("Restore attempt replay authority mismatch");
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
