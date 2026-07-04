#!/usr/bin/env node
/**
 * Self-test for audit-scripts.mjs. Builds throwaway fixture trees and runs the
 * audit against them with `--root`, asserting which findings it does and does
 * not produce. Mirrors ci-path-gate.self-test.mjs.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./audit-scripts.mjs", import.meta.url));

/** @param {{root?: Record<string,string>, files?: Record<string,string>}} fixture */
function makeFixture(fixture) {
  const dir = mkdtempSync(join(tmpdir(), "audit-scripts-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      { name: "fixture-root", scripts: fixture.root ?? {} },
      null,
      2,
    ),
  );
  for (const [rel, contents] of Object.entries(fixture.files ?? {})) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

function runAudit(fixture) {
  const dir = makeFixture(fixture);
  const result = spawnSync(
    process.execPath,
    [script, "--root", dir, "--json"],
    {
      encoding: "utf8",
    },
  );
  rmSync(dir, { recursive: true, force: true });
  if (!result.stdout) {
    throw new Error(result.stderr || `audit-scripts produced no output`);
  }
  return JSON.parse(result.stdout);
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function hasFinding(report, fragment) {
  return report.failures.some((f) => f.includes(fragment));
}

// 1. A clean tree passes.
{
  const report = runAudit({
    root: { build: "tsc -b", "test:unit": "vitest run" },
  });
  assert(
    report.ok,
    `clean tree should pass, got ${JSON.stringify(report.failures)}`,
  );
}

// 2. An orphan root script (unreferenced, unknown namespace) fails.
{
  const report = runAudit({ root: { "frobnicate:widgets": "node tool.mjs" } });
  assert(!report.ok, "orphan script should fail");
  assert(hasFinding(report, "[orphan]"), "expected an [orphan] finding");
  assert(
    hasFinding(report, "frobnicate:widgets"),
    "orphan finding should name the script",
  );
}

// 3. An orphan-looking script that is referenced by a workflow passes.
{
  const report = runAudit({
    root: { "frobnicate:widgets": "node tool.mjs" },
    files: {
      "tool.mjs": "// tool",
      ".github/workflows/ci.yml":
        "steps:\n  - run: bun run frobnicate:widgets\n",
    },
  });
  assert(
    report.ok,
    `referenced script should pass, got ${JSON.stringify(report.failures)}`,
  );
}

// 4. A fake-success echo-skip lint/typecheck/test/build fails.
{
  const report = runAudit({
    root: { build: "tsc -b" },
    files: {
      "plugins/p/package.json": JSON.stringify({
        name: "p",
        scripts: { lint: 'echo "Lint skipped for release"' },
      }),
    },
  });
  assert(!report.ok, "echo-skip lint should fail");
  assert(hasFinding(report, "[no-op]"), "expected a [no-op] finding");
}

// 5. A genuine conditional skip (real command alongside the echo) passes.
{
  const report = runAudit({
    root: { build: "tsc -b" },
    files: {
      "plugins/p/package.json": JSON.stringify({
        name: "p",
        scripts: {
          test: "command -v forge >/dev/null && forge test || echo 'skipping (no forge)'",
        },
      }),
    },
  });
  assert(
    report.ok,
    `conditional skip should pass, got ${JSON.stringify(report.failures)}`,
  );
}

// 6. A --cwd pointing at a missing directory fails.
{
  const report = runAudit({
    root: { dev: "bun run --cwd packages/ghost dev" },
  });
  assert(!report.ok, "broken --cwd should fail");
  assert(hasFinding(report, "[broken-cwd]"), "expected a [broken-cwd] finding");
}

// 7. A node/bun pointing at a missing repo file fails.
{
  const report = runAudit({
    root: { build: "node packages/scripts/missing.mjs" },
  });
  assert(!report.ok, "broken file path should fail");
  assert(
    hasFinding(report, "[broken-path]"),
    "expected a [broken-path] finding",
  );
}

// 8. A present file path passes.
{
  const report = runAudit({
    root: { build: "node packages/scripts/real.mjs" },
    files: { "packages/scripts/real.mjs": "// real" },
  });
  assert(
    report.ok,
    `present file path should pass, got ${JSON.stringify(report.failures)}`,
  );
}

// 9. An unallowlisted exact root -> package script wrapper fails.
{
  const report = runAudit({
    root: {
      "audit:thing": "bun run --cwd packages/thing test",
    },
    files: {
      "packages/thing/package.json": JSON.stringify({
        name: "thing",
        scripts: { test: "vitest run" },
      }),
    },
  });
  assert(!report.ok, "unallowlisted cwd wrapper should fail");
  assert(
    hasFinding(report, "[cwd-wrapper]"),
    "expected a [cwd-wrapper] finding",
  );
}

// 10. A documented allowlisted exact root -> package script wrapper passes.
{
  const report = runAudit({
    root: {
      "test:hmr": "bun run --cwd packages/app test:hmr",
    },
    files: {
      "packages/app/package.json": JSON.stringify({
        name: "app",
        scripts: { "test:hmr": "vitest run test/hmr.test.ts" },
      }),
    },
  });
  assert(
    report.ok,
    `allowlisted cwd wrapper should pass, got ${JSON.stringify(report.failures)}`,
  );
}

console.log("audit-scripts self-test passed");
