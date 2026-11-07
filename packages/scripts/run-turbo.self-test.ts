#!/usr/bin/env node
/**
 * Self-test for run-turbo.ts lockfile and affected-scope preflights.
 *
 * Turbo's Bun lock parser is part of cache correctness: unsupported lockfile
 * versions must fail before a Turbo run can silently fall back to coarse
 * invalidation. CI scope selection must also preserve full runs and use a
 * verified base for affected runs.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./run-turbo.ts", import.meta.url));

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

function runWithAffectedSelection(
  affected,
  base = "a".repeat(40),
  extraArgs = [],
) {
  const dir = mkdtempSync(join(tmpdir(), "run-turbo-affected-"));
  const lockfile = join(dir, "bun.lock");
  const turbo = join(dir, "turbo.mjs");
  const output = join(dir, "args.json");
  writeFileSync(lockfile, JSON.stringify({ lockfileVersion: 1 }));
  writeFileSync(
    turbo,
    'import { writeFileSync } from "node:fs"; writeFileSync(process.env.RUN_TURBO_TEST_OUTPUT, JSON.stringify(process.argv.slice(2)));\n',
  );
  try {
    const result = spawnSync(
      process.execPath,
      [script, "run", "build", "--concurrency=1", ...extraArgs],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          RUN_TURBO_AFFECTED: affected,
          RUN_TURBO_BIN: turbo,
          RUN_TURBO_BUN_LOCKFILE: lockfile,
          RUN_TURBO_TEST_OUTPUT: output,
          TURBO_SCM_BASE: base,
        },
      },
    );
    return {
      args: result.status === 0 ? JSON.parse(readFileSync(output, "utf8")) : [],
      result,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

{
  const { args, result } = runWithAffectedSelection("1");
  assert(
    result.status === 0,
    `affected build should pass, got ${result.status}: ${result.stderr}`,
  );
  assert(args.includes("--affected"), "affected build should pass --affected");
}

{
  const { args, result } = runWithAffectedSelection("0", "");
  assert(
    result.status === 0,
    `full build should pass, got ${result.status}: ${result.stderr}`,
  );
  assert(!args.includes("--affected"), "full build should omit --affected");
}

{
  const { args, result } = runWithAffectedSelection("1", "a".repeat(40), [
    "--filter=@elizaos/core",
  ]);
  assert(
    result.status === 0,
    `explicitly filtered build should pass, got ${result.status}: ${result.stderr}`,
  );
  assert(
    !args.includes("--affected"),
    "explicitly filtered build should not gain an implicit affected intersection",
  );
}

{
  const { result } = runWithAffectedSelection("1", "");
  assert(result.status === 1, "affected build should reject a missing base");
  assert(
    result.stderr.includes(
      "Affected verification requires a verified TURBO_SCM_BASE",
    ),
    `expected missing-base error, got ${result.stderr}`,
  );
}

console.log("run-turbo self-test passed");
