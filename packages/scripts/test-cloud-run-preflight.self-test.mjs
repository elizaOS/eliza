#!/usr/bin/env node

// Guards the clean-install preflight in test-cloud-run.mjs (#16187).
//
// A frozen `bun install` with ELIZA_SKIP_ARTIFACT_SYNC=1 leaves no
// @elizaos/core dist and no generated i18n keyword modules, and
// `bun run test:cloud` previously started the batches anyway — 10/11 batches
// red with hundreds of `Cannot find module '@elizaos/core'` /
// `validation-keyword-data` cascades that read like database regressions
// instead of one missing prerequisite.
//
// The scenarios below execute the preflight decision logic against simulated
// filesystem states (clean install, turbo-cache-hit-without-codegen, fully
// built) and assert the loud-failure contract when a step fails or produces
// nothing. The keyword codegen step is then run FOR REAL against the repo to
// prove the preflight's artifact list matches what the script actually emits
// (its outputs are gitignored generated modules, deterministic from the
// checked-in keyword JSON, so this is safe and idempotent in any tree).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeRequiredRuntimeArtifacts,
  ensureCloudTestRuntime,
  PREFLIGHT_STEPS,
  runPreflightStep,
} from "./test-cloud-run.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function stepKey(step) {
  const entry = Object.entries(PREFLIGHT_STEPS).find(
    ([, candidate]) => candidate === step,
  );
  assert.ok(entry, `runStep received an unknown step: ${step?.label}`);
  return entry[0];
}

// --- 1. Anti-drift: every remedy script and the codegen inputs are real files,
// and the artifact map has a step for every key.
const artifacts = computeRequiredRuntimeArtifacts("/repo");
for (const key of Object.keys(artifacts)) {
  const step = PREFLIGHT_STEPS[key];
  assert.ok(step, `no PREFLIGHT_STEPS entry for artifact group "${key}"`);
  const scriptPath = path.join(repoRoot, ...step.script);
  assert.ok(
    existsSync(scriptPath),
    `preflight step script missing: ${scriptPath}`,
  );
}
const keywordsDir = path.join(
  repoRoot,
  "packages",
  "shared",
  "src",
  "i18n",
  "keywords",
);
assert.ok(
  readdirSync(keywordsDir).some((file) => file.endsWith(".keywords.json")),
  `keyword codegen inputs missing under ${keywordsDir}`,
);

// --- 2. Fully built tree: no step runs, nothing is logged.
{
  const ran = [];
  const logs = [];
  ensureCloudTestRuntime({
    requiredArtifacts: artifacts,
    steps: PREFLIGHT_STEPS,
    existsFn: () => true,
    runStep: (step) => ran.push(step.label),
    log: (text) => logs.push(text),
  });
  assert.deepEqual(ran, []);
  assert.deepEqual(logs, []);
}

// --- 3. Clean install (nothing exists): codegen runs before build:core, each
// step satisfies its own artifact group, and the missing paths are logged.
{
  const ran = [];
  const logs = [];
  const created = new Set();
  ensureCloudTestRuntime({
    requiredArtifacts: artifacts,
    steps: PREFLIGHT_STEPS,
    existsFn: (file) => created.has(file),
    runStep: (step) => {
      ran.push(step.label);
      for (const file of artifacts[stepKey(step)]) created.add(file);
    },
    log: (text) => logs.push(text),
  });
  assert.deepEqual(ran, [
    PREFLIGHT_STEPS.keywordCodegen.label,
    PREFLIGHT_STEPS.coreBuild.label,
  ]);
  const logged = logs.join("");
  assert.ok(logged.includes("missing runtime artifact"));
  assert.ok(logged.includes(artifacts.coreBuild[0]));
}

// --- 4. Turbo-cache-hit shape: dist restored from cache but the codegen never
// ran (generated keyword modules are not turbo outputs) → only codegen runs.
{
  const ran = [];
  let generated = false;
  ensureCloudTestRuntime({
    requiredArtifacts: artifacts,
    steps: PREFLIGHT_STEPS,
    existsFn: (file) => (artifacts.coreBuild.includes(file) ? true : generated),
    runStep: (step) => {
      ran.push(step.label);
      generated = true;
    },
    log: () => {},
  });
  assert.deepEqual(ran, [PREFLIGHT_STEPS.keywordCodegen.label]);
}

