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
import { shouldNormalizeBunStatus99 } from "./test-cloud-run-helpers.mjs";

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
// The deployable cloud services (agent-server, container-control-plane,
// operator, gateways, coding-remote-runner, _common) carry bun:test suites,
// and cloud-tests.yml triggers on `packages/cloud/services/**` — but this
// runner never swept them, and container-control-plane/operator had no `test`
// script either, so their suites (the H4 fail-closed token gate, the #12268
// annotation-corruption proof) executed in NO CI lane: a services change went
// green without its tests running (#15603). Sweep the whole directory. The
// gateway suites also run in their dedicated workflows
// (cloud-gateway-discord/-webhook); they are self-contained bun:test files,
// so the duplicate coverage here is cheap and keeps this gate layout-proof.
const cloudServicesRoot = path.join(repoRoot, "packages", "cloud", "services");

// Fail loud if a test root is missing. `bun test <nonexistent-dir>` exits 0 with
// no tests run, so a stale path (e.g. after a package move) turns this gate into
// a silent false-green instead of a failure. Guard against that recurring.
// Also sweep colocated `<resource>/route.test.ts` unit tests that live
// OUTSIDE __tests__/ (billing, cron, credits, webhooks, …) — previously run by
// no lane. Exclude `test/` (the e2e harness: its own `test:e2e` lane + a live
// server) and build output.
const cloudApiRoot = path.join(repoRoot, "packages", "cloud", "api");
// `test/` is the api e2e harness (own `test:e2e` lane + a live server); the
// rest is build output / vendored deps that carry no unit lane.
const EXCLUDED_API_DIRS = new Set(["test", "node_modules", "dist", ".turbo"]);
// Vendored deps and build output under any non-api root: never a unit target.
const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".turbo"]);
function walkTests(dir, excluded) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (excluded.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTests(full, excluded));
    else if (/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}
const walkApiUnitTests = (dir) => walkTests(dir, EXCLUDED_API_DIRS);

const testRoots = {
  cloudSharedSrc,
  cloudApiRoot,
  cloudScriptsTests,
  cloudRoutingTests,
  cloudInfraTests,
  cloudServicesRoot,
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

const cloudApiUnitTests = walkApiUnitTests(cloudApiRoot).sort();

// If the api root exists but holds no colocated unit tests, the gate would
// silently run zero api tests — fail loud so a layout change can't quietly
// drop the lane.
if (cloudApiUnitTests.length === 0) {
  console.error(
    `[test:cloud] no colocated cloud/api unit tests found under ${cloudApiRoot} — ` +
      "the gate would silently run zero api tests. Update packages/scripts/test-cloud-run.mjs " +
      "to match the current package layout.",
  );
  process.exit(1);
}

const cloudServicesTests = walkTests(cloudServicesRoot, EXCLUDED_DIRS).sort();

// Same fail-loud guard as cloud/api: if a reorg moves the services suites,
// this gate must break instead of silently running zero services tests.
if (cloudServicesTests.length === 0) {
  console.error(
    `[test:cloud] no cloud/services tests found under ${cloudServicesRoot} — ` +
      "the gate would silently run zero services tests. Update packages/scripts/test-cloud-run.mjs " +
      "to match the current package layout.",
  );
  process.exit(1);
}

// The full unit set is ~700 files. bun's `--isolate` gives each file a fresh
// global but keeps ONE process, so JS heap plus external (pglite/WASM) memory
// accumulates monotonically across the whole run — RSS climbs past 7 GB. On the
// memory-bounded self-hosted runner that tips into GC-thrash/OOM, and because
// the drizzle-kit `pushSchema` introspect ("Pulling schema from database…")
// builds large full-schema JSON snapshots, the run consistently wedged there
// and the runner reclaimed the job (SIGTERM → exit 143). Splitting the file set
// into sequential fresh `bun test` processes bounds peak memory to one batch:
// each process starts cold, runs its slice, and frees everything on exit before
// the next starts.
const allTestFiles = [
  ...walkTests(cloudSharedSrc, EXCLUDED_DIRS),
  ...cloudApiUnitTests,
  ...walkTests(cloudScriptsTests, EXCLUDED_DIRS),
  ...walkTests(cloudRoutingTests, EXCLUDED_DIRS),
  ...walkTests(cloudInfraTests, EXCLUDED_DIRS),
  ...cloudServicesTests,
];
if (allTestFiles.length === 0) {
  console.error(
    "[test:cloud] enumerated zero test files across all roots — the gate would " +
      "silently pass. Update packages/scripts/test-cloud-run.mjs to match the layout.",
  );
  process.exit(1);
}

// Batch size bounds per-process memory; the char cap keeps each argv under
// Windows' ~8 KiB cmd.exe command-line ceiling (the spawn goes through cmd.exe
// there — `shell: true` below — to resolve bun's `.cmd` shim). Whichever limit
// a file hits first closes the current batch.
const MAX_FILES_PER_BATCH = 80;
const MAX_ARGS_CHARS = process.platform === "win32" ? 6000 : 100000;
function chunkByBudget(files) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const file of files) {
    const cost = file.length + 1;
    if (
      current.length > 0 &&
      (current.length >= MAX_FILES_PER_BATCH || chars + cost > MAX_ARGS_CHARS)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(file);
    chars += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
const batches = chunkByBudget(allTestFiles);

function formatBatchFiles(batch) {
  return batch.map((file) => `  - ${path.relative(repoRoot, file)}`).join("\n");
}

let anyFailed = false;
for (let i = 0; i < batches.length; i++) {
  const batch = batches[i];
  console.log(
    `[test:cloud] batch ${i + 1}/${batches.length} — ${batch.length} files`,
  );
  const result = spawnSync(
    "bun",
    ["test", ...batch, "--timeout", "120000", "--isolate"],
    {
      cwd: stagingDir,
      env,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  // Run every batch even after a failure so one broken suite doesn't mask the
  // rest; aggregate into a single non-zero exit for the gate.
  const status = result.status;
  const signal = result.signal;
  if ((status ?? 1) !== 0 || signal) {
    if (shouldNormalizeBunStatus99({ status, signal, output })) {
      console.warn(
        `[test:cloud] batch ${i + 1}/${batches.length} exited with Bun status ${status} ` +
          "after reporting no failed tests; treating as pass (known Bun/PGlite exitCode pollution).",
      );
      continue;
    }
    anyFailed = true;
    console.error(
      `[test:cloud] batch ${i + 1}/${batches.length} exited non-zero ` +
        `(status=${status ?? "null"}, signal=${signal ?? "none"})\n` +
        `[test:cloud] files in failed batch:\n${formatBatchFiles(batch)}`,
    );
  }
}

process.exit(anyFailed ? 1 : 0);
