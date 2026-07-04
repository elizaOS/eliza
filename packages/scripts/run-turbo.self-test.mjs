#!/usr/bin/env node
/**
 * Self-test for run-turbo.mjs lockfile-version preflight.
 *
 * Turbo's Bun lock parser is part of cache correctness: unsupported lockfile
 * versions must fail before a Turbo run can silently fall back to coarse
 * invalidation.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./run-turbo.mjs", import.meta.url));

function makeLockfile(version) {
  const dir = mkdtempSync(join(tmpdir(), "run-turbo-lock-"));
  const lockfile = join(dir, "bun.lock");
  writeFileSync(
    lockfile,
    JSON.stringify({ lockfileVersion: version, workspaces: {} }, null, 2),
  );
  return { dir, lockfile };
}

function runWithLockfile(version) {
  const { dir, lockfile } = makeLockfile(version);
  try {
    return spawnSync(process.execPath, [script, "run", "build", "--dry=json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUN_TURBO_BUN_LOCKFILE: lockfile,
        RUN_TURBO_LOCKFILE_CHECK_ONLY: "1",
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

{
  const result = runWithLockfile(1);
  assert(
    result.status === 0,
    `lockfileVersion 1 should pass, got ${result.status}: ${result.stderr}`,
  );
}

{
  const result = runWithLockfile(2);
  assert(result.status === 1, "lockfileVersion 2 should fail");
  assert(
    result.stderr.includes("Unsupported bun.lock lockfileVersion 2"),
    `expected unsupported-version error, got ${result.stderr}`,
  );
  assert(
    result.stderr.includes("turborepo/discussions/13126"),
    "error should point to the Turbo/Bun lockfile compatibility discussion",
  );
}

console.log("run-turbo self-test passed");
