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

// milady-ai/llama.cpp @ v0.2.0-milady (commit 7c7818aa) — the unified fork
// that composes TBQ + QJL + Q4_POLAR + Metal kernels + DFlash spec-decode
// onto upstream b8198. Same repo + commit lineage as compile-libllama.mjs
// (AOSP cross-compile path) so both build paths land on identical kernels.
const REMOTE =
  process.env.ELIZA_DFLASH_LLAMA_CPP_REMOTE ||
  "https://github.com/milady-ai/llama.cpp.git";
const REF = process.env.ELIZA_DFLASH_LLAMA_CPP_REF || "v0.2.0-milady";
// Minimum commit on milady/integration that contains the DFlash CLI
// surface (--spec-type dflash, --draft-min-prob, Prometheus counters).
const MIN_COMMIT = "7c7818aafc7599996268226e2e56099f4f38e972";

const SUPPORTED_TARGETS = [
  "linux-x64-cpu",
  "linux-x64-cuda",
  "linux-x64-rocm",
  "linux-x64-vulkan",
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
];

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
    console.warn(
      `[dflash-build] patchGgmlBaseForWindowsQjl: ${cmakeListsPath} missing, skipping`,
    );
    return;
  }
  const original = fs.readFileSync(cmakeListsPath, "utf8");
  const sentinel = "# MILADY-WINDOWS-QJL-IN-GGML-BASE";
  if (original.includes(sentinel)) {
    return; // already patched
  }
  const anchor = "            polar_centroids.h\n            gguf.cpp)";
  if (!original.includes(anchor)) {
    console.warn(
      `[dflash-build] patchGgmlBaseForWindowsQjl: anchor not found in ${cmakeListsPath}; ` +
        `the milady-ai/llama.cpp fork layout may have changed. Skipping; ` +
        `ggml-base.dll link will fail.`,
    );
    return;
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

function safelyPrepareVulkanHeaders() {
  try {
    return prepareVulkanHeaders();
  } catch (err) {
    console.warn(
      `[dflash-build] Vulkan-Headers / SPIRV-Headers fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
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
function parseTarget(target) {
  const parts = target.split("-");
  if (parts[0] === "ios" && parts[2] === "simulator") {
    return {
      platform: parts[0],
      arch: parts[1],
      backend: parts[3],
      isSimulator: true,
    };
  }
  return {
    platform: parts[0],
    arch: parts[1],
    backend: parts[2],
    isSimulator: false,
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
  } else if (backend === "cuda") {
    flags[flags.indexOf("-DGGML_CUDA=OFF")] = "-DGGML_CUDA=ON";
    flags.push("-DGGML_CUDA_FA=ON", "-DGGML_CUDA_FA_ALL_QUANTS=ON");
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
    if (process.env.MINGW_TOOLCHAIN_FILE) {
      flags.push(`-DCMAKE_TOOLCHAIN_FILE=${process.env.MINGW_TOOLCHAIN_FILE}`);
    } else if (ctx.mingwToolchainFile) {
      flags.push(`-DCMAKE_TOOLCHAIN_FILE=${ctx.mingwToolchainFile}`);
    }
    // CURL isn't part of the cross-toolchain sysroot. cpp-httplib is
    // statically vendored under llama.cpp/vendor/ and provides the HTTP
    // surface llama-server needs.
    flags.push("-DLLAMA_CURL=OFF");
    if (backend === "cpu") {
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
      // Don't try to build llama-server on iOS (no networking sandbox path).
      "-DLLAMA_BUILD_EXAMPLES=OFF",
    );
    if (isSimulator) {
      flags.push("-DCMAKE_OSX_SYSROOT=iphonesimulator");
    } else {
      flags.push("-DCMAKE_OSX_SYSROOT=iphoneos");
    }
    if (backend === "metal") {
      // Metal kernels work on both iOS device and simulator (since macOS 10.15
      // / iOS 13). Embed the .metallib into the bundle so runtime AIR JIT
      // doesn't have to read sources from the app sandbox.
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
  const { platform, backend } = parseTarget(target);
  if (platform === "darwin" && process.platform !== "darwin") {
    return { ok: false, reason: "darwin target requires macOS host" };
  }
  if (platform === "ios" && process.platform !== "darwin") {
    return { ok: false, reason: "ios target requires macOS host with Xcode" };
  }
  if (platform === "linux" && process.platform !== "linux") {
    return { ok: false, reason: "linux target requires linux host" };
  }
  if (platform === "windows") {
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

function defaultTarget() {
  const backend = detectBackend();
  const arch = process.arch === "x64" ? "x64" : process.arch;
  const platform =
    process.platform === "win32" ? "windows" : process.platform;
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
          ...SUPPORTED_TARGETS.map((t) => `  ${t}`),
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

function patchVulkanKernels(_cacheDir) {
  // Default-on after hardware verification (Wave-4 W4-A): the turbo3 / turbo4
  // / turbo3_tcq Vulkan compute shaders in packages/inference/vulkan/ now
  // pass 8/8 numerical fixtures on Intel ARL Mesa 25.2.8 + lavapipe with the
  // shared-memory tree reduction (replacing the broken subgroupAdd path that
  // assumed a single 32-lane subgroup per workgroup). The fork consumes the
  // same source-of-truth shaders, so this patch hook is a no-op log: kept so
  // a future layout drift can attach a warn-on-mismatch sentinel guard like
  // patchGgmlBaseForWindowsQjl. Set ELIZA_DFLASH_PATCH_VULKAN_KERNELS=0 to
  // silence the log.
  if (process.env.ELIZA_DFLASH_PATCH_VULKAN_KERNELS === "0") return;
  console.log(
    "[dflash-build] patchVulkanKernels: turbo3/turbo4/turbo3_tcq verified on Intel ARL + lavapipe; fork kernels in sync.",
  );
}

function patchMetalTurbo3Tcq(_cacheDir) {
  if (process.env.ELIZA_DFLASH_PATCH_METAL_TURBO3 !== "1") return;
  console.log(
    "[dflash-build] patchMetalTurbo3Tcq: kernels already present on milady-ai/llama.cpp; no-op.",
  );
}

function patchMetalQjl(_cacheDir) {
  if (process.env.ELIZA_DFLASH_PATCH_METAL_QJL !== "1") return;
  console.log(
    "[dflash-build] patchMetalQjl: kernels already present on milady-ai/llama.cpp; no-op.",
  );
}

function patchMetalPolar(_cacheDir) {
  if (process.env.ELIZA_DFLASH_PATCH_METAL_POLAR !== "1") return;
  console.log(
    "[dflash-build] patchMetalPolar: kernels already present on milady-ai/llama.cpp; no-op.",
  );
}

function applyForkPatches(cacheDir, backend, target) {
  if (backend === "metal") {
    patchMetalTurbo4(cacheDir);
    patchMetalTurbo3Tcq(cacheDir);
    patchMetalQjl(cacheDir);
    patchMetalPolar(cacheDir);
  }
  if (backend === "vulkan") {
    patchVulkanKernels(cacheDir);
  }
  if (target && target.startsWith("windows-")) {
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
  if (arch === "arm64" && process.arch !== "arm64") return false;
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

function writeCapabilities({
  outDir,
  target,
  buildDir,
  forkCommit,
  binaries,
}) {
  const { platform, arch, backend } = parseTarget(target);
  const kernels = probeKernels(target, buildDir, outDir);
  const capabilities = {
    target,
    platform,
    arch,
    backend,
    builtAt: new Date().toISOString(),
    fork: "milady-ai/llama.cpp",
    forkCommit,
    kernels,
    binaries,
  };
  fs.writeFileSync(
    path.join(outDir, "CAPABILITIES.json"),
    `${JSON.stringify(capabilities, null, 2)}\n`,
  );
  return capabilities;
}

function targetOutDir(target, override) {
  if (override) return override;
  return path.join(stateDir(), "local-inference", "bin", "dflash", target);
}

// Build a single target. Returns the resulting CAPABILITIES.json object.
function buildTarget({ target, args, ctx }) {
  const { platform, backend } = parseTarget(target);
  const outDir = targetOutDir(target, args.outDirOverride);
  const buildDir = path.join(args.cacheDir, "build", target);
  const flags = cmakeFlagsForTarget(target, ctx);

  if (args.dryRun) {
    console.log(`[dflash-build] (dry-run) target=${target}`);
    console.log(
      `  cmake -B ${buildDir} ${flags.join(" ")}`.replace(/ +/g, " "),
    );
    console.log(
      `  cmake --build ${buildDir} --target llama-server llama-cli llama-speculative-simple -j ${args.jobs}`,
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
  const isIos = platform === "ios";
  const cmakeBuildTargets = isIos
    ? ["llama", "ggml", "ggml-base", "ggml-cpu", "ggml-metal"]
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

  const capabilities = writeCapabilities({
    outDir,
    target,
    buildDir,
    forkCommit: ctx.forkCommit,
    binaries: installedBaseNames,
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
    (args.targets && args.targets.some((t) => t.endsWith("-vulkan"))) ||
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
    const arch = process.arch === "x64" ? "x64" : process.arch;
    const platform =
      process.platform === "win32" ? "windows" : process.platform;
    const legacyTarget = `${platform}-${arch}-${backend}`;
    targets = [legacyTarget];
    if (!SUPPORTED_TARGETS.includes(legacyTarget)) {
      console.warn(
        `[dflash-build] warning: legacy backend produced unsupported target ${legacyTarget}; proceeding anyway`,
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
  const skipped = [];
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
        skipped.push({ target, reason: `build failed: ${message}` });
      } else {
        throw err;
      }
    }
  }

  if (args.dryRun) {
    console.log(
      `[dflash-build] dry-run: ${targets.length - skipped.length} targets queued, ${skipped.length} skipped`,
    );
  } else {
    console.log(
      `[dflash-build] done. built=${built.length} skipped=${skipped.length}`,
    );
    console.log(
      `[dflash-build] set ELIZA_DFLASH_ENABLED=1 to force this backend, or leave it unset for auto-detect from the managed path.`,
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
