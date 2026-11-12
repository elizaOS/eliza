// --ffi-exports-only is opt-in: the default Android voice build keeps its flags.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, stageLibArgs } from "../paradee-voice/build-native.ts";
import {
  elizaVoiceBuildFlags,
  FFI_EXPORTS_VERSION_SCRIPT,
  parseStageElizaVoiceArgs,
} from "./elizavoice-build-flags.ts";

const cacheRoot = "/cache/elizavoice-android";

describe("stage-elizavoice-lib arguments", () => {
  it("defaults to the CPU build with every export", () => {
    expect(parseStageElizaVoiceArgs(["--abi", "x86_64"])).toEqual({
      abi: "x86_64",
      variant: "cpu",
      out: "",
      espeakDir: "",
      ffiExportsOnly: false,
    });
  });

  it("takes --ffi-exports-only", () => {
    expect(
      parseStageElizaVoiceArgs(["--ffi-exports-only"]).ffiExportsOnly,
    ).toBe(true);
  });

  it("refuses --ffi-exports-only with the Vulkan variant", () => {
    expect(() =>
      parseStageElizaVoiceArgs(["--variant", "vulkan", "--ffi-exports-only"]),
    ).toThrow("--ffi-exports-only needs --variant cpu");
    expect(parseStageElizaVoiceArgs(["--variant", "vulkan"]).variant).toBe(
      "vulkan",
    );
  });

  it("rejects unknown arguments and variants", () => {
    expect(() => parseStageElizaVoiceArgs(["--strip"])).toThrow(
      "unknown argument --strip",
    );
    expect(() => parseStageElizaVoiceArgs(["--variant", "gpu"])).toThrow(
      "unsupported --variant gpu",
    );
  });
});

describe("stage-elizavoice-lib build flags", () => {
  it("leaves the default build unchanged", () => {
    expect(
      elizaVoiceBuildFlags({
        abi: "arm64-v8a",
        variant: "cpu",
        ffiExportsOnly: false,
        cacheRoot,
      }),
    ).toEqual({
      buildDir: path.join(cacheRoot, "arm64-v8a"),
      versionScript: null,
      configureFlags: [
        "-DCMAKE_SHARED_LINKER_FLAGS=-Wl,-z,max-page-size=16384",
      ],
    });
    expect(
      elizaVoiceBuildFlags({
        abi: "arm64-v8a",
        variant: "vulkan",
        ffiExportsOnly: false,
        cacheRoot,
      }).buildDir,
    ).toBe(path.join(cacheRoot, "arm64-v8a-vulkan"));
  });

  it("adds sections, gc-sections and the version script in its own build directory", () => {
    const buildDir = path.join(cacheRoot, "arm64-v8a-ffi-exports");
    const versionScript = path.join(buildDir, "eliza-inference-exports.map");
    expect(
      elizaVoiceBuildFlags({
        abi: "arm64-v8a",
        variant: "cpu",
        ffiExportsOnly: true,
        cacheRoot,
      }),
    ).toEqual({
      buildDir,
      versionScript,
      configureFlags: [
        "-DCMAKE_C_FLAGS=-ffunction-sections -fdata-sections",
        "-DCMAKE_CXX_FLAGS=-ffunction-sections -fdata-sections",
        `-DCMAKE_SHARED_LINKER_FLAGS=-Wl,-z,max-page-size=16384 -Wl,--gc-sections -Wl,--version-script=${versionScript}`,
      ],
    });
  });

  it("keeps only eliza_inference_* global", () => {
    expect(FFI_EXPORTS_VERSION_SCRIPT.replace(/\s+/g, " ").trim()).toBe(
      "{ global: eliza_inference_*; local: *; };",
    );
  });
});

describe("paradee-voice build-native", () => {
  it("records explicit product language selection without changing the default", () => {
    expect(parseArgs(["--workspace", "/w"]).languages).toBeUndefined();
    expect(
      parseArgs(["--workspace", "/w", "--languages", "en"]).languages,
    ).toEqual(["en"]);
    expect(
      parseArgs(["--workspace", "/w", "--languages", "en,es"]).languages,
    ).toEqual(["en", "es"]);
  });
  it("passes --ffi-exports-only to stage-elizavoice-lib only when asked", () => {
    const plain = parseArgs(["--workspace", "/w", "--abi", "arm64-v8a"]);
    expect(plain.ffiExportsOnly).toBe(false);
    expect(stageLibArgs(plain, "arm64-v8a", "/e")).not.toContain(
      "--ffi-exports-only",
    );
    const small = parseArgs(["--workspace", "/w", "--ffi-exports-only"]);
    expect(small.ffiExportsOnly).toBe(true);
    const args = stageLibArgs(small, "arm64-v8a", "/e");
    expect(args.at(-1)).toBe("--ffi-exports-only");
    expect(args[0]).toMatch(
      /packages\/app\/scripts\/stage-elizavoice-lib\.ts$/,
    );
  });
});
