#!/usr/bin/env node
/** Verifies exact changed-path attribution and fail-closed missing-source handling. */
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

function writeLcovRecords(dir, sourcePaths) {
  const file = join(dir, "lcov.info");
  writeFileSync(
    file,
    sourcePaths
      .flatMap((sourcePath) => [
        `SF:${sourcePath}`,
        "LF:2",
        "LH:2",
        "end_of_record",
      ])
      .concat("")
      .join("\n"),
  );
  return file;
}

function runGate({ changed, lcov, enforce = true, threshold = 50 }) {
  const changedArgument = changed
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n");
  return spawnSync(
    "awk",
    [
      "-v",
      `changed=${changedArgument}`,
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

  assertGate("fails when any changed source is absent from LCOV", () => {
    const covered = "packages/demo/src/covered.ts";
    const missing = "packages/demo/src/missing.ts";
    const lcov = writeLcov(dir, covered);
    const result = runGate({ changed: `${covered}\n${missing}`, lcov });

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /100\.00% packages\/demo\/src\/covered\.ts/);
    assert.match(result.stdout, /MISSING: packages\/demo\/src\/missing\.ts/);
    assert.match(result.stdout, /changed source missing from LCOV/);
  });

  assertGate("prefers the longest matching changed path", () => {
    const rootPath = "src/foo.ts";
    const nestedPath = "packages/demo/src/foo.ts";
    const lcov = writeLcovRecords(dir, [
      `/workspace/eliza/${rootPath}`,
      `/workspace/eliza/${nestedPath}`,
    ]);
    const result = runGate({ changed: `${rootPath}\n${nestedPath}`, lcov });

    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /100\.00% src\/foo\.ts/);
    assert.match(result.stdout, /100\.00% packages\/demo\/src\/foo\.ts/);
    assert.doesNotMatch(result.stdout, /MISSING:/);
  });

  assertGate("rejects an executable source reported with LF zero", () => {
    const source = "packages/demo/src/runtime.ts";
    const lcov = writeLcov(dir, source, 0, 0);
    const result = runGate({ changed: source, lcov });

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /MISSING: packages\/demo\/src\/runtime[.]ts/);
    assert.match(result.stdout, /changed source missing from LCOV/);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
