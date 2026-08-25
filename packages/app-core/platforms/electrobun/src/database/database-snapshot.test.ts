/**
 * Verifies Electrobun database snapshot construction, recovery-action
 * selection, error classification precedence, and status updates against
 * the real module. No mocks: every assertion drives exported functions.
 */
import { describe, expect, it } from "vitest";
import {
  classifyDatabaseError,
  createDatabaseSnapshot,
  createUnknownDatabaseSnapshot,
  type DatabaseMode,
  type DatabaseSnapshot,
  type DatabaseStatus,
  databaseRecoveryActions,
  updateDatabaseSnapshotStatus,
} from "./database-snapshot.ts";

const FIXED_AT = "2026-05-17T00:00:00.000Z";

const MODES: DatabaseMode[] = [
  "postgres",
  "pglite-persistent",
  "pglite-memory",
  "unknown",
];

const QUIET_STATUSES: DatabaseStatus[] = ["ready", "migrating", "starting"];

const NOISY_STATUSES: DatabaseStatus[] = [
  "unconfigured",
  "resolving",
  "migration-failed",
  "corrupt",
  "permission-error",
  "path-error",
  "locked",
  "error",
];

const POSTGRES_LIKE_ACTIONS = [
  "retry",
  "open-logs",
  "switch-to-postgres",
] as const;

const PGLITE_PERSISTENT_ACTIONS = [
  "retry",
  "open-logs",
  "backup",
  "reset-pglite",
  "switch-to-postgres",
] as const;

function minimalInput(
  overrides: {
    mode?: DatabaseMode;
    status?: DatabaseStatus;
    postgresUrlSet?: boolean;
    updatedAt?: string;
  } = {},
) {
  return {
    mode: overrides.mode ?? "postgres",
    status: overrides.status ?? "unconfigured",
    postgresUrlSet: overrides.postgresUrlSet ?? false,
    updatedAt: overrides.updatedAt ?? FIXED_AT,
  };
}

describe("databaseRecoveryActions", () => {
  it("returns only open-logs while the database is ready, migrating, or starting", () => {
    for (const mode of MODES) {
      for (const status of QUIET_STATUSES) {
        expect(databaseRecoveryActions(mode, status)).toEqual(["open-logs"]);
      }
    }
  });

  it("offers the postgres-like retry set for postgres, memory, and unknown noisy statuses", () => {
    for (const mode of ["postgres", "pglite-memory", "unknown"] as const) {
      for (const status of NOISY_STATUSES) {
        expect(databaseRecoveryActions(mode, status)).toEqual([
          ...POSTGRES_LIKE_ACTIONS,
        ]);
      }
    }
  });

  it("adds backup and reset-pglite only for persistent PGlite noisy statuses", () => {
    for (const status of NOISY_STATUSES) {
      expect(databaseRecoveryActions("pglite-persistent", status)).toEqual([
        ...PGLITE_PERSISTENT_ACTIONS,
      ]);
    }
  });
});

