/**
 * Regression guard for the pre-early-exit stale-archive sweep in
 * sync-artifacts.mjs: the temp-directory enumeration is best-effort
 * (error-policy:J6), so an unreadable temp dir must never fail the
 * skip path. Harness is real — the script runs as a subprocess with a
 * broken TMPDIR; no mocks.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "sync-artifacts.mjs");

function runWithTmpdir(tmp: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      ELIZA_SKIP_ARTIFACT_SYNC: "1",
      TMPDIR: tmp,
    },
  });
}

describe("sync-artifacts stale-archive sweep", () => {
  test("skip path exits 0 when the temp directory cannot be enumerated", () => {
    const result = runWithTmpdir(
      join(tmpdir(), `eliza-sweep-guard-missing-${process.pid}`, "nope"),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "could not enumerate temp dir for stale archives",
    );
    expect(result.stdout).toContain("skipped (ELIZA_SKIP_ARTIFACT_SYNC=1)");
  });

  test("skip path still exits 0 with a healthy temp directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "eliza-sweep-guard-ok-"));
    try {
      const result = runWithTmpdir(tmp);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("skipped (ELIZA_SKIP_ARTIFACT_SYNC=1)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
