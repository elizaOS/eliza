import assert from "node:assert/strict";
import { it as test } from "vitest";

import { formatHelpText, parseArgs } from "./build-llama-cpp-dflash.mjs";

test("help advertises supported fused targets but not mobile fused targets", () => {
  const helpText = formatHelpText();
  assert.match(helpText, /linux-aarch64-cuda-fused/);
  assert.match(helpText, /darwin-arm64-metal-fused/);
  assert.doesNotMatch(helpText, /android-arm64-cpu-fused/);
  assert.doesNotMatch(helpText, /android-x86_64-cpu-fused/);
  assert.doesNotMatch(helpText, /ios-arm64-metal-fused/);
  assert.doesNotMatch(helpText, /ios-arm64-simulator-metal-fused/);
});

test("unsupported mobile fused targets fail closed with explicit diagnostics", () => {
  const cases = [
    ["android-arm64-cpu-fused", /Android fused FFI is not wired/],
    ["android-arm64-vulkan-fused", /Android fused FFI is not wired/],
    [
      "android-x86_64-cpu-fused",
      /Android x86_64 fused FFI is not a dflash target/,
    ],
    [
      "android-x86_64-vulkan-fused",
      /Android x86_64 fused FFI is not a dflash target/,
    ],
    ["ios-arm64-metal-fused", /iOS fused FFI is not wired/],
    ["ios-arm64-simulator-metal-fused", /iOS fused FFI is not wired/],
  ];

  for (const [target, pattern] of cases) {
    assert.throws(
      () => parseArgs(["--target", target, "--dry-run"]),
      (err) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.match(message, pattern, message);
        assert.match(message, new RegExp(target), message);
        return true;
      },
    );
  }
});
