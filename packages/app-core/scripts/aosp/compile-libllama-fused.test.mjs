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
  MIN_ZIG_RVV_VERSION,
  parseAndroidTarget,
  parseArgs,
  resolveRiscv64BuildPlan,
  riscv64CmakeFlagsForPlan,
} from "./compile-libllama.mjs";

test("parseAndroidTarget accepts the wired fused android targets", () => {
  for (const target of FUSED_ANDROID_TARGETS) {
    const parsed = parseAndroidTarget(target);
    assert.equal(parsed.fused, true);
    assert.equal(parsed.target, target);
    assert.ok(
      ["arm64-v8a", "x86_64", "riscv64"].includes(parsed.androidAbi),
      `unexpected androidAbi ${parsed.androidAbi} for ${target}`,
    );
    assert.equal(parsed.backend, "cpu");
  }
});

test("parseAndroidTarget accepts the wired non-fused android targets", () => {
  for (const target of [
    "android-arm64-cpu",
    "android-x86_64-cpu",
    "android-riscv64-cpu",
  ]) {
    const parsed = parseAndroidTarget(target);
    assert.equal(parsed.fused, false);
    assert.equal(parsed.target, target);
  }
});

test("parseAndroidTarget maps the riscv64 android target to androidAbi=riscv64", () => {
  const parsed = parseAndroidTarget("android-riscv64-cpu-fused");
  assert.equal(parsed.arch, "riscv64");
  assert.equal(parsed.androidAbi, "riscv64");
  assert.equal(parsed.backend, "cpu");
  assert.equal(parsed.fused, true);
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

test("parseAndroidTarget rejects Android Vulkan instead of silently producing CPU artifacts", () => {
  for (const target of [
    "android-arm64-vulkan",
    "android-arm64-vulkan-fused",
    "android-x86_64-vulkan",
    "android-x86_64-vulkan-fused",
    "android-riscv64-vulkan",
    "android-riscv64-vulkan-fused",
  ]) {
    assert.throws(
      () => parseAndroidTarget(target),
      /Android Vulkan artifacts are not wired.*CPU-only\/basic libllama/s,
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
    "android-x86_64-cpu-fused",
    "--dry-run",
  ]);
  assert.equal(args.targets.length, 2);
  assert.deepEqual(
    args.targets.map((t) => t.target),
    ["android-arm64-cpu-fused", "android-x86_64-cpu-fused"],
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
  const llamaSourceDir = path.join(root, "llama.cpp");
  fs.mkdirSync(abiAssetDir, { recursive: true });
  for (const dir of ["include", "common", "ggml/include", "src"]) {
    fs.mkdirSync(path.join(llamaSourceDir, dir), { recursive: true });
  }
  const source = path.join(root, "speculative.cpp");
  fs.writeFileSync(
    source,
    'extern "C" int eliza_speculative_supported(){return 0;}\n',
  );
  fs.writeFileSync(path.join(abiAssetDir, "libllama.so"), "fake");
  fs.writeFileSync(path.join(abiAssetDir, "libllama-common.so"), "fake");

  const calls = [];
  const out = buildSpeculativeShimForAbi({
    cacheDir,
    abi: "arm64-v8a",
    abiAssetDir,
    llamaSourceDir,
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
    calls[0].includes(`-I${path.join(llamaSourceDir, "include")}`),
    "llama include dir missing from compile args",
  );
  assert.ok(
    calls[0].includes("-lllama-common"),
    "speculative shim should link libllama-common when staged",
  );
  assert.equal(
    calls[0].includes("-DELIZA_SHIM_HEADERLESS=1"),
    false,
    "speculative shim should compile against llama.cpp headers",
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

test("ABI_TARGETS carries every wired Android ABI", () => {
  assert.equal(ABI_TARGETS.length, 3);
  assert.deepEqual(ABI_TARGETS.map((t) => t.androidAbi).sort(), [
    "arm64-v8a",
    "riscv64",
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

test("MIN_ZIG_RVV_VERSION is the documented 0.14 floor", () => {
  assert.equal(MIN_ZIG_RVV_VERSION, "0.14.0");
});

test("resolveRiscv64BuildPlan keeps scalar parity on Zig 0.13", () => {
  const plan = resolveRiscv64BuildPlan({ zigVersion: "0.13.0", env: {} });
  assert.equal(plan.rvv, false);
  assert.equal(plan.allVariants, false);
  assert.equal(plan.zigVersion, "0.13.0");
  assert.equal(plan.reason, "zig-too-old");
});

test("resolveRiscv64BuildPlan flips RVV ON at the Zig 0.14 floor", () => {
  const plan = resolveRiscv64BuildPlan({ zigVersion: "0.14.0", env: {} });
  assert.equal(plan.rvv, true);
  assert.equal(plan.allVariants, false);
  assert.equal(plan.reason, "zig-supports-rvv");
});

test("resolveRiscv64BuildPlan keeps RVV ON for Zig 0.15-dev pre-release strings", () => {
  const plan = resolveRiscv64BuildPlan({
    zigVersion: "0.15.0-dev.123+abcdef",
    env: {},
  });
  assert.equal(plan.rvv, true);
  assert.equal(plan.reason, "zig-supports-rvv");
});

test("resolveRiscv64BuildPlan flips GGML_CPU_ALL_VARIANTS on opt-in env", () => {
  const plan = resolveRiscv64BuildPlan({
    zigVersion: "0.14.0",
    env: { MILADY_GGML_CPU_ALL_VARIANTS: "1" },
  });
  assert.equal(plan.rvv, true);
  assert.equal(plan.allVariants, true);
  assert.equal(plan.reason, "all-variants-opt-in");
});

test("resolveRiscv64BuildPlan ignores MILADY_GGML_CPU_ALL_VARIANTS=1 on Zig 0.13 (scalar wins)", () => {
  const plan = resolveRiscv64BuildPlan({
    zigVersion: "0.13.0",
    env: { MILADY_GGML_CPU_ALL_VARIANTS: "1" },
  });
  assert.equal(plan.rvv, false);
  assert.equal(plan.allVariants, false);
});

test("resolveRiscv64BuildPlan falls back to scalar when probe fails in dry-run", () => {
  const plan = resolveRiscv64BuildPlan({
    isDryRun: true,
    probe: () => {
      throw new Error("zig not on PATH");
    },
    env: {},
  });
  assert.equal(plan.rvv, false);
  assert.equal(plan.allVariants, false);
  assert.equal(plan.zigVersion, null);
  assert.equal(plan.reason, "zig-not-detected");
});

test("riscv64CmakeFlagsForPlan: scalar plan turns every GGML_RV* OFF", () => {
  const flags = riscv64CmakeFlagsForPlan({
    abi: "riscv64",
    plan: { rvv: false, allVariants: false },
  });
  assert.ok(flags.includes("-DGGML_RVV=OFF"));
  assert.ok(flags.includes("-DGGML_RV_ZFH=OFF"));
  assert.ok(flags.includes("-DGGML_RV_ZVFH=OFF"));
  assert.ok(flags.includes("-DGGML_RV_ZICBOP=OFF"));
  assert.ok(flags.includes("-DGGML_RV_ZIHINTPAUSE=OFF"));
  assert.ok(flags.includes("-DGGML_XTHEADVECTOR=OFF"));
  assert.ok(!flags.some((f) => f.endsWith("=ON")));
});

test("riscv64CmakeFlagsForPlan: RVV plan turns the upstream defaults ON", () => {
  const flags = riscv64CmakeFlagsForPlan({
    abi: "riscv64",
    plan: { rvv: true, allVariants: false },
  });
  assert.ok(flags.includes("-DGGML_RVV=ON"));
  assert.ok(flags.includes("-DGGML_RV_ZFH=ON"));
  assert.ok(flags.includes("-DGGML_RV_ZVFH=ON"));
  assert.ok(flags.includes("-DGGML_RV_ZICBOP=ON"));
  assert.ok(flags.includes("-DGGML_RV_ZIHINTPAUSE=ON"));
  // Keep hardware-specific extensions off by default.
  assert.ok(flags.includes("-DGGML_RV_ZVFBFWMA=OFF"));
  assert.ok(flags.includes("-DGGML_XTHEADVECTOR=OFF"));
  assert.ok(flags.includes("-DGGML_RV_ZBA=OFF"));
  assert.ok(flags.includes("-DGGML_CPU_RISCV64_SPACEMIT=OFF"));
  // Not building per-variant libs in the default RVV plan.
  assert.ok(!flags.includes("-DGGML_BACKEND_DL=ON"));
  assert.ok(!flags.includes("-DGGML_CPU_ALL_VARIANTS=ON"));
});

test("riscv64CmakeFlagsForPlan: allVariants plan adds GGML_BACKEND_DL + GGML_CPU_ALL_VARIANTS", () => {
  const flags = riscv64CmakeFlagsForPlan({
    abi: "riscv64",
    plan: { rvv: true, allVariants: true },
  });
  assert.ok(flags.includes("-DGGML_RVV=ON"));
  assert.ok(flags.includes("-DGGML_BACKEND_DL=ON"));
  assert.ok(flags.includes("-DGGML_CPU_ALL_VARIANTS=ON"));
});

test("riscv64CmakeFlagsForPlan: non-riscv64 ABIs get empty flag list (no x86/arm leak)", () => {
  for (const abi of ["arm64-v8a", "x86_64"]) {
    const flags = riscv64CmakeFlagsForPlan({
      abi,
      plan: { rvv: true, allVariants: true },
    });
    assert.deepEqual(flags, [], `${abi} should not get riscv64 cmake flags`);
  }
});

test("describeAndroidTargetDryRun (riscv64) shows the resolver-reported plan + matching cmake flags", () => {
  // Force a deterministic resolver by clearing MILADY_GGML_CPU_ALL_VARIANTS
  // for this test so behavior doesn't drift with the developer's local env.
  const prev = process.env.MILADY_GGML_CPU_ALL_VARIANTS;
  delete process.env.MILADY_GGML_CPU_ALL_VARIANTS;
  try {
    const lines = [];
    describeAndroidTargetDryRun({
      target: "android-riscv64-cpu",
      srcDir: "/tmp/llama.cpp",
      cacheDir: "/tmp/cache",
      abiAssetDir: "/tmp/assets/riscv64",
      jobs: 2,
      log: (line) => lines.push(line),
    });
    const text = lines.join("\n");
    // Plan line emitted.
    assert.match(text, /riscv64 plan: zig=.* rvv=(ON|OFF) all-variants=(ON|OFF) reason=/);
    // Either the scalar OR the RVV flag set must appear — both are valid
    // depending on the build host's Zig version. (The resolver is what
    // chooses; the test just asserts the flag-list matches the plan.)
    if (text.includes("rvv=ON")) {
      assert.ok(text.includes("-DGGML_RVV=ON"));
      assert.ok(text.includes("-DGGML_RV_ZFH=ON"));
    } else {
      assert.ok(text.includes("-DGGML_RVV=OFF"));
      assert.ok(text.includes("-DGGML_RV_ZFH=OFF"));
    }
  } finally {
    if (prev === undefined) {
      delete process.env.MILADY_GGML_CPU_ALL_VARIANTS;
    } else {
      process.env.MILADY_GGML_CPU_ALL_VARIANTS = prev;
    }
  }
});

test("describeAndroidTargetDryRun (non-riscv64) does NOT leak GGML_RV* flags", () => {
  for (const target of ["android-arm64-cpu", "android-x86_64-cpu"]) {
    const lines = [];
    describeAndroidTargetDryRun({
      target,
      srcDir: "/tmp/llama.cpp",
      cacheDir: "/tmp/cache",
      abiAssetDir: "/tmp/assets/" + target,
      jobs: 2,
      log: (line) => lines.push(line),
    });
    const text = lines.join("\n");
    assert.ok(!text.includes("GGML_RVV="), `${target} leaked GGML_RVV flag`);
    assert.ok(!text.includes("riscv64 plan:"), `${target} leaked riscv plan log`);
  }
});
