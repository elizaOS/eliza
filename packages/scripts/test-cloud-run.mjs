#!/usr/bin/env node

// Cross-platform replacement for the previous `test:cloud` shell pipeline,
// which used `printf '...\n'` (broken under bun's embedded shell on Windows
// — outputs literal `n` instead of newlines) and required POSIX-shell
// `$OLDPWD` semantics.
//
// The pure helpers below (walkTests, chunkByBudget, formatBatchFiles,
// writeSyncAll, ensureCloudTestRuntime) are exported so
// test-cloud-run.test.mjs and the *.self-test.mjs files can exercise them
// directly; the batch-orchestration side effects (spawning `bun test`,
// writing bunfig.toml, building missing runtime artifacts) only run when this
// file is invoked as the entry script, guarded by the `main()` call at the
// bottom.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shouldNormalizeBunStatus99 } from "./test-cloud-run-helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const stagingDir = path.join(repoRoot, ".tmp", "cloud-unit-bun");

// `test/` is the api e2e harness (own `test:e2e` lane + a live server); the
// rest is build output / vendored deps that carry no unit lane.
export const EXCLUDED_API_DIRS = new Set([
  "test",
  "node_modules",
  "dist",
  ".turbo",
]);
// Vendored deps and build output under any non-api root: never a unit target.
export const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".turbo"]);

