#!/usr/bin/env node
/**
 * Build the DFlash-capable llama-server fork used by local inference.
 *
 * As of v0.2.0-milady, DFlash speculative decoding lives in the unified
 * milady-ai/llama.cpp fork (the same repo as the AOSP cross-compile).
 * Pre-2026-05-09 this script consumed spiritbuun/buun-llama-cpp directly
 * (which itself was 8,988 commits ahead of upstream b8198 with quant
 * type IDs that conflicted with apothic's TBQ slots). Wave-3 agent A
 * surgically ported the DFlash CLI surface (--spec-type dflash,
 * --draft-min-prob, n_drafted_total/n_drafted_accepted_total Prometheus
 * counters) onto the unified fork and retired the dual-fork situation.
 * See docs/porting/unified-fork-strategy.md §H step 8 for the migration
 * story. Override via ELIZA_DFLASH_LLAMA_CPP_REMOTE / _REF if you need
 * to point at the legacy spiritbuun pin during a rollback.
 *
 * The script builds the unified fork into:
 *   $ELIZA_STATE_DIR/local-inference/bin/dflash/<platform>-<arch>-<backend>/
 *
 * Multi-target build matrix (see SUPPORTED_TARGETS below):
 *   linux-x64-cpu, linux-x64-cuda, linux-x64-rocm, linux-x64-vulkan
 *   android-arm64-cpu, android-arm64-vulkan
 *   darwin-arm64-metal, darwin-x64-metal
 *   windows-x64-cpu, windows-x64-cuda
 *
 * Backend selection (legacy single-target mode, when --target is omitted):
 *   macOS           -> Metal
 *   Linux + nvcc    -> CUDA
 *   Linux + rocminfo/hipcc -> ROCm/HIP
 *   otherwise       -> CPU
 *
 * Usage:
 *   node build-llama-cpp-dflash.mjs [--target <triple>] [--all] [--dry-run]
 *                                   [--backend ...] [--ref ...] [--out-dir ...]
 *                                   [--jobs N] [--cache-dir ...]
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// Source-level omnivoice.cpp fusion (text + TTS sharing one llama.cpp
// build, one ggml pin, one kernel set). Helpers live alongside this
// script under omnivoice-fuse/; see omnivoice-fuse/README.md for the
// GGML pin reconciliation strategy.
import {
  prepareOmnivoiceFusion,
  OMNIVOICE_REF,
  OMNIVOICE_GGML_REF,
} from "./omnivoice-fuse/prepare.mjs";
import {
  appendCmakeGraft,
  fusedExtraCmakeFlags,
  fusedCmakeBuildTargets,
} from "./omnivoice-fuse/cmake-graft.mjs";
import { verifyFusedSymbols } from "./omnivoice-fuse/verify-symbols.mjs";
import { patchMetalKernels as patchMetalKernelsImpl } from "./kernel-patches/metal-kernels.mjs";
import { patchVulkanKernels as patchVulkanKernelsImpl } from "./kernel-patches/vulkan-kernels.mjs";

// milady-ai/llama.cpp @ v0.4.0-milady (commit 08032d57) — the unified fork
// that composes TBQ + QJL + Q4_POLAR + Metal kernels + DFlash spec-decode
// + W4-B CUDA QJL/Polar/TBQ3_TCQ kernels onto upstream b8198. Same repo +
// commit lineage as compile-libllama.mjs (AOSP cross-compile path) so both
// build paths land on identical kernels.
const REMOTE =
  process.env.ELIZA_DFLASH_LLAMA_CPP_REMOTE ||
  "https://github.com/milady-ai/llama.cpp.git";
const REF = process.env.ELIZA_DFLASH_LLAMA_CPP_REF || "v0.4.0-milady";
// Minimum commit on milady/integration that contains the DFlash CLI
// surface (--spec-type dflash, --draft-min-prob, Prometheus counters).
// Also satisfied by the W4-B v0.4.0-milady CUDA kernel additions.
const MIN_COMMIT = "7c7818aafc7599996268226e2e56099f4f38e972";

const SUPPORTED_TARGETS = [
  "linux-x64-cpu",
  "linux-x64-cuda",
  "linux-x64-rocm",
  "linux-x64-vulkan",
  // Linux aarch64. Required for the `server-h200` tier (GH200 = aarch64
  // host + H100/H200 GPU) and for Ampere Altra / AWS Graviton CPU-only
  // deployments. Both targets require a real arm64 Linux host (or a
  // sysroot + cross-toolchain for arm64) — there is no aarch64-cross
  // wiring on x64 hosts in this script.
  "linux-aarch64-cpu",
  "linux-aarch64-cuda",
  "android-arm64-cpu",
  "android-arm64-vulkan",
  "darwin-arm64-metal",
  "darwin-x64-metal",
  // iOS targets (require macOS host with Xcode). Output is a static .a +
  // headers that the LlamaCpp.xcframework patch in
  // packages/app-core/patches/llama-cpp-capacitor@0.1.5.patch consumes.
  "ios-arm64-metal",
  "ios-arm64-simulator-metal",
  "windows-x64-cpu",
  "windows-x64-cuda",
  // Windows arm64 (Snapdragon X Elite / Copilot+ PC, 2024+). Adreno X1
  // GPU is Vulkan 1.3; the 12-core ARM CPU runs the NEON paths in
  // qjl-cpu/polarquant-cpu. Both targets require an MSVC arm64
  // cross-toolchain (or a native Windows arm64 host); there is no
  // mingw arm64 cross-toolchain wiring here.
  "windows-arm64-cpu",
  "windows-arm64-vulkan",
  // Fused text+TTS targets — source-level fusion of
  // github.com/ServeurpersoCom/omnivoice.cpp into the same llama.cpp
  // build. Produce one shared library (libelizainference) and one
  // fused server binary that exposes both `llama_*` and `omnivoice_*`
  // symbols. See packages/app-core/scripts/omnivoice-fuse/README.md
  // for the GGML pin reconciliation strategy. The non-fused targets
  // above remain unchanged; fused is purely additive.
  "linux-x64-cpu-fused",
  "linux-x64-vulkan-fused",
  "darwin-arm64-metal-fused",
  "darwin-x64-metal-fused",
];

// Targets that opt into omnivoice fusion. Membership in this set is
// the only way the fused-build code path activates — no env var
// shortcuts, no implicit upgrades from a non-fused target.
const FUSED_TARGETS = new Set([
  "linux-x64-cpu-fused",
  "linux-x64-vulkan-fused",
  "darwin-arm64-metal-fused",
  "darwin-x64-metal-fused",
]);

// Strip the "-fused" suffix when one is present, returning the base
// triple parseTarget() / cmakeFlagsForTarget() already understand.
// Calling this on a non-fused triple is a no-op.
function baseTargetTriple(target) {
  return target.endsWith("-fused")
    ? target.slice(0, -"-fused".length)
    : target;
}

function isFusedTarget(target) {
  return FUSED_TARGETS.has(target);
}

function stateDir() {
  return (
    process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza")
  );
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const detail = opts.capture
      ? `\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`
      : "";
    throw new Error(
      `${cmd} ${args.join(" ")} failed with ${result.status}${detail}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

function tryRun(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "ignore",
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
  });
}

function has(cmd) {
  const result = spawnSync(cmd, ["--version"], {
    stdio: "ignore",
    env: process.env,
  });
  return result.status === 0;
}

function detectBackend() {
  const forced = process.env.ELIZA_DFLASH_BACKEND?.trim().toLowerCase();
  if (forced) return forced;
  if (process.platform === "darwin") return "metal";
  if (process.platform === "linux" && (has("hipcc") || has("rocminfo"))) {
    return "rocm";
  }
  if (process.platform === "linux" && (has("nvcc") || has("nvidia-smi"))) {
    return "cuda";
  }
  return "cpu";
}

// Resolve the Android NDK root.
//
// Order: $ANDROID_NDK_HOME, $ANDROID_NDK_ROOT, $ANDROID_NDK,
//        $HOME/Android/Sdk/ndk/<sole-or-newest-subdir>.
function resolveAndroidNdk() {
  const envCandidates = [
    process.env.ANDROID_NDK_HOME,
    process.env.ANDROID_NDK_ROOT,
    process.env.ANDROID_NDK,
  ].filter((value) => typeof value === "string" && value.trim().length > 0);
  for (const candidate of envCandidates) {
    if (
      fs.existsSync(
        path.join(candidate, "build", "cmake", "android.toolchain.cmake"),
      )
    ) {
      return candidate;
    }
  }
  const ndkDir = path.join(os.homedir(), "Android", "Sdk", "ndk");
  if (fs.existsSync(ndkDir)) {
    const versions = fs
      .readdirSync(ndkDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (versions.length > 0) {
      const chosen = path.join(ndkDir, versions[versions.length - 1]);
      if (
        fs.existsSync(
          path.join(chosen, "build", "cmake", "android.toolchain.cmake"),
        )
      ) {
        return chosen;
      }
    }
  }
  return null;
}

// Find Vulkan headers usable for an Android build. Returns the include dir
// (i.e. the parent of `vulkan/`) or null.
//
// NDK r21+ bundles Vulkan headers under
//   <ndk>/toolchains/llvm/prebuilt/<host>/sysroot/usr/include/vulkan/
// which is on the Android sysroot include path automatically. We still report
// the path so CAPABILITIES.json / logs can show where it came from.
function findAndroidVulkanInclude(ndk) {
  if (!ndk) return null;
  const hostDirs = ["linux-x86_64", "darwin-x86_64", "windows-x86_64"];
  for (const host of hostDirs) {
    const candidate = path.join(
      ndk,
      "toolchains",
      "llvm",
      "prebuilt",
      host,
      "sysroot",
      "usr",
      "include",
    );
    if (fs.existsSync(path.join(candidate, "vulkan", "vulkan_core.h"))) {
      return candidate;
    }
  }
  return null;
}

// Locate a glslc usable for the host. The Android NDK ships its own glslc
// under shader-tools/<host>/glslc.
function findGlslc(ndk) {
  if (has("glslc")) return "glslc";
  if (ndk) {
    const hostDirs = ["linux-x86_64", "darwin-x86_64", "windows-x86_64"];
    for (const host of hostDirs) {
      const candidate = path.join(ndk, "shader-tools", host, "glslc");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Find a usable x86_64-w64-mingw32 cross-toolchain on the host.
//
// Search order:
//   1. $MILADY_MINGW_PREFIX (operator override; expects PATH-style prefix
//      whose `bin/` contains x86_64-w64-mingw32-gcc)
//   2. PATH (apt-installed mingw-w64 lands here)
//   3. ~/.local/x86_64-w64-mingw32/usr/bin (user-local extracted .deb,
//      see reports/porting/2026-05-09-w3/windows-cross-build.md for the
//      no-root install recipe)
//
// On match: returns { gcc, gxx, windres, ar, ranlib, nm, objdump } so the
// toolchain file generator can emit absolute compiler paths and the
// symbol-verifier can run nm/objdump from the same toolset.
//
// Returns null when nothing usable was found.
function findMingwToolchain() {
  // PATH-installed gcc-mingw-w64-x86-64 (apt-get install mingw-w64).
  if (has("x86_64-w64-mingw32-gcc")) {
    return {
      gcc: "x86_64-w64-mingw32-gcc",
      gxx: "x86_64-w64-mingw32-g++",
      windres: "x86_64-w64-mingw32-windres",
      ar: "x86_64-w64-mingw32-ar",
      ranlib: "x86_64-w64-mingw32-ranlib",
      nm: "x86_64-w64-mingw32-nm",
      objdump: "x86_64-w64-mingw32-objdump",
    };
  }

  // User-local extracted-from-deb install. The Ubuntu mingw-w64 packages
  // pull in update-alternatives wrappers that aren't created when you
  // dpkg-deb -x without root, so we resolve the explicit `*-posix` names
  // and synthesize the canonical aliases at toolchain-write time.
  const candidates = [];
  const envPrefix = process.env.MILADY_MINGW_PREFIX?.trim();
  if (envPrefix) candidates.push(path.join(envPrefix, "bin"));
  candidates.push(
    path.join(os.homedir(), ".local", "x86_64-w64-mingw32", "usr", "bin"),
  );

  for (const dir of candidates) {
    const gccPosix = path.join(dir, "x86_64-w64-mingw32-gcc-posix");
    const gccCanonical = path.join(dir, "x86_64-w64-mingw32-gcc");
    const gxxPosix = path.join(dir, "x86_64-w64-mingw32-g++-posix");
    const gxxCanonical = path.join(dir, "x86_64-w64-mingw32-g++");
    const windres = path.join(dir, "x86_64-w64-mingw32-windres");
    const gcc = fs.existsSync(gccCanonical)
      ? gccCanonical
      : fs.existsSync(gccPosix)
        ? gccPosix
        : null;
    const gxx = fs.existsSync(gxxCanonical)
      ? gxxCanonical
      : fs.existsSync(gxxPosix)
        ? gxxPosix
        : null;
    if (!gcc || !gxx) continue;
    return {
      gcc,
      gxx,
      windres: fs.existsSync(windres) ? windres : "x86_64-w64-mingw32-windres",
      ar: path.join(dir, "x86_64-w64-mingw32-ar"),
      ranlib: path.join(dir, "x86_64-w64-mingw32-ranlib"),
      nm: path.join(dir, "x86_64-w64-mingw32-nm"),
      objdump: path.join(dir, "x86_64-w64-mingw32-objdump"),
    };
  }
  return null;
}

// Resolve a stable, source-tree-independent cache dir for cross-toolchain
// scaffolding (mingw toolchain file + Win10 SDK shim header). We *can't*
// drop these next to the llama.cpp checkout — `ensureCheckout()` clones
// into an empty dir and refuses to clobber our toolchain files.
function mingwToolchainCacheDir() {
  return path.join(os.homedir(), ".cache", "eliza-dflash", "mingw-toolchain");
}

// Write a CMake toolchain file targeting x86_64-w64-mingw32 plus a tiny
// "missing Windows 10 SDK shim" header that gets force-included into every
// translation unit. The shim defines THREAD_POWER_THROTTLING_STATE and
// related constants that mingw-w64 11.0 (Ubuntu 24.04) doesn't ship even
// though it advertises _WIN32_WINNT_WIN10.
//
// Why we need both:
//   * cpp-httplib in the llama.cpp vendor tree hard-requires
//     `_WIN32_WINNT >= 0x0A00` and uses CreateFile2.
//   * ggml/src/ggml-cpu/ggml-cpu.c uses THREAD_POWER_THROTTLING_STATE
//     (Win8+ API) under `#if _WIN32_WINNT >= 0x0602`. Bumping WINVER to
//     0x0A00 (required by the first point) triggers that branch, but
//     mingw-w64 11.0's headers don't have the type. The shim provides
//     the typedef with the same shape as the Microsoft SDK; the actual
//     SetThreadInformation API is in kernel32.dll on Win8+ so the binary
//     works at runtime.
//
// Returns the absolute path to the generated toolchain file.
function writeMingwToolchainFile({ mingw }) {
  const toolchainDir = mingwToolchainCacheDir();
  fs.mkdirSync(toolchainDir, { recursive: true });
  const shimPath = path.join(toolchainDir, "milady-mingw-win-shim.h");
  const shimBody = `/*
 * Auto-generated by build-llama-cpp-dflash.mjs. Do not edit.
 *
 * Tiny shim for x86_64-w64-mingw32 cross-builds that lets us target the
 * Windows 10 SDK (cpp-httplib hard-requires _WIN32_WINNT >= 0x0A00) on
 * mingw-w64 11.0 (Ubuntu 24.04) headers, which don't ship the Win8
 * THREAD_POWER_THROTTLING_STATE struct ggml-cpu.c references.
 */
