/**
 * Verifies Electrobun PGlite backup and reset against the real filesystem.
 * Injected `now` and `backupRoot` are the module's public options; fs stays real.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupPgliteDirectory,
  databaseBackupRoot,
  resetPgliteDirectory,
} from "./database-recovery.ts";

const FIXED_NOW = new Date("2026-05-17T12:34:56.789Z");
const FIXED_STAMP = "2026-05-17T12-34-56-789Z";

const tempDirs: string[] = [];

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `eliza-db-recovery-${name}-`),
  );
  tempDirs.push(dir);
  return dir;
}

function pgliteDir(name: string): string {
  return path.join(tempDir(name), "database", "pglite");
}

function writeTree(root: string, files: Record<string, string>): void {
  fs.mkdirSync(root, { recursive: true });
  for (const [relative, body] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, "utf8");
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("databaseBackupRoot", () => {
  it("places pglite-backups next to the data directory", () => {
    expect(databaseBackupRoot("/state/database/pglite")).toBe(
      "/state/database/pglite-backups",
    );
    expect(databaseBackupRoot("/state/.elizadb")).toBe("/state/pglite-backups");
    expect(databaseBackupRoot("pglite")).toBe("pglite-backups");
  });
});

describe("backupPgliteDirectory", () => {
  it("reports source-missing without creating a backup root", () => {
    const sourceDir = pgliteDir("missing");
    const result = backupPgliteDirectory(sourceDir, { now: () => FIXED_NOW });

    expect(result).toEqual({
      sourceDir,
      backupDir: null,
      created: false,
      reason: "source-missing",
    });
    expect(fs.existsSync(databaseBackupRoot(sourceDir))).toBe(false);
  });

  it("copies nested files into a timestamped sibling backup and leaves the source intact", () => {
    const sourceDir = pgliteDir("copy");
    writeTree(sourceDir, {
      state: "ok",
      "sub/nested.txt": "deep",
    });

    const result = backupPgliteDirectory(sourceDir, { now: () => FIXED_NOW });
    const expectedBackup = path.join(
      databaseBackupRoot(sourceDir),
      `pglite-${FIXED_STAMP}`,
    );

    expect(result).toEqual({
      sourceDir,
      backupDir: expectedBackup,
      created: true,
    });
    expect(fs.readFileSync(path.join(expectedBackup, "state"), "utf8")).toBe(
      "ok",
    );
    expect(
      fs.readFileSync(path.join(expectedBackup, "sub", "nested.txt"), "utf8"),
    ).toBe("deep");
    expect(fs.readFileSync(path.join(sourceDir, "state"), "utf8")).toBe("ok");
    expect(
      fs.readFileSync(path.join(sourceDir, "sub", "nested.txt"), "utf8"),
    ).toBe("deep");
  });

  it("backs up an empty pglite directory", () => {
    const sourceDir = pgliteDir("empty");
    fs.mkdirSync(sourceDir, { recursive: true });

    const result = backupPgliteDirectory(sourceDir, { now: () => FIXED_NOW });

    expect(result.created).toBe(true);
    expect(result.backupDir).toBe(
      path.join(databaseBackupRoot(sourceDir), `pglite-${FIXED_STAMP}`),
    );
    expect(fs.readdirSync(result.backupDir as string)).toEqual([]);
  });

  it("honors a custom backupRoot", () => {
    const sourceDir = pgliteDir("custom-root");
    writeTree(sourceDir, { marker: "1" });
    const backupRoot = path.join(tempDir("backups"), "custom");

    const result = backupPgliteDirectory(sourceDir, {
      now: () => FIXED_NOW,
      backupRoot,
    });

    expect(result.backupDir).toBe(
      path.join(backupRoot, `pglite-${FIXED_STAMP}`),
    );
    expect(fs.existsSync(databaseBackupRoot(sourceDir))).toBe(false);
    expect(
      fs.readFileSync(path.join(result.backupDir as string, "marker"), "utf8"),
    ).toBe("1");
  });

  it("accepts a .elizadb basename", () => {
    const sourceDir = path.join(tempDir("elizadb"), ".elizadb");
    writeTree(sourceDir, { db: "yes" });

    const result = backupPgliteDirectory(sourceDir, { now: () => FIXED_NOW });

    expect(result.created).toBe(true);
    expect(result.backupDir).toBe(
      path.join(databaseBackupRoot(sourceDir), `pglite-${FIXED_STAMP}`),
    );
    expect(
      fs.readFileSync(path.join(result.backupDir as string, "db"), "utf8"),
    ).toBe("yes");
  });

  it("uses the live clock when now is omitted", () => {
    const sourceDir = pgliteDir("live-clock");
    writeTree(sourceDir, { tick: "t" });

    const result = backupPgliteDirectory(sourceDir);

    expect(result.created).toBe(true);
    expect(result.backupDir).toMatch(
      new RegExp(
        `^${databaseBackupRoot(sourceDir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pglite-\\d{4}-`,
      ),
    );
    expect(
      fs.readFileSync(path.join(result.backupDir as string, "tick"), "utf8"),
    ).toBe("t");
  });

  it("merges into an existing timestamped backup without overwriting files", () => {
    const sourceDir = pgliteDir("no-overwrite");
    writeTree(sourceDir, { state: "first" });
    const first = backupPgliteDirectory(sourceDir, { now: () => FIXED_NOW });
    expect(first.created).toBe(true);

    fs.writeFileSync(path.join(sourceDir, "state"), "second", "utf8");
    fs.writeFileSync(path.join(sourceDir, "extra"), "new", "utf8");
    const second = backupPgliteDirectory(sourceDir, { now: () => FIXED_NOW });
    expect(second.created).toBe(true);
    expect(second.backupDir).toBe(first.backupDir);
    expect(
      fs.readFileSync(path.join(first.backupDir as string, "state"), "utf8"),
    ).toBe("first");
    expect(
      fs.readFileSync(path.join(first.backupDir as string, "extra"), "utf8"),
    ).toBe("new");
  });

  it("rejects memory://, filesystem root, wrong basename, and app-bundle paths", () => {
    expect(() => backupPgliteDirectory("memory://")).toThrow(
      "memory:// PGlite data cannot be backed up or reset.",
    );
    expect(() => backupPgliteDirectory("  memory://  ")).toThrow(
      "memory:// PGlite data cannot be backed up or reset.",
    );
    expect(() => backupPgliteDirectory("/")).toThrow(
      "PGlite reset target is too broad.",
    );
    expect(() => backupPgliteDirectory("/tmp/not-a-db")).toThrow(
      /must end in pglite or \.elizadb/,
    );
    expect(() =>
      backupPgliteDirectory("/Applications/Eliza.app/Contents/database/pglite"),
    ).toThrow("PGlite reset target cannot be inside an app bundle.");
  });
});

describe("resetPgliteDirectory", () => {
  it("backs up, removes contents, and recreates an empty source directory", () => {
    const sourceDir = pgliteDir("reset-existing");
    writeTree(sourceDir, {
      state: "ok",
      "sub/nested.txt": "deep",
    });

    const result = resetPgliteDirectory(sourceDir, { now: () => FIXED_NOW });
    const expectedBackup = path.join(
      databaseBackupRoot(sourceDir),
      `pglite-${FIXED_STAMP}`,
    );

    expect(result.sourceDir).toBe(sourceDir);
    expect(result.removed).toBe(true);
    expect(result.backup).toEqual({
      sourceDir,
      backupDir: expectedBackup,
      created: true,
    });
    expect(fs.existsSync(sourceDir)).toBe(true);
    expect(fs.readdirSync(sourceDir)).toEqual([]);
    expect(fs.readFileSync(path.join(expectedBackup, "state"), "utf8")).toBe(
      "ok",
    );
    expect(
      fs.readFileSync(path.join(expectedBackup, "sub", "nested.txt"), "utf8"),
    ).toBe("deep");
  });

  it("creates an empty source directory when the original is missing", () => {
    const sourceDir = pgliteDir("reset-missing");

    const result = resetPgliteDirectory(sourceDir, { now: () => FIXED_NOW });

    expect(result.removed).toBe(false);
    expect(result.backup).toEqual({
      sourceDir,
      backupDir: null,
      created: false,
      reason: "source-missing",
    });
    expect(fs.existsSync(sourceDir)).toBe(true);
    expect(fs.readdirSync(sourceDir)).toEqual([]);
    expect(fs.existsSync(databaseBackupRoot(sourceDir))).toBe(false);
  });

  it("forwards backupRoot to the backup step", () => {
    const sourceDir = pgliteDir("reset-custom-root");
    writeTree(sourceDir, { marker: "keep" });
    const backupRoot = path.join(tempDir("reset-backups"), "custom");

    const result = resetPgliteDirectory(sourceDir, {
      now: () => FIXED_NOW,
      backupRoot,
    });

    expect(result.removed).toBe(true);
    expect(result.backup.backupDir).toBe(
      path.join(backupRoot, `pglite-${FIXED_STAMP}`),
    );
    expect(
      fs.readFileSync(
        path.join(result.backup.backupDir as string, "marker"),
        "utf8",
      ),
    ).toBe("keep");
    expect(fs.readdirSync(sourceDir)).toEqual([]);
  });

  it("leaves the source tree in place when backup cannot create the backup root", () => {
    const sourceDir = pgliteDir("reset-backup-fails");
    writeTree(sourceDir, { state: "untouched" });
    const backupRoot = path.join(tempDir("blocked"), "not-a-dir");
    fs.writeFileSync(backupRoot, "file", "utf8");

    expect(() =>
      resetPgliteDirectory(sourceDir, {
        now: () => FIXED_NOW,
        backupRoot,
      }),
    ).toThrow();
    expect(fs.readFileSync(path.join(sourceDir, "state"), "utf8")).toBe(
      "untouched",
    );
  });

  it("rejects unsafe reset targets before touching the filesystem", () => {
    expect(() => resetPgliteDirectory("memory://")).toThrow(
      "memory:// PGlite data cannot be backed up or reset.",
    );
    expect(() => resetPgliteDirectory("/")).toThrow(
      "PGlite reset target is too broad.",
    );
    expect(() => resetPgliteDirectory("/tmp/other")).toThrow(
      /must end in pglite or \.elizadb/,
    );
  });
});
