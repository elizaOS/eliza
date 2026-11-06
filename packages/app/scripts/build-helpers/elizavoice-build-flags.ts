// Argument parsing and per-build flags for stage-elizavoice-lib.ts, kept free
// of side effects so tests can check them without an NDK.

import path from "node:path";

/** Version script for --ffi-exports-only: eliza_inference_* global, rest local. */
export const FFI_EXPORTS_VERSION_SCRIPT =
  "{\n  global:\n    eliza_inference_*;\n  local:\n    *;\n};\n";

/**
 * Parses stage-elizavoice-lib.ts arguments. Throws with the message the script
 * prints on a bad argument.
 *
 * @param {string[]} argv
 * @returns {{abi: string, variant: string, out: string, espeakDir: string, ffiExportsOnly: boolean}}
 */
export function parseStageElizaVoiceArgs(argv) {
  const out = {
    abi: "arm64-v8a",
    variant: "cpu",
    out: "",
    espeakDir: "",
    ffiExportsOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--abi") out.abi = argv[++i];
    else if (argv[i] === "--variant") out.variant = argv[++i];
    else if (argv[i] === "--out") out.out = path.resolve(argv[++i]);
    else if (argv[i] === "--espeak-dir")
      out.espeakDir = path.resolve(argv[++i]);
    else if (argv[i] === "--ffi-exports-only") out.ffiExportsOnly = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (out.variant !== "cpu" && out.variant !== "vulkan") {
    throw new Error(`unsupported --variant ${out.variant} (cpu | vulkan)`);
  }
  // The Vulkan variant's sibling libraries call into each other's exports.
  if (out.ffiExportsOnly && out.variant !== "cpu") {
    throw new Error("--ffi-exports-only needs --variant cpu");
  }
  return out;
}

/**
 * Build directory and the CMake flags that differ between builds.
 * --ffi-exports-only gets its own build directory, per-function and per-data
 * sections, --gc-sections and the version script, so the linker can drop what
 * the FFI never reaches. The default build only sets 16 KiB page alignment.
 *
 * @param {{abi: string, variant: string, ffiExportsOnly: boolean, cacheRoot: string}} opts
 * @returns {{buildDir: string, versionScript: string | null, configureFlags: string[]}}
 */
export function elizaVoiceBuildFlags({
  abi,
  variant,
  ffiExportsOnly,
  cacheRoot,
}) {
  const buildDir = path.join(
    cacheRoot,
    variant === "vulkan"
      ? `${abi}-vulkan`
      : ffiExportsOnly
        ? `${abi}-ffi-exports`
        : abi,
  );
  const linker = ["-Wl,-z,max-page-size=16384"];
  const configureFlags = [];
  let versionScript = null;
  if (ffiExportsOnly) {
    versionScript = path.join(buildDir, "eliza-inference-exports.map");
    linker.push("-Wl,--gc-sections", `-Wl,--version-script=${versionScript}`);
    configureFlags.push(
      "-DCMAKE_C_FLAGS=-ffunction-sections -fdata-sections",
      "-DCMAKE_CXX_FLAGS=-ffunction-sections -fdata-sections",
    );
  }
  // 16 KiB page alignment for Android 15+ devices.
  configureFlags.push(`-DCMAKE_SHARED_LINKER_FLAGS=${linker.join(" ")}`);
  return { buildDir, versionScript, configureFlags };
}
