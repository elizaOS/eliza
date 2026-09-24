/** Exercises verify fused symbols behavior with deterministic app test fixtures. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertVulkanMaliMitigation,
  REQUIRED_ELIZA_INFERENCE_SYMBOLS,
} from "./verify-fused-symbols.ts";

const MARKER = "GGML_VK_FA_ALLOW_SUBGROUPS";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const fusedFfiHeader = path.join(
  repoRoot,
  "plugins/plugin-local-inference/native/llama.cpp/tools/omnivoice/include/eliza-inference-ffi.h",
);

// The Mali gate only scans fixture bytes for a marker, so no native build is
// needed to exercise the release-blocking decision tree.
function fixtureLib({
  backendBytes = null,
  fusedBytes = "not a real fused lib",
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fused-verify-"));
  const lib = path.join(dir, "libelizainference.so");
  fs.writeFileSync(lib, Buffer.from(fusedBytes));
  if (backendBytes !== null) {
    fs.writeFileSync(
      path.join(dir, "libggml-vulkan.so"),
      Buffer.from(backendBytes),
    );
  }
  return lib;
}

describe("assertVulkanMaliMitigation — #9508 fail-closed Mali flash-attn gate", () => {
  it("is a no-op for non-vulkan targets", () => {
    const lib = fixtureLib({});
    expect(() =>
      assertVulkanMaliMitigation({ lib, target: "linux-x64-cpu-fused" }),
    ).not.toThrow();
  });

  it("passes when libggml-vulkan.so carries the Mali mitigation marker", () => {
    const lib = fixtureLib({ backendBytes: `prefix-${MARKER}-suffix` });
    expect(() =>
      assertVulkanMaliMitigation({ lib, target: "linux-x64-vulkan-fused" }),
    ).not.toThrow();
  });

  it("passes when statically fused Vulkan carries the mitigation marker in libelizainference", () => {
    const lib = fixtureLib({ fusedBytes: `prefix-${MARKER}-suffix` });
    expect(() =>
      assertVulkanMaliMitigation({ lib, target: "android-arm64-vulkan-fused" }),
    ).not.toThrow();
  });

  it("throws fail-closed on a stale pre-#9508 backend missing the marker", () => {
    const lib = fixtureLib({
      backendBytes: "a vulkan backend without the mitigation marker",
    });
    expect(() =>
      assertVulkanMaliMitigation({ lib, target: "android-arm64-vulkan-fused" }),
    ).toThrow(/Mali flash-attn mitigation marker/);
  });

  it("throws fail-closed when no Vulkan output carries the mitigation marker", () => {
    const lib = fixtureLib({});
    expect(() =>
      assertVulkanMaliMitigation({ lib, target: "android-arm64-vulkan-fused" }),
    ).toThrow(/neither libggml-vulkan\.so.*GGML_VK_FA_ALLOW_SUBGROUPS/);
  });
});

const headerDescribe = fs.existsSync(fusedFfiHeader) ? describe : describe.skip;

headerDescribe("REQUIRED_ELIZA_INFERENCE_SYMBOLS", () => {
  it("does not require symbols ahead of the pinned fused FFI header", () => {
    const header = fs.readFileSync(fusedFfiHeader, "utf8");
    const missingFromHeader = REQUIRED_ELIZA_INFERENCE_SYMBOLS.filter(
      (symbol) => !new RegExp(`\\b${symbol}\\s*\\(`).test(header),
    );
    expect(missingFromHeader).toEqual([]);
  });
});
