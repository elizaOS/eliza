/** Implements Electrobun desktop database recovery ts behavior for app-core shell integration. */
import fs from "node:fs";
import path from "node:path";
import { assertSafePgliteResetTarget } from "./pglite-paths";

export interface DatabaseBackupResult {
  sourceDir: string;
  backupDir: string | null;
  created: boolean;
  reason?: string;
}

export interface DatabaseResetResult {
  sourceDir: string;
  backup: DatabaseBackupResult;
  removed: boolean;
}

export interface DatabaseRecoveryOptions {
  now?: () => Date;
  backupRoot?: string;
}

function backupTimestamp(now: () => Date): string {
  return now().toISOString().replace(/[:.]/g, "-");
}

export function databaseBackupRoot(dataDir: string): string {
  return path.join(path.dirname(dataDir), "pglite-backups");
}

export function backupPgliteDirectory(
  dataDir: string,
  options: DatabaseRecoveryOptions = {},
): DatabaseBackupResult {
  const sourceDir = assertSafePgliteResetTarget(dataDir);
  if (!fs.existsSync(sourceDir)) {
    return {
      sourceDir,
      backupDir: null,
      created: false,
      reason: "source-missing",
    };
  }
  const backupRoot = options.backupRoot ?? databaseBackupRoot(sourceDir);
  const now = options.now ?? (() => new Date());
  const backupDir = path.join(backupRoot, `pglite-${backupTimestamp(now)}`);
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.cpSync(sourceDir, backupDir, { recursive: true, force: false });
  return {
    sourceDir,
    backupDir,
    created: true,
  };
}

export function resetPgliteDirectory(
  dataDir: string,
  options: DatabaseRecoveryOptions = {},
): DatabaseResetResult {
  const sourceDir = assertSafePgliteResetTarget(dataDir);
  const backup = backupPgliteDirectory(sourceDir, options);
  const existed = fs.existsSync(sourceDir);
  if (existed) {
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
  fs.mkdirSync(sourceDir, { recursive: true });
  return {
    sourceDir,
    backup,
    removed: existed,
  };
}
