#!/usr/bin/env node
/**
 * Builds the pinned llama.cpp fork for musl-linked Android and fused host targets.
 * Android's embedded Bun uses musl, so NDK/bionic libraries cannot be substituted.
 * Zig ABI and linker-version policy lives in zig-toolchain.ts; fork pins below
 * are authoritative. Artifact checks enforce architecture, SONAME and required
 * fused symbols before packaging.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { androidArm64SimdCmakeFlags } from "../build-helpers/arm64-simd.ts";
import {
  fusedCmakeBuildTargets,
  fusedExtraCmakeFlags,
} from "../build-helpers/omnivoice-merged.ts";
import { verifyFusedSymbols } from "../build-helpers/verify-fused-symbols.ts";
import { resolveRepoRootFromImportMeta } from "../lib/repo-root.ts";
import {
  compareSemver,
  resolveAndroidNdkHostDir,
  resolveDefaultAndroidAssetsDir as resolveDefaultAndroidAssetsDirForRoot,
  resolveHomebrewFormulaIncludeDirs,
} from "./compile-libllama-paths.ts";
import { main as compileShimMain } from "./compile-shim.ts";
import {
  readPinnedNativeRevision,
  validateMaintainedVulkanSource,
} from "./vulkan-source-contract.ts";
import {
  ABI_TARGETS,
  assertZigPinForTargets,
  ensureZigDrivers,
  probeZig,
  zigTriplesForAbis,
} from "./zig-toolchain.ts";

export {
  compareSemver,
  resolveAndroidNdkHostDir,
  resolveHomebrewFormulaIncludeDirs,
};

const here = path.dirname(fileURLToPath(import.meta.url));
// Walk up from `eliza/packages/app/scripts/aosp/` until we hit
// the host repo root (the directory with a top-level `package.json`).
// On a parent-host invocation that's `<host-root>`; when running
// inside the elizaOS source checkout it's the elizaOS repo root.
const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const RECURSIVE_CLEANUP_SCRIPT = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.ts",
);

// elizaOS/llama.cpp @ 33c888a7b. Composes TBQ (apothic) +
// QJL (W1-A) + Q4_POLAR (W1-B) + Metal sources (W1-D) + MTP spec-decode
// (W2) + W3-B fused CPU kernels + W4-B CUDA QJL/Polar/TBQ3_TCQ kernels onto
// upstream b9213. See docs/porting/unified-fork-strategy.md for the full
// migration story.
//
// The fork ships in-tree as the git submodule at
// plugins/plugin-local-inference/native/llama.cpp (next to the MTP build at
// scripts/build-llama-cpp-mtp.ts — same pinned commit so both build paths
// land on identical kernels). When that
// submodule is initialized this path defaults to it (no clone needed); pass
// `--src-dir` to point at another checkout, or `--cache-dir` to force a
// standalone clone of `${LLAMA_CPP_REMOTE}` at `${LLAMA_CPP_TAG}`.
//
// Pre-2026-05-09 the AOSP path consumed apothic/llama.cpp-1bit-turboquant
// directly and applied vendored QJL + PolarQuant patch series via
// scripts/aosp/llama-cpp-patches/apply-patches.ts at build time. That
// flow is now replaced by a single canonical fork — the patches are
// baked in. apply-patches.ts is kept around for one release as a
// rollback path; see scripts/aosp/llama-cpp-patches/README.md.
export const LLAMA_CPP_TAG = "v1.2.0-eliza";
// Must track the `plugins/plugin-local-inference/native/llama.cpp` submodule
// gitlink on develop. The old pin `33c888a7be` predated the Mali flash-attn
// subgroup-race fix (the `VK_VENDOR_ID_ARM` `disable_subgroups` branch), so the
// fused Vulkan lib built from it SIGABRTed mid-decode on Mali GPUs (#9508). This
// commit is a forward descendant that bakes the mitigation in; the
// `verify-fused-symbols` gate enforces the marker is present post-build.
export const LLAMA_CPP_COMMIT = "32a7911dced6230ce544c43a6399f5bd721cab90";
export const LLAMA_CPP_REMOTE = "https://github.com/elizaOS/llama.cpp.git";
export const AARCH64_MUSL_ZIG_MIN_VERSION = "0.13.0";
export const AARCH64_MUSL_ZIG_MAX_VERSION_EXCLUSIVE = "0.14.0";
// Floor for the RVV-on riscv64 build. Zig 0.13's bundled LLVM rejects the
// GCC-style `-march=rv64gcv*` ISA string the vendored llama.cpp's
// ggml-cpu/CMakeLists hard-codes when GGML_RVV / GGML_RV_ZFH / etc. are ON;
// zig 0.14+ accepts it. Below this floor we hard-disable RVV + Zfh + Zvfh +
// Zicbop + Zihintpause + Zvfbfwma + XTheadVector + Zba + SpaceMit so the
// MARCH_STR collapses to plain `rv64gc` (which Zig 0.13's argv filter then
// strips, since the `riscv64-linux-musl` triple already implies rv64gc/lp64d).
// At or above this floor we leave the upstream defaults ON, the filter
// becomes a no-op, and the vendored RVV intrinsic kernels (q4_0/q4_1/q5_0/
// q5_1/q8_0/q8_1/q4_K/q5_K/q6_K/q8_K/iq*/tq1_0/tq2_0/mxfp4 in
// ggml/src/ggml-cpu/arch/riscv/quants.c) light up.
export const MIN_ZIG_RVV_VERSION = "0.14.0";

// The in-repo submodule checkout of the fork.
// `repoRoot` resolves to the repo root that contains a top-level package.json.
const LLAMA_CPP_SUBMODULE_DIR = path.join(
  repoRoot,
  "plugins",
  "plugin-local-inference",
  "native",
  "llama.cpp",
);
// True when the submodule is checked out (has a worktree). When so, the AOSP
// cross-compile defaults its source dir to it instead of cloning.
export function llamaCppSubmodulePresent() {
  try {
    return (
      fs.existsSync(path.join(LLAMA_CPP_SUBMODULE_DIR, ".git")) &&
      fs.existsSync(path.join(LLAMA_CPP_SUBMODULE_DIR, "CMakeLists.txt"))
    );
  } catch {
    return false;
  }
}

// `*-fused` android targets that are wired to real AOSP artifacts.
// Membership in this set is the only way the fused (omnivoice-grafted) build
// path activates from this script — there is no env-var shortcut and no
// implicit upgrade from a non-fused `--abi` invocation.
export const FUSED_ANDROID_TARGETS = Object.freeze([
  "android-arm64-cpu-fused",
  "android-x86_64-cpu-fused",
  "android-riscv64-cpu-fused",
]);

// Extra cmake targets whose build failure must STILL abort the run. Only the
// fused `elizainference` lib (libelizainference.so) is bundled into the APK;
// every other extra target is a standalone CLI driver that ships nothing, so a
// compile break in one of those (e.g. the fork's stale omnivoice-tts.cpp) must
// not fail a build whose required libs are otherwise good.
const CRITICAL_EXTRA_TARGETS = new Set(["elizainference"]);

/**
 * Parse one of the `android-<arch>-<backend>[-fused]` target strings used by
 * the mtp build script into the pieces this script needs (the Android ABI
 * + the fused/backend flags). Throws on unsupported triples — there is no
 * implicit translation; the operator either asks for one of the known
 * triples or gets a hard error.
 *
 * Exported for tests.
 */
export function parseAndroidTarget(target) {
  if (typeof target !== "string" || target.length === 0) {
    throw new Error(`[compile-libllama] target must be a non-empty string`);
  }
  const fused = target.endsWith("-fused");
  const base = fused ? target.slice(0, -"-fused".length) : target;
  const match = /^android-(arm64|x86_64|riscv64)-(cpu|vulkan)$/.exec(base);
  if (!match) {
    throw new Error(
      `[compile-libllama] unsupported --target ${target}. ` +
        `Supported: ${[
          "android-arm64-cpu",
          "android-arm64-cpu-fused",
          "android-x86_64-cpu",
          "android-x86_64-cpu-fused",
          "android-riscv64-cpu",
          "android-riscv64-cpu-fused",
        ].join(", ")}`,
    );
  }
  const [, arch, backend] = match;
  // Android Vulkan is wired for arm64 only (the GPU device target). The
  // GGML_VULKAN CMake flags + NDK glslc/headers + libggml-vulkan.so staging +
  // the eliza-1 qjl/polar Vulkan kernel patches are applied in the build path
  // when backend === "vulkan" (see resolveVulkanBuildConfig / the build fn).
  if (backend === "vulkan" && arch !== "arm64") {
    throw new Error(
      `[compile-libllama] unsupported --target ${target}: Android Vulkan is ` +
        `only wired for arm64 (the GPU device target). Use android-arm64-vulkan ` +
        `or android-${arch}-cpu${fused ? "-fused" : ""}.`,
    );
  }
  // Map the parsed arch token to the Android ABI directory name. arm64 →
  // arm64-v8a (only Android ABI for aarch64); x86_64 and riscv64 share
  // their name with the parsed token.
  let androidAbi;
  if (arch === "x86_64") androidAbi = "x86_64";
  else if (arch === "riscv64") androidAbi = "riscv64";
  else androidAbi = "arm64-v8a";
  return { target, arch, backend, fused, androidAbi };
}

