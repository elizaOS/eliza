/**
 * Exercises artifact temp cleanup through the real CLI process, including an
 * unavailable temp root and the skip-mode reclamation path used by CI.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "sync-artifacts.mjs",
);
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runSkippedSync(tempDirectory: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      ELIZA_SKIP_ARTIFACT_SYNC: "1",
      TEMP: tempDirectory,
      TMP: tempDirectory,
      TMPDIR: tempDirectory,
    },
  });
}

describe("sync-artifacts temp cleanup", () => {
  test("keeps skip mode available when the temp directory cannot be enumerated", () => {
    const missingDirectory = path.join(
      tmpdir(),
      `sync-artifacts-missing-${randomUUID()}`,
    );
    expect(existsSync(missingDirectory)).toBe(false);

    const result = runSkippedSync(missingDirectory);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      `WARNING: could not enumerate artifact temp directory ${missingDirectory}`,
    );
    expect(result.stdout).toContain("skipped (ELIZA_SKIP_ARTIFACT_SYNC=1)");
  });

  test("removes only aged matching archives before the skip exit", () => {
    const tempDirectory = mkdtempSync(
      path.join(tmpdir(), "sync-artifacts-cleanup-"),
    );
    tempDirectories.push(tempDirectory);
    const staleArchive = path.join(tempDirectory, "eliza-artifacts-101.tar.gz");
    const freshArchive = path.join(tempDirectory, "eliza-artifacts-202.tar.gz");
    const unrelatedArchive = path.join(
      tempDirectory,
      "other-artifacts-303.tar.gz",
    );
    for (const file of [staleArchive, freshArchive, unrelatedArchive]) {
      writeFileSync(file, "fixture");
    }
    const agedAt = new Date(Date.now() - 7 * 60 * 60_000);
    utimesSync(staleArchive, agedAt, agedAt);
    utimesSync(unrelatedArchive, agedAt, agedAt);

    const result = runSkippedSync(tempDirectory);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("removed 1 stale artifact temp archive");
    expect(result.stdout).toContain("skipped (ELIZA_SKIP_ARTIFACT_SYNC=1)");
    expect(existsSync(staleArchive)).toBe(false);
    expect(existsSync(freshArchive)).toBe(true);
    expect(existsSync(unrelatedArchive)).toBe(true);
  });
});