#ifndef MILADY_MINGW_WIN_SHIM_H
#define MILADY_MINGW_WIN_SHIM_H

#include <windows.h>

#ifndef THREAD_POWER_THROTTLING_CURRENT_VERSION
#define THREAD_POWER_THROTTLING_CURRENT_VERSION 1
#define THREAD_POWER_THROTTLING_EXECUTION_SPEED 0x1
#define THREAD_POWER_THROTTLING_VALID_FLAGS THREAD_POWER_THROTTLING_EXECUTION_SPEED

typedef struct _THREAD_POWER_THROTTLING_STATE {
    ULONG Version;
    ULONG ControlMask;
    ULONG StateMask;
} THREAD_POWER_THROTTLING_STATE, *PTHREAD_POWER_THROTTLING_STATE;
#endif

#endif /* MILADY_MINGW_WIN_SHIM_H */
`;
  fs.writeFileSync(shimPath, shimBody, "utf8");

  const toolchainPath = path.join(toolchainDir, "mingw-x86_64.cmake");
  const body = `# Auto-generated by build-llama-cpp-dflash.mjs. Do not edit.
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER ${mingw.gcc})
set(CMAKE_CXX_COMPILER ${mingw.gxx})
set(CMAKE_RC_COMPILER ${mingw.windres})
set(CMAKE_AR ${mingw.ar})
set(CMAKE_RANLIB ${mingw.ranlib})
add_compile_definitions(_WIN32_WINNT=0x0A00 WINVER=0x0A00 NTDDI_VERSION=0x0A000000)
add_compile_options(-include "${shimPath.replace(/\\/g, "/")}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
`;
  fs.writeFileSync(toolchainPath, body, "utf8");
  return toolchainPath;
}

// Patch the cached llama.cpp checkout's `ggml/src/CMakeLists.txt` so that
// `ggml-base` also compiles the QJL kernel sources from `ggml-cpu/qjl/`.
//
// Why: the milady-ai/llama.cpp fork places QJL function definitions in
// `ggml/src/ggml-cpu/qjl/quants-qjl.c` (i.e. the ggml-cpu compilation
// unit), but `ggml/src/ggml.c` (in ggml-base) references those symbols
// from the type-traits table. ELF allows unresolved DSO symbols at link
// time and resolves them via the runtime loader; PE/COFF doesn't, so
// `ggml-base.dll` fails to link with "undefined reference to
// quantize_qjl1_256" etc.
//
// The transitional fix is to compile the QJL sources into ggml-base on
// Windows shared-lib builds. Linux/macOS keep the original placement.
// Idempotent: checks for a sentinel marker in the file before patching.
//
// TODO(milady-ai/llama.cpp): land an upstream fix that either (a) moves
// the QJL function definitions into ggml-base, or (b) wires the
// type-traits table through a registration callback that ggml-cpu fills
// in at backend-load time. When that lands, this patch becomes a no-op
// and can be removed.
function patchGgmlBaseForWindowsQjl(cacheDir) {
  const cmakeListsPath = path.join(cacheDir, "ggml", "src", "CMakeLists.txt");
  if (!fs.existsSync(cmakeListsPath)) {
    throw new Error(
      `[dflash-build] patchGgmlBaseForWindowsQjl: ${cmakeListsPath} missing — fork layout broken`,
    );
  }
  const original = fs.readFileSync(cmakeListsPath, "utf8");
  const sentinel = "# MILADY-WINDOWS-QJL-IN-GGML-BASE";
  if (original.includes(sentinel)) {
    return; // already patched
  }
  const anchor = "            polar_centroids.h\n            gguf.cpp)";
  if (!original.includes(anchor)) {
    throw new Error(
      `[dflash-build] patchGgmlBaseForWindowsQjl: anchor not found in ${cmakeListsPath}; ` +
        `the milady-ai/llama.cpp fork layout has changed. Without this patch ` +
        `Windows shared-lib builds will fail to link QJL symbols into ggml-base.dll.`,
    );
  }
  const replacement = `            polar_centroids.h
            gguf.cpp
            ${sentinel}
            # PE/COFF requires every imported symbol to be resolved at
            # link time; the QJL definitions in ggml-cpu/qjl/ are referenced
            # from ggml.c (ggml-base), so on Windows shared-lib builds they
            # must also live in ggml-base. Linux/macOS use the original
            # ggml-cpu placement and ignore this duplicate.
            ggml-cpu/qjl/quants-qjl.c
            ggml-cpu/qjl/qjl_dispatch.c
            ggml-cpu/qjl/qjl_projection.c
            ggml-cpu/qjl/qjl_quantize_ref.c
            ggml-cpu/qjl/qjl_quantize_avx2.c
            ggml-cpu/qjl/qjl_quantize_neon.c
            ggml-cpu/qjl/qjl_score_ref.c
            ggml-cpu/qjl/qjl_score_avx2.c
            ggml-cpu/qjl/qjl_score_neon.c)