function removeDirectoryRecursive(targetPath) {
  try {
    execFileSync("node", [RECURSIVE_CLEANUP_SCRIPT, path.resolve(targetPath)], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const detail = [error?.stdout, error?.stderr].filter(Boolean).join("\n");
    throw new Error(detail || error?.message || String(error), {
      cause: error,
    });
  }
}

/**
 * GGML_VULKAN CMake flags for the android-arm64 Vulkan backend. Points cmake at
 * the NDK's host `glslc` (the shader compiler ggml-vulkan's codegen invokes),
 * the Vulkan headers, and the aarch64 Vulkan loader stub. ggml-vulkan dlopen()s
 * the device's real libvulkan.so at runtime; the NDK stub only satisfies the
 * link. Throws (fail-closed) if any NDK Vulkan prerequisite is missing, so the
 * build never silently falls back to CPU for a Vulkan target.
 */
export function resolveAndroidVulkanCmakeFlags({
  androidApi = 31,
  stagingDir,
} = {}) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) {
    throw new Error(
      "[compile-libllama] ANDROID_HOME/ANDROID_SDK_ROOT is required for the " +
        "android Vulkan build (NDK glslc + Vulkan headers + loader).",
    );
  }
  const ndkRoot = path.join(sdk, "ndk");
  const ndks = fs.existsSync(ndkRoot)
    ? fs
        .readdirSync(ndkRoot)
        .filter((d) => /^\d+\./.test(d))
        .sort(compareSemver)
    : [];
  if (ndks.length === 0) {
    throw new Error(
      `[compile-libllama] No NDK found under ${ndkRoot}; install one for the Vulkan build.`,
    );
  }
  const ndk = path.join(ndkRoot, ndks[ndks.length - 1]);
  // Resolve the NDK host-prebuilt dir from the actual host, not a hardcoded
  // `linux-x86_64` — the same NDK ships `darwin-x86_64` on macOS hosts, so
  // hardcoding linux made the Android Vulkan build Linux-only (#9508).
  const prebuiltRoot = path.join(ndk, "toolchains/llvm/prebuilt");
  const hostDir = resolveAndroidNdkHostDir(prebuiltRoot);
  if (!hostDir) {
    throw new Error(
      `[compile-libllama] No NDK host toolchain under ${prebuiltRoot} ` +
        `(need a host-matching linux/darwin/windows prebuilt).`,
    );
  }
  const sysroot = path.join(prebuiltRoot, hostDir, "sysroot");
  const glslc = path.join(
    ndk,
    "shader-tools",
    hostDir,
    os.platform() === "win32" ? "glslc.exe" : "glslc",
  );
  const libBase = path.join(sysroot, "usr/lib/aarch64-linux-android");
  const apis = fs.existsSync(libBase)
    ? fs
        .readdirSync(libBase)
        .filter((d) => /^\d+$/.test(d))
        .map(Number)
        .filter((n) => n >= androidApi)
        .sort((a, b) => a - b)
    : [];
  if (apis.length === 0) {
    throw new Error(
      `[compile-libllama] No aarch64 libvulkan.so >= API ${androidApi} under ${libBase}.`,
    );
  }
  const libVulkan = path.join(libBase, String(apis[0]), "libvulkan.so");

  // ggml-vulkan.cpp includes <vulkan/vulkan.hpp> (the C++ Vulkan-Hpp bindings).
  // The NDK sysroot ships only the C headers (vulkan.h / vulkan_core.h) + the
  // libvulkan.so loader, NOT the C++ wrapper. Vulkan headers are pure API
  // declarations (arch-independent); only the loader is arch-specific. So we
  // stage a complete host Vulkan-Hpp header set (vulkan.hpp + the structs/enums/
  // handles/funcs/raii partials it pulls in) into an ISOLATED include root and
  // point Vulkan_INCLUDE_DIR there. Staging only the `vulkan/` subtree keeps the
  // musl/zig cross-compile from ever seeing host glibc headers via a wide -I.
  const headerCandidates = [
    process.env.VULKAN_SDK && path.join(process.env.VULKAN_SDK, "include"),
    "/usr/include",
    "/usr/local/include",
    ...resolveHomebrewFormulaIncludeDirs("vulkan-headers"),
  ].filter(Boolean);
  const hostVulkanDir = headerCandidates
    .map((d) => path.join(d, "vulkan"))
    .find((d) => fs.existsSync(path.join(d, "vulkan.hpp")));
  if (!hostVulkanDir) {
    throw new Error(
      "[compile-libllama] vulkan/vulkan.hpp (C++ Vulkan-Hpp bindings) not found. " +
        "ggml-vulkan needs it; install the Vulkan headers (e.g. `apt install " +
        "libvulkan-dev`) or set VULKAN_SDK. Searched: " +
        headerCandidates.join(", "),
    );
  }
  const incRoot = stagingDir
    ? path.resolve(stagingDir)
    : path.join(os.tmpdir(), "eliza-vulkan-headers");
  const stagedVulkan = path.join(incRoot, "vulkan");
  removeDirectoryRecursive(stagedVulkan);
  fs.mkdirSync(incRoot, { recursive: true });
  fs.cpSync(hostVulkanDir, stagedVulkan, { recursive: true });
  // vulkan_core.h `#include <vk_video/...>` the video-codec extension headers,
  // which live in a sibling `vk_video/` dir next to `vulkan/`. Stage it too so
  // the single -I<incRoot> resolves both.
  const hostVkVideoDir = path.join(path.dirname(hostVulkanDir), "vk_video");
  if (fs.existsSync(hostVkVideoDir)) {
    const stagedVkVideo = path.join(incRoot, "vk_video");
    removeDirectoryRecursive(stagedVkVideo);
    fs.cpSync(hostVkVideoDir, stagedVkVideo, { recursive: true });
  }

  // ggml-vulkan.cpp also `#include <spirv/unified1/spirv.hpp>` (SPIR-V Headers,
  // for shader reflection). The NDK bundles SPIRV-Headers under shaderc; prefer
  // those (they match the glslc/shaderc toolchain version), else fall back to a
  // host spirv-headers install. Stage the `spirv/` subtree into the same root.
  const spirvCandidates = [
    path.join(
      ndk,
      "sources/third_party/shaderc/third_party/spirv-tools/external/spirv-headers/include",
    ),
    process.env.VULKAN_SDK && path.join(process.env.VULKAN_SDK, "include"),
    "/usr/include",
    "/usr/local/include",
    ...resolveHomebrewFormulaIncludeDirs("spirv-headers"),
  ].filter(Boolean);
  const hostSpirvRoot = spirvCandidates.find((d) =>
    fs.existsSync(path.join(d, "spirv/unified1/spirv.hpp")),
  );
  if (!hostSpirvRoot) {
    throw new Error(
      "[compile-libllama] spirv/unified1/spirv.hpp (SPIRV-Headers) not found. " +
        "ggml-vulkan needs it; expected it under the NDK shaderc third_party " +
        "tree or a host spirv-headers install. Searched: " +
        spirvCandidates.join(", "),
    );
  }
  const stagedSpirv = path.join(incRoot, "spirv");
  removeDirectoryRecursive(stagedSpirv);
  fs.cpSync(path.join(hostSpirvRoot, "spirv"), stagedSpirv, {
    recursive: true,
  });

  // ggml-vulkan's CMakeLists also does `find_package(SPIRV-Headers REQUIRED)`
  // (config mode). CI runners and NDK installs carry the headers but no
  // installed CMake package config, which failed every android-*-vulkan-fused
  // configure on develop (#9508). Prefer a real install; otherwise emit the
  // canonical config shape over the headers staged above (nothing in the
  // build consumes the interface target — only the find_package must
  // resolve). CMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH is required alongside:
  // the NDK toolchain file otherwise restricts find_package to the sysroot.
  const spirvConfigDir =
    [
      process.env.ELIZA_SPIRV_HEADERS_DIR,
      "/tmp/spirv-headers-install/lib/cmake/SPIRV-Headers",
      path.join(os.homedir(), ".local/spirv-headers/lib/cmake/SPIRV-Headers"),
      "/usr/local/lib/cmake/SPIRV-Headers",
      "/usr/lib/cmake/SPIRV-Headers",
      "/usr/share/cmake/SPIRV-Headers",
    ]
      .filter(Boolean)
      .find((d) => fs.existsSync(path.join(d, "SPIRV-HeadersConfig.cmake"))) ??
    writeSpirvHeadersConfigShim(incRoot);

  for (const [name, p] of [
    ["vulkan/vulkan.hpp", path.join(stagedVulkan, "vulkan.hpp")],
    ["glslc", glslc],
    ["libvulkan.so", libVulkan],
  ]) {
    if (!fs.existsSync(p)) {
      throw new Error(
        `[compile-libllama] android Vulkan build prerequisite ${name} missing: ${p}`,
      );
    }
  }
  return androidVulkanCmakeFlags({
    includeDir: incRoot,
    glslc,
    libVulkan,
    spirvHeadersDir: spirvConfigDir,
  });
}

/**
 * The GGML_VULKAN CMake flag list for resolved (or, in `--dry-run`, symbolic)
 * NDK/Vulkan paths. Shared by the real build and the dry-run plan so both
 * print the same flag set.
 */
export function androidVulkanCmakeFlags({
  includeDir,
  glslc,
  libVulkan,
  spirvHeadersDir,
}) {
  return [
    "-DGGML_VULKAN=ON",
    `-DVulkan_INCLUDE_DIR=${includeDir}`,
    `-DVulkan_GLSLC_EXECUTABLE=${glslc}`,
    `-DVulkan_LIBRARY=${libVulkan}`,
    `-DSPIRV-Headers_DIR=${spirvHeadersDir}`,
    "-DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH",
  ];
}

/**
 * Minimal SPIRV-Headers CMake package config over the staged `spirv/` header
 * tree, matching the target shape `cmake --install` of KhronosGroup/
 * SPIRV-Headers produces. Lets `find_package(SPIRV-Headers REQUIRED)` resolve
 * on hosts that have the headers (NDK shaderc tree, distro include dirs) but
 * no installed package config.
 */
function writeSpirvHeadersConfigShim(incRoot) {
  const dir = path.join(incRoot, "cmake", "SPIRV-Headers");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SPIRV-HeadersConfig.cmake"),
    [
      "# Generated by compile-libllama.ts (#9508): package-config shim over",
      "# the staged SPIRV headers for toolchains without an installed config.",
      "if(NOT TARGET SPIRV-Headers::SPIRV-Headers)",
      "  add_library(SPIRV-Headers::SPIRV-Headers INTERFACE IMPORTED)",
      "  set_target_properties(SPIRV-Headers::SPIRV-Headers PROPERTIES",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: CMake expands this placeholder.
      '    INTERFACE_INCLUDE_DIRECTORIES "${CMAKE_CURRENT_LIST_DIR}/../..")',
      "endif()",
      "set(SPIRV-Headers_FOUND TRUE)",
      "",
    ].join("\n"),
  );
  return dir;
}

export function resolveDefaultAndroidAssetsDir({ root = repoRoot } = {}) {
  return resolveDefaultAndroidAssetsDirForRoot({ root });
}

export function parseArgs(argv) {
  const args = {
    androidAssetsDir: resolveDefaultAndroidAssetsDir(),
    cacheDir: path.join(
      os.homedir(),
      ".cache",
      "eliza-android-agent",
      `llama-cpp-${LLAMA_CPP_TAG}`,
    ),
    abis: ABI_TARGETS.map((t) => t.androidAbi),
    // Optional explicit --target=android-<arch>-<backend>[-fused] triples
    // (see parseAndroidTarget). When present, this list takes precedence
    // over --abi (which is the legacy bulk-build entry point that produces
    // CPU-only libllama.so for one or both ABIs, no fusion).
    targets: [],
    skipIfPresent: false,
    jobs: Math.max(1, Math.min(os.cpus().length, 8)),
    srcDir: null,
    cacheDirExplicit: false,
    dryRun: false,
    // Optional source dir of prebuilt LiteRT-LM `.litertlm` text artifacts to
    // stage into the on-device bundle assets (`models/text/`), parallel to the
    // `.so`/.gguf staging. Defaults to ELIZA_LITERTLM_DIR; absent ⇒ no-op (the
    // GGUF-only default bundle is byte-identical).
    litertlmDir:
      process.env.ELIZA_LITERTLM_DIR &&
      process.env.ELIZA_LITERTLM_DIR.trim().length > 0
        ? path.resolve(process.env.ELIZA_LITERTLM_DIR.trim())
        : null,
  };

  const readFlagValue = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--assets-dir") {
      args.androidAssetsDir = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--cache-dir") {
      args.cacheDir = path.resolve(readFlagValue(arg, i));
      args.cacheDirExplicit = true;
      i += 1;
    } else if (arg === "--src-dir") {
      args.srcDir = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--litertlm-dir") {
      args.litertlmDir = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--abi") {
      const value = readFlagValue(arg, i);
      const valid = ABI_TARGETS.map((t) => t.androidAbi);
      if (!valid.includes(value)) {
        throw new Error(
          `--abi must be one of ${valid.join(", ")} (got: ${value})`,
        );
      }
      args.abis = [value];
      i += 1;
    } else if (arg === "--target") {
      const value = readFlagValue(arg, i);
      // Validates the triple and records it. Resolved further below.
      args.targets.push(parseAndroidTarget(value));
      i += 1;
    } else if (arg.startsWith("--target=")) {
      args.targets.push(parseAndroidTarget(arg.slice("--target=".length)));
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--jobs" || arg === "-j") {
      const value = Number.parseInt(readFlagValue(arg, i), 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--jobs must be a positive integer");
      }
      args.jobs = value;
      i += 1;
    } else if (arg === "--skip-if-present") {
      args.skipIfPresent = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node eliza/packages/app/scripts/aosp/compile-libllama.ts " +
          "[--assets-dir <PATH>] [--cache-dir <PATH>] [--src-dir <PATH>] " +
          "[--abi <arm64-v8a|x86_64|riscv64>] [--target <android-<arch>-<backend>[-fused]>] " +
          "[--litertlm-dir <PATH>] [--jobs <N>] [--skip-if-present] [--dry-run]\n" +
          "  --litertlm-dir <PATH>  Stage prebuilt LiteRT-LM .litertlm text artifacts from\n" +
          "                    PATH into the on-device bundle assets (models/text/), parallel\n" +
          "                    to the .so/.gguf staging. Defaults to ELIZA_LITERTLM_DIR.\n" +
          "                    Omit ⇒ GGUF-only bundle (the default).\n" +
          "  --target <TRIPLE>  Build a single target: android-{arm64,x86_64,riscv64}-cpu[-fused].\n" +
          "                    riscv64 requires NDK r27+ (first stable NDK with a real\n" +
          "                    riscv64-linux-android sysroot); older NDKs will fail the\n" +
          "                    compiler probe before any TU compiles.\n" +
          "                    Android Vulkan targets fail closed until GGML_VULKAN\n" +
          "                    flags and Vulkan backend artifact staging are wired.\n" +
          "                    -fused enables the omnivoice graft (same as mtp's\n" +
          "                    *-fused desktop targets) — one binary serving text +\n" +
          "                    POST /v1/audio/speech.\n" +
          "  --dry-run         Print the cmake invocation + expected\n" +
          "                    output layout WITHOUT running cmake/ndk. Honored for\n" +
          "                    every --target.\n" +
          "  --src-dir <PATH>  Use an existing llama.cpp checkout instead of the\n" +
          "                    in-repo submodule / a fresh clone. The directory's HEAD\n" +
          "                    is used as-is; Vulkan requires the parent native gitlink for source admission.\n" +
          `  Default source:   the git submodule plugins/plugin-local-inference/native/llama.cpp\n` +
          `                    (elizaOS/llama.cpp @ ${LLAMA_CPP_TAG}) when initialized;\n` +
          `                    otherwise a standalone clone under --cache-dir.\n` +
          "  --cache-dir <PATH>  Force the standalone-clone path even when the submodule\n" +
          "                    is present.",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  // Default the source dir to the in-repo submodule when it is initialized and
  // the caller did not point us elsewhere (--src-dir) or force a standalone
  // clone (--cache-dir). Keeps both build paths (mtp + AOSP) on the exact
  // same pinned commit.
  if (!args.srcDir && !args.cacheDirExplicit && llamaCppSubmodulePresent()) {
    args.srcDir = LLAMA_CPP_SUBMODULE_DIR;
  }

  return args;
}

