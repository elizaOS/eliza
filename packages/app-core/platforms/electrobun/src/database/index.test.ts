/**
 * Verifies the Electrobun desktop database public barrel the way the native
 * agent consumes it: mode resolution flowing into child-env application,
 * snapshots, startup locks, and filesystem recovery against the real module,
 * with injected clocks/probes and temporary directories.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDatabaseStartupLock,
  applyDatabaseResolutionToEnv,
  classifyDatabaseError,
  createDatabaseSnapshot,
  databaseStartupLockPath,
  describePglitePath,
  ensurePgliteDataDir,
  inspectDatabaseStartupLock,
  redactDatabaseTarget,
  resetPgliteDirectory,
  resolveDatabaseMode,
  updateDatabaseSnapshotStatus,
} from "./index";

const FIXED_NOW = new Date("2026-05-17T00:00:00.000Z");
const TEN_MINUTES_MS = 10 * 60 * 1000;

const tempDirs: string[] = [];

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eliza-db-index-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function dataDir(name: string): string {
  return path.join(tempDir(name), "database", "pglite");
}

function writeLockRecord(
  lockPath: string,
  record: { pid: number; createdAt: string },
): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(record)}\n`, "utf8");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("startup lock staleness boundaries", () => {
  it("treats an age exactly equal to staleAfterMs as not stale", () => {
    const lockPath = databaseStartupLockPath(dataDir("boundary"));
    writeLockRecord(lockPath, {
      pid: 4242,
      createdAt: FIXED_NOW.toISOString(),
    });

    expect(
      inspectDatabaseStartupLock(lockPath, {
        now: () => new Date(FIXED_NOW.getTime() + TEN_MINUTES_MS),
        isProcessAlive: () => true,
      }),
    ).toEqual({ held: true, stale: false, ownerPid: 4242 });
  });

  it("steals a live owner's lock once its age passes a custom staleAfterMs", () => {
    const dir = dataDir("steal-custom-window");
    const lockPath = databaseStartupLockPath(dir);
    writeLockRecord(lockPath, {
      pid: 999_999,
      createdAt: FIXED_NOW.toISOString(),
    });

    const stolen = acquireDatabaseStartupLock(dir, {
      now: () => new Date(FIXED_NOW.getTime() + 1000),
      isProcessAlive: () => true,
      staleAfterMs: 500,
    });

    expect(stolen.ok).toBe(true);
    if (!stolen.ok) throw new Error(stolen.error);
    const recorded = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid: number;
    };
    expect(recorded.pid).toBe(process.pid);
  });

  it("refuses a live owner's lock whose age is inside a custom staleAfterMs", () => {
    const dir = dataDir("held-custom-window");
    const lockPath = databaseStartupLockPath(dir);
    writeLockRecord(lockPath, {
      pid: 999_999,
      createdAt: FIXED_NOW.toISOString(),
    });

    const result = acquireDatabaseStartupLock(dir, {
      now: () => new Date(FIXED_NOW.getTime() + 1000),
      isProcessAlive: () => true,
      staleAfterMs: 60_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected held lock");
    expect(result.error).toBe(`PGlite startup lock is held at ${lockPath}.`);
    expect(result.snapshot).toEqual({
      held: true,
      stale: false,
      ownerPid: 999_999,
    });
  });
});

describe("describePglitePath classification", () => {
  it("reports a directory outside the app state dir as not inside it", () => {
    const root = tempDir("outside");
    const appStateDir = path.join(root, "state");
    const outside = path.join(root, "elsewhere", "pglite");

    const description = describePglitePath(outside, { appStateDir });

    expect(description).toMatchObject({
      dataDir: outside,
      insideAppState: false,
      insideAppBundle: false,
      memory: false,
      writableParent: true,
    });
  });

  it("detects an app bundle layout by its .app/Contents path segment", () => {
    const root = tempDir("bundle");
    const appStateDir = path.join(root, "state");
    const bundled = path.join(root, "Eliza.app", "Contents", "db", "pglite");

    const description = describePglitePath(bundled, { appStateDir });

    expect(description.insideAppBundle).toBe(true);
    expect(description.insideAppState).toBe(false);
    expect(description.memory).toBe(false);
  });

  it("reports an unwritable parent when a regular file blocks the path", () => {
    const root = tempDir("blocked");
    fs.writeFileSync(path.join(root, "blocker"), "x", "utf8");
    const blocked = path.join(root, "blocker", "child", "pglite");

    const description = describePglitePath(blocked, { appStateDir: root });

    expect(description.writableParent).toBe(false);
    expect(description.memory).toBe(false);
  });
});

describe("ensurePgliteDataDir", () => {
  it("treats the memory sentinel as needing no filesystem work", () => {
    expect(() => ensurePgliteDataDir("memory://")).not.toThrow();
  });

  it("propagates the mkdir failure when a regular file blocks the target", () => {
    const root = tempDir("ensure-blocked");
    fs.writeFileSync(path.join(root, "blocker"), "x", "utf8");

    expect(() =>
      ensurePgliteDataDir(path.join(root, "blocker", "pglite")),
    ).toThrow(/ENOTDIR/);
  });
});

describe("desktop boot policy composition through the public barrel", () => {
  it("maps DATABASE_URL into the child env and a redacted postgres snapshot", () => {
    const childEnv: Record<string, string> = {
      DATABASE_URL: "postgres://owner:s3cret@localhost:5432/eliza",
      PGLITE_DATA_DIR: "/tmp/stale-from-earlier-boot",
    };

    const resolution = resolveDatabaseMode({
      env: childEnv,
      packagedDesktop: true,
      appStateDir: tempDir("postgres-state"),
    });
    applyDatabaseResolutionToEnv(childEnv, resolution);

    expect(childEnv.POSTGRES_URL).toBe(
      "postgres://owner:s3cret@localhost:5432/eliza",
    );
    expect(childEnv.PGLITE_DATA_DIR).toBeUndefined();

    const effectiveTarget =
      resolution.mode === "postgres"
        ? redactDatabaseTarget(resolution.postgresUrl)
        : (resolution.pgliteDataDir ?? null);

    let snapshot = createDatabaseSnapshot({
      mode: resolution.mode,
      status: "resolving",
      postgresUrlSet: resolution.mode === "postgres",
      databaseUrlMapped: resolution.databaseUrlMapped,
      pgliteDataDir: resolution.pgliteDataDir ?? null,
      effectiveTarget,
      warnings: resolution.warnings,
    });
    expect(effectiveTarget).toContain("%5Buser%5D:%5Bpassword%5D");
    expect(effectiveTarget).not.toContain("s3cret");
    expect(snapshot.postgresUrlSet).toBe(true);
    expect(snapshot.databaseUrlMapped).toBe(true);
    expect(snapshot.warnings).toEqual([
      "DATABASE_URL is mapped to POSTGRES_URL for the agent runtime.",
    ]);

    snapshot = updateDatabaseSnapshotStatus(snapshot, "starting");
    expect(snapshot.recoveryActions).toEqual(["open-logs"]);
  });

  it("boots the packaged-desktop default, locks it, then recovers from corruption", () => {
    const appStateDir = tempDir("recovery-state");

    const resolution = resolveDatabaseMode({
      env: {},
      packagedDesktop: true,
      appStateDir,
    });
    expect(resolution.source).toBe("packaged-desktop-default");
    const dir = resolution.pgliteDataDir;
    if (!dir) throw new Error("expected a persistent default data dir");

    let snapshot = createDatabaseSnapshot({
      mode: resolution.mode,
      status: "resolving",
      postgresUrlSet: false,
      databaseUrlMapped: resolution.databaseUrlMapped,
      pgliteDataDir: dir,
      effectiveTarget: dir,
      warnings: resolution.warnings,
    });

    ensurePgliteDataDir(dir);
    const acquired = acquireDatabaseStartupLock(dir, { now: () => FIXED_NOW });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error(acquired.error);

    snapshot = updateDatabaseSnapshotStatus(snapshot, "starting", {
      lock: acquired.lock.snapshot,
    });
    expect(snapshot.status).toBe("starting");
    expect(snapshot.lock).toEqual({
      held: true,
      ownerPid: process.pid,
      stale: false,
    });
    expect(snapshot.recoveryActions).toEqual(["open-logs"]);
    acquired.lock.release();

    snapshot = updateDatabaseSnapshotStatus(
      snapshot,
      classifyDatabaseError("database disk image is malformed"),
      { error: "database disk image is malformed" },
    );
    expect(snapshot.status).toBe("corrupt");
    expect(snapshot.recoveryActions).toEqual([
      "retry",
      "open-logs",
      "backup",
      "reset-pglite",
      "switch-to-postgres",
    ]);

    fs.writeFileSync(path.join(dir, "state"), "ok", "utf8");
    const reset = resetPgliteDirectory(dir, {
      now: () => new Date(FIXED_NOW.getTime() + 1000),
    });

    expect(reset.removed).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(
      fs.readFileSync(path.join(reset.backup.backupDir ?? "", "state"), "utf8"),
    ).toBe("ok");
  });

  it("lands the boot snapshot in locked with the holder's details when acquire refuses", () => {
    const appStateDir = tempDir("locked-state");
    const resolution = resolveDatabaseMode({
      env: {},
      packagedDesktop: true,
      appStateDir,
    });
    const dir = resolution.pgliteDataDir;
    if (!dir) throw new Error("expected a persistent default data dir");
    const lockPath = databaseStartupLockPath(dir);
    writeLockRecord(lockPath, {
      pid: 999_999,
      createdAt: FIXED_NOW.toISOString(),
    });

    let snapshot = createDatabaseSnapshot({
      mode: "pglite-persistent",
      status: "resolving",
      postgresUrlSet: false,
      databaseUrlMapped: false,
      pgliteDataDir: dir,
      effectiveTarget: dir,
      warnings: [],
    });

    const lockResult = acquireDatabaseStartupLock(dir, {
      now: () => FIXED_NOW,
      isProcessAlive: (pid) => pid === 999_999,
    });
    expect(lockResult.ok).toBe(false);
    if (lockResult.ok) throw new Error("expected refusal");

    snapshot = updateDatabaseSnapshotStatus(snapshot, "locked", {
      error: lockResult.error,
      lock: lockResult.snapshot,
    });

    expect(snapshot.status).toBe("locked");
    expect(snapshot.error).toBe(`PGlite startup lock is held at ${lockPath}.`);
    expect(snapshot.lock).toEqual({
      held: true,
      stale: false,
      ownerPid: 999_999,
    });
    expect(snapshot.recoveryActions).toEqual([
      "retry",
      "open-logs",
      "backup",
      "reset-pglite",
      "switch-to-postgres",
    ]);
  });
});