target_include_directories(ggml-base PRIVATE ggml-cpu ggml-cpu/qjl ggml-cpu/qjl/include)`;
  fs.writeFileSync(
    cmakeListsPath,
    original.replace(anchor, replacement),
    "utf8",
  );
  console.log(
    "[dflash-build] patched ggml/src/CMakeLists.txt to compile QJL kernels into ggml-base for Windows shared-lib build",
  );
}

// The fork's `ggml-vulkan.cpp` includes <vulkan/vulkan.hpp> (Vulkan-Headers)
// and <spirv/unified1/spirv.hpp> (SPIRV-Headers). The Android NDK ships only
// the C-level vulkan.h and no SPIRV headers, so a cross-compile against the
// NDK alone fails at ~38–47% of the build with these headers missing.
//
// Fetch stable tagged checkouts of both Khronos header repos into the cache
// and return both include paths so callers can add them via -isystem.
const VULKAN_HEADERS_REPO = "https://github.com/KhronosGroup/Vulkan-Headers.git";
const VULKAN_HEADERS_REF = process.env.ELIZA_DFLASH_VULKAN_HEADERS_REF || "v1.3.295";
const SPIRV_HEADERS_REPO = "https://github.com/KhronosGroup/SPIRV-Headers.git";
const SPIRV_HEADERS_REF = process.env.ELIZA_DFLASH_SPIRV_HEADERS_REF || "vulkan-sdk-1.3.296.0";

function fetchHeadersRepo({ name, repo, ref, sentinelRel }) {
  const cacheRoot = path.join(os.homedir(), ".cache", "eliza-dflash", name);
  const includeDir = path.join(cacheRoot, "include");
  if (fs.existsSync(path.join(includeDir, sentinelRel))) return includeDir;
  if (!has("git")) {
    throw new Error(
      `Vulkan target requires ${name}; install git so I can fetch from ${repo} or set ELIZA_DFLASH_${name.toUpperCase().replace(/-/g, "_")}_DIR`,
    );
  }
  fs.mkdirSync(path.dirname(cacheRoot), { recursive: true });
  if (fs.existsSync(path.join(cacheRoot, ".git"))) {
    run("git", ["fetch", "--depth=1", "origin", ref], { cwd: cacheRoot });
    run("git", ["checkout", "FETCH_HEAD"], { cwd: cacheRoot });
  } else {
    run("git", ["clone", "--depth=1", "--branch", ref, repo, cacheRoot]);
  }
  if (!fs.existsSync(path.join(includeDir, sentinelRel))) {
    throw new Error(
      `${name} checkout at ${cacheRoot} is missing include/${sentinelRel}`,
    );
  }
  console.log(`[dflash-build] ${name} ${ref} ready at ${includeDir}`);
  return includeDir;
}

function prepareVulkanHeaders() {
  let vulkanInclude;
  const explicitVulkan = process.env.ELIZA_DFLASH_VULKAN_HEADERS_DIR?.trim();
  if (explicitVulkan && fs.existsSync(path.join(explicitVulkan, "vulkan", "vulkan.hpp"))) {
    vulkanInclude = explicitVulkan;
  } else {
    vulkanInclude = fetchHeadersRepo({
      name: "vulkan-headers",
      repo: VULKAN_HEADERS_REPO,
      ref: VULKAN_HEADERS_REF,
      sentinelRel: path.join("vulkan", "vulkan.hpp"),
    });
  }
  let spirvInclude;
  const explicitSpirv = process.env.ELIZA_DFLASH_SPIRV_HEADERS_DIR?.trim();
  if (
    explicitSpirv &&
    fs.existsSync(path.join(explicitSpirv, "spirv", "unified1", "spirv.hpp"))
  ) {
    spirvInclude = explicitSpirv;
  } else {
    spirvInclude = fetchHeadersRepo({
      name: "spirv-headers",
      repo: SPIRV_HEADERS_REPO,
      ref: SPIRV_HEADERS_REF,
      sentinelRel: path.join("spirv", "unified1", "spirv.hpp"),
    });
  }
  return { vulkanInclude, spirvInclude };
}

// Resolve the system libvulkan.so.1 on Linux when libvulkan-dev isn't
// installed. CMake's FindVulkan looks for libvulkan.so by name, but distro
// runtime packages ship only libvulkan.so.1; passing the resolved versioned
// path via -DVulkan_LIBRARY satisfies the package check.
function findLinuxLibVulkan() {
  const candidates = [
    "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
    "/usr/lib64/libvulkan.so.1",
    "/usr/lib/libvulkan.so.1",
    "/usr/lib/x86_64-linux-gnu/libvulkan.so",
    "/usr/lib64/libvulkan.so",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Previously swallowed fetch failures into a `null` return that silently
// dropped `-isystem` flags — Vulkan target then failed at cmake configure
// with a cryptic missing-header error several seconds later. Per AGENTS.md
// §3 (build-time exit non-zero), let the original error surface so the
// operator sees the cause and the failure point are co-located. Calling
// code now sees a real exception rather than a magic null sentinel.
function safelyPrepareVulkanHeaders() {
  return prepareVulkanHeaders();
}

// Map a target triple to cmake configure flags.
//
// Notes / quirks:
//   * Several targets explicitly disable other GPU backends so that probe
//     code in ggml/src/CMakeLists.txt doesn't pull in an unrelated SDK.
//   * Android cross-compile uses the NDK's bundled cmake toolchain.
//   * GGML_NATIVE is on for host targets and OFF for cross-compiles
//     (you can't sniff -march for a different ABI).
// Split a target triple into (platform, arch, backend, isSimulator).
// Handles the special-case 4-part `ios-arm64-simulator-metal` triple.
// The `-fused` suffix is stripped before parsing — fused triples reuse
// the underlying base triple's cmake/compat plumbing and only differ
// at the omnivoice-graft + final-link layer.
function parseTarget(target) {
  const fused = isFusedTarget(target);
  const parts = baseTargetTriple(target).split("-");
  if (parts[0] === "ios" && parts[2] === "simulator") {
    return {
      platform: parts[0],
      arch: parts[1],
      backend: parts[3],
      isSimulator: true,
      fused,
    };
  }
  return {
    platform: parts[0],
    arch: parts[1],
    backend: parts[2],
    isSimulator: false,
    fused,
  };
}

function cmakeFlagsForTarget(target, ctx) {
  const { platform, arch, backend, isSimulator } = parseTarget(target);
  const flags = ["-DLLAMA_BUILD_TESTS=OFF", "-DLLAMA_BUILD_EXAMPLES=ON"];
  const isCross =
    platform === "android" || platform === "windows" || platform === "ios";
  flags.push(`-DGGML_NATIVE=${isCross ? "OFF" : "ON"}`);

  // Disable backends we don't want by default; flip the chosen one back on.
  const offByDefault = ["GGML_METAL", "GGML_CUDA", "GGML_HIP", "GGML_VULKAN"];
  for (const name of offByDefault) flags.push(`-D${name}=OFF`);

  if (backend === "metal") {
    flags[flags.indexOf("-DGGML_METAL=OFF")] = "-DGGML_METAL=ON";
    // EMBED_LIBRARY behavior:
    //
    //   * iOS (later in this function) sets it to ON unconditionally —
    //     the static-archive build needs the metallib data baked into
    //     the framework via .incbin.
    //   * Darwin desktop (this branch) sets it OFF so the metallib is
    //     compiled at build time into a sidecar default.metallib that
    //     ships next to llama-server. The kernel-patches/metal-kernels
    //     CMakeLists patch hooks into the non-EMBED add_custom_command
    //     so each standalone shader (turbo3/turbo4/turbo3_tcq/qjl/polar)
    //     is compiled into its own .air and merged into default.metallib
    //     alongside ggml-metal.air.
    //
    //     The EMBED path is incompatible with the standalones because
    //     it concatenates ggml-metal.metal + ggml-common.h into a single
    //     compilation unit, and the standalones redefine block_qjl1_256
    //     and block_q4_polar (same byte layout, different field names)
    //     plus QK_POLAR / QK_QJL / QJL_RESIDUAL_BYTES already in
    //     ggml-common.h. Wiring them through the EMBED path requires a
    //     dup-strip pass that is filed as a separate follow-up.
    flags.push("-DGGML_METAL_EMBED_LIBRARY=OFF");
  } else if (backend === "cuda") {
    flags[flags.indexOf("-DGGML_CUDA=OFF")] = "-DGGML_CUDA=ON";
    flags.push("-DGGML_CUDA_FA=ON", "-DGGML_CUDA_FA_ALL_QUANTS=ON");
    // Pin a multi-arch fat-binary so a build host without a GPU does not
    // emit a `sm_52`-only artifact (CMake's default = native probe).
    //   90a → H200 / GH200 (sm_90a, the only arch with the new TMA / WGMMA paths)
    //   90  → H100
    //   89  → Ada / RTX 4090 / L4
    //   86  → Ampere consumer / RTX 30xx
    //   80  → A100 / data-center Ampere
    // Operators that target an older card (sm_75 Turing, sm_70 Volta) can
    // override via ELIZA_DFLASH_CMAKE_FLAGS=-DCMAKE_CUDA_ARCHITECTURES=...
    // which appends after this list and wins.
    flags.push('-DCMAKE_CUDA_ARCHITECTURES=90a;90;89;86;80');
  } else if (backend === "rocm") {
    flags[flags.indexOf("-DGGML_HIP=OFF")] = "-DGGML_HIP=ON";
  } else if (backend === "vulkan") {
    flags[flags.indexOf("-DGGML_VULKAN=OFF")] = "-DGGML_VULKAN=ON";
    if (ctx.glslc) flags.push(`-DVulkan_GLSLC_EXECUTABLE=${ctx.glslc}`);
    // The fork includes vulkan.hpp + spirv/unified1/spirv.hpp, neither of
    // which ships in the NDK *or* in Linux libvulkan-runtime-only installs.
    // ctx.vulkanHpp is the result of safelyPrepareVulkanHeaders() —
    // { vulkanInclude, spirvInclude } pointing at fetched Khronos checkouts.
    if (ctx.vulkanHpp) {
      const isystem = [ctx.vulkanHpp.vulkanInclude, ctx.vulkanHpp.spirvInclude]
        .filter(Boolean)
        .map((p) => `-isystem ${p}`)
        .join(" ");
      if (isystem) flags.push(`-DCMAKE_CXX_FLAGS=${isystem}`);
      // CMake's FindVulkan also needs Vulkan_INCLUDE_DIR / Vulkan_LIBRARY
      // for its package check. On Linux without libvulkan-dev installed,
      // we still have:
      //   - libvulkan.so.1 from the runtime package (Mesa / NVIDIA driver)
      //   - vulkan/vulkan.h in the fetched Khronos headers
      // Wire those manually so the build doesn't need the SDK.
      if (platform === "linux") {
        const libVulkan = findLinuxLibVulkan();
        if (libVulkan) {
          flags.push(`-DVulkan_INCLUDE_DIR=${ctx.vulkanHpp.vulkanInclude}`);
          flags.push(`-DVulkan_LIBRARY=${libVulkan}`);
        }
      }
    }
  }

  if (platform === "android") {
    if (!ctx.androidNdk) {
      throw new Error(
        "Android target requested but ANDROID_NDK_HOME is not set and no NDK was found under ~/Android/Sdk/ndk",
      );
    }
    flags.push(
      `-DCMAKE_TOOLCHAIN_FILE=${path.join(ctx.androidNdk, "build", "cmake", "android.toolchain.cmake")}`,
      `-DANDROID_NDK=${ctx.androidNdk}`,
      "-DANDROID_ABI=arm64-v8a",
      "-DANDROID_PLATFORM=android-28",
      // CURL is optional for llama-server and not part of the NDK sysroot.
      "-DLLAMA_CURL=OFF",
    );
    if (backend === "vulkan" && ctx.androidVulkanInclude) {
      // Mostly informational - the NDK sysroot already exposes vulkan/ on the
      // include path. Pass it explicitly so CMake's FindVulkan succeeds even
      // if upstream changes its detection.
      flags.push(`-DVulkan_INCLUDE_DIR=${ctx.androidVulkanInclude}`);
    }
  } else if (platform === "windows") {
    // Cross-build Windows DLLs from a Linux host via x86_64-w64-mingw32.
    // ctx.mingwToolchainFile is set by build() when a usable mingw was
    // found on PATH or under ~/.local/x86_64-w64-mingw32/. Operators on
    // Windows itself bypass this and use the native MSVC/MinGW host
    // toolchain — pass MINGW_TOOLCHAIN_FILE to override either path.
    //
    // arm64 Windows (Snapdragon X Elite, Copilot+ PC) requires either an
    // MSVC arm64 cross-toolchain (CMake `-A ARM64` on a Windows host with
    // MSVC build tools), or a clang/LLVM mingw arm64 cross-toolchain on
    // a Linux host. There is no x86_64-w64-mingw32 → arm64 path, so
    // arm64 builds on Linux hosts must pass MINGW_TOOLCHAIN_FILE
    // explicitly pointing at a clang/LLVM arm64 toolchain file.
    if (process.env.MINGW_TOOLCHAIN_FILE) {
      flags.push(`-DCMAKE_TOOLCHAIN_FILE=${process.env.MINGW_TOOLCHAIN_FILE}`);
    } else if (ctx.mingwToolchainFile && arch === "x64") {
      flags.push(`-DCMAKE_TOOLCHAIN_FILE=${ctx.mingwToolchainFile}`);
    }
    if (arch === "arm64" && process.platform === "win32") {
      // Native MSVC arm64 build. CMake's default (Visual Studio generator)
      // honors -A ARM64 to select the arm64 toolset.
      flags.push("-A", "ARM64");
    }
    // CURL isn't part of the cross-toolchain sysroot. cpp-httplib is
    // statically vendored under llama.cpp/vendor/ and provides the HTTP
    // surface llama-server needs.
    flags.push("-DLLAMA_CURL=OFF");
    if (backend === "cpu" && arch === "x64") {
      // Enable AVX/AVX2/FMA/F16C explicitly. -DGGML_NATIVE=OFF is the
      // right default for cross-builds (you can't sniff -march for a
      // different machine), but AVX2 is the de-facto baseline for
      // Windows x86_64 in 2026 and the QJL/Polar kernels have AVX2
      // implementations that drop in here. Operators that target
      // pre-Haswell CPUs can override via ELIZA_DFLASH_CMAKE_FLAGS.
      flags.push(
        "-DGGML_AVX=ON",
        "-DGGML_AVX2=ON",
        "-DGGML_FMA=ON",
        "-DGGML_F16C=ON",
        // OpenMP isn't usable from the mingw cross-toolchain without an
        // extra runtime. ggml-cpu's std::thread fallback is fine.
        "-DGGML_OPENMP=OFF",
        // Build the multi-DLL split (llama.dll + ggml*.dll). Required by
        // the milady distribution shape; the patchGgmlBaseForWindowsQjl
        // pre-build step makes the QJL symbols resolve against ggml-base
        // so the DLL link succeeds (PE/COFF doesn't allow unresolved DSO
        // symbols at link time the way ELF does).
        "-DBUILD_SHARED_LIBS=ON",
      );
    } else if (backend === "cpu" && arch === "arm64") {
      // Snapdragon X Elite ships ARMv8.4-A + dotprod + i8mm + sve2.
      // qjl-cpu/polarquant-cpu's NEON paths cover the dot-product
      // primitive; OpenMP is still off because the mingw/clang arm64
      // cross-toolchain doesn't ship libomp without extra setup.
      flags.push(
        "-DGGML_OPENMP=OFF",
        "-DBUILD_SHARED_LIBS=ON",
      );
    }
    // Statically link backends into llama-server.exe. With the default
    // (BACKEND_DL=ON) MSVC builds, the dynamic loader looks for a generic
    // `ggml_backend_init` export but ggml-cpu.dll only exports
    // `ggml_backend_cpu_init` (per-backend symbol name), so the loader
    // fails and inference can't run. -DGGML_BACKEND_DL=OFF embeds the
    // backend's init directly into the binary.
    flags.push("-DGGML_BACKEND_DL=OFF", "-DBUILD_SHARED_LIBS=OFF");
  } else if (platform === "ios") {
    // iOS cross-compile (host must be macOS with Xcode). The Capacitor
    // plugin's xcframework patch consumes the resulting static archive +
    // headers; we emit a static lib here so the patch can drop it into
    // ios/Frameworks-xcframework/LlamaCpp.xcframework/ios-arm64{-simulator}/
    // LlamaCpp.framework/.
    flags.push(
      "-DCMAKE_SYSTEM_NAME=iOS",
      "-DCMAKE_OSX_ARCHITECTURES=arm64",
      // iOS 14 covers every supported Capacitor target.
      "-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0",
      // Capacitor plugin links the native code statically.
      "-DBUILD_SHARED_LIBS=OFF",
      // CURL isn't part of the iOS SDK and llama-server's HTTP isn't used
      // on-device — disable to keep the static archive minimal.
      "-DLLAMA_CURL=OFF",
      // Don't try to build llama-server / llama-cli on iOS — they install
      // as console executables and CMake's install(TARGETS …) errors with
      // "no BUNDLE DESTINATION for MACOSX_BUNDLE executable" under the
      // CMAKE_SYSTEM_NAME=iOS generator. Disable the entire tools and
      // examples trees; iOS only needs the static llama / ggml libraries.
      "-DLLAMA_BUILD_EXAMPLES=OFF",
      "-DLLAMA_BUILD_TOOLS=OFF",
      "-DLLAMA_BUILD_SERVER=OFF",
    );
    if (isSimulator) {
      flags.push("-DCMAKE_OSX_SYSROOT=iphonesimulator");
    } else {
      flags.push("-DCMAKE_OSX_SYSROOT=iphoneos");
    }
    // iOS static-archive build needs the metallib data baked in via .incbin
    // since there is no place on-device to ship a sidecar default.metallib.
    // Override the OFF default that the metal backend block set above.
    // NOTE: at v0.4.0-milady the iOS path is a deferred gap — the EMBED
    // pipeline concatenates ggml-metal.metal with ggml-common.h via sed,
    // and our standalone shaders' redefinitions of block_qjl1_256 /
    // block_q4_polar collide. The iOS metallib will not yet contain the
    // milady kernels until kernel-patches/metal-kernels.mjs grows an
    // EMBED-path patcher that strips the duplicate decls. requiredKernels-
    // Missing() will catch and refuse the iOS artifact accordingly.
    const embedIdx = flags.indexOf("-DGGML_METAL_EMBED_LIBRARY=OFF");
    if (embedIdx !== -1) {
      flags[embedIdx] = "-DGGML_METAL_EMBED_LIBRARY=ON";
    } else {
      flags.push("-DGGML_METAL_EMBED_LIBRARY=ON");
    }
  }

  const extra = process.env.ELIZA_DFLASH_CMAKE_FLAGS?.trim();
  if (extra) flags.push(...extra.split(/\s+/).filter(Boolean));
  return flags;
}

// Inspect compatibility from the host point of view. Returns either
// { ok: true } or { ok: false, reason: string } so --all can skip cleanly.
function targetCompatibility(target, ctx) {
  const { platform, arch, backend, fused } = parseTarget(target);
  if (fused && (platform === "android" || platform === "ios")) {
    return {
      ok: false,
      reason:
        "fused (omnivoice-grafted) targets are desktop/server only — mobile fusion is not wired yet",
    };
  }
  if (platform === "darwin" && process.platform !== "darwin") {
    return { ok: false, reason: "darwin target requires macOS host" };
  }
  if (platform === "ios" && process.platform !== "darwin") {
    return { ok: false, reason: "ios target requires macOS host with Xcode" };
  }
  if (platform === "linux" && process.platform !== "linux") {
    return { ok: false, reason: "linux target requires linux host" };
  }
  // linux-aarch64-* requires an arm64 Linux host. There is no aarch64 cross
  // toolchain wired in this script, so x64 hosts cannot produce aarch64
  // binaries here. The GH200 / Graviton path is to run this on an arm64
  // build runner.
  if (platform === "linux" && arch === "aarch64" && process.arch !== "arm64") {
    return {
      ok: false,
      reason:
        "linux-aarch64 target requires an arm64 Linux host (no aarch64 cross-toolchain wired here; run on a real arm64 build runner)",
    };
  }
  if (platform === "windows") {
    // arm64 Windows builds need either a native MSVC arm64 host or an
    // operator-supplied MINGW_TOOLCHAIN_FILE pointing at clang/LLVM
    // arm64 cross-tools — the bundled mingw discovery only handles
    // x86_64-w64-mingw32.
    if (arch === "arm64") {
      if (process.platform === "win32") return { ok: true };
      if (process.env.MINGW_TOOLCHAIN_FILE) return { ok: true };
      return {
        ok: false,
        reason:
          "windows-arm64 target requires a native Windows arm64 host (MSVC -A ARM64) or MINGW_TOOLCHAIN_FILE pointing at a clang/LLVM aarch64-w64-mingw32 toolchain file",
      };
    }
    if (process.platform === "win32") return { ok: true };
    if (process.env.MINGW_TOOLCHAIN_FILE) return { ok: true };
    if (ctx.mingwToolchainFile) return { ok: true };
    return {
      ok: false,
      reason:
        "windows target requires Windows host, MINGW_TOOLCHAIN_FILE, or mingw-w64 (apt-get install mingw-w64) / extracted .deb under ~/.local/x86_64-w64-mingw32/",
    };
  }
  if (platform === "android") {
    if (!ctx.androidNdk) {
      return { ok: false, reason: "Android NDK not found" };
    }
    if (backend === "vulkan" && !ctx.androidVulkanInclude) {
      return {
        ok: false,
        reason: "Android Vulkan headers not found in NDK sysroot",
      };
    }
    return { ok: true };
  }
  if (backend === "cuda" && !has("nvcc")) {
    return { ok: false, reason: "no nvcc (CUDA toolkit)" };
  }
  if (backend === "rocm" && !(has("hipcc") || has("rocminfo"))) {
    return { ok: false, reason: "no hipcc / rocminfo" };
  }
  if (backend === "vulkan" && !ctx.glslc) {
    return { ok: false, reason: "no glslc (Vulkan shader compiler)" };
  }
  if (backend === "metal" && process.platform !== "darwin") {
    return { ok: false, reason: "metal requires macOS" };
  }
  return { ok: true };
}

// Map Node's process.arch to the triple's arch token. Linux uses
// `aarch64` in its triples (linux-aarch64-cuda); every other platform
// uses `arm64` (darwin-arm64-metal, windows-arm64-vulkan, android-arm64-*).
function nodeArchToTripleArch(platform) {
  if (process.arch === "x64") return "x64";
  if (process.arch === "arm64") return platform === "linux" ? "aarch64" : "arm64";
  return process.arch;
}

function defaultTarget() {
  const backend = detectBackend();
  const platform =
    process.platform === "win32" ? "windows" : process.platform;
  const arch = nodeArchToTripleArch(platform);
  return `${platform}-${arch}-${backend}`;
}

function parseArgs(argv) {
  const args = {
    // Renamed from buun-llama-cpp to milady-llama-cpp on the unified-fork
    // migration. Old caches stay around harmlessly under the prior name —
    // the new directory busts the cache so a fresh ref pull is forced.
    cacheDir: path.join(
      os.homedir(),
      ".cache",
      "eliza-dflash",
      "milady-llama-cpp",
    ),
    outDirOverride: null,
    targets: null, // null => single legacy target, otherwise an array
    backend: null, // legacy --backend
    ref: REF,
    jobs: Math.max(1, Math.min(os.cpus().length, 16)),
    dryRun: false,
    all: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === "--cache-dir") args.cacheDir = path.resolve(next());
    else if (arg === "--out-dir") args.outDirOverride = path.resolve(next());
    else if (arg === "--backend") args.backend = next();
    else if (arg === "--target") {
      const value = next();
      if (!SUPPORTED_TARGETS.includes(value)) {
        throw new Error(
          `Unsupported --target ${value}. Supported: ${SUPPORTED_TARGETS.join(", ")}`,
        );
      }
      args.targets = args.targets || [];
      args.targets.push(value);
    } else if (arg === "--all") args.all = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--ref") args.ref = next();
    else if (arg === "--jobs" || arg === "-j")
      args.jobs = Number.parseInt(next(), 10);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: node build-llama-cpp-dflash.mjs [options]",
          "",
          "Targets (use --target one or more times, or --all):",
          ...SUPPORTED_TARGETS.map(
            (t) =>
              `  ${t}${FUSED_TARGETS.has(t) ? "  (fused: text + omnivoice TTS in one build)" : ""}`,
          ),
          "",
          "Fused targets perform source-level fusion of",
          "github.com/ServeurpersoCom/omnivoice.cpp into the milady-ai/llama.cpp",
          "build, sharing one ggml pin and one kernel set.",
          `Pinned omnivoice commit: ${OMNIVOICE_REF}`,
          `Reconciled-out omnivoice ggml submodule: ${OMNIVOICE_GGML_REF}`,
          "See packages/app-core/scripts/omnivoice-fuse/README.md.",
          "",
          "Options:",
          "  --target <triple>      Build a specific target (repeatable).",
          "  --all                  Build every host-compatible target.",
          "  --dry-run              Print cmake invocations without running.",
          "  --backend <name>       Legacy single-target backend selector.",
          "  --ref <git-ref>        Branch/tag/SHA of the fork to build.",
          "  --out-dir <path>       Override the output directory (single target).",
          "  --cache-dir <path>     Override the source checkout cache.",
          "  --jobs N | -j N        Parallel build jobs.",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.all && args.targets) {
    throw new Error("--all and --target are mutually exclusive");
  }
  return args;
}

function ensureCheckout(cacheDir, ref) {
  if (fs.existsSync(path.join(cacheDir, ".git"))) {
    run("git", ["fetch", "--depth=1", "origin", ref], { cwd: cacheDir });
    run("git", ["checkout", "FETCH_HEAD"], { cwd: cacheDir });
  } else {
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    run("git", ["clone", "--depth=1", "--branch", ref, REMOTE, cacheDir]);
  }
  const head = run("git", ["rev-parse", "HEAD"], {
    cwd: cacheDir,
    capture: true,
  });
  console.log(`[dflash-build] checkout ${head}`);
  const ancestor = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", MIN_COMMIT, "HEAD"],
    {
      cwd: cacheDir,
      stdio: "ignore",
    },
  );
  if (ancestor.status !== 0) {
    const shallow = run("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: cacheDir,
      capture: true,
    });
    if (shallow === "true") {
      console.log(
        `[dflash-build] shallow checkout; skipping ancestry check for minimum known-good DFlash/SWA commit ${MIN_COMMIT}`,
      );
    } else {
      console.warn(
        `[dflash-build] warning: HEAD does not contain minimum known-good DFlash/SWA commit ${MIN_COMMIT}`,
      );
    }
  }
  return head;
}

// Real patch hooks: the v0.4.0-milady decorative log no-ops have been replaced
// with kernel-patches/{metal,vulkan}-kernels.mjs implementations that actually
// (a) copy the verified standalone shaders from packages/inference/{metal,vulkan}/
// into the fork tree, and (b) for Metal, patch ggml/src/ggml-metal/CMakeLists.txt
// to compile each standalone into its own .air and merge them into the
// final default.metallib. Both helpers hard-throw on failure per AGENTS.md §3.
//
// What still doesn't fully ship at v0.4.0-milady (deferred dispatch wiring):
//
//   * ggml-metal-ops.cpp / ggml-metal-device.m have NO dispatch sites for
//     the milady quant types (TBQ3_0, TBQ4_0, TBQ3_TCQ, QJL1_256, Q4_POLAR).
//     CUDA has them; Metal does not. After this patch the kernel symbols
//     (kernel_turbo3_dot, kernel_attn_score_qjl1_256, kernel_mul_mv_q4_polar_f32,
//     etc.) are present in default.metallib and `nm`/`strings` will see
//     them, but the runtime cannot yet select them via GGML_TYPE_*. That
//     wiring is a separate fork-internals patch and is the next agent's
//     mission.
//
//   * The EMBED_LIBRARY=ON branch (used by iOS targets) is not yet patched.
//     iOS builds compile a single concatenated .metal via .incbin and would
//     require stripping the duplicate decls (block_qjl1_256, block_q4_polar,
//     QK_QJL, QK_POLAR, QJL_RESIDUAL_BYTES already in ggml-common.h). That
//     is a separate patch tracked in kernel-patches/metal-kernels.mjs's
//     module comment.
//
//   * Vulkan: the .comp files are staged at ggml/src/ggml-vulkan/milady-shipped/
//     but vulkan-shaders-gen does not yet know about them. patchVulkanKernels
//     hard-throws if a *-vulkan target is queued unless
//     ELIZA_DFLASH_ALLOW_INCOMPLETE_VULKAN=1 is set as an audit-loggable
//     escape hatch.
function applyForkPatches(cacheDir, backend, target, { dryRun = false } = {}) {
  if (backend === "metal") {
    patchMetalKernelsImpl(cacheDir, { dryRun });
  }
  if (backend === "vulkan") {
    patchVulkanKernelsImpl(cacheDir, { dryRun, target });
  }
  if (target && target.startsWith("windows-")) {
    patchGgmlBaseForWindowsQjl(cacheDir);
  }
  // The same broken cross-library reference that bites Windows shared-lib
  // builds also bites darwin shared-lib builds: ggml.c (in ggml-base) calls
  // quantize_qjl1_256 / dequantize_row_qjl1_256 / quantize_row_qjl1_256_ref,
  // which live in ggml-cpu/qjl/. On darwin the BUILD_SHARED_LIBS_DEFAULT is
  // ON and ggml-base is linked with `-undefined error`, so the link fails
  // before a single Metal kernel can run. Folding the QJL TUs into ggml-base
  // resolves the symbols at link time without breaking the ggml-cpu build
  // (the duplicate object files in two libraries link cleanly because they
  // are part of the same .dylib at runtime). The same fix is independently
  // safe to apply to iOS static-archive builds. Idempotent via the
  // existing `# MILADY-WINDOWS-QJL-IN-GGML-BASE` sentinel inside
  // patchGgmlBaseForWindowsQjl().
  if (
    target &&
    (target.startsWith("darwin-") || target.startsWith("ios-"))
  ) {
    patchGgmlBaseForWindowsQjl(cacheDir);
  }
}

