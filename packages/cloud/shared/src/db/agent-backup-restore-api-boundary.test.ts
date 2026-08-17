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
  test("contains no provisional receipt shape, writer, outcome query, or production callsite", () => {
    const sources = productionSources().map((path) => ({
      path,
      source: readFileSync(path, "utf8"),
    }));
    const production = sources.map(({ source }) => source).join("\n");
    for (const forbidden of [
      "agentBackupRestoreReceipts",
      "agentVaultKeySeedReceipts",
      "agent_backup_restore_receipts",
      "agent_vault_key_seed_receipts",
      "queryAgentBackupRestoreCommitOutcome",
      "markAgentBackupRestoreVerified",
      "commitAgentBackupRestore",
      "activation_publication_authority_unique",
      "docker_nodes_vault_seed_authority_unique",
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

  test("contains no provision-capacity migration in the restore-foundation ordinal range", () => {
    const restoreMigrations = readdirSync(MIGRATIONS_DIR).filter((name) => {
      const ordinal = Number(name.slice(0, 4));
      return ordinal >= 236 && ordinal <= 245 && name.endsWith(".sql");
    });
    expect(restoreMigrations).toHaveLength(10);
    expect(restoreMigrations.join("\n")).not.toMatch(/capacity|billing|history|probe/i);
    const migrationSource = restoreMigrations
      .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf8"))
      .join("\n");
    expect(migrationSource).not.toMatch(
      /agent_backup_restore_receipts|agent_vault_key_seed_receipts/,
    );
  });

  test("locks an existing reservation backup before its catalogue authority", () => {
    const source = readFileSync(
      join(import.meta.dir, "repositories/agent-backup-catalog.ts"),
      "utf8",
    );
    const reservation = source.slice(
      source.indexOf("export async function reserveAgentBackupOperationInTransaction"),
      source.indexOf("export async function claimDueAgentBackupOperations"),
    );
    const replayLock = reservation.indexOf("Replay must join the global backup");
    const replayBackup = reservation.indexOf(".from(agentSandboxBackups)", replayLock);
    const replayOperation = reservation.indexOf(
      "eq(agentSandboxBackups.backup_operation_id",
      replayBackup,
    );
    const replayForUpdate = reservation.indexOf('.for("update")', replayOperation);
    const authorityLock = reservation.indexOf("const reservationAuthority");
    expect(replayLock).toBeGreaterThanOrEqual(0);
    expect(replayBackup).toBeGreaterThan(replayLock);
    expect(replayOperation).toBeGreaterThan(replayBackup);
    expect(replayForUpdate).toBeGreaterThan(replayOperation);
    expect(authorityLock).toBeGreaterThan(replayForUpdate);
  });
});