describe("createDatabaseSnapshot", () => {
  it("fills omitted optional fields with false, null, empty warnings, and computed recovery", () => {
    const snapshot = createDatabaseSnapshot(minimalInput());
    expect(snapshot).toEqual({
      mode: "postgres",
      status: "unconfigured",
      postgresUrlSet: false,
      databaseUrlMapped: false,
      pgliteDataDir: null,
      effectiveTarget: null,
      migrationStatus: undefined,
      lock: undefined,
      error: null,
      warnings: [],
      recoveryActions: [...POSTGRES_LIKE_ACTIONS],
      updatedAt: FIXED_AT,
    });
  });

  it("preserves provided optional fields, including the same warnings array reference", () => {
    const input = {
      mode: "pglite-persistent" as const,
      status: "locked" as const,
      postgresUrlSet: true,
      databaseUrlMapped: true,
      pgliteDataDir: "/state/database/pglite",
      effectiveTarget: "pglite",
      migrationStatus: {
        running: false,
        completed: false,
        failed: true,
        failedPlugin: "plugin-sql",
        error: "checksum mismatch",
      },
      lock: { held: true, stale: false, ownerPid: 4242 },
      error: "database is locked",
      warnings: ["mapped DATABASE_URL"],
      updatedAt: FIXED_AT,
    };
    const snapshot = createDatabaseSnapshot(input);
    expect(snapshot.databaseUrlMapped).toBe(true);
    expect(snapshot.pgliteDataDir).toBe("/state/database/pglite");
    expect(snapshot.effectiveTarget).toBe("pglite");
    expect(snapshot.migrationStatus).toBe(input.migrationStatus);
    expect(snapshot.lock).toBe(input.lock);
    expect(snapshot.error).toBe("database is locked");
    expect(snapshot.warnings).toBe(input.warnings);
    expect(snapshot.recoveryActions).toEqual([...PGLITE_PERSISTENT_ACTIONS]);
  });

  it("treats false databaseUrlMapped as false rather than falling back", () => {
    const snapshot = createDatabaseSnapshot({
      ...minimalInput(),
      databaseUrlMapped: false,
    });
    expect(snapshot.databaseUrlMapped).toBe(false);
  });

  it("keeps an empty error string and empty warnings when they are provided", () => {
    const snapshot = createDatabaseSnapshot({
      ...minimalInput({ status: "error" }),
      error: "",
      warnings: [],
    });
    expect(snapshot.error).toBe("");
    expect(snapshot.warnings).toEqual([]);
  });

  it("computes recovery actions from mode and status rather than copying a field", () => {
    const ready = createDatabaseSnapshot(
      minimalInput({ mode: "pglite-persistent", status: "ready" }),
    );
    const noisy = createDatabaseSnapshot(
      minimalInput({ mode: "pglite-persistent", status: "corrupt" }),
    );
    expect(ready.recoveryActions).toEqual(["open-logs"]);
    expect(noisy.recoveryActions).toEqual([...PGLITE_PERSISTENT_ACTIONS]);
  });

  it("stamps updatedAt with the current ISO time when the caller omits it", () => {
    const before = Date.now();
    const snapshot = createDatabaseSnapshot({
      mode: "unknown",
      status: "unconfigured",
      postgresUrlSet: false,
    });
    const after = Date.now();
    const stamped = Date.parse(snapshot.updatedAt);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });
});

describe("createUnknownDatabaseSnapshot", () => {
  it("builds the unconfigured unknown snapshot with the postgres-like retry set", () => {
    const snapshot = createUnknownDatabaseSnapshot(FIXED_AT);
    expect(snapshot).toEqual({
      mode: "unknown",
      status: "unconfigured",
      postgresUrlSet: false,
      databaseUrlMapped: false,
      pgliteDataDir: null,
      effectiveTarget: null,
      migrationStatus: undefined,
      lock: undefined,
      error: null,
      warnings: [],
      recoveryActions: [...POSTGRES_LIKE_ACTIONS],
      updatedAt: FIXED_AT,
    });
  });

  it("uses a generated ISO timestamp when updatedAt is omitted", () => {
    const before = Date.now();
    const snapshot = createUnknownDatabaseSnapshot();
    const after = Date.now();
    const stamped = Date.parse(snapshot.updatedAt);
    expect(snapshot.mode).toBe("unknown");
    expect(snapshot.status).toBe("unconfigured");
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });
});

describe("classifyDatabaseError", () => {
  it("classifies lock phrases before any later category", () => {
    expect(classifyDatabaseError("Already In Use")).toBe("locked");
    expect(classifyDatabaseError("database is locked by pid 9")).toBe("locked");
    expect(classifyDatabaseError("stale lock file present")).toBe("locked");
    expect(classifyDatabaseError("lock file is corrupt")).toBe("locked");
  });

  it("classifies corrupt phrases when no lock phrase matches", () => {
    expect(classifyDatabaseError("MALFORMED header")).toBe("corrupt");
    expect(classifyDatabaseError("file is not a database")).toBe("corrupt");
    expect(classifyDatabaseError("checksum mismatch")).toBe("corrupt");
    expect(classifyDatabaseError("database CORRUPT")).toBe("corrupt");
    expect(classifyDatabaseError("corrupt path /state/pglite")).toBe("corrupt");
  });

  it("classifies permission phrases when lock and corrupt do not match", () => {
    expect(classifyDatabaseError("Permission Denied")).toBe("permission-error");
    expect(classifyDatabaseError("EACCES opening data dir")).toBe(
      "permission-error",
    );
    expect(classifyDatabaseError("EPERM on mkdir")).toBe("permission-error");
    expect(
      classifyDatabaseError("EACCES: permission denied, open '/path'"),
    ).toBe("permission-error");
  });

  it("classifies path phrases, including the broad substring path, before migration", () => {
    expect(classifyDatabaseError("ENOENT")).toBe("path-error");
    expect(classifyDatabaseError("not a directory")).toBe("path-error");
    expect(classifyDatabaseError("PATH")).toBe("path-error");
    expect(classifyDatabaseError("migration failed at path /tmp/pglite")).toBe(
      "path-error",
    );
  });

  it("classifies the two migration-failed phrases and nothing nearby", () => {
    expect(classifyDatabaseError("Migration failed for plugin-x")).toBe(
      "migration-failed",
    );
    expect(classifyDatabaseError("migration(s) failed")).toBe(
      "migration-failed",
    );
    expect(classifyDatabaseError("migrations failed")).toBe("error");
  });

  it("returns error for empty, unmatched, and near-miss phrases", () => {
    expect(classifyDatabaseError("")).toBe("error");
    expect(classifyDatabaseError("   ")).toBe("error");
    expect(classifyDatabaseError("locked")).toBe("error");
    expect(classifyDatabaseError("lock")).toBe("error");
    expect(classifyDatabaseError("unknown failure")).toBe("error");
  });
});

