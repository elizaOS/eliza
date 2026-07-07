#!/usr/bin/env node

// Cross-platform replacement for the previous `test:cloud` shell pipeline,
// which used `printf '...\n'` (broken under bun's embedded shell on Windows
// — outputs literal `n` instead of newlines) and required POSIX-shell
// `$OLDPWD` semantics.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const stagingDir = path.join(repoRoot, ".tmp", "cloud-unit-bun");

mkdirSync(stagingDir, { recursive: true });

writeFileSync(
  path.join(stagingDir, "bunfig.toml"),
  "[test]\ntimeout = 120000\ncoverage = false\n",
);

// The unit lane runs with NO database service (Cloud Tests → unit-tests calls
// cloud-setup-test-env without setup-db). DB-touching suites are built to fall
// back to in-process PGlite, but that fallback only engages when DATABASE_URL is
// empty or `pglite://` — and the Cloud Tests workflow sets a real
// `postgresql://…:5432` URL at the workflow level, which every job inherits.
// Left as-is, that ambient URL points every suite at a Postgres socket nothing
// is listening on: the isolated-PGlite guards disable themselves (their loud
// "pglite applied" assertions fail) and the raw-SQL suites hit ECONNREFUSED.
// Pin the unit lane to in-process PGlite so it is self-contained; suites that
// need a networked DB opt out via SKIP_DB_DEPENDENT.
const env = {
  ...process.env,
  DATABASE_URL: "pglite://memory",
  TEST_DATABASE_URL: "pglite://memory",
  SKIP_DB_DEPENDENT: "1",
  SKIP_SERVER_CHECK: "true",
};

// NOTE: keep in sync with the package layout. The #9917 reorg moved these from
// packages/cloud-shared -> packages/cloud/shared and packages/cloud-api ->
// packages/cloud/api; the stale paths made `bun test` target nonexistent dirs,
// so the cloud unit suite (incl. the IAC inference hot-path tests) silently ran
// nothing = false-green gate.
const cloudSharedSrc = path.join(
  repoRoot,
  "packages",
  "cloud",
  "shared",
  "src",
);
// cloud-tests.yml already triggers on `packages/scripts/cloud/**`, but nothing
// here ran those tests — the daemon/admin guards (e.g. the provisioning-worker
// env-reconcile regression test for #8756) silently never executed. Include the
// directory so the path trigger actually exercises them.
const cloudScriptsTests = path.join(repoRoot, "packages", "scripts", "cloud");
// The routing (model-routing resolver) and infra (IaC / static-config) packages
// carry pure, DB-free unit suites (104 tests) that ran on NO PR lane: this
// runner did not include them and cloud-tests.yml did not list them in `paths:`,
// so a routing/infra-only change was a silent false-green. Both suites resolve
// their fixtures via import.meta.dir, so they are cwd-independent under the
// staging-dir run below. (Added alongside the cloud-tests.yml `paths:` update so
// the workflow actually triggers when they change.)
const cloudRoutingTests = path.join(
  repoRoot,
  "packages",
  "cloud",
  "routing",
  "src",
);
const cloudInfraTests = path.join(
  repoRoot,
  "packages",
  "cloud",
  "infra",
  "tests",
);

// Fail loud if a test root is missing. `bun test <nonexistent-dir>` exits 0 with
// no tests run, so a stale path (e.g. after a package move) turns this gate into
// a silent false-green instead of a failure. Guard against that recurring.
// Also sweep colocated `<resource>/route.test.ts` unit tests that live
// OUTSIDE __tests__/ (billing, cron, credits, webhooks, …) — previously run by
// no lane. Exclude `test/` (the e2e harness: its own `test:e2e` lane + a live
// server) and build output.
const cloudApiRoot = path.join(repoRoot, "packages", "cloud", "api");
const EXCLUDED_API_DIRS = new Set(["test", "node_modules", "dist", ".turbo"]);
function walkApiUnitTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_API_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkApiUnitTests(full));
    else if (/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}
const cloudApiUnitTests = existsSync(cloudApiRoot)
  ? walkApiUnitTests(cloudApiRoot).sort()
  : [];

// Pass DIRECTORY targets (plus root-level test files), not the 150+ individual
// files: on Windows the spawn goes through cmd.exe (`shell: true` below, needed
// to resolve bun's .cmd shim), whose ~8 KiB command-line ceiling the file list
// outgrew ("The command line is too long."). The exclusion semantics are
// identical — the excluded dirs exist only at the api root (asserted by the
// walk above staying the source of truth for the fail-loud non-empty check),
// and `bun test <dir>` recurses the rest.
function apiUnitTestTargets(root) {
  const targets = [];
  for (const entry of readdirSync(root)) {
    if (EXCLUDED_API_DIRS.has(entry)) continue;
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) {
      if (walkApiUnitTests(full).length > 0) targets.push(full);
    } else if (/\.(test|spec)\.tsx?$/.test(entry)) {
      targets.push(full);
    }
  }
  return targets.sort();
}
const cloudApiTestTargets = existsSync(cloudApiRoot)
  ? apiUnitTestTargets(cloudApiRoot)
  : [];

const testRoots = {
  cloudSharedSrc,
  cloudApiRoot,
  cloudScriptsTests,
  cloudRoutingTests,
  cloudInfraTests,
};
const missing = Object.entries(testRoots)
  .filter(([, dir]) => !existsSync(dir))
  .map(([name, dir]) => `${name} -> ${dir}`);
if (missing.length > 0) {
  console.error(
    `[test:cloud] test root(s) not found — the gate would silently run no tests:\n  ${missing.join("\n  ")}\n` +
      "Update packages/scripts/test-cloud-run.mjs to match the current package layout.",
  );
  process.exit(1);
}

// The directory-target list is what `bun test` actually receives; the explicit
// file walk stays the source of truth for coverage. If the api root exists but
// holds no colocated unit tests, the directory targets would silently run
// nothing — fail loud instead so a layout change can't quietly drop the lane.
if (existsSync(cloudApiRoot) && cloudApiUnitTests.length === 0) {
  console.error(
    `[test:cloud] no colocated cloud/api unit tests found under ${cloudApiRoot} — ` +
      "the gate would silently run zero api tests. Update packages/scripts/test-cloud-run.mjs " +
      "to match the current package layout.",
  );
  process.exit(1);
}

const result = spawnSync(
  "bun",
  [
    "test",
    cloudSharedSrc,
    ...cloudApiTestTargets,
    cloudScriptsTests,
    cloudRoutingTests,
    cloudInfraTests,
    "--timeout",
    "120000",
    "--isolate",
  ],
  {
    cwd: stagingDir,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