/**
 * Decide the riscv64 build plan based on the detected Zig version + env knobs.
 * Pure: takes the version string + env, returns a structured plan. No side
 * effects.
 *
 * Returns one of:
 *   { rvv: false, allVariants: false, zigVersion, reason: "zig-too-old" }
 *     — Zig < MIN_ZIG_RVV_VERSION. Scalar parity; the riscv64ArgFilter in
 *     ensureZigDrivers strips `-march=rv64gc*` and the resulting binary is
 *     a plain rv64gc/lp64d build.
 *
 *   { rvv: true, allVariants: false, zigVersion, reason: "zig-supports-rvv" }
 *     — Zig >= MIN_ZIG_RVV_VERSION. RVV + Zfh + Zvfh + Zicbop + Zihintpause
 *     ON (the upstream llama.cpp defaults). Resulting libggml-cpu.so requires
 *     RVV-capable hardware at runtime; SIGILLs on a scalar core.
 *
 *   { rvv: true, allVariants: true, zigVersion, reason: "all-variants-opt-in" }
 *     — Zig >= MIN_ZIG_RVV_VERSION AND env ELIZA_GGML_CPU_ALL_VARIANTS=1.
 *     Builds GGML_BACKEND_DL + GGML_CPU_ALL_VARIANTS so two
 *     libggml-cpu-riscv64_{0,v}.so variants ship; runtime picks via
 *     riscv_hwprobe (`ggml-cpu/arch/riscv/cpu-feats.cpp`). Opt-in until the
 *     Android loader story for the DL-backend dispatch is verified end-to-end
 *     across arm64/x86_64 — flipping that on by default would change the
 *     artifact list for non-riscv64 ABIs too.
 *
 *   { rvv: false, allVariants: false, zigVersion: null, reason: "zig-not-detected" }
 *     — Probe failed (used in dry-run mode where zig may legitimately not be
 *     on PATH). Falls back to scalar so the dry-run plan reflects the
 *     conservative default.
 *
 * Exported for tests.
 */
export function resolveRiscv64BuildPlan({
  zigVersion = null,
  probe = probeZig,
  env = process.env,
  isDryRun = false,
} = {}) {
  let version = zigVersion;
  if (version === null) {
    if (isDryRun) {
      try {
        version = probe();
      } catch {
        return {
          rvv: false,
          allVariants: false,
          zigVersion: null,
          reason: "zig-not-detected",
        };
      }
    } else {
      version = probe();
    }
  }
  if (compareSemver(version, MIN_ZIG_RVV_VERSION) < 0) {
    return {
      rvv: false,
      allVariants: false,
      zigVersion: version,
      reason: "zig-too-old",
    };
  }
  const allVariantsOptIn = env.ELIZA_GGML_CPU_ALL_VARIANTS === "1";
  return {
    rvv: true,
    allVariants: allVariantsOptIn,
    zigVersion: version,
    reason: allVariantsOptIn ? "all-variants-opt-in" : "zig-supports-rvv",
  };
}

/**
 * Map a riscv64 build plan to the cmake -D flags that select the right
 * GGML_RVV / GGML_RV_ZFH / etc. combination. Returns an empty array for
 * non-riscv64 ABIs.
 *
 * Exported for tests.
 */
export function riscv64CmakeFlagsForPlan({ abi, plan }) {
  if (abi !== "riscv64") return [];
  if (plan.rvv === false) {
    return [
      "-DGGML_RVV=OFF",
      "-DGGML_RV_ZFH=OFF",
      "-DGGML_RV_ZVFH=OFF",
      "-DGGML_RV_ZICBOP=OFF",
      "-DGGML_RV_ZIHINTPAUSE=OFF",
      "-DGGML_RV_ZVFBFWMA=OFF",
      "-DGGML_XTHEADVECTOR=OFF",
      "-DGGML_RV_ZBA=OFF",
      "-DGGML_CPU_RISCV64_SPACEMIT=OFF",
    ];
  }
  // RVV-on. Leave the vendored llama.cpp defaults (ON) for RVV / Zfh / Zvfh /
  // Zicbop / Zihintpause. Keep Zvfbfwma / XTheadVector / Zba / SpaceMit off
  // unless explicitly opted in — they're hardware-specific extensions that
  // SIGILL on generic RVV cores.
  const flags = [
    "-DGGML_RVV=ON",
    "-DGGML_RV_ZFH=ON",
    "-DGGML_RV_ZVFH=ON",
    "-DGGML_RV_ZICBOP=ON",
    "-DGGML_RV_ZIHINTPAUSE=ON",
    "-DGGML_RV_ZVFBFWMA=OFF",
    "-DGGML_XTHEADVECTOR=OFF",
    "-DGGML_RV_ZBA=OFF",
    "-DGGML_CPU_RISCV64_SPACEMIT=OFF",
  ];
  if (plan.allVariants) {
    // GGML_CPU_ALL_VARIANTS implies GGML_BACKEND_DL and builds per-variant
    // libggml-cpu-riscv64_{0,v}.so; the loader picks via riscv_hwprobe.
    // GGML_NATIVE is incompatible with GGML_BACKEND_DL in this mode (see
    // ggml/src/ggml-cpu/CMakeLists.txt:491-494), so the existing
    // `-DGGML_NATIVE=OFF` we pass must stay OFF (it does).
    flags.push("-DGGML_BACKEND_DL=ON", "-DGGML_CPU_ALL_VARIANTS=ON");
  }
  return flags;
}

