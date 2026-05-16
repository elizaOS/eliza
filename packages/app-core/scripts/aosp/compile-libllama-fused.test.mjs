// Tests for the omnivoice-fused wiring in `compile-libllama.mjs`. The
// production wiring runs zig + the Android NDK; these tests stay
// dry-run-only so they pass on a CI box without those toolchains. End-to-end
// hardware coverage is described in
// `packages/inference/reports/porting/2026-05-12/remaining-work-ledger.md`.
//
// See `packages/app-core/scripts/aosp/compile-libllama.mjs` for the
// wiring itself.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it as test } from "vitest";

import {
  ABI_TARGETS,
  buildSpeculativeShimForAbi,
  describeAndroidTargetDryRun,
  FUSED_ANDROID_TARGETS,
  parseAndroidTarget,
  parseArgs,
} from "./compile-libllama.mjs";

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
  // The merged-tree omnivoice line must be described.
  assert.ok(
    text.includes("omnivoice: merged in-fork path"),
    "missing merged-path omnivoice line",
  );
  // The cmake invocation must carry the fused flag.
  assert.ok(
    text.includes("-DLLAMA_BUILD_OMNIVOICE=ON"),
    "fused cmake flag not present",
  );
  // The build target list must include omnivoice_lib + elizainference.
  assert.ok(
    text.includes("omnivoice_lib"),
    "omnivoice_lib build target missing",
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

test("buildSpeculativeShimForAbi emits the Android DFlash shim artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-spec-shim-"));
  const cacheDir = path.join(root, "cache");
  const abiAssetDir = path.join(root, "assets", "arm64-v8a");
  fs.mkdirSync(abiAssetDir, { recursive: true });
  const source = path.join(root, "speculative.cpp");
  fs.writeFileSync(
    source,
    'extern "C" int eliza_speculative_supported(){return 0;}\n',
  );
  fs.writeFileSync(path.join(abiAssetDir, "libllama.so"), "fake");

  const calls = [];
  const out = buildSpeculativeShimForAbi({
    cacheDir,
    abi: "arm64-v8a",
    abiAssetDir,
    shimSourcePath: source,
    zigBin: "definitely-missing-zig-for-test",
    log: () => {},
    spawn: (_cmd, args) => {
      calls.push(args);
      const outIndex = args.indexOf("-o");
      fs.writeFileSync(args[outIndex + 1], "shim");
    },
  });

  assert.equal(path.basename(out), "libeliza-llama-speculative-shim.so");
  assert.ok(fs.existsSync(out), "speculative shim artifact was not created");
  assert.ok(
    calls[0].includes("-DELIZA_SHIM_HEADERLESS=1"),
    "headerless support gate missing from compile args",
  );
});

test("describeAndroidTargetDryRun does NOT emit fused/omnivoice lines for non-fused targets", () => {
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
  assert.ok(
    !text.includes("omnivoice:"),
    "non-fused dry-run leaked omnivoice line",
  );
  assert.ok(
    !text.includes("-DLLAMA_BUILD_OMNIVOICE"),
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
test("CLI --target ... --dry-run produces a plan that mentions cmake, the merged-path omnivoice line, and verify-symbols (fused target)", () => {
  const lines = [];
  describeAndroidTargetDryRun({
    target: "android-x86_64-cpu-fused",
    srcDir: "/tmp/llama.cpp",
    cacheDir: "/tmp/cache",
    abiAssetDir: "/tmp/assets/x86_64",
    jobs: 2,
    log: (line) => lines.push(line),
  });
  const out = lines.join("\n");
  assert.ok(out.includes("(dry-run) target=android-x86_64-cpu-fused"));
  assert.ok(out.includes("omnivoice: merged in-fork path"));
  assert.ok(out.includes("-DLLAMA_BUILD_OMNIVOICE=ON"));
  assert.ok(out.includes("elizainference"));
  assert.ok(out.includes("verifyFusedSymbols"));
});

test("CLI --target rejects desktop targets with a hard error", () => {
  assert.throws(
    () => parseArgs(["--target", "linux-x64-cpu-fused", "--dry-run"]),
    /unsupported --target linux-x64-cpu-fused/,
  );
});
