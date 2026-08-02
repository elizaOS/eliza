/**
 * Per-ABI asset-directory mapping for the AOSP / generic-FFI fused loader.
 *
 * The fused `libelizainference.so` (the sole text/voice native library on
 * AOSP) lives under `<agent_root>/<abi>/`. The ABI directory for riscv64 is
 * `riscv64/`, matching the layout the Android Agent / chip BSP unpacks. There
 * is no riscv64 NAPI prebuild, so the in-process FFI loader is the only viable
 * local path there.
 */

import { describe, expect, it } from "bun:test";

import {
  isAospEnabled,
  resolveAospAbiDir,
  resolveAospElizaInferenceLibPath,
} from "../src/aosp-llama-paths";

const ROOT = "/tmp/agent-root";

describe("AOSP fused-lib ABI mapping", () => {
  it("maps arm64 to arm64-v8a", () => {
    expect(resolveAospAbiDir("arm64", ROOT)).toBe("/tmp/agent-root/arm64-v8a");
    expect(resolveAospElizaInferenceLibPath("arm64", ROOT)).toBe(
      "/tmp/agent-root/arm64-v8a/libelizainference.so",
    );
  });

  it("maps x64 to x86_64", () => {
    expect(resolveAospElizaInferenceLibPath("x64", ROOT)).toBe(
      "/tmp/agent-root/x86_64/libelizainference.so",
    );
  });

  it("maps riscv64 to riscv64/", () => {
    // The Wave-2 cross-compiled libelizainference lives under <root>/riscv64/.
    expect(resolveAospAbiDir("riscv64", ROOT)).toBe("/tmp/agent-root/riscv64");
    expect(resolveAospElizaInferenceLibPath("riscv64", ROOT)).toBe(
      "/tmp/agent-root/riscv64/libelizainference.so",
    );
  });

  it("throws on truly unsupported arches", () => {
    // ia32 / mips etc. are never going to ship a libelizainference.so in this
    // repo; surface the failure loudly rather than silently mapping to a wrong
    // directory.
    expect(() =>
      resolveAospAbiDir("ia32" as NodeJS.Architecture, ROOT),
    ).toThrow(/Unsupported process\.arch/);
  });
});

describe("isAospEnabled", () => {
  it("returns false on x64 with no env flags", () => {
    expect(isAospEnabled({}, "x64")).toBe(false);
  });

  it("returns true on x64 with ELIZA_LOCAL_LLAMA=1", () => {
    expect(isAospEnabled({ ELIZA_LOCAL_LLAMA: "1" }, "x64")).toBe(true);
  });

  it("auto-fires on riscv64 with no env flags", () => {
    // There is no riscv64 NAPI prebuild; the FFI loader is the only viable
    // in-process path on riscv64, so we auto-enable.
    expect(isAospEnabled({}, "riscv64")).toBe(true);
  });

  it("ELIZA_DISABLE_FFI_LLAMA=1 hard-disables riscv64 auto-fire", () => {
    expect(isAospEnabled({ ELIZA_DISABLE_FFI_LLAMA: "1" }, "riscv64")).toBe(
      false,
    );
  });

  it("ELIZA_DISABLE_FFI_LLAMA=1 overrides explicit ELIZA_LOCAL_LLAMA=1", () => {
    expect(
      isAospEnabled(
        { ELIZA_DISABLE_FFI_LLAMA: "1", ELIZA_LOCAL_LLAMA: "1" },
        "arm64",
      ),
    ).toBe(false);
  });
});