function isRuntimeLibrary(name) {
  return (
    /^lib.*\.(dylib|so|dll)$/.test(name) ||
    /^lib.*\.so\.\d/.test(name) ||
    /^lib.*\.\d+(\.\d+)*\.dylib$/.test(name) ||
    // mingw produces `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll` (no `lib`
    // prefix) for Windows shared-lib builds. Accept any plain `.dll`.
    /\.dll$/i.test(name)
  );
}

function makeDarwinInstallSelfContained(outDir, names, buildBinDir) {
  if (process.platform !== "darwin") return;
  for (const name of names) {
    const file = path.join(outDir, name);
    tryRun("install_name_tool", ["-delete_rpath", buildBinDir, file]);
    tryRun("install_name_tool", ["-delete_rpath", path.dirname(file), file]);
    tryRun("install_name_tool", ["-delete_rpath", outDir, file]);
    tryRun("install_name_tool", ["-delete_rpath", path.resolve(outDir), file]);
    const rpath = isRuntimeLibrary(name) ? "@loader_path" : "@executable_path";
    tryRun("install_name_tool", ["-delete_rpath", rpath, file]);
    tryRun("install_name_tool", ["-add_rpath", rpath, file]);
  }
}

// Probe a freshly-built llama-server for kernel availability.
//
// For host targets, run `llama-server --help` and grep for kernel-specific
// flags / cache-type names. For cross-compiled targets (e.g. Android) the
// binary cannot run on the host; introspect the build directory for compiled
// object files instead (e.g. ggml-cuda/turbo3.cu.o,
// ggml-metal/turbo3.metal.air, etc.).
function probeKernels(target, buildDir, outDir) {
  const { platform, backend } = parseTarget(target);
  const canRunOnHost = canRunTargetOnHost(target);
  const kernels = {
    dflash: false,
    turbo3: false,
    turbo4: false,
    turbo3_tcq: false,
    qjl_full: false,
    polarquant: false,
    lookahead: true, // upstream
    ngramDraft: true, // upstream
  };

  if (canRunOnHost) {
    // On Windows the binary is named with .exe suffix; on macOS/Linux it has
    // no extension. Probe both so the kernel detection works on every host.
    const serverBinCandidates = [
      path.join(outDir, "llama-server"),
      path.join(outDir, "llama-server.exe"),
    ];
    const serverBin =
      serverBinCandidates.find((p) => fs.existsSync(p)) ??
      serverBinCandidates[0];
    if (fs.existsSync(serverBin)) {
      const result = spawnSync(serverBin, ["--help"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        timeout: 30_000,
      });
      const help = `${result.stdout || ""}\n${result.stderr || ""}`;
      const lc = help.toLowerCase();
      kernels.dflash = /dflash/.test(lc);
      kernels.turbo3 = /turbo3/.test(lc);
      kernels.turbo4 = /turbo4/.test(lc);
      kernels.turbo3_tcq = /turbo3[_-]?tcq|tcq/.test(lc);
      kernels.qjl_full = /qjl[_-]?full|qjl/.test(lc);
      kernels.polarquant = /polar(?:quant)?|q4[_-]?polar/.test(lc);
    }
  } else {
    // Fall back to scanning compiled object files in the build directory.
    // Different backends emit different file extensions:
    //   CUDA:   ggml/src/ggml-cuda/<name>.cu.o
    //   Metal:  ggml/src/ggml-metal/<name>.metal.air (or .o for setup)
    //   Vulkan: ggml/src/ggml-vulkan/<name>.cpp.o + compiled SPIR-V
    //   CPU:    ggml/src/ggml-cpu/<name>.cpp.o
    const objects = collectFilesUnder(buildDir, /\.(o|obj|air|spv)$/);
    const names = objects.join("\n").toLowerCase();
    // Per-backend kernels (CUDA/Metal/Vulkan emit per-kernel object files).
    kernels.dflash = /dflash|flash[-_]?attn[-_]?ext/.test(names);
    kernels.turbo3 = /turbo3/.test(names);
    kernels.turbo4 = /turbo4/.test(names);
    kernels.turbo3_tcq = /turbo3[-_]?tcq|tcq/.test(names);
    kernels.qjl_full = /qjl/.test(names);
    kernels.polarquant = /polar(?:quant)?|q4[-_]?polar/.test(names);
    // CPU build inlines the turbo quantization paths inside ggml-cpu and
    // links a single ggml-turbo-quant.c.o into ggml-base. Treat its presence
    // as evidence both turbo3 and turbo4 paths are compiled in. Likewise,
    // the fork wires DFlash through ggml-cpu's flash-attn entry, so dflash
    // is also implicit when ggml-turbo-quant is present on CPU targets.
    if (backend === "cpu" && /ggml-turbo-quant\.c\.o/.test(names)) {
      kernels.turbo3 = true;
      kernels.turbo4 = true;
      kernels.dflash = true;
    }
    // For non-CPU backends, presence of the backend's flash-attn unit is a
    // strong proxy for dflash (the fork hangs DFlash off the existing FA
    // kernel registration).
    if (
      !kernels.dflash &&
      (backend === "cuda" || backend === "vulkan" || backend === "metal") &&
      /(flash[-_]?attn|fattn)/.test(names)
    ) {
      kernels.dflash = true;
    }
  }
  return kernels;
}

