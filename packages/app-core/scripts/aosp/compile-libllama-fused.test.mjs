// Tests for the omnivoice-fused wiring in `compile-libllama.mjs`. The
// production wiring runs zig + the Android NDK; these tests stay
// dry-run-only so they pass on a CI box without those toolchains. End-to-end
// hardware coverage is described in
// `packages/inference/reports/porting/2026-05-12/remaining-work-ledger.md`.
//
// See `packages/app-core/scripts/aosp/compile-libllama.mjs` for the
// wiring itself.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ABI_TARGETS,
  describeAndroidTargetDryRun,
  FUSED_ANDROID_TARGETS,
  parseAndroidTarget,
  parseArgs,
} from "./compile-libllama.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, "compile-libllama.mjs");

test("parseAndroidTarget accepts the four fused android targets", () => {
  for (const target of FUSED_ANDROID_TARGETS) {
    const parsed = parseAndroidTarget(target);
    assert.equal(parsed.fused, true);
    assert.equal(parsed.target, target);
    assert.ok(["arm64-v8a", "x86_64"].includes(parsed.androidAbi));
    assert.ok(["cpu", "vulkan"].includes(parsed.backend));
  }
});

test("parseAndroidTarget accepts the four non-fused android targets", () => {
  for (const target of [
    "android-arm64-cpu",
    "android-arm64-vulkan",
    "android-x86_64-cpu",
    "android-x86_64-vulkan",
  ]) {
    const parsed = parseAndroidTarget(target);
    assert.equal(parsed.fused, false);
    assert.equal(parsed.target, target);
  }
});

test("parseAndroidTarget rejects desktop/server fused targets", () => {
  for (const target of [
    "linux-x64-cpu-fused",
    "darwin-arm64-metal-fused",
    "windows-x64-cuda-fused",
    "android-arm64-metal-fused", // metal isn't an android backend
    "android-x86_64-cuda", // no cuda on android
  ]) {
    assert.throws(
      () => parseAndroidTarget(target),
      /unsupported --target/,
      `should reject ${target}`,
    );
  }
});

test("parseArgs accepts --target + --dry-run flags", () => {
  const args = parseArgs([
    "--target",
    "android-x86_64-cpu-fused",
    "--dry-run",
    "--jobs",
    "2",
  ]);
  assert.equal(args.targets.length, 1);
  assert.equal(args.targets[0].target, "android-x86_64-cpu-fused");
  assert.equal(args.targets[0].fused, true);
  assert.equal(args.targets[0].androidAbi, "x86_64");
  assert.equal(args.dryRun, true);
  assert.equal(args.jobs, 2);
});

test("parseArgs accepts multiple --target invocations", () => {
  const args = parseArgs([
    "--target",
    "android-arm64-cpu-fused",
    "--target",
    "android-x86_64-vulkan-fused",
    "--dry-run",
  ]);
  assert.equal(args.targets.length, 2);
  assert.deepEqual(
    args.targets.map((t) => t.target),
    ["android-arm64-cpu-fused", "android-x86_64-vulkan-fused"],
  );
});

test("describeAndroidTargetDryRun emits cmake + graft + verify lines for fused targets", () => {
  const lines = [];
  const log = (line) => lines.push(line);
  describeAndroidTargetDryRun({
    target: "android-x86_64-cpu-fused",
    srcDir: "/tmp/llama.cpp",
    cacheDir: "/tmp/cache",
    abiAssetDir: "/tmp/assets/x86_64",
    jobs: 4,
    log,
  });
  const text = lines.join("\n");
  // The graft block must be described.
  assert.ok(text.includes("graft:"), "missing graft: header");
  assert.ok(
    text.includes("prepareOmnivoiceFusion"),
    "missing prepareOmnivoiceFusion step",
  );
  assert.ok(text.includes("appendCmakeGraft"), "missing appendCmakeGraft step");
  // The cmake invocation must carry the fused flag.
  assert.ok(
    text.includes("-DELIZA_FUSE_OMNIVOICE=ON"),
    "fused cmake flag not present",
  );
  // The build target list must include omnivoice-core + elizainference.
  assert.ok(
    text.includes("omnivoice-core"),
    "omnivoice-core build target missing",
  );
  assert.ok(
    text.includes("elizainference"),
    "elizainference build target missing",
  );
  // Post-build verify step must be referenced.
  assert.ok(
    text.includes("verifyFusedSymbols"),
    "missing verifyFusedSymbols step",
  );
  assert.ok(
    text.includes("libelizainference.so"),
    "expected output layout missing libelizainference.so",
  );
});

test("describeAndroidTargetDryRun does NOT emit fused/graft lines for non-fused targets", () => {
  const lines = [];
  describeAndroidTargetDryRun({
    target: "android-arm64-cpu",
    srcDir: "/tmp/llama.cpp",
    cacheDir: "/tmp/cache",
    abiAssetDir: "/tmp/assets/arm64-v8a",
    jobs: 4,
    log: (line) => lines.push(line),
  });
  const text = lines.join("\n");
  assert.ok(!text.includes("graft:"), "non-fused dry-run leaked graft block");
  assert.ok(
    !text.includes("-DELIZA_FUSE_OMNIVOICE"),
    "non-fused dry-run leaked fused cmake flag",
  );
  assert.ok(
    !text.includes("verifyFusedSymbols"),
    "non-fused dry-run leaked verify-symbols step",
  );
  // Non-fused build target list = llama + llama-server only.
  assert.ok(
    text.includes("--target llama llama-server"),
    "non-fused build-target list wrong",
  );
});

test("ABI_TARGETS still carries the two canonical ABIs", () => {
  assert.equal(ABI_TARGETS.length, 2);
  assert.deepEqual(ABI_TARGETS.map((t) => t.androidAbi).sort(), [
    "arm64-v8a",
    "x86_64",
  ]);
});

// End-to-end smoke through the actual CLI entry. Spawns `node
// compile-libllama.mjs --target ... --dry-run` and asserts the printed plan
// matches the wiring contract.
test("CLI --target ... --dry-run produces a plan that mentions cmake, the graft, and verify-symbols (fused target)", () => {
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`compile-libllama.mjs not found at ${scriptPath}`);
  }
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--target",
      "android-x86_64-cpu-fused",
      "--dry-run",
      "--jobs",
      "2",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(
    result.status,
    0,
    `CLI exited ${result.status} stdout=${result.stdout} stderr=${result.stderr}`,
  );
  const out = result.stdout;
  assert.ok(out.includes("(dry-run) target=android-x86_64-cpu-fused"));
  assert.ok(out.includes("prepareOmnivoiceFusion"));
  assert.ok(out.includes("appendCmakeGraft"));
  assert.ok(out.includes("-DELIZA_FUSE_OMNIVOICE=ON"));
  assert.ok(out.includes("elizainference"));
  assert.ok(out.includes("verifyFusedSymbols"));
  assert.ok(out.includes("plan complete: 1 target(s)"));
});

test("CLI --target rejects desktop targets with a hard error", () => {
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--target", "linux-x64-cpu-fused", "--dry-run"],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.notEqual(result.status, 0);
  assert.ok(
    /unsupported --target linux-x64-cpu-fused/.test(result.stderr) ||
      /unsupported --target linux-x64-cpu-fused/.test(result.stdout),
    `expected hard error; got stderr=${result.stderr}`,
  );
});
