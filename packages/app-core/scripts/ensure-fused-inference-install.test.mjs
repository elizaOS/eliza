/** Verifies app-core's install-time fused setup initializes and stages the source-owned build path. */

import assert from "node:assert/strict";
import test from "node:test";
import { ensureFusedInferenceInstall } from "./ensure-fused-inference-install.mjs";

test("a normal install initializes the pinned source and ensures the fused library", () => {
  const calls = [];
  const result = ensureFusedInferenceInstall({
    env: {},
    platform: "linux",
    repoRoot: "/repo",
    bunExecutable: "/bun",
    provision: false,
    run(command, args, options) {
      calls.push({ command, args, options });
    },
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(calls[0], {
    command: "git",
    args: [
      "submodule",
      "update",
      "--init",
      "--recursive",
      "plugins/plugin-local-inference/native/llama.cpp",
    ],
    options: { cwd: "/repo" },
  });
  assert.deepEqual(calls[1], {
    command: "/bun",
    args: [
      "/repo/packages/app-core/scripts/stage-desktop-fused-lib.mjs",
      "--ensure",
    ],
    options: { cwd: "/repo", env: {} },
  });
});

test("CI is not an implicit escape hatch", () => {
  const calls = [];
  const result = ensureFusedInferenceInstall({
    env: { CI: "true" },
    platform: "linux",
    repoRoot: "/repo",
    bunExecutable: "/bun",
    provision: false,
    run(command, args) {
      calls.push([command, ...args]);
    },
  });

  assert.equal(result.status, "ready");
  assert.equal(calls.length, 2);
});

test("missing Linux prerequisites are provisioned before the native build", () => {
  const events = [];
  ensureFusedInferenceInstall({
    env: {},
    platform: "linux",
    repoRoot: "/repo",
    bunExecutable: "/bun",
    findLinuxPackages: () => ["cmake", "build-essential"],
    provisionLinux(packages) {
      events.push(["provision", ...packages]);
    },
    run(command) {
      events.push(["run", command]);
    },
  });

  assert.deepEqual(events, [
    ["run", "git"],
    ["provision", "cmake", "build-essential"],
    ["run", "/bun"],
  ]);
});

test("the explicit emergency escape hatch performs no native mutations", () => {
  let called = false;
  const result = ensureFusedInferenceInstall({
    env: { ELIZA_SKIP_FUSED_INFERENCE_SETUP: "1" },
    run() {
      called = true;
    },
  });

  assert.equal(result.status, "skipped");
  assert.equal(called, false);
});
