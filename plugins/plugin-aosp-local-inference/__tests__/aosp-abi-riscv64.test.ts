/**
 * Riscv64 ABI mapping for the AOSP / generic-FFI llama loader.
 *
 * `node-llama-cpp` ships native prebuilts for linux-{x64,arm64},
 * darwin-arm64, win-x64 only — no riscv64 prebuild exists. On riscv64 we
 * fall back to the FFI loader in this package, which dlopens
 * `<abi>/libllama.so` (cross-built by Wave 2) and `<abi>/libeliza-llama-shim.so`.
 * The ABI directory for riscv64 is `riscv64/`, matching the layout the
 * Android Agent / chip BSP unpacks.
 */

import { describe, expect, it } from "bun:test";

import {
  isAospEnabled,
  resolveLibllamaPath,
  resolveLlamaShimPath,
  resolveSpeculativeShimPath,
} from "../src/aosp-llama-adapter";

const ROOT = "/tmp/agent-root";

describe("AOSP llama ABI mapping", () => {
  it("maps arm64 to arm64-v8a", () => {
    expect(resolveLibllamaPath("arm64", ROOT)).toBe(
      "/tmp/agent-root/arm64-v8a/libllama.so",
    );
    expect(resolveLlamaShimPath("arm64", ROOT)).toBe(
      "/tmp/agent-root/arm64-v8a/libeliza-llama-shim.so",
    );
  });

  it("maps x64 to x86_64", () => {
    expect(resolveLibllamaPath("x64", ROOT)).toBe(
      "/tmp/agent-root/x86_64/libllama.so",
    );
  });

  it("maps riscv64 to riscv64/", () => {
    // The Wave-2 cross-compiled libllama lives under <root>/riscv64/.
    expect(resolveLibllamaPath("riscv64", ROOT)).toBe(
      "/tmp/agent-root/riscv64/libllama.so",
    );
    expect(resolveLlamaShimPath("riscv64", ROOT)).toBe(
      "/tmp/agent-root/riscv64/libeliza-llama-shim.so",
    );
    expect(resolveSpeculativeShimPath("riscv64", ROOT)).toBe(
      "/tmp/agent-root/riscv64/libeliza-llama-speculative-shim.so",
    );
  });

  it("throws on truly unsupported arches", () => {
    // ia32 / mips etc. are never going to ship a libllama.so in this repo;
    // surface the failure loudly rather than silently mapping to a wrong
    // directory.
    expect(() => resolveLibllamaPath("ia32" as NodeJS.Architecture, ROOT))
      .toThrow(/Unsupported process\.arch/);
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
    // node-llama-cpp has no riscv64 prebuild; the FFI loader is the only
    // viable in-process llama.cpp path on riscv64, so we auto-enable.
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