function run(command, args, { cwd, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with code ${result.status}`,
    );
  }
}

/**
 * Clone (or reuse) llama.cpp at the pinned tag/commit. Uses a sentinel file
 * to skip the network when the cache already holds the exact commit. The
 * working tree is detached at LLAMA_CPP_COMMIT — we never let a moving tag
 * slip the source out from under a build.
 *
 * Also runs `patchLlamaCppSourceForMusl()` on every checkout so the patch
 * survives cache reuse (the source-patch sentinel sits next to the
 * checkout sentinel and is keyed off LLAMA_CPP_COMMIT), and applies the
 * vendored QJL + PolarQuant patch series via `applyVendoredPatches()` so
 * the cross-compile picks up the GGML quant types and custom ops the
 * AOSP runtime adapter expects (qjl1_256 / q4_polar).
 */
export function ensureLlamaCppCheckout({
  cacheDir,
  log = console.log,
  spawn = run,
}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const sentinel = path.join(cacheDir, `.checked-out.${LLAMA_CPP_COMMIT}`);
  if (
    fs.existsSync(sentinel) &&
    fs.existsSync(path.join(cacheDir, "CMakeLists.txt"))
  ) {
    log(`[compile-libllama] Reusing cached llama.cpp checkout at ${cacheDir}`);
    patchLlamaCppSourceForMusl({ srcDir: cacheDir, log });
    applyVendoredPatches({ srcDir: cacheDir, log });
    assertSwaSpecDecodeFallback({ srcDir: cacheDir });
    return cacheDir;
  }
  if (!fs.existsSync(path.join(cacheDir, ".git"))) {
    log(
      `[compile-libllama] Cloning llama.cpp ${LLAMA_CPP_TAG} into ${cacheDir}`,
    );
    removeDirectoryRecursive(cacheDir);
    fs.mkdirSync(cacheDir, { recursive: true });
    spawn(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        LLAMA_CPP_TAG,
        LLAMA_CPP_REMOTE,
        cacheDir,
      ],
      {},
    );
  } else {
    log(`[compile-libllama] Refreshing llama.cpp checkout in ${cacheDir}`);
    spawn("git", ["fetch", "--depth", "1", "origin", `tag`, LLAMA_CPP_TAG], {
      cwd: cacheDir,
    });
  }
  // The pinned commit is authoritative and may NOT be the tag tip — the moving
  // LLAMA_CPP_TAG and LLAMA_CPP_COMMIT can diverge (e.g. the commit lives on a
  // feature branch while the tag was re-pointed at a release). A
  // `--branch <tag>` shallow clone only carries the tag's commit, so a bare
  // `git checkout <commit>` then fails with "unable to read tree". Fetch the
  // exact pinned commit by sha first (GitHub serves any ref-reachable sha) so
  // the working tree always lands on LLAMA_CPP_COMMIT, never the tag.
  spawn("git", ["fetch", "--depth", "1", "origin", LLAMA_CPP_COMMIT], {
    cwd: cacheDir,
  });
  spawn("git", ["checkout", "--detach", LLAMA_CPP_COMMIT], {
    cwd: cacheDir,
  });
  fs.writeFileSync(sentinel, `${LLAMA_CPP_COMMIT}\n`, "utf8");
  patchLlamaCppSourceForMusl({ srcDir: cacheDir, log });
  applyVendoredPatches({ srcDir: cacheDir, log });
  return cacheDir;
}

/**
 * Run the vendored patch applier (`llama-cpp-patches/apply-patches.ts`)
 * against the cached llama.cpp checkout. The applier is idempotent: it
 * checks each patch with `git apply --check -R` first and skips any that
 * are already on the tree, so cache reuse stays correct across pin bumps
 * and across partial-failure re-runs.
 *
 * Patches under `llama-cpp-patches/qjl/` add `GGML_TYPE_QJL1_256` (=46),
 * the QJL kernel sources vendored from `plugins/plugin-local-inference/native/qjl-cpu/`,
 * the type-traits + op-dispatch wiring, and the `tests/test-qjl-cache.cpp`
 * synthetic-graph test.
 *
 * Series selection is scoped: today only `qjl` is applied here. The
 * `polarquant` series under the same directory exists but conflicts with
 * `qjl` over the GGML_TYPE_COUNT tag (PolarQuant claims id 45, QJL
 * claims 46) and is owned by a separate landing. When that series is
 * merged with QJL, append it here.
 *
 * Order is:
 *   1. checkout -> 2. patchLlamaCppSourceForMusl -> 3. applyVendoredPatches.
 *
 * Failure mode is loud — if a patch fails to apply (e.g. the upstream
 * commit drifted), the script aborts the in-progress `git am` and exits
 * non-zero. A successful run leaves the tree with the QJL commits on top
 * of LLAMA_CPP_COMMIT.
 */
export function applyVendoredPatches({
  srcDir,
  log = console.log,
  spawn = run,
}) {
  const applierPath = path.join(here, "llama-cpp-patches", "apply-patches.ts");
  if (!fs.existsSync(applierPath)) {
    throw new Error(
      `[compile-libllama] Vendored patch applier missing at ${applierPath}. ` +
        `The llama-cpp-patches/ directory is the canonical location for QJL ` +
        `fork patches; restore it from git history.`,
    );
  }
  log(
    `[compile-libllama] Applying vendored llama.cpp patches (qjl) to ${srcDir}`,
  );
  spawn("node", [applierPath, "--repo", srcDir, "--series", "qjl"], {});
}

function sourceContainsSwaSpecDecodeFallback(srcDir) {
  const serverContextPath = path.join(
    srcDir,
    "tools",
    "server",
    "server-context.cpp",
  );
  if (!fs.existsSync(serverContextPath)) return false;
  const source = fs.readFileSync(serverContextPath, "utf8");
  return (
    source.includes("seq_rm probe failed but model declares SWA") &&
    source.includes("llama_model_n_swa(model_tgt) > 0") &&
    source.includes("ctx_tgt_seq_rm_type = COMMON_CONTEXT_SEQ_RM_TYPE_FULL")
  );
}

function assertSwaSpecDecodeFallback({ srcDir }) {
  if (sourceContainsSwaSpecDecodeFallback(srcDir)) return;
  throw new Error(
    `[compile-libllama] checkout ${srcDir} lacks the SWA-aware seq_rm fallback ` +
      `required for --spec-type mtp on SWA target bodies (elizaOS/eliza#7635).`,
  );
}

/**
 * Ensure `ggml/src/ggml.c` has the `<execinfo.h>` include gated on
 * `__GLIBC__`. musl libc does not ship `execinfo.h`, so a bare `__linux__`
 * guard breaks `zig cc --target=*-linux-musl` with
 * "fatal error: 'execinfo.h' file not found".
 *
 * Upstream llama.cpp added `__GLIBC__` to the guard in commits between
 * b3490 and b4500 (verified against the b4500 source: it uses
 * `#elif defined(__linux__) && defined(__GLIBC__)`). On the current pin
 * this function is therefore a no-op; on b3490 and earlier it rewrites
 * the include guard.
 *
 * Decision matrix:
 *   - If the source already has the `__GLIBC__` guard => no-op (write
 *     sentinel so cache reuse is fast, log, return).
 *   - If it has the legacy `#if defined(__linux__)\n#include <execinfo.h>`
 *     block (b3490) => rewrite the guard, sentinel the patch.
 *   - Otherwise => fail loudly. The pin may have introduced an entirely
 *     new layout we haven't audited; refuse to silently skip
 *     (Commandment 8: explicit failure beats silent breakage).
 *
 * Sentinel is keyed off LLAMA_CPP_COMMIT so cache reuse stays correct
 * across pin bumps.
 *
 * Exported for unit testing.
 */
export function patchLlamaCppSourceForMusl({ srcDir, log = console.log }) {
  const target = path.join(srcDir, "ggml", "src", "ggml.c");
  if (!fs.existsSync(target)) {
    throw new Error(
      `[compile-libllama] Cannot patch ggml.c: file not found at ${target}. ` +
        `Has the llama.cpp source layout changed in a newer pin?`,
    );
  }
  const sentinel = path.join(
    srcDir,
    `.musl-execinfo-patched.${LLAMA_CPP_COMMIT}`,
  );
  if (fs.existsSync(sentinel)) {
    return;
  }

  const original = fs.readFileSync(target, "utf8");

  // Already-fixed: pin includes the `__GLIBC__` guard upstream. Just write
  // the sentinel so subsequent cached runs short-circuit.
  if (
    original.includes("defined(__linux__) && defined(__GLIBC__)") &&
    original.includes("#include <execinfo.h>")
  ) {
    fs.writeFileSync(sentinel, `${LLAMA_CPP_COMMIT}\n`, "utf8");
    log(
      `[compile-libllama] ggml/src/ggml.c already gates <execinfo.h> on __GLIBC__; no patch needed.`,
    );
    return;
  }

  // Legacy b3490-style block. Exact pre-image match required so we don't
  // silently no-op on partial source drift.
  const preImage =
    "#if defined(__linux__)\n" +
    "#include <execinfo.h>\n" +
    "static void ggml_print_backtrace_symbols(void) {\n" +
    "    void * trace[100];\n" +
    "    int nptrs = backtrace(trace, sizeof(trace)/sizeof(trace[0]));\n" +
    "    backtrace_symbols_fd(trace, nptrs, STDERR_FILENO);\n" +
    "}\n" +
    "#else\n" +
    "static void ggml_print_backtrace_symbols(void) {\n" +
    "    // platform not supported\n" +
    "}\n" +
    "#endif\n";
  if (!original.includes(preImage)) {
    throw new Error(
      `[compile-libllama] Could not locate expected execinfo.h block in ggml.c, ` +
        `and the file does not already use the __GLIBC__ guard. The llama.cpp ` +
        `source layout drifted; update patchLlamaCppSourceForMusl() before bumping ` +
        `LLAMA_CPP_COMMIT. Looked at ${target}.`,
    );
  }
  const postImage =
    "#if defined(__linux__) && defined(__GLIBC__)\n" +
    "#include <execinfo.h>\n" +
    "static void ggml_print_backtrace_symbols(void) {\n" +
    "    void * trace[100];\n" +
    "    int nptrs = backtrace(trace, sizeof(trace)/sizeof(trace[0]));\n" +
    "    backtrace_symbols_fd(trace, nptrs, STDERR_FILENO);\n" +
    "}\n" +
    "#else\n" +
    "static void ggml_print_backtrace_symbols(void) {\n" +
    "    // platform not supported (musl libc has no execinfo.h)\n" +
    "}\n" +
    "#endif\n";
  fs.writeFileSync(target, original.replace(preImage, postImage), "utf8");
  fs.writeFileSync(sentinel, `${LLAMA_CPP_COMMIT}\n`, "utf8");
  log(
    `[compile-libllama] Patched ggml/src/ggml.c to gate <execinfo.h> on __GLIBC__ (musl compatibility).`,
  );
}

/**
 * Discard a CMake build tree whose cached archiver predates the Zig wrappers.
 * CMake does not repair generated link commands when an old cache recorded the
 * host macOS ar/ranlib; those tools emit successful but empty archives for ELF
 * objects. A clean configure is required to make the toolchain change real.
 */
export function resetIncompatibleCmakeArchiverCache({
  buildDir,
  arPath,
  ranlibPath,
  log = () => {},
}) {
  const cachePath = path.join(buildDir, "CMakeCache.txt");
  if (!fs.existsSync(cachePath)) return false;

  const cache = fs.readFileSync(cachePath, "utf8");
  const expectedAr = `CMAKE_AR:FILEPATH=${arPath}`;
  const expectedRanlib = `CMAKE_RANLIB:FILEPATH=${ranlibPath}`;
  if (
    cache.split(/\r?\n/).includes(expectedAr) &&
    cache.split(/\r?\n/).includes(expectedRanlib)
  ) {
    return false;
  }

  fs.rmSync(buildDir, { recursive: true, force: true });
  log(
    `[compile-libllama] Reset stale CMake build tree at ${buildDir}: ` +
      "cached archiver was not the Zig ELF archiver.",
  );
  return true;
}

/**
 * The `cmake -S … -B …` configure argv for one Android ABI. The single source
 * of truth for both the real build ({@link buildLibllamaForAbi}) and the
 * `--dry-run` plan ({@link describeAndroidTargetDryRun}), so the plan an
 * operator reads is byte-for-byte the argv the build passes.
 *
 * `riscv64BuildFlags` comes from the caller because the real build and the
 * dry-run resolve the riscv64 plan differently (the dry-run tolerates a
 * missing zig). `extraCmakeFlags` carries the fused/Vulkan layers.
 */
export function libllamaCmakeConfigureArgs({
  srcDir,
  buildDir,
  abi,
  drivers,
  riscv64BuildFlags = [],
  extraCmakeFlags = [],
}) {
  const target = ABI_TARGETS.find((t) => t.androidAbi === abi);
  if (!target) {
    throw new Error(`[compile-libllama] Unknown ABI: ${abi}`);
  }
  const { ccPath, cxxPath, arPath, ranlibPath } = drivers;
  // x86_64: the mobile x86_64 ABI only ever runs on cuttlefish / the Android
  // x86_64 emulator (both KVM-backed by an AVX2-class host, and our emulator
  // recipe boots with `-cpu host`). GGML_NATIVE=OFF leaves the build at the
  // baseline x86_64 ISA, which has two problems: (1) ggml's own AVX2 kernels
  // stay off, and (2) — fatal — the vendored QJL kernels gate their AVX2
  // implementations on `__AVX2__` while `qjl_dispatch.c` references
  // `qjl_quantize_rows_avx2` (and the score/projection AVX2 entry points)
  // unconditionally, so a baseline build links with an UNDEFINED symbol and
  // `dlopen(libllama.so)` fails at runtime with
  // `Error relocating libggml-cpu.so.0: qjl_quantize_rows_avx2: symbol not
  // found`. Turning on the standard ggml AVX2/FMA/F16C/AVX feature flags
  // defines `__AVX2__` for the ggml-cpu translation units (QJL included) so
  // those entry points are actually compiled. Runtime CPU dispatch still picks
  // scalar vs AVX2 per-call, but the symbols now exist.
  const x86_64BuildFlags =
    abi === "x86_64"
      ? ["-DGGML_AVX=ON", "-DGGML_AVX2=ON", "-DGGML_FMA=ON", "-DGGML_F16C=ON"]
      : [];

  // arm64-v8a: GGML_NATIVE=OFF leaves the cross-build at the bare armv8-a
  // baseline; see build-helpers/arm64-simd.ts for the SIMD floor rationale.
  const arm64BuildFlags = androidArm64SimdCmakeFlags(abi);
  return [
    "-S",
    srcDir,
    "-B",
    buildDir,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DBUILD_SHARED_LIBS=ON",
    "-DLLAMA_BUILD_EXAMPLES=OFF",
    "-DLLAMA_BUILD_TESTS=OFF",
    // llama-server is required for the AOSP MTP speculative-decode path
    // (target + drafter share one process; the AOSP local-inference
    // bootstrap spawns this binary and routes inference over the
    // OpenAI-compatible HTTP API). The
    // server target also pulls in the JSON/HTTP common-lib pieces, but adds
    // ~1.5 MB stripped per ABI; small price relative to the spec-decode
    // throughput win.
    "-DLLAMA_BUILD_SERVER=ON",
    "-DLLAMA_CURL=OFF",
    // Cross-builds must not discover host OpenSSL or espeak-ng archives.
    // Android uses localhost HTTP, and the app supplies IPA when Kokoro
    // reports its built-in ASCII fallback.
    "-DLLAMA_OPENSSL=OFF",
    "-DKOKORO_ENABLE_ESPEAK=OFF",
    `-DCMAKE_C_COMPILER=${ccPath}`,
    `-DCMAKE_CXX_COMPILER=${cxxPath}`,
    // Archive ELF objects with zig's llvm-ar/ranlib. The host default
    // (/usr/bin/ar on macOS) silently writes empty archives for ELF input,
    // dropping all of libllama.a/libggml*.a (see ensureZigDrivers).
    `-DCMAKE_AR=${arPath}`,
    `-DCMAKE_RANLIB=${ranlibPath}`,
    // No launcher — the driver scripts do all the wrapping themselves.
    "-DCMAKE_C_COMPILER_LAUNCHER=",
    "-DCMAKE_CXX_COMPILER_LAUNCHER=",
    "-DCMAKE_SYSTEM_NAME=Linux",
    `-DCMAKE_SYSTEM_PROCESSOR=${target.cmakeProcessor}`,
    // Disable host-arch-specific ISA so the resulting .so loads on any
    // device of the target ABI. The default tunes for the build host's
    // native cpu, which is wrong for a cross-build.
    "-DGGML_NATIVE=OFF",
    ...riscv64BuildFlags,
    ...x86_64BuildFlags,
    ...arm64BuildFlags,
    // Don't bake in an absolute RUNPATH to the build tree. The default
    // CMAKE_BUILD_RPATH points at the per-ABI build dir, which is a
    // path-leak in shipped APKs and adds dead lookup entries at runtime.
    // Android's ElizaAgentService.java sets LD_LIBRARY_PATH to the
    // per-ABI asset dir, so the dynamic linker resolves NEEDED siblings
    // from there.
    "-DCMAKE_SKIP_BUILD_RPATH=TRUE",
    "-DCMAKE_SKIP_INSTALL_RPATH=TRUE",
    "-DCMAKE_BUILD_WITH_INSTALL_RPATH=TRUE",
    "-DCMAKE_INSTALL_RPATH=",
    // `extraCmakeFlags` carries the omnivoice fused-build flags
    // (-DELIZA_FUSE_OMNIVOICE=ON, etc.) when the explicit-triple
    // path asked for a fused build. Empty for the non-fused bulk
    // --abi path.
    ...extraCmakeFlags,
  ];
}

/**
 * Configure + build libllama.so + libggml.so for one ABI. Produces:
 *   <srcDir>/build-<abi>/src/libllama.so
 *   <srcDir>/build-<abi>/ggml/src/libggml.so
 * and copies both into <abiAssetDir>/ after stripping.
 *
 * libllama.so has a NEEDED entry for libggml.so (`readelf -d`); the dynamic
 * linker resolves it from the same dir at runtime via the LD_LIBRARY_PATH
 * ElizaAgentService.java sets to the per-ABI asset dir. Without the
 * libggml.so co-copy, dlopen(libllama.so) fails with
 * "libggml.so: cannot open shared object file" the moment bun tries to
 * load it via bun:ffi.
 *
 * Strip strategy: out-of-place via `zig objcopy --strip-all <src> <dst>` then
 * rename. zig 0.13's objcopy truncates dst to 0 BEFORE reading src when
 * src == dst, which destroys the binary on in-place strip. Falls back to
 * system `strip` (which does in-place safely) if zig objcopy isn't available.
 */
export function buildLibllamaForAbi({
  srcDir,
  cacheDir,
  abi,
  abiAssetDir,
  jobs,
  zigBin = "zig",
  log = console.log,
  spawn = run,
  // Optional pass-through hooks used by the explicit-triple path
  // (`mainTargets`) to layer in the fused omnivoice flags + targets without
  // forking this helper. The non-fused bulk --abi path defaults both to
  // empty so its behavior stays byte-for-byte identical.
  extraCmakeFlags = [],
  extraBuildTargets = [],
  targetName = "",
  // Fused targets must ship the product llama-server (`verifyFusedSymbols`
  // rejects an install dir without it), so a server build failure is fatal
  // there instead of a warning that only surfaces later as a verify failure.
  llamaServerRequired = false,
}) {
  const target = ABI_TARGETS.find((t) => t.androidAbi === abi);
  if (!target) {
    throw new Error(`[compile-libllama] Unknown ABI: ${abi}`);
  }
  const buildDir = path.join(srcDir, `build-${abi}`);

  // riscv64: gate the RVV-on path on the detected Zig version. The vendored
  // llama.cpp defaults GGML_RVV / GGML_RV_ZFH / GGML_RV_ZVFH / GGML_RV_ZICBOP
  // / GGML_RV_ZIHINTPAUSE to ON, which builds the `-march=rv64gcv_zfh_zvfh_
  // zicbop_zihintpause` ISA string. Zig 0.13's bundled LLVM doesn't accept
  // that as a -march value (it tries to translate it to -mcpu= and fails
  // with "unknown CPU"); Zig 0.14+ does. resolveRiscv64BuildPlan() reads the
  // probed version and tells us which lane to take:
  //   - rvv=false (Zig < 0.14)  -> scalar parity. Force every RVV / Zfh /
  //     Zvfh / Zicbop / Zihintpause / Zvfbfwma / XTheadVector option OFF so
  //     MARCH_STR collapses to plain `rv64gc`. The driver-script argv
  //     filter then strips `-march=rv64gc -mabi=lp64d` (Zig already implies
  //     them via the triple).
  //   - rvv=true  (Zig >= 0.14) -> upstream defaults. The full
  //     `-march=rv64gcv_zfh_zvfh_zicbop_zihintpause -mabi=lp64d` string
  //     passes straight through to Zig 0.14's LLVM; quants.c's intrinsic
  //     codepaths light up.
  //   - allVariants (env ELIZA_GGML_CPU_ALL_VARIANTS=1) -> additionally
  //     enable GGML_BACKEND_DL + GGML_CPU_ALL_VARIANTS so the build emits
  //     libggml-cpu-riscv64_{0,v}.so siblings and the loader picks via
  //     riscv_hwprobe at runtime. Opt-in until the Android DL-loader
  //     plumbing for arm64/x86_64 is also verified.
  const riscv64Plan =
    abi === "riscv64"
      ? resolveRiscv64BuildPlan({ env: process.env })
      : { rvv: false, allVariants: false, zigVersion: null, reason: "n/a" };
  if (abi === "riscv64") {
    log(
      `[compile-libllama] riscv64 plan: zig=${riscv64Plan.zigVersion ?? "unknown"} ` +
        `rvv=${riscv64Plan.rvv ? "ON" : "OFF"} ` +
        `all-variants=${riscv64Plan.allVariants ? "ON" : "OFF"} ` +
        `reason=${riscv64Plan.reason}`,
    );
  }
  const riscv64BuildFlags = riscv64CmakeFlagsForPlan({
    abi,
    plan: riscv64Plan,
  });

  // arm64-v8a: GGML_NATIVE=OFF leaves the cross-build at the bare armv8-a
  // baseline, which keeps ggml's dotprod/i8mm/fp16 NEON kernels AND the eliza
  // QJL NEON-dotprod kernel dead. Pin the armv8.2-a+dotprod+fp16 floor (no i8mm — see arm64-simd.ts) and
  // flip the QJL dispatch define so the Pixel-class Tensor G4 actually runs the
  // accelerated paths. See build-helpers/arm64-simd.ts for the full rationale.
  const arm64BuildFlags = androidArm64SimdCmakeFlags(abi);
  if (arm64BuildFlags.length > 0) {
    log(
      `[compile-libllama] arm64 SIMD floor: ${arm64BuildFlags.join(" ")} ` +
        `(dotprod/i8mm/fp16 + QJL NEON-dotprod dispatch)`,
    );
  }

  // Per-ABI driver scripts that wrap `zig cc --target=<triple>` so cmake's
  // single-binary compiler probe works. See ensureZigDrivers() for why
  // passing `--target=` via CMAKE_C_FLAGS doesn't work on its own. When
  // RVV is on, the riscv64 driver passes `-march=rv64gc*` through to Zig
  // 0.14+ instead of filtering it out.
  const { ccPath, cxxPath, arPath, ranlibPath } = ensureZigDrivers({
    cacheDir,
    abi,
    zigBin,
    riscv64MarchPassthrough: riscv64Plan.rvv,
  });
  resetIncompatibleCmakeArchiverCache({
    buildDir,
    arPath,
    ranlibPath,
    log,
  });
  fs.mkdirSync(buildDir, { recursive: true });

  log(
    `[compile-libllama] Configuring llama.cpp for ${abi} (${target.zigTarget}) in ${buildDir}`,
  );
  spawn(
    "cmake",
    libllamaCmakeConfigureArgs({
      srcDir,
      buildDir,
      abi,
      drivers: { ccPath, cxxPath, arPath, ranlibPath },
      riscv64BuildFlags,
      extraCmakeFlags,
    }),
    {},
  );

  log(`[compile-libllama] Compiling libllama for ${abi} with -j${jobs}`);
  spawn(
    "cmake",
    ["--build", buildDir, "--target", "llama", "-j", String(jobs)],
    {},
  );

  // Build any extra cmake targets the caller asked for — for fused builds
  // this is omnivoice-core + libelizainference + llama-omnivoice-server +
  // the bench/completion drivers (see fusedCmakeBuildTargets()). We filter
  // out `llama` + `llama-server` upstream (the dedicated build steps below
  // already handle those), so the extra-target invocation only adds NEW
  // CMake target names. The non-fused path passes an empty list.
  //
  // Targets are filtered against what the configured build tree actually
  // exposes. The eliza llama.cpp fork's target set drifts from the script's
  // pinned expectations — e.g. `llama-speculative-simple` is an upstream
  // example the fork drops in favour of MTP spec-decode. A
  // requested-but-absent *auxiliary* target must not abort the whole
  // libllama build: the libllama.so + libggml*.so family is the critical
  // output and is fully built by the `llama` target above. We warn on the
  // gap and continue. A target that *exists* but fails to build still
  // hard-errors via `spawn()`.
  if (extraBuildTargets.length > 0) {
    const helpProbe = spawnSync(
      "cmake",
      ["--build", buildDir, "--target", "help"],
      { encoding: "utf8" },
    );
    const availableTargets = new Set(
      (helpProbe.stdout || "")
        .split("\n")
        .map((line) => line.replace(/^\.\.\.\s*/, "").trim())
        .filter(Boolean),
    );
    for (const extraTarget of extraBuildTargets) {
      if (availableTargets.size > 0 && !availableTargets.has(extraTarget)) {
        log(
          `[compile-libllama] Skipping extra cmake target ${extraTarget} for ${abi} — ` +
            `not defined in this llama.cpp checkout (auxiliary target; libllama.so is unaffected).`,
        );
        continue;
      }
      log(
        `[compile-libllama] Building extra cmake target ${extraTarget} for ${abi}`,
      );
      try {
        spawn(
          "cmake",
          ["--build", buildDir, "--target", extraTarget, "-j", String(jobs)],
          {},
        );
      } catch (err) {
        // The fused libelizainference.so (`elizainference` target) is the only
        // extra target the APK actually bundles, and `verifyFusedSymbols`
        // enforces it after this loop — so it stays fatal. The rest are
        // standalone CLI drivers (omnivoice-tts / omnivoice-codec / llama-cli /
        // llama-bench / llama-completion / llama-mtmd-cli) that ship nothing
        // into the APK. The pinned fork's `omnivoice-tts.cpp` currently calls a
        // removed `backend_init("LM")` overload (backend.h only exposes
        // `backend_init_auto()`), so that driver fails to compile while
        // libelizainference.so builds fine. Don't let a broken auxiliary CLI
        // abort the build that produces the lib we need; warn and continue.
        if (CRITICAL_EXTRA_TARGETS.has(extraTarget)) throw err;
        log(
          `[compile-libllama] WARN: auxiliary cmake target ${extraTarget} failed to build for ${abi}; ` +
            `continuing — it bundles nothing into the APK and libllama.so/libelizainference.so are unaffected. ` +
            `Cause: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // llama-server target. Built in a second --target invocation so a future
  // operator can disable it via a flag without touching the libllama target.
  // The target name is `llama-server` on the apothic fork (verified against
  // the upstream b8198 examples/server/CMakeLists.txt: `add_executable(
  // ${TARGET} server.cpp ...)` with `set(TARGET llama-server)`).
  //
  // Non-fused builds: non-fatal. llama-server is the optional AOSP
  // MTP/spec-decode HTTP path, and the required in-process libs below
  // (libllama.so/libggml*.so) are verified separately. On the musl cross-link
  // this target can fail to resolve its httplib/OpenSSL deps (undefined
  // `httplib::*` / `SSLClient` symbols); stage-android-agent then warns about
  // the missing server and runtime falls back to the non-MTP path.
  // Fused builds (`llamaServerRequired`): fatal, because verifyFusedSymbols
  // requires the product llama-server in the install dir.
  log(`[compile-libllama] Compiling llama-server for ${abi} with -j${jobs}`);
  try {
    spawn(
      "cmake",
      ["--build", buildDir, "--target", "llama-server", "-j", String(jobs)],
      {},
    );
  } catch (err) {
    if (llamaServerRequired) {
      throw new Error(
        `[compile-libllama] llama-server failed to build for ${targetName || abi}; ` +
          `fused targets require it (verifyFusedSymbols checks the installed server).`,
        { cause: err },
      );
    }
    log(
      `[compile-libllama] WARN: llama-server failed to build for ${abi}; ` +
        `continuing without it — the runtime falls back to the non-MTP path; libllama.so is unaffected. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // libllama.so and the ggml shared-library family are all transitive build
  // products of the `llama` target. b4500's NEEDED chain (verified via
  // `readelf -d`):
  //   libllama.so -> libggml.so, libggml-cpu.so, libggml-base.so, libc.so
  //   libggml.so   -> libggml-cpu.so, libggml-base.so, libc.so
  // We co-copy every libggml*.so we find under the build tree alongside
  // libllama.so so the dynamic linker resolves the whole graph from the
  // per-ABI asset dir at runtime (LD_LIBRARY_PATH set by
  // ElizaAgentService.java).
  // Static-fuse (BUILD_SHARED_LIBS=OFF — the `*-fused` targets): llama/ggml/
  // mtmd build as STATIC `.a` archives folded into a self-contained
  // libelizainference.so (no DT_NEEDED on libllama.so/libggml*.so). The Android
  // Vulkan backend is the exception: ggml-vulkan is a runtime backend .so, not a
  // folded static archive, and must ship beside libelizainference.so so the GPU
  // backend actually loads on device. The non-fused (BUILD_SHARED_LIBS=ON) bulk
  // `--abi` path keeps staging the shared family verbatim for its
  // libllama.so-loading consumers.
  const isStaticFused = extraCmakeFlags.some((f) =>
    /BUILD_SHARED_LIBS\s*=\s*OFF/i.test(String(f)),
  );

  fs.mkdirSync(abiAssetDir, { recursive: true });
  let llamaOut = null;
  let ggmlOuts = [];
  let runtimeSiblingOuts = [];
  const sonameAliases = [];
  if (!isStaticFused) {
    const builtLlama = locateBuiltLib(buildDir, "libllama.so");
    if (!builtLlama) {
      throw new Error(
        `[compile-libllama] Could not locate built libllama.so anywhere under ${buildDir}.`,
      );
    }
    const builtGgmlLibs = locateBuiltGgmlLibs(buildDir);
    if (builtGgmlLibs.length === 0) {
      throw new Error(
        `[compile-libllama] Could not locate any libggml*.so under ${buildDir}. ` +
          `libllama.so has NEEDED entries for the ggml family; without co-copying ` +
          `them the runtime dlopen will fail. Check that BUILD_SHARED_LIBS=ON took effect.`,
      );
    }
    const builtRuntimeSiblingLibs = ["libllama-common.so", "libmtmd.so"]
      .map((name) => locateBuiltLib(buildDir, name))
      .filter(Boolean);

    llamaOut = path.join(abiAssetDir, "libllama.so");
    fs.copyFileSync(builtLlama, llamaOut);
    ggmlOuts = builtGgmlLibs.map((src) => {
      const dst = path.join(abiAssetDir, path.basename(src));
      fs.copyFileSync(src, dst);
      return dst;
    });
    runtimeSiblingOuts = builtRuntimeSiblingLibs.map((src) => {
      const dst = path.join(abiAssetDir, path.basename(src));
      fs.copyFileSync(src, dst);
      return dst;
    });

    // The apothic fork builds with SONAME chains: libllama.so has
    // SONAME=libllama.so.0 and NEEDED entries pointing at SONAME (e.g.
    // "libggml.so.0"), not at the unversioned filename. The dynamic linker
    // matches NEEDED against on-disk SONAME, so we must ship a copy at
    // libfoo.so.0 (or the linker fails to resolve and dlopen returns NULL).
    // We do NOT ship the .so.X.Y.Z versioned tail — only the SONAME alias
    // that NEEDED references.
    for (const out of [llamaOut, ...ggmlOuts, ...runtimeSiblingOuts]) {
      const soname = readSoname(out);
      if (soname && soname !== path.basename(out)) {
        const aliasPath = path.join(abiAssetDir, soname);
        fs.copyFileSync(out, aliasPath);
        sonameAliases.push(aliasPath);
        log(
          `[compile-libllama] Copied ${path.basename(out)} -> ${soname} ` +
            `(NEEDED-resolution alias for ${abi}).`,
        );
      }
    }
  }

  let staticFusedRuntimeBackendOuts = [];

  // Locate + stage the llama-server binary. cmake puts it under
  // `<build>/bin/llama-server` for upstream b8198 (and the apothic fork
  // inherits the same install layout). Some older pins drop it at
  // `<build>/llama-server`; check both.
  const llamaServerSrcCandidates = [
    path.join(buildDir, "bin", "llama-server"),
    path.join(buildDir, "llama-server"),
  ];
  const llamaServerSrc = llamaServerSrcCandidates.find((c) => fs.existsSync(c));
  let llamaServerOut = null;
  if (llamaServerSrc) {
    llamaServerOut = path.join(abiAssetDir, "llama-server");
    fs.copyFileSync(llamaServerSrc, llamaServerOut);
    fs.chmodSync(llamaServerOut, 0o755);
    log(
      `[compile-libllama] Copied llama-server for ${abi} (${(fs.statSync(llamaServerOut).size / (1024 * 1024)).toFixed(2)} MB).`,
    );
  } else if (llamaServerRequired) {
    throw new Error(
      `[compile-libllama] llama-server binary not found under ${buildDir}/bin/ or ${buildDir}/ ` +
        `for ${targetName || abi}; fused targets require it (verifyFusedSymbols checks the installed server).`,
    );
  } else {
    log(
      `[compile-libllama] WARN: llama-server binary not found under ${buildDir}/bin/ or ${buildDir}/. ` +
        `MTP speculative decode on AOSP requires it; rebuild with -DLLAMA_BUILD_SERVER=ON.`,
    );
  }

  // Stage the fused-build artifacts when they are present: libelizainference.so
  // (the SHARED target the cmake graft declares) plus the legacy CLI smoke
  // target llama-omnivoice-server. We do NOT throw when these are missing —
  // a non-fused build (extraBuildTargets empty) won't produce them, and the
  // caller is responsible for invoking `verifyFusedSymbols` only on fused
  // targets. Mirrors the mtp install-loop's conditional copy of the same
  // pair.
  const fusedLibSrcCandidates = [
    path.join(buildDir, "libelizainference.so"),
    path.join(buildDir, "src", "libelizainference.so"),
    path.join(buildDir, "bin", "libelizainference.so"),
  ];
  const fusedLibSrc =
    fusedLibSrcCandidates.find((c) => fs.existsSync(c)) ??
    locateBuiltLib(buildDir, "libelizainference.so");
  let fusedLibOut = null;
  if (fusedLibSrc) {
    fusedLibOut = path.join(abiAssetDir, "libelizainference.so");
    fs.copyFileSync(fusedLibSrc, fusedLibOut);
    log(
      `[compile-libllama] Copied libelizainference.so for ${abi} (${(fs.statSync(fusedLibOut).size / (1024 * 1024)).toFixed(2)} MB).`,
    );
  }
  // Under static-fuse the self-contained libelizainference.so is the ONLY
  // shipped native lib (no libllama.so/libggml*.so), so its absence is fatal.
  if (isStaticFused && !fusedLibOut) {
    throw new Error(
      `[compile-libllama] static-fuse build for ${abi} produced no libelizainference.so ` +
        `under ${buildDir}. The fused self-contained lib is the only artifact this ` +
        `target ships — verify the elizainference cmake target built.`,
    );
  }
  staticFusedRuntimeBackendOuts = isStaticFused
    ? stageStaticFusedRuntimeBackendLibs({
        buildDir,
        abiAssetDir,
        target: targetName,
        fusedLibPath: fusedLibOut,
        log,
      })
    : [];
  const fusedServerSrcCandidates = [
    path.join(buildDir, "bin", "llama-omnivoice-server"),
    path.join(buildDir, "llama-omnivoice-server"),
  ];
  const fusedServerSrc = fusedServerSrcCandidates.find((c) => fs.existsSync(c));
  let fusedServerOut = null;
  if (fusedServerSrc) {
    fusedServerOut = path.join(abiAssetDir, "llama-omnivoice-server");
    fs.copyFileSync(fusedServerSrc, fusedServerOut);
    fs.chmodSync(fusedServerOut, 0o755);
    log(
      `[compile-libllama] Copied llama-omnivoice-server for ${abi} (${(fs.statSync(fusedServerOut).size / (1024 * 1024)).toFixed(2)} MB).`,
    );
  }

  const stripTargets = [
    ...ggmlOuts,
    ...runtimeSiblingOuts,
    ...staticFusedRuntimeBackendOuts,
    llamaOut,
    ...sonameAliases,
  ].filter(Boolean); // llamaOut is null under static-fuse (no shared libllama.so)
  if (llamaServerOut) stripTargets.push(llamaServerOut);
  if (fusedLibOut) stripTargets.push(fusedLibOut);
  if (fusedServerOut) stripTargets.push(fusedServerOut);
  for (const out of stripTargets) {
    const sizeBefore = fs.statSync(out).size;
    const stripped = stripBinary({ filePath: out, zigBin, log });
    if (stripped) {
      const sizeAfter = fs.statSync(out).size;
      if (sizeAfter === 0) {
        throw new Error(
          `[compile-libllama] Strip produced an empty file at ${out} ` +
            `(was ${sizeBefore} bytes). This is the zig objcopy in-place ` +
            `truncation bug — the script is supposed to strip out-of-place.`,
        );
      }
      log(
        `[compile-libllama] Stripped ${path.basename(out)} for ${abi} (${sizeBefore} -> ${sizeAfter} bytes).`,
      );
    }
  }
  // Re-chmod executables after strip — system strip may reset perms.
  if (llamaServerOut) fs.chmodSync(llamaServerOut, 0o755);
  if (fusedServerOut) fs.chmodSync(fusedServerOut, 0o755);
  return {
    llama: llamaOut,
    ggml: ggmlOuts,
    runtimeBackends: staticFusedRuntimeBackendOuts,
    llamaServer: llamaServerOut,
    elizainference: fusedLibOut,
    omnivoiceServer: fusedServerOut,
  };
}

/**
 * Stage runtime backend shared objects that still exist in static-fused builds.
 * Most llama/ggml products are folded into libelizainference.so when
 * BUILD_SHARED_LIBS=OFF. If a backend still emits a separate shared object,
 * stage it; otherwise require marker evidence that the Vulkan backend was
 * linked into the fused library.
 */
export function stageStaticFusedRuntimeBackendLibs({
  buildDir,
  abiAssetDir,
  target,
  fusedLibPath = null,
  log = () => {},
}) {
  if (!String(target).includes("vulkan")) return [];
  const vulkanBackend = locateBuiltLib(buildDir, "libggml-vulkan.so");
  if (!vulkanBackend && !staticFusedLibCarriesVulkan(fusedLibPath)) {
    throw new Error(
      `[compile-libllama] static-fuse Vulkan target ${target} built no libggml-vulkan.so under ${buildDir}. ` +
        `It also lacks the static Vulkan/Mali mitigation marker in libelizainference.so. ` +
        `A Vulkan fused APK must either ship the ggml-vulkan runtime backend beside libelizainference.so ` +
        `or carry the statically-linked Vulkan backend inside libelizainference.so; otherwise it silently runs CPU-only.`,
    );
  }
  if (!vulkanBackend) {
    log(
      `[compile-libllama] ${target} carries ggml-vulkan statically inside libelizainference.so; no separate libggml-vulkan.so to stage.`,
    );
    return [];
  }
  fs.mkdirSync(abiAssetDir, { recursive: true });
  const out = path.join(abiAssetDir, "libggml-vulkan.so");
  fs.copyFileSync(vulkanBackend, out);
  log(
    `[compile-libllama] Copied libggml-vulkan.so for ${target} (${(fs.statSync(out).size / (1024 * 1024)).toFixed(2)} MB).`,
  );
  return [out];
}

function staticFusedLibCarriesVulkan(fusedLibPath) {
  if (!fusedLibPath || !fs.existsSync(fusedLibPath)) return false;
  const bytes = fs.readFileSync(fusedLibPath);
  return bytes.includes(Buffer.from("GGML_VK_FA_ALLOW_SUBGROUPS"));
}

/**
 * Find every `libggml*.so` under the build tree. b4500 shipped plain .so
 * files; the apothic fork (built off b8198) ships SONAME-versioned files
 * (e.g. `libggml.so.0.9.7`) plus an unversioned symlink chain
 * (`libggml.so` -> `libggml.so.0` -> `libggml.so.0.9.7`).
 *
 * Strategy: collect the unversioned `libggml*.so` symlink (matched by
 * exact `.so` suffix — `.so.0` and `.so.0.9.7` are skipped) and copy via
 * `fs.copyFileSync`, which follows the symlink and writes a real file at
 * the asset destination. The asset dir then carries a regular `.so` file
 * the dynamic linker can resolve directly via NEEDED entries — no need
 * to ship the SONAME chain into the APK.
 */
function locateBuiltGgmlLibs(buildDir) {
  const found = new Set();
  const stack = [buildDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (
          entry.name === "_deps" ||
          entry.name === "CMakeFiles" ||
          entry.name.startsWith(".")
        ) {
          continue;
        }
        stack.push(path.join(dir, entry.name));
      } else if (
        // Accept both regular files (older pins) and symlinks (b8198+
        // ships SONAME chains). Match `libggml*.so` exactly — the
        // `.so.0` / `.so.X.Y.Z` SONAME copies are skipped because we
        // want the unversioned entry the dynamic linker resolves at
        // NEEDED-time.
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name.startsWith("libggml") &&
        entry.name.endsWith(".so")
      ) {
        found.add(path.join(dir, entry.name));
      }
    }
  }
  return [...found];
}

/**
 * Parse the DT_SONAME entry from a shared object's `.dynamic` section
 * without spawning a subprocess. Returns the SONAME string (e.g.
 * `"libllama.so.0"`) or `null` when absent or unparseable.
 *
 * Why parse manually instead of running `readelf -d`:
 *   - `readelf` may not be on PATH on every CI/dev host.
 *   - The script already runs in zig-cc / cmake mode; adding a third
 *     external dependency is friction.
 *   - The encoding is well-defined: ELF64, little-endian (zig builds
 *     always produce LSB), find PT_DYNAMIC via PHDR table, walk
 *     d_tag/d_un pairs looking for DT_SONAME (5), then index into
 *     DT_STRTAB (5)'s string table.
 *
 * Falls back to null on any parse error so the caller can decide
 * whether to fail loud (NEEDED missing) or proceed.
 *
 * Exported for unit tests.
 */
export function readSoname(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(64); // ELF64 header is 64 bytes
    fs.readSync(fd, head, 0, 64, 0);
    if (
      head[0] !== 0x7f ||
      head[1] !== 0x45 ||
      head[2] !== 0x4c ||
      head[3] !== 0x46
    ) {
      return null; // not ELF
    }
    const eiClass = head[4]; // 1=ELF32, 2=ELF64
    if (eiClass !== 2) return null;
    const eiData = head[5]; // 1=LSB, 2=MSB
    if (eiData !== 1) return null;
    const phoff = Number(head.readBigUInt64LE(0x20));
    const phentsize = head.readUInt16LE(0x36);
    const phnum = head.readUInt16LE(0x38);

    // Find PT_DYNAMIC (p_type = 2)
    const phbuf = Buffer.alloc(phentsize * phnum);
    fs.readSync(fd, phbuf, 0, phbuf.length, phoff);
    let dynOff = -1;
    let dynSize = 0;
    for (let i = 0; i < phnum; i += 1) {
      const off = i * phentsize;
      const ptype = phbuf.readUInt32LE(off);
      if (ptype === 2) {
        dynOff = Number(phbuf.readBigUInt64LE(off + 0x08));
        dynSize = Number(phbuf.readBigUInt64LE(off + 0x20));
        break;
      }
    }
    if (dynOff < 0) return null;

    const dynBuf = Buffer.alloc(dynSize);
    fs.readSync(fd, dynBuf, 0, dynSize, dynOff);
    let sonameStrOff = -1;
    let strtabAddr = -1;
    let strtabSize = -1;
    // Walk DT_NEEDED (1), DT_STRTAB (5), DT_SONAME (14), DT_STRSZ (10)
    for (let i = 0; i < dynSize; i += 16) {
      const dTag = Number(dynBuf.readBigInt64LE(i));
      const dUn = Number(dynBuf.readBigUInt64LE(i + 8));
      if (dTag === 0) break; // DT_NULL
      if (dTag === 14) sonameStrOff = dUn; // DT_SONAME
      if (dTag === 5) strtabAddr = dUn; // DT_STRTAB
      if (dTag === 10) strtabSize = dUn; // DT_STRSZ
    }
    if (sonameStrOff < 0 || strtabAddr < 0 || strtabSize < 0) return null;

    // DT_STRTAB is a virtual address; we need the file offset. Walk PHDRs
    // again to find the LOAD segment containing strtabAddr.
    let strtabFileOff = -1;
    for (let i = 0; i < phnum; i += 1) {
      const off = i * phentsize;
      const ptype = phbuf.readUInt32LE(off);
      if (ptype !== 1) continue; // PT_LOAD
      const pOffset = Number(phbuf.readBigUInt64LE(off + 0x08));
      const pVaddr = Number(phbuf.readBigUInt64LE(off + 0x10));
      const pFilesz = Number(phbuf.readBigUInt64LE(off + 0x20));
      if (strtabAddr >= pVaddr && strtabAddr < pVaddr + pFilesz) {
        strtabFileOff = pOffset + (strtabAddr - pVaddr);
        break;
      }
    }
    if (strtabFileOff < 0) return null;

    const strBuf = Buffer.alloc(strtabSize);
    fs.readSync(fd, strBuf, 0, strtabSize, strtabFileOff);
    if (sonameStrOff >= strtabSize) return null;
    const end = strBuf.indexOf(0, sonameStrOff);
    if (end < 0) return null;
    return strBuf.toString("utf8", sonameStrOff, end);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function locateBuiltLib(buildDir, soName) {
  // Known cmake output dirs for llama.cpp b3490: libllama.so lands under
  // build/src, libggml.so lands under build/ggml/src. Other layouts are
  // possible if cmake's RUNTIME_OUTPUT_DIRECTORY changes upstream.
  const candidates = [
    path.join(buildDir, "src", soName),
    path.join(buildDir, "ggml", "src", soName),
    path.join(buildDir, soName),
    path.join(buildDir, "bin", soName),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fallback: BFS through the build tree (skip CMake internals + _deps).
  const stack = [buildDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (
          entry.name === "_deps" ||
          entry.name === "CMakeFiles" ||
          entry.name.startsWith(".")
        ) {
          continue;
        }
        stack.push(path.join(dir, entry.name));
      } else if (
        // Accept files OR symlinks — the apothic fork builds with
        // SONAME chains where the unversioned `lib*.so` is a symlink.
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name === soName
      ) {
        return path.join(dir, entry.name);
      }
    }
  }
  return null;
}

/**
 * Strip a shared object out-of-place, then atomically rename over the
 * original. zig 0.13's `zig objcopy --strip-all <src> <dst>` truncates dst
 * to 0 BEFORE it reads src when src == dst — the in-place pattern leaves
 * an empty file and a non-zero exit. Out-of-place is correct on every
 * platform (and is also what GNU strip does internally for cross-binaries).
 *
 * Falls back to system `strip --strip-all <file>` (in-place safe on
 * GNU coreutils) if `zig objcopy` is missing or errors.
 */
// Cache of the resolved llvm-strip path (from the Android NDK toolchain).
// Set once on first call so we don't re-walk the NDK dir for every artifact.
let _ndkLlvmStripPathCache;
function locateNdkLlvmStrip() {
  if (_ndkLlvmStripPathCache !== undefined) return _ndkLlvmStripPathCache;
  // Honor the same env-var ladder as build-llama-cpp-mtp's resolveAndroidNdk()
  // so operators with a custom NDK location get a consistent answer in both
  // scripts.
  const envRoots = [
    process.env.ANDROID_NDK_HOME,
    process.env.ANDROID_NDK_ROOT,
    process.env.ANDROID_NDK,
  ].filter((v) => typeof v === "string" && v.length > 0);
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
  ].filter((v) => typeof v === "string" && v.length > 0);
  const candidateNdks = [...envRoots];
  for (const sdk of sdkRoots) {
    const ndkDir = path.join(sdk, "ndk");
    if (!fs.existsSync(ndkDir)) continue;
    const versions = fs
      .readdirSync(ndkDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    if (versions.length > 0) {
      candidateNdks.push(path.join(ndkDir, versions[versions.length - 1]));
    }
  }
  const hosts = ["linux-x86_64", "darwin-arm64", "darwin-x86_64"];
  for (const ndk of candidateNdks) {
    for (const host of hosts) {
      const cand = path.join(
        ndk,
        "toolchains",
        "llvm",
        "prebuilt",
        host,
        "bin",
        "llvm-strip",
      );
      if (fs.existsSync(cand)) {
        _ndkLlvmStripPathCache = cand;
        return cand;
      }
    }
  }
  _ndkLlvmStripPathCache = null;
  return null;
}

function stripBinary({ filePath, zigBin, log }) {
  const tmpPath = `${filePath}.stripped`;
  const zigStripResult = spawnSync(
    zigBin,
    ["objcopy", "--strip-all", filePath, tmpPath],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (zigStripResult.status === 0 && fs.existsSync(tmpPath)) {
    const tmpSize = fs.statSync(tmpPath).size;
    if (tmpSize > 0) {
      fs.renameSync(tmpPath, filePath);
      return true;
    }
    // Defensive: zig wrote a zero-byte file. Discard and fall through to
    // system strip — better to ship with symbols than ship empty.
    log(
      `[compile-libllama] DEBUG: zig objcopy produced an empty ${path.basename(tmpPath)}; ` +
        `falling back to system strip.`,
    );
    fs.rmSync(tmpPath, { force: true });
  } else if (fs.existsSync(tmpPath)) {
    log(
      `[compile-libllama] DEBUG: zig objcopy failed (status=${zigStripResult.status}, ` +
        `error=${zigStripResult.error?.message ?? "none"}); falling back to system strip.`,
    );
    fs.rmSync(tmpPath, { force: true });
  } else if (zigStripResult.status !== 0) {
    log(
      `[compile-libllama] DEBUG: zig objcopy unavailable or failed (status=${zigStripResult.status}, ` +
        `error=${zigStripResult.error?.message ?? "none"}); falling back to system strip.`,
    );
  }
  // Fallback 1: system strip. GNU coreutils strip is in-place safe.
  // x86_64-binutils doesn't grok riscv64 ELF or aarch64 ELF, so on a
  // mismatched host this returns non-zero — fall through to llvm-strip.
  const systemStripResult = spawnSync("strip", ["--strip-all", filePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (systemStripResult.status === 0) return true;
  // Fallback 2: NDK's llvm-strip handles every Android ABI (arm64-v8a,
  // x86_64, riscv64) including cross-host. This is the production path
  // for riscv64 until Zig 0.14's objcopy lands across all build hosts.
  const llvmStrip = locateNdkLlvmStrip();
  if (llvmStrip) {
    const llvmStripResult = spawnSync(llvmStrip, ["--strip-all", filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (llvmStripResult.status === 0) return true;
    log(
      `[compile-libllama] DEBUG: NDK llvm-strip (${llvmStrip}) failed ` +
        `(status=${llvmStripResult.status}, error=${llvmStripResult.error?.message ?? "none"}).`,
    );
  }
  log(
    `[compile-libllama] WARN: could not strip ${filePath}; shipping with debug symbols.`,
  );
  return false;
}

/**
 * Stage prebuilt LiteRT-LM `.litertlm` text artifacts into the on-device
 * bundle assets, parallel to the `.so` libs this script stages and the `.gguf`
 * models `stage-default-models.ts` stages. The destination is
 * `<androidAssetsDir>/models/text/` — the same `text/` subdir the GGUF text
 * weights land in (`models/text/eliza-1-<tier>-128k.gguf`) and the path the
 * C-side `llm_backend_select` / `find_litertlm_artifact` probes at runtime
 * (`<bundleRoot>/text/*.litertlm`, see
 * `tools/omnivoice/src/backends/litert-backend.cpp`).
 *
 * GGUF stays the default: when no `litertlmDir` is configured (no
 * `--litertlm-dir` / `ELIZA_LITERTLM_DIR`) or the dir holds no `.litertlm`,
 * this is a no-op and the bundle is byte-identical to a GGUF-only build. A
 * configured dir that does not exist is a hard error (the operator asked for
 * LiteRT staging but pointed us at nothing — don't silently ship GGUF-only).
 *
 * `.litertlm` artifacts are model files, arch-independent like the GGUFs, so
 * they are staged ONCE into the shared `models/text/` dir — not per-ABI.
 *
 * Exported for unit tests.
 */
export function stageLitertlmArtifacts({
  litertlmDir,
  androidAssetsDir,
  log = console.log,
  dryRun = false,
}) {
  if (!litertlmDir) return [];
  if (!fs.existsSync(litertlmDir)) {
    throw new Error(
      `[compile-libllama] --litertlm-dir ${litertlmDir} does not exist. ` +
        `Point it at a directory of prebuilt .litertlm artifacts, or omit it to ` +
        `ship the GGUF-only bundle.`,
    );
  }
  const artifacts = fs
    .readdirSync(litertlmDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".litertlm"))
    .map((e) => e.name);
  if (artifacts.length === 0) {
    log(
      `[compile-libllama] No .litertlm artifacts under ${litertlmDir}; LiteRT ` +
        `staging is a no-op (GGUF-only bundle).`,
    );
    return [];
  }
  const textDir = path.join(androidAssetsDir, "models", "text");
  if (dryRun) {
    log(
      `[compile-libllama] (dry-run) would stage ${artifacts.length} .litertlm ` +
        `artifact(s) into ${textDir}: ${artifacts.join(", ")}`,
    );
    return artifacts.map((name) => path.join(textDir, name));
  }
  fs.mkdirSync(textDir, { recursive: true });
  const staged = [];
  for (const name of artifacts) {
    const src = path.join(litertlmDir, name);
    const dst = path.join(textDir, name);
    fs.copyFileSync(src, dst);
    staged.push(dst);
    log(
      `[compile-libllama] Staged LiteRT artifact ${name} -> ${dst} ` +
        `(${(fs.statSync(dst).size / (1024 * 1024)).toFixed(2)} MB).`,
    );
  }
  return staged;
}

/**
 * Print the dry-run plan for one `android-<arch>-<backend>[-fused]` target:
 * the cmake invocation, the post-cmake build target list, the graft steps
 * (for fused targets), the expected output file layout, and the post-build
 * verify step (for fused targets). Mirrors the structure of the mtp build
 * script's --dry-run output so the two paths read the same.
 *
 * Exported for tests so the dry-run rendering can be asserted without going
 * through the CLI entry point.
 */
export function describeAndroidTargetDryRun({
  target,
  srcDir,
  cacheDir,
  abiAssetDir,
  jobs,
  log = console.log,
}) {
  const parsed = parseAndroidTarget(target.target ?? target);
  const abiTarget = ABI_TARGETS.find((t) => t.androidAbi === parsed.androidAbi);
  if (!abiTarget) {
    throw new Error(
      `[compile-libllama] No ABI mapping for ${parsed.androidAbi}`,
    );
  }
  const buildDir = path.join(srcDir, `build-${parsed.androidAbi}`);
  const driverDir = path.join(cacheDir, "zig-driver", parsed.androidAbi);
  const ccPath = path.join(driverDir, "zig-cc");
  const cxxPath = path.join(driverDir, "zig-cxx");
  const arPath = path.join(driverDir, "zig-ar");
  const ranlibPath = path.join(driverDir, "zig-ranlib");
  log(`[compile-libllama] (dry-run) target=${parsed.target}`);
  log(`  zig-target=${abiTarget.zigTarget} android-abi=${parsed.androidAbi}`);
  log(`  src=${srcDir}`);
  log(`  build=${buildDir}`);
  log(`  install=${abiAssetDir}`);
  if (parsed.androidAbi === "arm64-v8a") {
    log(
      `  zig requirement: ${AARCH64_MUSL_ZIG_MIN_VERSION} <= version < ` +
        `${AARCH64_MUSL_ZIG_MAX_VERSION_EXCLUSIVE} (aarch64-linux-musl pin)`,
    );
  }
  if (parsed.fused) {
    log(`  omnivoice: merged in-fork path (tools/omnivoice/)`);
  }
  // riscv64 build flags must show up in dry-run output too. The real
  // buildLibllamaForAbi() resolves these from the detected Zig version;
  // resolveRiscv64BuildPlan() falls back to scalar when zig is not installed
  // (dry-run is allowed on toolchain-less boxes), so the plan reported here
  // mirrors what a build invocation would actually emit on the same host.
  let riscv64BuildFlags = [];
  if (parsed.androidAbi === "riscv64") {
    const plan = resolveRiscv64BuildPlan({ env: process.env, isDryRun: true });
    log(
      `  riscv64 plan: zig=${plan.zigVersion ?? "unknown"} ` +
        `rvv=${plan.rvv ? "ON" : "OFF"} ` +
        `all-variants=${plan.allVariants ? "ON" : "OFF"} ` +
        `reason=${plan.reason}`,
    );
    riscv64BuildFlags = riscv64CmakeFlagsForPlan({
      abi: parsed.androidAbi,
      plan,
    });
  }
  // The Vulkan paths are resolved (and headers staged) only by a real build,
  // so the dry-run shows the same flag set with symbolic path values.
  const vulkanCmakeFlags =
    parsed.backend === "vulkan"
      ? androidVulkanCmakeFlags({
          includeDir: path.join(cacheDir, "vulkan-headers"),
          glslc: "<ndk>/shader-tools/<host>/glslc",
          libVulkan:
            "<ndk-sysroot>/usr/lib/aarch64-linux-android/<api>/libvulkan.so",
          spirvHeadersDir: "<SPIRV-Headers cmake config dir>",
        })
      : [];
  // Same builder as buildLibllamaForAbi(), with the same extra-flag layering
  // mainTargets() passes (fused flags, then Vulkan flags).
  const cmakeFlags = libllamaCmakeConfigureArgs({
    srcDir,
    buildDir,
    abi: parsed.androidAbi,
    drivers: { ccPath, cxxPath, arPath, ranlibPath },
    riscv64BuildFlags,
    extraCmakeFlags: [
      ...(parsed.fused ? fusedExtraCmakeFlags() : []),
      ...vulkanCmakeFlags,
    ],
  });
  log(`  cmake ${cmakeFlags.join(" ")}`);
  const buildTargets = [
    ...(parsed.fused ? fusedCmakeBuildTargets() : ["llama", "llama-server"]),
    ...(parsed.backend === "vulkan" ? ["ggml-vulkan"] : []),
  ];
  log(
    `  cmake --build ${buildDir} --target ${buildTargets.join(" ")} -j ${jobs}`,
  );
  log(`  expected output layout under ${abiAssetDir}:`);
  if (parsed.fused) {
    log(`    libelizainference.so`);
    if (parsed.backend === "vulkan") {
      log(
        `    ggml-vulkan backend (separate libggml-vulkan.so if emitted, otherwise static marker in libelizainference.so)`,
      );
    }
  } else {
    log(`    libllama.so libggml*.so llama-server`);
  }
  if (parsed.fused) {
    log(`    omnivoice-tts omnivoice-codec (merged-tree auxiliary artifacts)`);
    log(
      `  verifyFusedSymbols outDir=${abiAssetDir} target=${parsed.target} (post-build)`,
    );
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  // If --target was passed, the caller is asking for the mtp-style
  // explicit-triple build path. --abi still drives the legacy bulk-build
  // (cpu only, no fusion) entry point so existing callers keep working.
  if (args.targets.length > 0) {
    return mainTargets(args);
  }

  // Probe toolchain first so we fail loudly before doing any work. Skip in
  // dry-run mode — operators on a box without zig still want to inspect what
  // the build WOULD do.
  if (!args.dryRun) {
    const zigVersion = probeZig();
    console.log(`[compile-libllama] Found zig ${zigVersion}`);
    assertZigPinForTargets({
      version: zigVersion,
      zigTriples: zigTriplesForAbis(args.abis),
    });
  } else {
    console.log(`[compile-libllama] (dry-run) skipping zig toolchain probe`);
  }

  let allPresent = true;
  for (const abi of args.abis) {
    const llama = path.join(args.androidAssetsDir, abi, "libllama.so");
    const ggml = path.join(args.androidAssetsDir, abi, "libggml.so");
    const llamaServer = path.join(args.androidAssetsDir, abi, "llama-server");
    if (
      !fs.existsSync(llama) ||
      !fs.existsSync(ggml) ||
      !fs.existsSync(llamaServer)
    ) {
      allPresent = false;
      break;
    }
  }
  if (args.skipIfPresent && allPresent) {
    console.log(
      "[compile-libllama] All requested libllama.so files already present; --skip-if-present honoured.",
    );
    return;
  }
  if (args.dryRun) {
    console.log(
      "[compile-libllama] (dry-run) bulk --abi mode requested; emit dry-run for each ABI as a non-fused android-<arch>-cpu target",
    );
    const srcDirForDry =
      args.srcDir ??
      (llamaCppSubmodulePresent() ? LLAMA_CPP_SUBMODULE_DIR : args.cacheDir);
    for (const abi of args.abis) {
      // arm64-v8a is the only ANDROID_ABI that doesn't share its name with
      // the `android-<arch>-cpu` triple's <arch> token; x86_64 and riscv64
      // map 1:1 to the same string in both spellings. Keep this in sync
      // with parseAndroidTarget()'s arch→ABI mapping.
      const arch = abi === "arm64-v8a" ? "arm64" : abi;
      const target = `android-${arch}-cpu`;
      const abiAssetDir = path.join(args.androidAssetsDir, abi);
      describeAndroidTargetDryRun({
        target,
        srcDir: srcDirForDry,
        cacheDir: args.cacheDir,
        abiAssetDir,
        jobs: args.jobs,
      });
    }
    return;
  }

  let srcDir;
  let srcDescription;
  if (args.srcDir) {
    if (!fs.existsSync(path.join(args.srcDir, "CMakeLists.txt"))) {
      throw new Error(
        `[compile-libllama] --src-dir ${args.srcDir} does not contain a CMakeLists.txt; ` +
          `expected a llama.cpp checkout.`,
      );
    }
    srcDir = args.srcDir;
    const isSubmodule =
      path.resolve(srcDir) === path.resolve(LLAMA_CPP_SUBMODULE_DIR);
    let headRef = "(unknown)";
    try {
      // A submodule's `.git` is a file (`gitdir: ...`), not a dir, so resolve
      // HEAD via `git rev-parse` rather than reading `.git/HEAD` directly.
      const out = spawnSync("git", ["-C", srcDir, "rev-parse", "HEAD"], {
        encoding: "utf8",
      });
      if (out.status === 0) headRef = out.stdout.trim();
    } catch {}
    if (isSubmodule) {
      // The in-repo submodule is pinned by the eliza repo's gitlink. Discard
      // the source patches a prior build left behind (tracked + untracked)
      // before re-applying them, so a fresh artifact starts from the pristine
      // submodule tree. Never detach/fetch — `bun install` keeps it pinned.
      console.log(
        `[compile-libllama] Using the in-repo llama.cpp submodule ${srcDir} ` +
          `(HEAD: ${headRef}); resetting prior source patches.`,
      );
      run("git", ["-C", srcDir, "checkout", "--", "."], {});
      run("git", ["-C", srcDir, "clean", "-fdx"], {});
      assertSwaSpecDecodeFallback({ srcDir });
      srcDescription = `submodule plugins/plugin-local-inference/native/llama.cpp @ ${headRef.slice(0, 12)}`;
    } else {
      console.log(
        `[compile-libllama] Using --src-dir ${srcDir} (HEAD: ${headRef}); ` +
          `pinned tag ${LLAMA_CPP_TAG} ignored.`,
      );
      assertSwaSpecDecodeFallback({ srcDir });
      srcDescription = `external src-dir ${srcDir}`;
    }
  } else {
    srcDir = ensureLlamaCppCheckout({
      cacheDir: args.cacheDir,
      log: console.log,
      spawn: run,
    });
    srcDescription = `llama.cpp ${LLAMA_CPP_TAG} / ${LLAMA_CPP_COMMIT.slice(0, 12)}`;
  }

  for (const abi of args.abis) {
    const abiAssetDir = path.join(args.androidAssetsDir, abi);
    // Builds + stages libllama.so + the libggml*.so family + llama-server.
    // libllama.so + libggml*.so are runtime DT_NEEDED dependencies of the
    // fused libelizainference.so (the fork's `elizainference` target does
    // `target_link_libraries(elizainference PUBLIC llama)` with
    // BUILD_SHARED_LIBS=ON), so they stay required even though no TS adapter
    // dlopens libllama.so directly anymore.
    buildLibllamaForAbi({
      srcDir,
      cacheDir: args.cacheDir,
      abi,
      abiAssetDir,
      jobs: args.jobs,
      log: console.log,
      spawn: run,
    });
  }

  // Cross-compile the SIGSYS-handler shim + loader-wrap for x86_64. ARM64
  // skips this — its kernel ABI omits the legacy non-AT syscalls Android's
  // x86_64 seccomp filter traps on, so musl's wrappers there never invoke
  // a form the filter could block. The compile-shim main() short-circuits
  // when --skip-if-present is honoured.
  //
  // Staged into the APK by stage-android-agent.ts: the wrapper takes the
  // place of `ld-musl-x86_64.so.1`, and the original Alpine loader is
  // renamed to `.so.1.real`. See seccomp-shim/sigsys-handler.c header for
  // the production-landing checklist.
  await compileShimMain(["--skip-if-present"]);

  // Stage any prebuilt LiteRT-LM `.litertlm` text artifacts into the shared
  // on-device bundle assets (arch-independent, so once — not per ABI). No-op
  // unless --litertlm-dir / ELIZA_LITERTLM_DIR is configured; GGUF stays default.
  stageLitertlmArtifacts({
    litertlmDir: args.litertlmDir,
    androidAssetsDir: args.androidAssetsDir,
  });

  console.log(
    `[compile-libllama] Built libllama.so + libggml*.so + llama-server for ` +
      `${args.abis.join(", ")} (${srcDescription}).`,
  );
}

/**
 * Explicit-triple entry point: runs the build for one or more
 * `android-<arch>-<backend>[-fused]` targets. Mirrors the mtp build
 * script's `--target` semantics one-for-one so an operator running the
 * desktop fused build and the mobile fused build invokes the two scripts
 * with the same target string.
 *
 * Build flow per target:
 *   1. Resolve the llama.cpp source tree (--src-dir / in-repo submodule /
 *      standalone clone — same logic as the bulk --abi path).
 *   2. For `*-fused`: the merged in-fork tree at `tools/omnivoice/`
 *      already declares the omnivoice + elizainference targets; just add
 *      the CMake flags via `fusedExtraCmakeFlags()`.
 *   3. Run `buildLibllamaForAbi()` (which also configures + links the
 *      llama-server target — required for fused so omnivoice_lib links
 *      into the same binary).
 *   4. For `*-fused`: run `verifyFusedSymbols()` against the install dir,
 *      asserting libelizainference.so carries `llama_*` + `ov_*` +
 *      `eliza_inference_*` exports.
 *
 * Dry-run prints what each step WOULD do without touching the filesystem
 * or running cmake / the NDK.
 */
export async function mainTargets(args) {
  // Resolve the source dir up front so dry-run can report a real path.
  let srcDir;
  let srcDescription;
  if (args.srcDir) {
    if (
      !args.dryRun &&
      !fs.existsSync(path.join(args.srcDir, "CMakeLists.txt"))
    ) {
      throw new Error(
        `[compile-libllama] --src-dir ${args.srcDir} does not contain a CMakeLists.txt; ` +
          `expected a llama.cpp checkout.`,
      );
    }
    srcDir = args.srcDir;
    const isSubmodule =
      path.resolve(srcDir) === path.resolve(LLAMA_CPP_SUBMODULE_DIR);
    srcDescription = isSubmodule
      ? `submodule plugins/plugin-local-inference/native/llama.cpp`
      : `external src-dir ${srcDir}`;
    if (!args.dryRun) assertSwaSpecDecodeFallback({ srcDir });
  } else if (args.dryRun) {
    // In a dry run with no --src-dir and no submodule, just describe the
    // intended cache path; we never clone in dry-run.
    srcDir = args.cacheDir;
    srcDescription = `cache ${args.cacheDir} (would clone ${LLAMA_CPP_TAG})`;
  } else {
    srcDir = ensureLlamaCppCheckout({
      cacheDir: args.cacheDir,
      log: console.log,
      spawn: run,
    });
    srcDescription = `llama.cpp ${LLAMA_CPP_TAG} / ${LLAMA_CPP_COMMIT.slice(0, 12)}`;
  }

  if (
    !args.dryRun &&
    args.targets.some((target) => target.backend === "vulkan")
  ) {
    validateMaintainedVulkanSource({
      source: srcDir,
      expectedRevision: readPinnedNativeRevision(repoRoot),
    });
  }

  if (!args.dryRun) {
    const zigVersion = probeZig();
    console.log(`[compile-libllama] Found zig ${zigVersion}`);
    assertZigPinForTargets({
      version: zigVersion,
      zigTriples: zigTriplesForAbis(args.targets.map((t) => t.androidAbi)),
    });
  } else {
    console.log(`[compile-libllama] (dry-run) skipping zig toolchain probe`);
  }

  for (const parsed of args.targets) {
    const abiAssetDir = path.join(args.androidAssetsDir, parsed.androidAbi);
    if (args.dryRun) {
      describeAndroidTargetDryRun({
        target: parsed.target,
        srcDir,
        cacheDir: args.cacheDir,
        abiAssetDir,
        jobs: args.jobs,
      });
      continue;
    }

    // Vulkan source was admitted before toolchain work. Assemble the
    // GGML_VULKAN CMake flags (NDK glslc + headers + aarch64 loader). The
    // libggml-vulkan.so the build emits is glob-staged alongside the rest of
    // the libggml family by buildLibllamaForAbi.
    let vulkanCmakeFlags = [];
    if (parsed.backend === "vulkan") {
      console.log(
        `[compile-libllama] Using unchanged pinned Vulkan source from ${srcDir}`,
      );
      vulkanCmakeFlags = resolveAndroidVulkanCmakeFlags({
        stagingDir: path.join(args.cacheDir, "vulkan-headers"),
      });
    }

    // The existing per-ABI build helper handles the cmake configure +
    // build + per-ABI install for libllama + ggml + llama-server. We
    // reuse it as-is; the fused cmake flags + extra targets are applied
    // below via a thin override hook so the non-fused path stays
    // byte-for-byte identical.
    buildLibllamaForAbi({
      srcDir,
      cacheDir: args.cacheDir,
      abi: parsed.androidAbi,
      abiAssetDir,
      jobs: args.jobs,
      log: console.log,
      spawn: run,
      // The fused path needs `-DELIZA_FUSE_OMNIVOICE=ON` on the configure
      // line and the omnivoice-core + libelizainference + fused
      // llama-server targets on the build line. Pass-through hooks let
      // the caller layer those in without forking the helper. The Vulkan
      // target adds GGML_VULKAN=ON + the NDK toolchain paths and asks the
      // build to also produce ggml-vulkan (libggml-vulkan.so).
      extraCmakeFlags: [
        ...(parsed.fused ? fusedExtraCmakeFlags() : []),
        ...vulkanCmakeFlags,
      ],
      extraBuildTargets: [
        ...(parsed.fused
          ? fusedCmakeBuildTargets().filter(
              (t) => t !== "llama" && t !== "llama-server",
            )
          : []),
        ...(parsed.backend === "vulkan" ? ["ggml-vulkan"] : []),
      ],
      targetName: parsed.target,
      llamaServerRequired: parsed.fused,
    });

    // Post-build: for fused targets prove libelizainference.so exports both
    // `llama_*` and `ov_*` (and the eliza_inference ABI surface). Hard error
    // on a half-fused artifact — same contract as the mtp build path.
    if (parsed.fused) {
      const verification = verifyFusedSymbols({
        outDir: abiAssetDir,
        target: parsed.target,
      });
      console.log(
        `[compile-libllama] omnivoice symbol-verify: ` +
          `library=${verification.library} ` +
          `llama=${verification.llamaSymbolCount} ` +
          `omnivoice=${verification.omnivoiceSymbolCount} ` +
          `abi=${verification.abiSymbolCount}`,
      );
    }
  }

  if (args.dryRun) {
    stageLitertlmArtifacts({
      litertlmDir: args.litertlmDir,
      androidAssetsDir: args.androidAssetsDir,
      dryRun: true,
    });
    console.log(
      `[compile-libllama] (dry-run) plan complete: ${args.targets.length} target(s) (${srcDescription}).`,
    );
    return;
  }

  // SIGSYS-handler shim only needed when an x86_64 ABI was built (matches
  // the bulk --abi path's behavior — see the comment in main()).
  if (args.targets.some((t) => t.androidAbi === "x86_64")) {
    await compileShimMain(["--skip-if-present"]);
  }

  // Stage any prebuilt LiteRT-LM `.litertlm` text artifacts into the shared
  // on-device bundle assets (once — arch-independent). No-op unless
  // --litertlm-dir / ELIZA_LITERTLM_DIR is configured; GGUF stays the default.
  stageLitertlmArtifacts({
    litertlmDir: args.litertlmDir,
    androidAssetsDir: args.androidAssetsDir,
  });

  console.log(
    `[compile-libllama] Built ${args.targets.map((t) => t.target).join(", ")} (${srcDescription}).`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await main();
}