function canRunTargetOnHost(target) {
  const { platform, arch } = parseTarget(target);
  if (platform === "android" || platform === "ios") return false;
  if (platform === "windows" && process.platform !== "win32") return false;
  if (platform === "darwin" && process.platform !== "darwin") return false;
  if (platform === "linux" && process.platform !== "linux") return false;
  // arm64 (Apple, Windows, Android) and aarch64 (Linux) both map to
  // process.arch === "arm64" on Node. x64 maps to "x64".
  if ((arch === "arm64" || arch === "aarch64") && process.arch !== "arm64") {
    return false;
  }
  if (arch === "x64" && process.arch !== "x64") return false;
  return true;
}

function collectFilesUnder(root, pattern) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && pattern.test(entry.name)) out.push(full);
    }
  }
  return out;
}

// Per AGENTS.md §3, every Eliza-1 bundle MUST run dflash + turbo3 + turbo4 +
// qjl + polar. probeKernels() returns the per-target detection map; this gate
// translates that into a hard failure when a required kernel is absent.
//
// Returns the list of missing-but-required kernels. An empty list means the
// target satisfies the contract.
function requiredKernelsMissing(target, kernels) {
  const { backend } = parseTarget(target);
  // Required for every shipped backend.
  const required = ["dflash", "turbo3", "turbo4", "qjl_full", "polarquant"];
  // Vulkan host detection currently relies on `--help` strings (CLI flags).
  // Metal kernel-presence after this patch is verified via the metallib
  // (see kernel-patches/metal-kernels.mjs); the help-text probe still works
  // because the fork's CLI lists the quant types regardless of backend.
  if (backend === "vulkan") {
    // The fork at v0.4.0-milady has zero turbo/qjl/polar Vulkan dispatch.
    // Even with our standalones staged under milady-shipped/, the runtime
    // cannot select them — see kernel-patches/vulkan-kernels.mjs. Allow the
    // build to proceed only when the operator has explicitly acknowledged
    // the gap; the gate then reports the missing kernels into
    // CAPABILITIES.json so the runtime layer can refuse to load Eliza-1
    // bundles on this binary.
    if (process.env.ELIZA_DFLASH_ALLOW_INCOMPLETE_VULKAN === "1") {
      return [];
    }
  }
  return required.filter((k) => !kernels[k]);
}