export function walkTests(dir, excluded) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (excluded.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTests(full, excluded));
    else if (/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// Batch size bounds per-process memory; the char cap keeps each argv under
// Windows' ~8 KiB cmd.exe command-line ceiling (the spawn goes through cmd.exe
// there — `shell: true` below — to resolve bun's `.cmd` shim). Whichever limit
// a file hits first closes the current batch.
export const MAX_FILES_PER_BATCH = 80;
export const MAX_ARGS_CHARS_WIN32 = 6000;
export const MAX_ARGS_CHARS_POSIX = 100000;

export function chunkByBudget(files, maxFilesPerBatch, maxArgsChars) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const file of files) {
    const cost = file.length + 1;
    if (
      current.length > 0 &&
      (current.length >= maxFilesPerBatch || chars + cost > maxArgsChars)
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

export function formatBatchFiles(batch, root) {
  return batch.map((file) => `  - ${path.relative(root, file)}`).join("\n");
}

// Write straight to the stdout/stderr file descriptors. `process.stdout.write`
// buffers asynchronously when the sink is a back-pressured pipe (the GitHub
// Actions log collector is exactly that): each per-batch `bun test` dump queues
// in Node's internal stream buffer, the synchronous `spawnSync` loop never
// yields to drain it, and the final `process.exit()` then discards every
// un-flushed byte. That silently swallowed the batch-10 failure diagnostic AND
// the earlier batches' summaries, surfacing as a bare `exited with code 1` with
// no reported failing test. `fs.writeSync` blocks until the bytes hit the fd,
// so nothing can be truncated by exit. Retry on EAGAIN for non-blocking fds.
export function writeSyncAll(fd, text) {
  if (!text) return;
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (error) {
      if (error && error.code === "EAGAIN") continue;
      throw error;
    }
  }
}

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
export function buildTestEnv(baseEnv) {
  return {
    ...baseEnv,
    DATABASE_URL: "pglite://memory",
    TEST_DATABASE_URL: "pglite://memory",
    SKIP_DB_DEPENDENT: "1",
    SKIP_SERVER_CHECK: "true",
  };
}

// NOTE: keep in sync with the package layout. The #9917 reorg moved these from
// packages/cloud-shared -> packages/cloud/shared and packages/cloud-api ->
// packages/cloud/api; the stale paths made `bun test` target nonexistent dirs,
// so the cloud unit suite (incl. the IAC inference hot-path tests) silently ran
// nothing = false-green gate. cloud-tests.yml already triggers on
// `packages/scripts/cloud/**` and `packages/cloud/services/**`; the routing
// (model-routing resolver) and infra (IaC / static-config) packages carry
// pure, DB-free unit suites that ran on no PR lane until they were added here
// alongside the cloud-tests.yml `paths:` update.
export function computeTestRoots(root) {
  return {
    cloudSharedSrc: path.join(root, "packages", "cloud", "shared", "src"),
    cloudApiRoot: path.join(root, "packages", "cloud", "api"),
    cloudScriptsTests: path.join(root, "packages", "scripts", "cloud"),
    cloudRoutingTests: path.join(root, "packages", "cloud", "routing", "src"),
    cloudInfraTests: path.join(root, "packages", "cloud", "infra", "tests"),
    cloudServicesRoot: path.join(root, "packages", "cloud", "services"),
  };
}

// `bun test <nonexistent-dir>` exits 0 with no tests run, so a stale path
// (e.g. after a package move) would turn this gate into a silent false-green.
// Injectable `existsFn` lets the check run against a real or a fake filesystem.
export function findMissingRoots(testRoots, existsFn) {
  return Object.entries(testRoots)
    .filter(([, dir]) => !existsFn(dir))
    .map(([name, dir]) => `${name} -> ${dir}`);
}

// --- Clean-install preflight (#16187) ---
//
// A frozen `bun install` with ELIZA_SKIP_ARTIFACT_SYNC=1 leaves the tree with
// no built dist/ and no generated i18n keyword modules. The cloud suites
// resolve `@elizaos/core` through its package.json `bun` export condition
// (packages/core/dist/node/index.node.js) and import the gitignored keyword
// modules from source, so without these artifacts every DB/service batch dies
// in `Cannot find module` cascades that read like hundreds of regressions
// instead of one missing prerequisite. The keyword modules are tracked
// separately from the dist because turbo's `build` task caches `dist/**`
// only: a cache hit can restore core's dist without ever running the codegen
// that emits them (core's prebuild generates keywords only on a real build).
//
// Only the artifacts this lane's import graph actually resolves are listed —
// `@elizaos/core` is the sole dist-resolved workspace package in the cloud
// test graph (everything else resolves from source) — so a fully built tree
// pays four existsSync calls and nothing more.
export function computeRequiredRuntimeArtifacts(root) {
  return {
    keywordCodegen: [
      path.join(
        root,
        "packages",
        "shared",
        "src",
        "i18n",
        "generated",
        "validation-keyword-data.ts",
      ),
      path.join(
        root,
        "packages",
        "shared",
        "src",
        "i18n",
        "generated",
        "validation-keyword-data.js",
      ),
      path.join(
        root,
        "packages",
        "core",
        "src",
        "i18n",
        "generated",
        "validation-keyword-data.ts",
      ),
    ],
    coreBuild: [
      path.join(root, "packages", "core", "dist", "node", "index.node.js"),
    ],
  };
}

// Each step is the same standard mechanism CI already uses: the keyword
// codegen is what packages/shared's `build:i18n` and packages/core's prebuild
// invoke, and build-core.mjs is the root `bun run build:core` — the exact
// prerequisite the other root test lanes (test:server/client/plugins) and the
// cloud-tests workflow's cloud-setup-test-env action run.
export const PREFLIGHT_STEPS = {
  keywordCodegen: {
    label: "i18n keyword codegen (generate-keywords.mjs)",
    script: ["packages", "shared", "scripts", "generate-keywords.mjs"],
  },
  coreBuild: {
    label: "core workspace build (build:core)",
    script: ["packages", "scripts", "build-core.mjs"],
  },
};

// `spawnFn` is injected so the failure contract (loud throw naming the step,
// its exit code/signal, and how to re-run) is testable without a real build.
export function runPreflightStep(step, { repoRoot: root, spawnFn }) {
  const scriptPath = path.join(root, ...step.script);
  const result = spawnFn(process.execPath, [scriptPath], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(
      `[test:cloud] could not start ${step.label} (${scriptPath}): ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const cause =
      result.status === null || result.status === undefined
        ? `signal ${result.signal}`
        : `exit ${result.status}`;
    throw new Error(
      `[test:cloud] ${step.label} failed (${cause}). The cloud suites cannot ` +
        `run without it — fix the failure above and re-run: bun run test:cloud`,
    );
  }
}

// For each step whose artifacts are missing, run the step, then re-check and
// fail loudly if the step "succeeded" without producing them (e.g. a remedy
// script whose output paths drifted from this list). Never proceeds into the
// batches with a known-broken runtime: that is exactly the failure mode this
// preflight exists to prevent.
export function ensureCloudTestRuntime({
  requiredArtifacts,
  steps,
  existsFn,
  runStep,
  log,
}) {
  for (const [stepName, artifacts] of Object.entries(requiredArtifacts)) {
    const missing = artifacts.filter((file) => !existsFn(file));
    if (missing.length === 0) continue;
    const step = steps[stepName];
    if (!step) {
      throw new Error(
        `[test:cloud] no preflight step named "${stepName}" — keep ` +
          "computeRequiredRuntimeArtifacts and PREFLIGHT_STEPS key-aligned in " +
          "packages/scripts/test-cloud-run.mjs.",
      );
    }
    log(
      "[test:cloud] missing runtime artifact(s) (clean install without artifact sync?):\n" +
        `${missing.map((file) => `  - ${file}`).join("\n")}\n` +
        `[test:cloud] running ${step.label}\n`,
    );
    runStep(step);
    const stillMissing = artifacts.filter((file) => !existsFn(file));
    if (stillMissing.length > 0) {
      throw new Error(
        `[test:cloud] ${step.label} completed but the required artifact(s) are still missing:\n` +
          `${stillMissing.map((file) => `  - ${file}`).join("\n")}\n` +
          "[test:cloud] the preflight and the build/codegen disagree about output paths — " +
          "update computeRequiredRuntimeArtifacts in packages/scripts/test-cloud-run.mjs.",
      );
    }
  }
}

// The full unit set is ~700 files. bun's `--isolate` gives each file a fresh
// global but keeps ONE process, so JS heap plus external (pglite/WASM) memory
// accumulates monotonically across the whole run — RSS climbs past 7 GB. On the
// memory-bounded self-hosted runner that tips into GC-thrash/OOM, and because
// the drizzle-kit `pushSchema` introspect ("Pulling schema from database…")
// builds large full-schema JSON snapshots, the run consistently wedged there
// and the runner reclaimed the job (SIGTERM → exit 143). Splitting the file set
// into sequential fresh `bun test` processes (runBatches below) bounds peak
// memory to one batch: each process starts cold, runs its slice, and frees
// everything on exit before the next starts.
//
// `spawnBatch` is injected so tests can drive the failure-classification logic
// (status/signal handling, the pglite status-99 normalization, spawn errors)
// without shelling out to a real `bun test` run. Returns true if any batch's
// failure should fail the overall gate.
export function runBatches(
  batches,
  { spawnBatch, stagingDir, env, repoRoot, writeOut, writeErr },
) {
  let anyFailed = false;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    writeOut(
      `[test:cloud] batch ${i + 1}/${batches.length} — ${batch.length} files\n`,
    );
    const result = spawnBatch(batch, { cwd: stagingDir, env });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.stdout) writeOut(result.stdout);
    if (result.stderr) writeErr(result.stderr);
    if (result.error) {
      // spawnSync failure (e.g. ENOBUFS from maxBuffer, spawn ENOENT). Surface it
      // and keep the exit deferred so the drained batch output is not truncated.
      writeErr(
        `[test:cloud] batch ${i + 1}/${batches.length} spawn error: ${
          result.error.stack ?? String(result.error)
        }\n`,
      );
      return true;
    }
    // Run every batch even after a failure so one broken suite doesn't mask the
    // rest; aggregate into a single non-zero exit for the gate.
    const status = result.status;
    const signal = result.signal;
    if ((status ?? 1) !== 0 || signal) {
      if (shouldNormalizeBunStatus99({ status, signal, output })) {
        writeErr(
          `[test:cloud] batch ${i + 1}/${batches.length} exited with Bun status ${status} ` +
            "after reporting no failed tests; treating as pass (known Bun/PGlite exitCode pollution).\n",
        );
        continue;
      }
      anyFailed = true;
      writeErr(
        `[test:cloud] batch ${i + 1}/${batches.length} exited non-zero ` +
          `(status=${status ?? "null"}, signal=${signal ?? "none"})\n` +
          `[test:cloud] files in failed batch:\n${formatBatchFiles(batch, repoRoot)}\n`,
      );
    }
  }
  return anyFailed;
}

function main() {
  try {
    ensureCloudTestRuntime({
      requiredArtifacts: computeRequiredRuntimeArtifacts(repoRoot),
      steps: PREFLIGHT_STEPS,
      existsFn: existsSync,
      runStep: (step) =>
        runPreflightStep(step, { repoRoot, spawnFn: spawnSync }),
      log: (text) => writeSyncAll(1, text),
    });
  } catch (error) {
    // error-policy:J1 process boundary — surface a preflight failure as one
    // loud diagnostic + non-zero exit instead of letting the batches run into
    // hundreds of misleading `Cannot find module` failures.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  mkdirSync(stagingDir, { recursive: true });

  writeFileSync(
    path.join(stagingDir, "bunfig.toml"),
    "[test]\ntimeout = 120000\ncoverage = false\n",
  );

  const env = buildTestEnv(process.env);
  const testRoots = computeTestRoots(repoRoot);
  const {
    cloudSharedSrc,
    cloudApiRoot,
    cloudScriptsTests,
    cloudRoutingTests,
    cloudInfraTests,
    cloudServicesRoot,
  } = testRoots;

  const missing = findMissingRoots(testRoots, existsSync);
  if (missing.length > 0) {
    console.error(
      `[test:cloud] test root(s) not found — the gate would silently run no tests:\n  ${missing.join("\n  ")}\n` +
        "Update packages/scripts/test-cloud-run.mjs to match the current package layout.",
    );
    process.exit(1);
  }

  // Also sweeps colocated `<resource>/route.test.ts` unit tests that live
  // OUTSIDE __tests__/ (billing, cron, credits, webhooks, …). Excludes `test/`
  // (the api e2e harness: its own `test:e2e` lane + a live server) and build
  // output.
  const cloudApiUnitTests = walkTests(cloudApiRoot, EXCLUDED_API_DIRS).sort();

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
  // this gate must break instead of silently running zero services tests. The
  // gateway suites also run in their dedicated workflows
  // (cloud-gateway-discord/-webhook); they are self-contained bun:test files,
  // so the duplicate coverage here is cheap and keeps this gate layout-proof.
  if (cloudServicesTests.length === 0) {
    console.error(
      `[test:cloud] no cloud/services tests found under ${cloudServicesRoot} — ` +
        "the gate would silently run zero services tests. Update packages/scripts/test-cloud-run.mjs " +
        "to match the current package layout.",
    );
    process.exit(1);
  }

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

  const maxArgsChars =
    process.platform === "win32" ? MAX_ARGS_CHARS_WIN32 : MAX_ARGS_CHARS_POSIX;
  const batches = chunkByBudget(
    allTestFiles,
    MAX_FILES_PER_BATCH,
    maxArgsChars,
  );

  const writeOut = (text) => writeSyncAll(1, text);
  const writeErr = (text) => writeSyncAll(2, text);

  const spawnBatch = (batch, { cwd, env: batchEnv }) =>
    spawnSync("bun", ["test", ...batch, "--timeout", "120000", "--isolate"], {
      cwd,
      env: batchEnv,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

  const anyFailed = runBatches(batches, {
    spawnBatch,
    stagingDir,
    env,
    repoRoot,
    writeOut,
    writeErr,
  });

  // Use process.exitCode + natural return instead of process.exit(): the latter
  // tears the process down before any still-queued async stdout/stderr flushes,
  // which is what erased the failure diagnostics above (#16062). All batch
  // output already went out synchronously via writeSync, so the exit code
  // alone remains here.
  if (anyFailed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