describe("updateDatabaseSnapshotStatus", () => {
  const base: DatabaseSnapshot = createDatabaseSnapshot({
    mode: "pglite-persistent",
    status: "starting",
    postgresUrlSet: true,
    databaseUrlMapped: true,
    pgliteDataDir: "/state/database/pglite",
    effectiveTarget: "pglite",
    migrationStatus: { running: true, completed: false, failed: false },
    lock: { held: true, ownerPid: 7 },
    error: "boot",
    warnings: ["slow start"],
    updatedAt: FIXED_AT,
  });

  it("keeps identity fields, recomputes recovery, and stamps a new time when options are omitted", () => {
    const before = Date.now();
    const next = updateDatabaseSnapshotStatus(base, "ready");
    const after = Date.now();
    expect(next).not.toBe(base);
    expect(next.mode).toBe("pglite-persistent");
    expect(next.postgresUrlSet).toBe(true);
    expect(next.databaseUrlMapped).toBe(true);
    expect(next.pgliteDataDir).toBe("/state/database/pglite");
    expect(next.effectiveTarget).toBe("pglite");
    expect(next.migrationStatus).toEqual(base.migrationStatus);
    expect(next.lock).toEqual(base.lock);
    expect(next.error).toBe("boot");
    expect(next.warnings).toEqual(["slow start"]);
    expect(next.status).toBe("ready");
    expect(next.recoveryActions).toEqual(["open-logs"]);
    expect(base.status).toBe("starting");
    expect(base.recoveryActions).toEqual(["open-logs"]);
    const stamped = Date.parse(next.updatedAt);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it("applies provided option fields and expands recovery when moving to a noisy status", () => {
    const next = updateDatabaseSnapshotStatus(base, "locked", {
      error: "database is locked",
      lock: { held: true, stale: true, ownerPid: 99 },
      migrationStatus: {
        running: false,
        completed: false,
        failed: true,
        error: "interrupted",
      },
      warnings: ["stale lock stolen"],
      updatedAt: FIXED_AT,
    });
    expect(next.status).toBe("locked");
    expect(next.error).toBe("database is locked");
    expect(next.lock).toEqual({
      held: true,
      stale: true,
      ownerPid: 99,
    });
    expect(next.migrationStatus).toEqual({
      running: false,
      completed: false,
      failed: true,
      error: "interrupted",
    });
    expect(next.warnings).toEqual(["stale lock stolen"]);
    expect(next.updatedAt).toBe(FIXED_AT);
    expect(next.recoveryActions).toEqual([...PGLITE_PERSISTENT_ACTIONS]);
  });

  it("does not clear error via null because nullish coalescing keeps the prior value", () => {
    const next = updateDatabaseSnapshotStatus(base, "error", {
      error: null,
      updatedAt: FIXED_AT,
    });
    expect(next.error).toBe("boot");
    expect(next.status).toBe("error");
    expect(next.recoveryActions).toEqual([...PGLITE_PERSISTENT_ACTIONS]);
  });

  it("replaces warnings with an empty list when the caller passes []", () => {
    const next = updateDatabaseSnapshotStatus(base, "ready", {
      warnings: [],
      updatedAt: FIXED_AT,
    });
    expect(next.warnings).toEqual([]);
    expect(base.warnings).toEqual(["slow start"]);
  });

  it("shrinks recovery to open-logs when a noisy postgres snapshot becomes ready", () => {
    const noisy = createDatabaseSnapshot(
      minimalInput({ mode: "postgres", status: "migration-failed" }),
    );
    const next = updateDatabaseSnapshotStatus(noisy, "ready", {
      updatedAt: FIXED_AT,
    });
    expect(noisy.recoveryActions).toEqual([...POSTGRES_LIKE_ACTIONS]);
    expect(next.recoveryActions).toEqual(["open-logs"]);
    expect(next.mode).toBe("postgres");
  });
});