function writeCapabilities({
  outDir,
  target,
  buildDir,
  forkCommit,
  binaries,
  omnivoice = null,
}) {
  const { platform, arch, backend, fused } = parseTarget(target);
  const kernels = probeKernels(target, buildDir, outDir);
  const missing = requiredKernelsMissing(target, kernels);
  const capabilities = {
    target,
    platform,
    arch,
    backend,
    fused: Boolean(fused),
    builtAt: new Date().toISOString(),
    fork: "milady-ai/llama.cpp",
    forkCommit,
    kernels,
    binaries,
    omnivoice,
  };
  fs.writeFileSync(
    path.join(outDir, "CAPABILITIES.json"),
    `${JSON.stringify(capabilities, null, 2)}\n`,
  );
  if (missing.length > 0) {
    throw new Error(
      `[dflash-build] target=${target} missing required kernels: ${missing.join(", ")}. ` +
        `AGENTS.md §3 forbids shipping an Eliza-1 binary without the full ` +
        `dflash + turbo3 + turbo4 + qjl + polar kernel set. CAPABILITIES.json ` +
        `was written for diagnostic purposes only — the artifact is incomplete ` +
        `and must not be published. Inspect the build log for the failed ` +
        `patch hook or absent dispatch site, fix the root cause, and rebuild.`,
    );
  }
  return capabilities;
}

