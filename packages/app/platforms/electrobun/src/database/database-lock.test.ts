/**
 * Verifies Electrobun PGlite startup-lock path, inspect, acquire, steal, and
 * release against the real filesystem. Injected `now` / `isProcessAlive` are
 * the module's public test seams; fs and `process.kill` stay real.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDatabaseStartupLock,
  databaseStartupLockPath,
  inspectDatabaseStartupLock,
} from "./database-lock.ts";

const FIXED_NOW = new Date("2026-05-17T00:00:00.000Z");
const TEN_MINUTES_MS = 10 * 60 * 1000;

const tempDirs: string[] = [];

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eliza-db-lock-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function dataDir(name: string): string {
  return path.join(tempDir(name), "database", "pglite");
}

function writeLockFile(
  lockPath: string,
  record: { pid: number; createdAt: string } | string,
): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const body =
    typeof record === "string"
      ? record
      : `${JSON.stringify(record, null, 2)}\n`;
  fs.writeFileSync(lockPath, body, "utf8");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("databaseStartupLockPath", () => {
  it("appends .startup.lock to the PGlite data dir", () => {
    expect(databaseStartupLockPath("/state/database/pglite")).toBe(
      "/state/database/pglite.startup.lock",
    );
    expect(databaseStartupLockPath("pglite")).toBe("pglite.startup.lock");
  });
});

describe("inspectDatabaseStartupLock", () => {
  it("reports an absent file as not held", () => {
    const lockPath = databaseStartupLockPath(dataDir("missing"));
    expect(inspectDatabaseStartupLock(lockPath)).toEqual({ held: false });
  });

  it("treats unreadable or malformed records as held and stale", () => {
    const lockPath = databaseStartupLockPath(dataDir("malformed"));
    writeLockFile(lockPath, "{");
    expect(inspectDatabaseStartupLock(lockPath)).toEqual({
      held: true,
      stale: true,
    });

    writeLockFile(lockPath, JSON.stringify({ pid: 12 }));
    expect(inspectDatabaseStartupLock(lockPath)).toEqual({
      held: true,
      stale: true,
    });

    writeLockFile(
      lockPath,
      JSON.stringify({ createdAt: FIXED_NOW.toISOString() }),
    );
    expect(inspectDatabaseStartupLock(lockPath)).toEqual({
      held: true,
      stale: true,
    });

    writeLockFile(
      lockPath,
      JSON.stringify({ pid: "12", createdAt: FIXED_NOW.toISOString() }),
    );
    expect(inspectDatabaseStartupLock(lockPath)).toEqual({
      held: true,
      stale: true,
    });
  });

  it("treats a live owner within the stale window as held and not stale", () => {
    const lockPath = databaseStartupLockPath(dataDir("live"));
    writeLockFile(lockPath, {
      pid: 4242,
      createdAt: FIXED_NOW.toISOString(),
    });
    expect(
      inspectDatabaseStartupLock(lockPath, {
        now: () => new Date(FIXED_NOW.getTime() + TEN_MINUTES_MS),
        isProcessAlive: (pid) => pid === 4242,
      }),
    ).toEqual({ held: true, stale: false, ownerPid: 4242 });
  });

  it("marks a live owner stale only after age exceeds staleAfterMs", () => {
    const lockPath = databaseStartupLockPath(dataDir("aged"));
    writeLockFile(lockPath, {
      pid: 7,
      createdAt: FIXED_NOW.toISOString(),
    });
    const justPastDefault = inspectDatabaseStartupLock(lockPath, {
      now: () => new Date(FIXED_NOW.getTime() + TEN_MINUTES_MS + 1),
      isProcessAlive: () => true,
    });
    expect(justPastDefault).toEqual({
      held: true,
      stale: true,
      ownerPid: 7,
    });

    const customWindow = inspectDatabaseStartupLock(lockPath, {
      now: () => new Date(FIXED_NOW.getTime() + 500),
      isProcessAlive: () => true,
      staleAfterMs: 100,
    });
    expect(customWindow.stale).toBe(true);
    expect(customWindow.held).toBe(true);
  });

  it("marks a dead owner stale even when the lock is young", () => {
    const lockPath = databaseStartupLockPath(dataDir("dead"));
    writeLockFile(lockPath, {
      pid: 99,
      createdAt: FIXED_NOW.toISOString(),
    });
    expect(
      inspectDatabaseStartupLock(lockPath, {
        now: () => FIXED_NOW,
        isProcessAlive: () => false,
      }),
    ).toEqual({ held: false, stale: true, ownerPid: 99 });
  });

  it("uses process.kill to decide liveness when no probe is provided", () => {
    const lockPath = databaseStartupLockPath(dataDir("kill"));
    writeLockFile(lockPath, {
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    expect(inspectDatabaseStartupLock(lockPath)).toMatchObject({
      held: true,
      stale: false,
      ownerPid: process.pid,
    });

    writeLockFile(lockPath, {
      pid: 0,
      createdAt: new Date().toISOString(),
    });
    expect(inspectDatabaseStartupLock(lockPath)).toEqual({
      held: false,
      stale: true,
      ownerPid: 0,
    });

    writeLockFile(lockPath, {
      pid: -3,
      createdAt: new Date().toISOString(),
    });
    expect(inspectDatabaseStartupLock(lockPath)).toEqual({
      held: false,
      stale: true,
      ownerPid: -3,
    });

    const deadPid = 2_147_483_647;
    writeLockFile(lockPath, {
      pid: deadPid,
      createdAt: new Date().toISOString(),
    });
    expect(inspectDatabaseStartupLock(lockPath)).toEqual({
      held: false,
      stale: true,
      ownerPid: deadPid,
    });
  });

  it("does not treat an unparseable createdAt as age-stale while the owner lives", () => {
    const lockPath = databaseStartupLockPath(dataDir("baddate"));
    writeLockFile(lockPath, { pid: 5, createdAt: "not-a-date" });
    expect(
      inspectDatabaseStartupLock(lockPath, {
        now: () => FIXED_NOW,
        isProcessAlive: () => true,
      }),
    ).toEqual({ held: true, stale: false, ownerPid: 5 });
  });
});

describe("acquireDatabaseStartupLock", () => {
  it("creates the parent directory, writes an exclusive lock, and reports this pid", () => {
    const dir = dataDir("fresh");
    const result = acquireDatabaseStartupLock(dir, { now: () => FIXED_NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const lockPath = databaseStartupLockPath(dir);
    expect(result.lock.path).toBe(lockPath);
    expect(result.lock.snapshot).toEqual({
      held: true,
      ownerPid: process.pid,
      stale: false,
    });
    expect(fs.existsSync(lockPath)).toBe(true);
    const recorded = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid: number;
      createdAt: string;
    };
    expect(recorded).toEqual({
      pid: process.pid,
      createdAt: FIXED_NOW.toISOString(),
    });
  });

  it("refuses a second acquire while the lock is held and not stale", () => {
    const dir = dataDir("held");
    const first = acquireDatabaseStartupLock(dir, {
      now: () => FIXED_NOW,
      isProcessAlive: () => true,
    });
    expect(first.ok).toBe(true);

    const second = acquireDatabaseStartupLock(dir, {
      now: () => new Date(FIXED_NOW.getTime() + 1000),
      isProcessAlive: () => true,
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected held lock");
    expect(second.error).toBe(
      `PGlite startup lock is held at ${databaseStartupLockPath(dir)}.`,
    );
    expect(second.snapshot).toEqual({
      held: true,
      stale: false,
      ownerPid: process.pid,
    });
  });

  it("steals a stale lock left by a dead owner", () => {
    const dir = dataDir("steal-dead");
    const lockPath = databaseStartupLockPath(dir);
    writeLockFile(lockPath, {
      pid: 999_999,
      createdAt: FIXED_NOW.toISOString(),
    });

    const stolen = acquireDatabaseStartupLock(dir, {
      now: () => FIXED_NOW,
      isProcessAlive: () => false,
    });
    expect(stolen.ok).toBe(true);
    if (!stolen.ok) throw new Error(stolen.error);
    const recorded = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
      pid: number;
    };
    expect(recorded.pid).toBe(process.pid);
  });

  it("steals a lock that is older than the stale window even if the owner is live", () => {
    const dir = dataDir("steal-aged");
    const lockPath = databaseStartupLockPath(dir);
    writeLockFile(lockPath, {
      pid: 11,
      createdAt: FIXED_NOW.toISOString(),
    });

    const stolen = acquireDatabaseStartupLock(dir, {
      now: () => new Date(FIXED_NOW.getTime() + TEN_MINUTES_MS + 1),
      isProcessAlive: () => true,
    });
    expect(stolen.ok).toBe(true);
    if (!stolen.ok) throw new Error(stolen.error);
    expect(stolen.lock.snapshot.ownerPid).toBe(process.pid);
  });

  it("returns the steal error when the lock path is a directory that cannot be unlinked", () => {
    const dir = dataDir("dir-lock");
    const lockPath = databaseStartupLockPath(dir);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "occupant"), "x", "utf8");

    const result = acquireDatabaseStartupLock(dir, {
      now: () => FIXED_NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected steal failure");
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.snapshot).toEqual({ held: true, stale: true });
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("releases the lock file once and ignores a second release", () => {
    const dir = dataDir("release");
    const result = acquireDatabaseStartupLock(dir, { now: () => FIXED_NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const lockPath = result.lock.path;
    result.lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(inspectDatabaseStartupLock(lockPath)).toEqual({ held: false });

    result.lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not throw when release runs after the file is already gone", () => {
    const dir = dataDir("release-missing");
    const result = acquireDatabaseStartupLock(dir, { now: () => FIXED_NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    fs.rmSync(result.lock.path, { force: true });
    expect(() => result.lock.release()).not.toThrow();
  });
});