// --- 5. Dist missing only (keywords present): only build:core runs.
{
  const ran = [];
  let built = false;
  ensureCloudTestRuntime({
    requiredArtifacts: artifacts,
    steps: PREFLIGHT_STEPS,
    existsFn: (file) => (artifacts.coreBuild.includes(file) ? built : true),
    runStep: (step) => {
      ran.push(step.label);
      built = true;
    },
    log: () => {},
  });
  assert.deepEqual(ran, [PREFLIGHT_STEPS.coreBuild.label]);
}

// --- 6. A step that "succeeds" without producing its artifacts must fail
// loudly (path drift between the preflight list and the remedy script) —
// never proceed into the batches with a known-broken runtime.
assert.throws(
  () =>
    ensureCloudTestRuntime({
      requiredArtifacts: artifacts,
      steps: PREFLIGHT_STEPS,
      existsFn: () => false,
      runStep: () => {},
      log: () => {},
    }),
  /still missing/,
);

// --- 7. Artifact group without a matching step is a wiring error, not a skip.
assert.throws(
  () =>
    ensureCloudTestRuntime({
      requiredArtifacts: { orphanGroup: ["/repo/nope"] },
      steps: PREFLIGHT_STEPS,
      existsFn: () => false,
      runStep: () => {},
      log: () => {},
    }),
  /no preflight step named "orphanGroup"/,
);

// --- 8. runPreflightStep failure contract: loud throw naming the step and the
// exit cause; a runStep failure propagates out of ensureCloudTestRuntime.
assert.throws(
  () =>
    runPreflightStep(PREFLIGHT_STEPS.coreBuild, {
      repoRoot,
      spawnFn: () => ({ status: 1, signal: null }),
    }),
  /core workspace build \(build:core\) failed \(exit 1\)/,
);
assert.throws(
  () =>
    runPreflightStep(PREFLIGHT_STEPS.coreBuild, {
      repoRoot,
      spawnFn: () => ({ status: null, signal: "SIGTERM" }),
    }),
  /failed \(signal SIGTERM\)/,
);
assert.throws(
  () =>
    runPreflightStep(PREFLIGHT_STEPS.keywordCodegen, {
      repoRoot,
      spawnFn: () => ({
        error: new Error("spawn ENOENT"),
        status: null,
        signal: null,
      }),
    }),
  /could not start i18n keyword codegen/,
);
{
  let spawned;
  runPreflightStep(PREFLIGHT_STEPS.coreBuild, {
    repoRoot,
    spawnFn: (cmd, args, opts) => {
      spawned = { cmd, args, opts };
      return { status: 0, signal: null };
    },
  });
  assert.equal(spawned.cmd, process.execPath);
  assert.equal(
    spawned.args[0],
    path.join(repoRoot, "packages", "scripts", "build-core.mjs"),
  );
  assert.equal(spawned.opts.cwd, repoRoot);
  assert.equal(spawned.opts.stdio, "inherit");
}
assert.throws(
  () =>
    ensureCloudTestRuntime({
      requiredArtifacts: artifacts,
      steps: PREFLIGHT_STEPS,
      existsFn: () => false,
      runStep: () => {
        throw new Error("[test:cloud] simulated build failure");
      },
      log: () => {},
    }),
  /simulated build failure/,
);

// --- 9. REAL execution: run the actual keyword codegen and assert every
// keywordCodegen artifact the preflight requires now exists — if the codegen's
// output paths ever move, this fails before the preflight can silently
// mis-detect a broken tree as healthy.
{
  const real = computeRequiredRuntimeArtifacts(repoRoot);
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, ...PREFLIGHT_STEPS.keywordCodegen.script)],
    { cwd: repoRoot, stdio: "pipe", encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `keyword codegen failed:\n${result.stdout}\n${result.stderr}`,
  );
  for (const file of real.keywordCodegen) {
    assert.ok(
      existsSync(file),
      `codegen did not emit preflight-required artifact: ${file}`,
    );
  }
}

console.log("[test-cloud-run-preflight] self-test passed");