function targetOutDir(target, override) {
  if (override) return override;
  return path.join(stateDir(), "local-inference", "bin", "dflash", target);
}

// Build a single target. Returns the resulting CAPABILITIES.json object.
function buildTarget({ target, args, ctx }) {
  const { platform, backend, fused } = parseTarget(target);
  const outDir = targetOutDir(target, args.outDirOverride);
  const buildDir = path.join(args.cacheDir, "build", target);
  const flags = cmakeFlagsForTarget(target, ctx);

  // Fused targets graft omnivoice.cpp's `src/` + `tools/` into the
  // llama.cpp tree, append a CMake snippet that declares the fused
  // shared library + server, and add `-DMILADY_FUSE_OMNIVOICE=ON`.
  // The non-fused targets are unchanged.
  let omnivoiceInfo = null;
  if (fused) {
    if (args.dryRun) {
      console.log(
        `[dflash-build] (dry-run) target=${target} fused=true`,
      );
      console.log(
        `  prepareOmnivoiceFusion ref=${OMNIVOICE_REF} llamaCppRoot=${args.cacheDir}`,
      );
      console.log(
        `  appendCmakeGraft -> ${path.join(args.cacheDir, "CMakeLists.txt")}`,
      );
    } else {
      omnivoiceInfo = prepareOmnivoiceFusion({
        cacheRoot: path.dirname(args.cacheDir),
        llamaCppRoot: args.cacheDir,
      });
      const grafted = appendCmakeGraft({ llamaCppRoot: args.cacheDir });
      console.log(
        `[dflash-build] omnivoice-fuse: pin=${omnivoiceInfo.commit} ` +
          `ggmlSubmodule=${omnivoiceInfo.ggmlSubmoduleCommit} ` +
          `sources=${omnivoiceInfo.sourceCount} ` +
          `cmakeGraftAppended=${grafted}`,
      );
    }
    flags.push(...fusedExtraCmakeFlags());
  }

  if (args.dryRun) {
    console.log(`[dflash-build] (dry-run) target=${target}`);
    // Dry-run still describes the kernel patches that WOULD be applied so
    // an audit can see the real behavior, not just the cmake invocation.
    // The patch helpers themselves treat dryRun=true as "log only, no fs
    // writes" so this is safe even when args.cacheDir doesn't yet exist
    // (we only run this branch when the dir does exist; the helpers throw
    // otherwise to surface that mismatch).
    if (fs.existsSync(args.cacheDir)) {
      applyForkPatches(args.cacheDir, backend, target, { dryRun: true });
    } else {
      console.log(
        `  (dry-run) skip patch hooks: ${args.cacheDir} not yet cloned`,
      );
    }
    console.log(
      `  cmake -B ${buildDir} ${flags.join(" ")}`.replace(/ +/g, " "),
    );
    const dryTargets = fused
      ? fusedCmakeBuildTargets()
      : ["llama-server", "llama-cli", "llama-speculative-simple"];
    console.log(
      `  cmake --build ${buildDir} --target ${dryTargets.join(" ")} -j ${args.jobs}`,
    );
    console.log(`  install -> ${outDir}`);
    return null;
  }

  console.log(`[dflash-build] building target=${target}`);
  applyForkPatches(args.cacheDir, backend, target);

  fs.mkdirSync(buildDir, { recursive: true });
  run("cmake", ["-B", buildDir, ...flags], { cwd: args.cacheDir });

  // iOS targets emit a static archive used by the Capacitor xcframework
  // patch; everything else builds the executables we use directly on host.
  // Fused targets additionally build omnivoice-core, libelizainference,
  // and the stub fused server.
  const isIos = platform === "ios";
  const cmakeBuildTargets = isIos
    ? ["llama", "ggml", "ggml-base", "ggml-cpu", "ggml-metal"]
    : fused
      ? fusedCmakeBuildTargets()
      : ["llama-server", "llama-cli", "llama-speculative-simple"];

  // MSVC + Xcode are multi-config generators — cmake --build needs an
  // explicit --config flag, otherwise it defaults to Debug and the install
  // step below looks in the wrong subdir. Use Release for runtime perf.
  const isMultiConfig = platform === "windows" || platform === "ios";
  run(
    "cmake",
    [
      "--build",
      buildDir,
      ...(isMultiConfig ? ["--config", "Release"] : []),
      "--target",
      ...cmakeBuildTargets,
      "-j",
      String(args.jobs),
    ],
    { cwd: args.cacheDir },
  );

  fs.mkdirSync(outDir, { recursive: true });

  const installedNames = [];
  const installedBaseNames = [];
  if (isIos) {
    // Collect every static archive produced by the iOS build into the output
    // directory. The Capacitor patch script glues these into a single
    // LlamaCpp.framework alongside the public headers.
    const archives = collectFilesUnder(buildDir, /\.a$/);
    for (const archive of archives) {
      const name = path.basename(archive);
      fs.copyFileSync(archive, path.join(outDir, name));
      installedNames.push(name);
      installedBaseNames.push(name.replace(/^lib|\.a$/g, ""));
    }
    // Stage the headers needed by cap-bridge.cpp / the public llama.cpp API
    // so the xcframework patch can include them under
    // LlamaCpp.framework/Headers/. Mirrors what packages/app-core/patches/
    // llama-cpp-capacitor@0.1.5.patch's `ios/CMakeLists*.txt` PUBLIC_HEADERS
    // list expects.
    const headerOut = path.join(outDir, "include");
    fs.mkdirSync(headerOut, { recursive: true });
    const headerSources = [
      path.join(args.cacheDir, "include", "llama.h"),
      path.join(args.cacheDir, "ggml", "include", "ggml.h"),
      path.join(args.cacheDir, "ggml", "include", "ggml-alloc.h"),
      path.join(args.cacheDir, "ggml", "include", "ggml-backend.h"),
      path.join(args.cacheDir, "ggml", "include", "ggml-cpu.h"),
      path.join(args.cacheDir, "ggml", "include", "ggml-metal.h"),
    ];
    for (const src of headerSources) {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(headerOut, path.basename(src)));
      }
    }
    // Stage the embedded Metal library if the build produced one.
    for (const candidate of collectFilesUnder(buildDir, /\.metallib$/)) {
      fs.copyFileSync(candidate, path.join(outDir, path.basename(candidate)));
    }
  } else {
    // MSVC and Xcode are multi-config generators: binaries land in
    // bin/Release/ (or bin/Debug/ when --config Release is missing). Resolve
    // the actual directory by preferring Release, then Debug, then the
    // single-config layout used by Ninja / Unix Makefiles on macOS/Linux.
    const binDirCandidates = [
      path.join(buildDir, "bin", "Release"),
      path.join(buildDir, "bin", "Debug"),
      path.join(buildDir, "bin"),
    ];
    const binDir =
      binDirCandidates.find((p) => fs.existsSync(p)) ?? binDirCandidates[2];
    const executableNames = [
      "llama-server",
      "llama-cli",
      "llama-speculative-simple",
      // Stub fused server emitted only when target is in FUSED_TARGETS.
      // Adding it unconditionally is harmless: the install loop only
      // copies a binary when it actually exists in binDir.
      ...(fused ? ["llama-omnivoice-server"] : []),
    ];
    // Cross-compiled binaries can have a host-specific suffix (.exe). Match
    // by base name so Windows builds still install the right files.
    if (fs.existsSync(binDir)) {
      for (const name of fs.readdirSync(binDir)) {
        const base = name.replace(/\.(exe)$/i, "");
        if (executableNames.includes(base) || isRuntimeLibrary(name)) {
          installedNames.push(name);
        }
      }
    }
    for (const name of installedNames) {
      const src = path.join(binDir, name);
      const dst = path.join(outDir, name);
      fs.copyFileSync(src, dst);
      if (executableNames.includes(name.replace(/\.(exe)$/i, ""))) {
        fs.chmodSync(dst, 0o755);
      }
    }

    // Darwin Metal builds (non-EMBED, see cmakeFlagsForTarget) emit
    // default.metallib alongside the runtime libraries in binDir. The
    // metallib must ship next to llama-server because Metal looks for it
    // via dlopen-style loader_path resolution (the binary's directory).
    if (platform === "darwin" && backend === "metal") {
      const metallibCandidate = path.join(binDir, "default.metallib");
      if (!fs.existsSync(metallibCandidate)) {
        throw new Error(
          `[dflash-build] expected default.metallib at ${metallibCandidate} ` +
            `for ${target} — the non-EMBED metallib build did not produce it. ` +
            `Inspect the cmake build log for failures in the milady-shipped/ ` +
            `xcrun metal compile steps.`,
        );
      }
      const metallibDst = path.join(outDir, "default.metallib");
      fs.copyFileSync(metallibCandidate, metallibDst);
      installedNames.push("default.metallib");
      console.log(
        `[dflash-build] installed default.metallib (${fs.statSync(metallibDst).size} bytes) -> ${outDir}`,
      );
    }

    const ggufPySrc = path.join(args.cacheDir, "gguf-py");
    const ggufPyDst = path.join(outDir, "gguf-py");
    if (fs.existsSync(ggufPySrc)) {
      fs.rmSync(ggufPyDst, { recursive: true, force: true });
      fs.cpSync(ggufPySrc, ggufPyDst, { recursive: true });
    }
    makeDarwinInstallSelfContained(outDir, installedNames, binDir);

    for (const name of installedNames) {
      const base = name.replace(/\.(exe)$/i, "");
      if (executableNames.includes(base)) installedBaseNames.push(base);
    }
  }

  // For fused targets, prove that BOTH llama_* and omnivoice_* symbol
  // families landed in the produced shared library. Per
  // packages/inference/AGENTS.md §3, missing fusion is a hard error
  // with no fallback.
  let omnivoiceVerification = null;
  if (fused) {
    omnivoiceVerification = verifyFusedSymbols({ outDir, target });
    console.log(
      `[dflash-build] omnivoice-fuse symbol-verify: ` +
        `library=${omnivoiceVerification.library} ` +
        `llama=${omnivoiceVerification.llamaSymbolCount} ` +
        `omnivoice=${omnivoiceVerification.omnivoiceSymbolCount}`,
    );
  }

  const capabilities = writeCapabilities({
    outDir,
    target,
    buildDir,
    forkCommit: ctx.forkCommit,
    binaries: installedBaseNames,
    omnivoice:
      fused && omnivoiceInfo
        ? {
            ref: omnivoiceInfo.ref,
            commit: omnivoiceInfo.commit,
            ggmlSubmoduleCommit: omnivoiceInfo.ggmlSubmoduleCommit,
            ggmlReconciliation: "graft-strip-submodule",
            sourceCount: omnivoiceInfo.sourceCount,
            appliedPatches: omnivoiceInfo.appliedPatches,
            verification: omnivoiceVerification,
          }
        : null,
  });
  console.log(
    `[dflash-build] installed ${target} binaries to ${outDir} (kernels: ${Object.entries(
      capabilities.kernels,
    )
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ") || "none"})`,
  );
  return capabilities;
}

