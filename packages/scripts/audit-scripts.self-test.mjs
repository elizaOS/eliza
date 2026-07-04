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

// 11. A generic script with NO hardcoded plugin token passes the coupling gate.
{
  const report = runAudit({
    root: { build: "tsc -b" },
    files: {
      "packages/scripts/build-thing.ts":
        "import { listPackages } from './lib/workspaces.mjs';\nexport const set = listPackages();\n",
    },
  });
  assert(
    report.ok,
    `plugin-free generic script should pass, got ${JSON.stringify(report.failures)}`,
  );
}

// 12. An UNALLOWLISTED hardcoded plugin token in a generic script fails.
{
  const report = runAudit({
    root: { build: "tsc -b" },
    files: {
      "packages/scripts/dev-thing.ts":
        'const SKIP = ["@elizaos/plugin-wallet"];\n',
    },
  });
  assert(!report.ok, "unallowlisted plugin token should fail");
  assert(hasFinding(report, "[coupling]"), "expected a [coupling] finding");
  assert(
    hasFinding(report, "packages/scripts/dev-thing.ts"),
    "coupling finding should name the file",
  );
}

// 13. The SAME token becomes clean once the file+token is allowlisted with a reason.
{
  const report = runAudit({
    root: { build: "tsc -b" },
    files: {
      "packages/scripts/dev-thing.ts":
        'const SKIP = ["@elizaos/plugin-wallet"];\n',
      "packages/scripts/script-plugin-coupling.allowlist.json": JSON.stringify([
        {
          file: "packages/scripts/dev-thing.ts",
          tokens: ["@elizaos/plugin-wallet"],
          reason: "systemic: exercises the wallet plugin by name",
        },
      ]),
    },
  });
  assert(
    report.ok,
    `allowlisted plugin token should pass, got ${JSON.stringify(report.failures)}`,
  );
}

// 14. A STALE allowlist entry — the token no longer appears in the file — fails.
{
  const report = runAudit({
    root: { build: "tsc -b" },
    files: {
      // File exists but its plugin token changed to plugin-sql.
      "packages/scripts/dev-thing.ts":
        'const SKIP = ["@elizaos/plugin-sql"];\n',
      "packages/scripts/script-plugin-coupling.allowlist.json": JSON.stringify([
        {
          file: "packages/scripts/dev-thing.ts",
          tokens: ["@elizaos/plugin-wallet"],
          reason: "systemic: exercises the wallet plugin by name",
        },
      ]),
    },
  });
  assert(!report.ok, "stale allowlist token should fail");
  assert(
    hasFinding(report, "[coupling-stale]"),
    "expected a [coupling-stale] finding for the vanished token",
  );
  // And the still-present plugin-sql token is now unallowlisted → also fails.
  assert(
    hasFinding(report, "[coupling]"),
    "the newly-introduced unallowlisted token should also fail",
  );
}

// 15. A stale entry whose FILE no longer has any plugin token fails.
{
  const report = runAudit({
    root: { build: "tsc -b" },
    files: {
      // Fully decoupled — no plugin tokens left.
      "packages/scripts/dev-thing.ts":
        "import { listPackages } from './lib/workspaces.mjs';\n",
      "packages/scripts/script-plugin-coupling.allowlist.json": JSON.stringify([
        {
          file: "packages/scripts/dev-thing.ts",
          tokens: ["@elizaos/plugin-wallet"],
          reason: "systemic: exercises the wallet plugin by name",
        },
      ]),
    },
  });
  assert(!report.ok, "allowlist entry for a decoupled file should fail");
  assert(
    hasFinding(report, "[coupling-stale]"),
    "expected a [coupling-stale] finding for the decoupled file",
  );
}

// 16. A malformed allowlist entry (missing reason) fails loudly.
{
  const report = runAudit({
    root: { build: "tsc -b" },
    files: {
      "packages/scripts/dev-thing.ts":
        'const SKIP = ["@elizaos/plugin-wallet"];\n',
      "packages/scripts/script-plugin-coupling.allowlist.json": JSON.stringify([
        {
          file: "packages/scripts/dev-thing.ts",
          tokens: ["@elizaos/plugin-wallet"],
        },
      ]),
    },
  });
  assert(!report.ok, "malformed allowlist entry should fail");
  assert(
    hasFinding(report, "[coupling-allowlist]"),
    "expected a [coupling-allowlist] malformed-entry finding",
  );
}

// 17. Tests / self-tests / __tests__ are exempt from the coupling scan.
{
  const report = runAudit({
    root: { build: "tsc -b" },
    files: {
      "packages/scripts/thing.test.ts":
        'expect(load("@elizaos/plugin-wallet")).toBeTruthy();\n',
      "packages/scripts/__tests__/other.ts":
        'const p = "plugins/plugin-sql";\n',
    },
  });
  assert(
    report.ok,
    `test files should be exempt, got ${JSON.stringify(report.failures)}`,
  );
}

console.log("audit-scripts self-test passed");
