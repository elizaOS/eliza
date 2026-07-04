/** Exercises database behavior with deterministic app-core test fixtures. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireDatabaseStartupLock,
  applyDatabaseResolutionToEnv,
  assertSafePgliteResetTarget,
  backupPgliteDirectory,
  classifyDatabaseError,
  describePglitePath,
  ensurePgliteDataDir,
  inspectDatabaseStartupLock,
  redactDatabaseTarget,
  resetPgliteDirectory,
  resolveDatabaseMode,
  resolveDefaultPgliteDataDir,
} from "./index";

function tempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `eliza-${name}-`));
}

describe("database boot policy", () => {
  it("uses POSTGRES_URL before any other database source", () => {
    const result = resolveDatabaseMode({
      env: {
        POSTGRES_URL: "postgres://user:secret@localhost:5432/eliza",
        DATABASE_URL: "postgres://other:secret@localhost:5432/other",
        PGLITE_DATA_DIR: "/tmp/ignored",
      },
      packagedDesktop: true,
      appStateDir: "/tmp/app-state",
    });

    expect(result.mode).toBe("postgres");
    expect(result.source).toBe("POSTGRES_URL");
    expect(result.postgresUrl).toBe(
      "postgres://user:secret@localhost:5432/eliza",
    );
    expect(result.databaseUrlMapped).toBe(false);
  });

  it("maps DATABASE_URL to POSTGRES_URL when POSTGRES_URL is missing", () => {
    const result = resolveDatabaseMode({
      env: {
        DATABASE_URL: "postgres://user:secret@localhost:5432/eliza",
      },
      packagedDesktop: true,
      appStateDir: "/tmp/app-state",
    });
    const childEnv: Record<string, string> = {};

    applyDatabaseResolutionToEnv(childEnv, result);

    expect(result.mode).toBe("postgres");
    expect(result.source).toBe("DATABASE_URL");
    expect(result.databaseUrlMapped).toBe(true);
    expect(childEnv.POSTGRES_URL).toBe(
      "postgres://user:secret@localhost:5432/eliza",
    );
    expect(result.warnings[0]).toContain("DATABASE_URL");
  });

  it("resolves PGLITE_DATA_DIR persistent and memory modes", () => {
    const persistent = resolveDatabaseMode({
      env: { PGLITE_DATA_DIR: "data/pglite" },
      packagedDesktop: false,
      appStateDir: "/tmp/app-state",
      cwd: "/tmp/project",
    });
    const memory = resolveDatabaseMode({
      env: { PGLITE_DATA_DIR: "memory://" },
      packagedDesktop: false,
      appStateDir: "/tmp/app-state",
    });

    expect(persistent.mode).toBe("pglite-persistent");
    expect(persistent.pgliteDataDir).toBe("/tmp/project/data/pglite");
    expect(memory.mode).toBe("pglite-memory");
    expect(memory.pgliteDataDir).toBe("memory://");
  });

  it("uses memory mode only when explicitly requested", () => {
    const result = resolveDatabaseMode({
      env: { ELIZA_DB_MODE: "memory" },
      packagedDesktop: false,
      appStateDir: "/tmp/app-state",
    });

    expect(result.mode).toBe("pglite-memory");
    expect(result.source).toBe("explicit-memory");
  });

  it("uses deterministic packaged desktop PGlite path", () => {
    const appStateDir = "/Users/example/Library/Application Support/Eliza";
    const result = resolveDatabaseMode({
      env: {},
      packagedDesktop: true,
      appStateDir,
    });

    expect(result.mode).toBe("pglite-persistent");
    expect(result.source).toBe("packaged-desktop-default");
    expect(result.pgliteDataDir).toBe(
      path.join(appStateDir, "database", "pglite"),
    );
  });

  it("does not silently choose PGlite in development without an explicit source", () => {
    const result = resolveDatabaseMode({
      env: {},
      packagedDesktop: false,
      appStateDir: "/tmp/app-state",
    });

    expect(result.mode).toBe("unknown");
    expect(result.source).toBe("unknown");
    expect(result.warnings[0]).toContain("development database policy");
  });

  it("ensures and describes writable PGlite paths", () => {
    const appStateDir = tempDir("app-state");
    const dataDir = resolveDefaultPgliteDataDir({ appStateDir });

    ensurePgliteDataDir(dataDir);
    const description = describePglitePath(dataDir, { appStateDir });

    expect(fs.existsSync(dataDir)).toBe(true);
    expect(description.insideAppState).toBe(true);
    expect(description.writableParent).toBe(true);
  });

  it("detects active and stale database startup locks", () => {
    const appStateDir = tempDir("lock");
    const dataDir = path.join(appStateDir, "database", "pglite");
    const active = acquireDatabaseStartupLock(dataDir, {
      now: () => new Date("2026-05-17T00:00:00.000Z"),
      isProcessAlive: () => true,
    });

    expect(active.ok).toBe(true);
    if (!active.ok) throw new Error(active.error);
    expect(
      inspectDatabaseStartupLock(active.lock.path, {
        now: () => new Date("2026-05-17T00:01:00.000Z"),
        isProcessAlive: () => true,
      }),
    ).toMatchObject({ held: true, stale: false });
    active.lock.release();
    fs.writeFileSync(
      active.lock.path,
      `${JSON.stringify({ pid: 999999, createdAt: "2026-05-17T00:00:00.000Z" })}\n`,
      "utf8",
    );
    expect(
      inspectDatabaseStartupLock(active.lock.path, {
        now: () => new Date("2026-05-17T00:20:00.000Z"),
        isProcessAlive: () => false,
      }),
    ).toMatchObject({ held: false, stale: true, ownerPid: 999999 });
  });

  it("backs up and resets only validated PGlite directories", () => {
    const appStateDir = tempDir("recovery");
    const dataDir = path.join(appStateDir, "database", "pglite");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "state"), "ok", "utf8");

    const backup = backupPgliteDirectory(dataDir, {
      now: () => new Date("2026-05-17T00:00:00.000Z"),
    });
    const reset = resetPgliteDirectory(dataDir, {
      now: () => new Date("2026-05-17T00:00:01.000Z"),
    });

    expect(backup.created).toBe(true);
    expect(
      backup.backupDir && fs.existsSync(path.join(backup.backupDir, "state")),
    ).toBe(true);
    expect(reset.removed).toBe(true);
    expect(fs.existsSync(dataDir)).toBe(true);
    expect(() => assertSafePgliteResetTarget(appStateDir)).toThrow(
      /must end in pglite/,
    );
  });

  it("redacts database credentials and classifies migration failures", () => {
    expect(
      redactDatabaseTarget("postgres://user:secret@localhost:5432/eliza"),
    ).toContain("%5Bpassword%5D");
    expect(classifyDatabaseError("Migration failed for plugin-x")).toBe(
      "migration-failed",
    );
  });
});