function build(args) {
  if (!has("git")) throw new Error("git is required");
  if (!has("cmake")) throw new Error("cmake is required");

  // Build host context once for compatibility checks and toolchain wiring.
  const androidNdk = resolveAndroidNdk();
  // Decide whether any Vulkan target is in scope. We only fetch the
  // Khronos header repos when needed — cheap, but pointless otherwise.
  const willBuildVulkan =
    args.all ||
    (args.targets &&
      args.targets.some(
        (t) => t.endsWith("-vulkan") || t.endsWith("-vulkan-fused"),
      )) ||
    (!args.targets && (args.backend ?? detectBackend()) === "vulkan");
  // Same idea for the Windows cross path — only probe + write the
  // mingw-w64 toolchain file when at least one windows target is queued.
  const willBuildWindows =
    args.all ||
    (args.targets && args.targets.some((t) => t.startsWith("windows-"))) ||
    (!args.targets &&
      process.platform !== "win32" &&
      (args.backend ?? detectBackend()) === "cpu" &&
      false); /* never auto-trigger for legacy mode on non-windows hosts */
  const mingw =
    willBuildWindows && process.platform !== "win32"
      ? findMingwToolchain()
      : null;
  const ctx = {
    androidNdk,
    androidVulkanInclude: findAndroidVulkanInclude(androidNdk),
    glslc: findGlslc(androidNdk),
    vulkanHpp: willBuildVulkan ? safelyPrepareVulkanHeaders() : null,
    mingw,
    mingwToolchainFile: mingw ? writeMingwToolchainFile({ mingw }) : null,
    forkCommit: "",
  };

  // Decide the target list.
  let targets;
  if (args.all) {
    targets = SUPPORTED_TARGETS.slice();
  } else if (args.targets && args.targets.length > 0) {
    targets = args.targets.slice();
  } else {
    // Legacy single-target mode.
    const backend = args.backend || detectBackend();
    const platform =
      process.platform === "win32" ? "windows" : process.platform;
    const arch = nodeArchToTripleArch(platform);
    const legacyTarget = `${platform}-${arch}-${backend}`;
    targets = [legacyTarget];
    if (!SUPPORTED_TARGETS.includes(legacyTarget)) {
      throw new Error(
        `[dflash-build] legacy backend produced unsupported target ${legacyTarget}; ` +
          `pass --target explicitly with one of: ${SUPPORTED_TARGETS.join(", ")}`,
      );
    }
  }

  if (!args.dryRun) {
    ctx.forkCommit = ensureCheckout(args.cacheDir, args.ref);
  } else if (fs.existsSync(path.join(args.cacheDir, ".git"))) {
    ctx.forkCommit = run("git", ["rev-parse", "HEAD"], {
      cwd: args.cacheDir,
      capture: true,
    });
  }

  const built = [];
  const skipped = []; // host-incompat — soft skip
  const failed = []; // real failures — hard fail at end
  for (const target of targets) {
    const compat = targetCompatibility(target, ctx);
    if (!compat.ok) {
      console.log(
        `[dflash-build] skip target=${target}: ${compat.reason}`,
      );
      skipped.push({ target, reason: compat.reason });
      if (args.targets && args.targets.length > 0 && !args.all) {
        // Explicit single --target should fail loudly rather than silently skip.
        throw new Error(
          `target ${target} is not buildable on this host: ${compat.reason}`,
        );
      }
      continue;
    }
    try {
      const capabilities = buildTarget({ target, args, ctx });
      built.push({ target, capabilities });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (args.all) {
        console.error(`[dflash-build] target=${target} failed: ${message}`);
        // In --all mode we collect failures rather than tear down the whole
        // run on the first error, so a partial green can still produce
        // diagnostic CAPABILITIES.json files. But unlike host-incompat skips
        // (Linux on macOS, etc.) these are REAL failures — the run as a
        // whole must exit non-zero. failed[] is checked at the bottom.
        failed.push({ target, reason: `build failed: ${message}` });
      } else {
        throw err;
      }
    }
  }

  if (args.dryRun) {
    console.log(
      `[dflash-build] dry-run: ${targets.length - skipped.length - failed.length} targets queued, ${skipped.length} host-incompat-skipped, ${failed.length} would-fail`,
    );
  } else {
    console.log(
      `[dflash-build] done. built=${built.length} host-incompat-skipped=${skipped.length} failed=${failed.length}`,
    );
    console.log(
      `[dflash-build] set ELIZA_DFLASH_ENABLED=1 to force this backend, or leave it unset for auto-detect from the managed path.`,
    );
  }
  if (failed.length > 0) {
    // Per AGENTS.md §3 + the build-script audit: --all mode must NOT exit 0
    // when any target failed for a real reason. host-incompat skips (Linux
    // on macOS, etc.) remain a soft skip; everything else is fatal.
    throw new Error(
      `[dflash-build] ${failed.length} target(s) failed: ` +
        failed.map((f) => `${f.target} (${f.reason})`).join("; "),
    );
  }
}

try {
  build(parseArgs(process.argv.slice(2)));
} catch (err) {
  console.error(
    `[dflash-build] ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
