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

// Write a single-record lcov under an explicit filename so a test can hand the
// awk MULTIPLE lcov inputs (one per lane), exactly as the CI does with the
// per-nearest-config lcov.info files.
function writeLcovAs(dir, name, sourcePath, found, hit) {
  const file = join(dir, name);
  writeFileSync(
    file,
    [`SF:${sourcePath}`, `LF:${found}`, `LH:${hit}`, "end_of_record", ""].join(
      "\n",
    ),
  );
  return file;
}

function runGate({ changed, lcov, enforce = true, threshold = 50, excluded = "" }) {
  const changedArgument = changed
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n");
  const excludedArgument = excluded
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n");
  const lcovArgs = Array.isArray(lcov) ? lcov : [lcov];
  return spawnSync(
    "awk",
    [
      "-v",
      `changed=${changedArgument}`,
      "-v",
      `threshold=${threshold}`,
      "-v",
      `excluded=${excludedArgument}`,
      "-f",
      awkScript,
      ...lcovArgs,
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
  assertGate(
    "aggregates a file across lanes: an incidental low record does not fail a file whose real lane clears the floor (#16043)",
    () => {
      const src = "packages/core/src/features/documents/service.ts";
      // Its own focused lane covers it well (8/10 = 80%); another package's lane
      // merely imports it (1/50 = 2%). Pre-fix, the 2% record alone failed the gate.
      const ownLane = writeLcovAs(dir, "core.lcov", src, 10, 8);
      const importLane = writeLcovAs(dir, "meetings.lcov", src, 50, 1);
      const result = runGate({ changed: src, lcov: [ownLane, importLane] });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /coverage gate OK/);
      // Counted once, at the best lane's percentage — not the 2% record.
      assert.match(result.stdout, /changed files: 1,/);
      assert.match(
        result.stdout,
        /80\.00% packages\/core\/src\/features\/documents\/service\.ts/,
      );
    },
  );

  assertGate(
    "still fails a file that is genuinely below the floor in every lane (#16043)",
    () => {
      const src = "packages/core/src/features/documents/service.ts";
      // Both lanes under 50% (19.90% and 2%). The aggregated best is still below,
      // so the gate must fail — aggregation must not blanket-pass shared files.
      const laneA = writeLcovAs(dir, "a.lcov", src, 1000, 199);
      const laneB = writeLcovAs(dir, "b.lcov", src, 50, 1);
      const result = runGate({ changed: src, lcov: [laneA, laneB] });
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stdout,
        /BELOW: packages\/core\/src\/features\/documents\/service\.ts/,
      );
    },
  );
  assertGate(
    "excluded changed file absent from LCOV passes with a visible EXCLUDED line (#16409)",
    () => {
      // eliza.ts cannot be instrumented; only foo.ts appears in LCOV.
      const lcov = writeLcov(dir, "packages/demo/src/foo.ts");
      const result = runGate({
        changed: "packages/demo/src/foo.ts\npackages/agent/src/runtime/eliza.ts",
        lcov,
        excluded: "packages/agent/src/runtime/eliza.ts",
      });
      assert.equal(result.status, 0, result.stdout);
      assert.match(
        result.stdout,
        /EXCLUDED \(cannot appear in LCOV.*\): packages\/agent\/src\/runtime\/eliza\.ts/,
      );
      assert.doesNotMatch(result.stdout, /MISSING/);
    },
  );

  assertGate(
    "an excluded file that DOES appear in LCOV is gated normally (#16409 — the escape expires)",
    () => {
      // Collection got fixed: the file shows up at 25% — below the floor, so
      // the manifest entry must NOT shield it.
      const lcov = writeLcov(dir, "packages/agent/src/runtime/eliza.ts", 100, 25);
      const result = runGate({
        changed: "packages/agent/src/runtime/eliza.ts",
        lcov,
        excluded: "packages/agent/src/runtime/eliza.ts",
      });
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stdout, /BELOW: packages\/agent\/src\/runtime\/eliza\.ts/);
    },
  );

  assertGate(
    "a non-excluded absent file still hard-fails as MISSING (#16409 — no blanket fail-open)",
    () => {
      const lcov = writeLcov(dir, "packages/demo/src/foo.ts");
      const result = runGate({
        changed: "packages/demo/src/bar.ts",
        lcov,
        excluded: "packages/agent/src/runtime/eliza.ts",
      });
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stdout, /MISSING: packages\/demo\/src\/bar\.ts/);
    },
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
