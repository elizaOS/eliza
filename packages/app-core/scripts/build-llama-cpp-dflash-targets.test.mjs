import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it as test } from "vitest";

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "build-llama-cpp-dflash.mjs",
);

function runDflashBuild(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
  });
}

test("help advertises linux aarch64 CUDA fused but not mobile fused targets", () => {
  const result = runDflashBuild(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /linux-aarch64-cuda-fused/);
  assert.doesNotMatch(result.stdout, /android-arm64-cpu-fused/);
  assert.doesNotMatch(result.stdout, /android-x86_64-cpu-fused/);
  assert.doesNotMatch(result.stdout, /ios-arm64-metal-fused/);
});

test("mobile fused targets fail closed with explicit diagnostics", () => {
  const cases = [
    ["android-arm64-cpu-fused", /Android fused FFI is not wired/],
    ["android-arm64-vulkan-fused", /Android fused FFI is not wired/],
    ["android-x86_64-cpu-fused", /Android x86_64 fused FFI is not a dflash target/],
    ["android-x86_64-vulkan-fused", /Android x86_64 fused FFI is not a dflash target/],
    ["ios-arm64-metal-fused", /iOS fused FFI is not wired or verifier-covered/],
  ];

  for (const [target, pattern] of cases) {
    const result = runDflashBuild(["--target", target, "--dry-run"]);
    assert.notEqual(result.status, 0, `expected ${target} to fail`);
    assert.match(result.stderr, pattern, result.stderr);
    assert.match(result.stderr, new RegExp(target), result.stderr);
  }
});
