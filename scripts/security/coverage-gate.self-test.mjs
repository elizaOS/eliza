#!/usr/bin/env node
/**
 * Regression checks for the changed-file LCOV matcher used by the coverage
 * gate. The gate compares repo-relative changed paths with LCOV paths that may
 * be absolute, so these cases pin the exact path-boundary behavior rather than
 * a permissive substring match.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const awkScript = join(root, "scripts/security/coverage-gate.awk");

function writeLcov(dir, sourcePath, found = 2, hit = 2) {
  const file = join(dir, "lcov.info");
  writeFileSync(
    file,
    [`SF:${sourcePath}`, `LF:${found}`, `LH:${hit}`, "end_of_record", ""].join(
      "\n",
    ),
  );
  return file;
}

function runGate({ changed, lcov, enforce = true, threshold = 50 }) {
  return spawnSync(
    "awk",
    [
      "-v",
      `changed=${changed}`,
      "-v",
      `threshold=${threshold}`,
      "-f",
      awkScript,
      lcov,
    ],
    {
      cwd: root,
      env: { ...process.env, COVERAGE_GATE_ENFORCE: enforce ? "1" : "" },
      encoding: "utf8",
    },
  );
}

function assertGate(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const dir = mkdtempSync(join(tmpdir(), "coverage-gate-"));
try {
  assertGate("matches identical repo-relative path", () => {
    const lcov = writeLcov(dir, "packages/demo/src/foo.ts");
    const result = runGate({ changed: "packages/demo/src/foo.ts", lcov });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /coverage gate OK/);
  });

  assertGate("matches absolute LCOV path at path boundary", () => {
    const lcov = writeLcov(dir, "/workspace/eliza/packages/demo/src/foo.ts");
    const result = runGate({ changed: "packages/demo/src/foo.ts", lcov });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /coverage gate OK/);
  });

  assertGate("does not match similar filename substring", () => {
    const lcov = writeLcov(dir, "/workspace/eliza/packages/demo/src/foo.tsx");
    const result = runGate({ changed: "packages/demo/src/foo.ts", lcov });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /changed source missing from LCOV/);
  });

  assertGate("does not match longer path segment prefix", () => {
    const lcov = writeLcov(dir, "/workspace/eliza/packages/demo/src/notfoo.ts");
    const result = runGate({ changed: "packages/demo/src/foo.ts", lcov });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /changed source missing from LCOV/);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
