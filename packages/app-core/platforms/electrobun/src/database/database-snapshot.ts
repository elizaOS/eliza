export type DatabaseMode =
  | "postgres"
  | "pglite-persistent"
  | "pglite-memory"
  | "unknown";

export type DatabaseStatus =
  | "unconfigured"
  | "resolving"
  | "starting"
  | "ready"
  | "migrating"
  | "migration-failed"
  | "corrupt"
  | "permission-error"
  | "path-error"
  | "locked"
  | "error";

export type DatabaseRecoveryAction =
  | "retry"
  | "open-logs"
  | "backup"
  | "reset-pglite"
  | "switch-to-postgres";

export interface DatabaseMigrationStatus {
  running: boolean;
  completed: boolean;
  failed: boolean;
  failedPlugin?: string;
  error?: string;
}

export interface DatabaseLockSnapshot {
  held: boolean;
  stale?: boolean;
  ownerPid?: number;
}

export interface DatabaseSnapshot {
  mode: DatabaseMode;
  status: DatabaseStatus;
  postgresUrlSet: boolean;
  databaseUrlMapped: boolean;
  pgliteDataDir: string | null;
  effectiveTarget: string | null;
  migrationStatus?: DatabaseMigrationStatus;
  lock?: DatabaseLockSnapshot;
  error?: string | null;
  warnings: string[];
  recoveryActions: DatabaseRecoveryAction[];
  updatedAt: string;
}

export interface DatabaseSnapshotInput {
  mode: DatabaseMode;
  status: DatabaseStatus;
  postgresUrlSet: boolean;
  databaseUrlMapped?: boolean;
  pgliteDataDir?: string | null;
  effectiveTarget?: string | null;
  migrationStatus?: DatabaseMigrationStatus;
  lock?: DatabaseLockSnapshot;
  error?: string | null;
  warnings?: string[];
  updatedAt?: string;
}

export function databaseRecoveryActions(
  mode: DatabaseMode,
  status: DatabaseStatus,
): DatabaseRecoveryAction[] {
  if (status === "ready" || status === "migrating" || status === "starting") {
    return ["open-logs"];
  }
  if (mode === "postgres") {
    return ["retry", "open-logs", "switch-to-postgres"];
  }
  if (mode === "pglite-persistent") {
    return [
      "retry",
      "open-logs",
      "backup",
      "reset-pglite",
      "switch-to-postgres",
    ];
  }
  if (mode === "pglite-memory") {
    return ["retry", "open-logs", "switch-to-postgres"];
  }
  return ["retry", "open-logs", "switch-to-postgres"];
}

export function createDatabaseSnapshot(
  input: DatabaseSnapshotInput,
): DatabaseSnapshot {
  return {
    mode: input.mode,
    status: input.status,
    postgresUrlSet: input.postgresUrlSet,
    databaseUrlMapped: input.databaseUrlMapped ?? false,
    pgliteDataDir: input.pgliteDataDir ?? null,
    effectiveTarget: input.effectiveTarget ?? null,
    migrationStatus: input.migrationStatus,
    lock: input.lock,
    error: input.error ?? null,
    warnings: input.warnings ?? [],
    recoveryActions: databaseRecoveryActions(input.mode, input.status),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}

export function createUnknownDatabaseSnapshot(
  updatedAt = new Date().toISOString(),
): DatabaseSnapshot {
  return createDatabaseSnapshot({
    mode: "unknown",
    status: "unconfigured",
    postgresUrlSet: false,
    warnings: [],
    updatedAt,
  });
}

export function classifyDatabaseError(message: string): DatabaseStatus {
  const text = message.toLowerCase();
  if (
    text.includes("already in use") ||
    text.includes("database is locked") ||
    text.includes("lock file")
  ) {
    return "locked";
  }
  if (
    text.includes("malformed") ||
    text.includes("file is not a database") ||
    text.includes("checksum") ||
    text.includes("corrupt")
  ) {
    return "corrupt";
  }
  if (
    text.includes("permission denied") ||
    text.includes("eacces") ||
    text.includes("eperm")
  ) {
    return "permission-error";
  }
  if (
    text.includes("enoent") ||
    text.includes("not a directory") ||
    text.includes("path")
  ) {
    return "path-error";
  }
  if (
    text.includes("migration failed") ||
    text.includes("migration(s) failed")
  ) {
    return "migration-failed";
  }
  return "error";
}

export function updateDatabaseSnapshotStatus(
  snapshot: DatabaseSnapshot,
  status: DatabaseStatus,
  options?: {
    error?: string | null;
    lock?: DatabaseLockSnapshot;
    migrationStatus?: DatabaseMigrationStatus;
    warnings?: string[];
    updatedAt?: string;
  },
): DatabaseSnapshot {
  return createDatabaseSnapshot({
    mode: snapshot.mode,
    status,
    postgresUrlSet: snapshot.postgresUrlSet,
    databaseUrlMapped: snapshot.databaseUrlMapped,
    pgliteDataDir: snapshot.pgliteDataDir,
    effectiveTarget: snapshot.effectiveTarget,
    migrationStatus: options?.migrationStatus ?? snapshot.migrationStatus,
    lock: options?.lock ?? snapshot.lock,
    error: options?.error ?? snapshot.error,
    warnings: options?.warnings ?? snapshot.warnings,
    updatedAt: options?.updatedAt,
  });
}
