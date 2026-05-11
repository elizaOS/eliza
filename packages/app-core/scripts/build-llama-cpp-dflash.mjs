#!/usr/bin/env node
/**
 * Build the DFlash-capable llama-server fork used by local inference.
 *
 * As of v0.2.0-milady, DFlash speculative decoding lives in the unified
 * elizaOS/llama.cpp fork (the same repo as the AOSP cross-compile).
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
 *   linux-aarch64-cpu, linux-aarch64-cuda   (GH200 / Ampere Altra / Graviton; arm64 Linux host only)
 *   android-arm64-cpu, android-arm64-vulkan
 *   darwin-arm64-metal, darwin-x64-metal    (darwin-x64-metal: COMPILE-ONLY; Intel-Mac GPUs aren't Apple7+)
 *   ios-arm64-metal, ios-arm64-simulator-metal  (macOS + Xcode host)
 *   windows-x64-cpu, windows-x64-cuda, windows-x64-vulkan
 *   windows-arm64-cpu, windows-arm64-vulkan  (Snapdragon X / Copilot+ PC; native MSVC arm64 or LLVM aarch64 mingw)
 *   ...plus the *-fused variants (omnivoice text+TTS source fusion).
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
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { patchCpuPolarKernels as patchCpuPolarKernelsImpl } from "./kernel-patches/cpu-polar-kernels.mjs";
import {
  patchCpuSimdKernels as patchCpuSimdKernelsImpl,
  QJL_GGML_BASE_LINK_FILES,
} from "./kernel-patches/cpu-simd-kernels.mjs";
import { patchCpuThreadParallelism as patchCpuThreadParallelismImpl } from "./kernel-patches/cpu-thread-parallelism.mjs";
import { patchMetalKernels as patchMetalKernelsImpl } from "./kernel-patches/metal-kernels.mjs";
import { patchServerOmnivoiceRoute as patchServerOmnivoiceRouteImpl } from "./kernel-patches/server-omnivoice-route.mjs";
import { patchServerStructuredOutput as patchServerStructuredOutputImpl } from "./kernel-patches/server-structured-output.mjs";
import { patchVulkanKernels as patchVulkanKernelsImpl } from "./kernel-patches/vulkan-kernels.mjs";
import {
  appendCmakeGraft,
  fusedCmakeBuildTargets,
  fusedExtraCmakeFlags,
} from "./omnivoice-fuse/cmake-graft.mjs";
// Source-level omnivoice.cpp fusion (text + TTS sharing one llama.cpp
// build, one ggml pin, one kernel set). Helpers live alongside this
// script under omnivoice-fuse/; see omnivoice-fuse/README.md for the
// GGML pin reconciliation strategy.
import {
  OMNIVOICE_GGML_REF,
  OMNIVOICE_REF,
  prepareOmnivoiceFusion,
} from "./omnivoice-fuse/prepare.mjs";
import { verifyFusedSymbols } from "./omnivoice-fuse/verify-symbols.mjs";

// elizaOS/llama.cpp @ v1.0.0-eliza (commit 08032d57) — the unified fork that
// composes TBQ (turbo3/turbo4/turbo3_tcq) + QJL (block_qjl1_256,
// GGML_OP_ATTN_SCORE_QJL, GGML_OP_FUSED_ATTN_QJL_TBQ) + Q4_POLAR (Q4_POLAR=47)
// + the milady Metal/Vulkan/CUDA kernels + DFlash spec-decode (--spec-type
// dflash, the dflash-draft GGUF arch) + the post-refactor llama-server
// (server-task.cpp / server-common.cpp with grammar_lazy / json_schema /
// response_format / prefill_assistant) onto upstream b8198. Same repo + commit
// lineage as compile-libllama.mjs (AOSP cross-compile path) so both build
// paths land on identical kernels. (v1.0.0-eliza is the same tree as the prior
// v0.4.0-milady tag, re-tagged on the elizaOS rename.)
//
// The fork ships in-tree as a git submodule at packages/inference/llama.cpp
// (next to the kernel sources under packages/inference/{metal,vulkan,cuda}).
// `bun install` runs `git submodule update --init --recursive` so a fresh
// checkout has it. The build defaults to that submodule checkout; set
// ELIZA_DFLASH_LLAMA_CPP_REMOTE / _REF (or pass --cache-dir / --ref) to build
// from a standalone clone instead — that path falls back to a per-user clone
// under ~/.cache/eliza-dflash/milady-llama-cpp.
const REMOTE =
  process.env.ELIZA_DFLASH_LLAMA_CPP_REMOTE ||
  "https://github.com/elizaOS/llama.cpp.git";
const REF = process.env.ELIZA_DFLASH_LLAMA_CPP_REF || "v1.0.0-eliza";
// The in-repo submodule checkout of the fork. When it is initialized this is
// the default build source (no clone needed); see resolveSourceCheckout().
const SUBMODULE_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "inference",
  "llama.cpp",
);
// The fork is wired as a submodule unless the operator forces a standalone
// clone via ELIZA_DFLASH_LLAMA_CPP_REMOTE / _REF or an explicit --cache-dir.
const USING_FORK_OVERRIDE = Boolean(
  process.env.ELIZA_DFLASH_LLAMA_CPP_REMOTE ||
    process.env.ELIZA_DFLASH_LLAMA_CPP_REF,
);
const LEGACY_DFLASH_DRAFTER_REMOTE =
  process.env.ELIZA_DFLASH_LEGACY_DRAFTER_REMOTE ||
  "https://github.com/spiritbuun/buun-llama-cpp.git";
const LEGACY_DFLASH_DRAFTER_REF =
  process.env.ELIZA_DFLASH_LEGACY_DRAFTER_REF ||
  "6575873e9c4872709d374d854b583cfaa270caff";
// Minimum commit that must be an ancestor of the build source's HEAD: it
// carries the DFlash CLI surface (--spec-type dflash, --draft-min-prob,
// Prometheus draft counters). It is contained by v1.0.0-eliza (and the W4-B
// CUDA kernel additions). The submodule checkout always satisfies this; the
// check only matters for a standalone clone pinned at an older ref.
const MIN_COMMIT = "7c7818aafc7599996268226e2e56099f4f38e972";
const METAL_RUNTIME_DISPATCH_EVIDENCE = path.resolve(
  __dirname,
  "..",
  "..",
  "inference",
  "verify",
  "metal-runtime-dispatch-evidence.json",
);
const VULKAN_RUNTIME_DISPATCH_EVIDENCE = path.resolve(
  __dirname,
  "..",
  "..",
  "inference",
  "verify",
  "vulkan-runtime-dispatch-evidence.json",
);

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
  // windows-x64-vulkan: generic-GPU path on x64 Windows. NVIDIA/AMD/Intel
  // ARC all expose Vulkan 1.3+ here. Cross-builds from a Linux/Darwin host
  // via mingw + Khronos Vulkan-Headers — same shape as windows-x64-cpu but
  // with the existing Vulkan-headers prep step.
  "windows-x64-vulkan",
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
  "linux-x64-cuda-fused",
  "linux-x64-vulkan-fused",
  "darwin-arm64-metal-fused",
  "darwin-x64-metal-fused",
  "windows-x64-cuda-fused",
];

// Targets that opt into omnivoice fusion. Membership in this set is
// the only way the fused-build code path activates — no env var
// shortcuts, no implicit upgrades from a non-fused target.
const FUSED_TARGETS = new Set([
  "linux-x64-cpu-fused",
  "linux-x64-cuda-fused",
  "linux-x64-vulkan-fused",
  "darwin-arm64-metal-fused",
  "darwin-x64-metal-fused",
  "windows-x64-cuda-fused",
]);

// Strip the "-fused" suffix when one is present, returning the base
// triple parseTarget() / cmakeFlagsForTarget() already understand.
// Calling this on a non-fused triple is a no-op.
function baseTargetTriple(target) {
  return target.endsWith("-fused") ? target.slice(0, -"-fused".length) : target;
}

function isFusedTarget(target) {
  return FUSED_TARGETS.has(target);
}

function stateDir() {
  return (
    process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza")
  );
}

function envFlag(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
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

// Does the *build host's* CPU expose 256-bit AVX-VNNI (Alder Lake / Arrow Lake
// and newer)? Used to pass -DGGML_AVX_VNNI=ON for native x86_64-Linux builds so
// the fork's ggml-cpu CMakeLists adds -mavxvnni + defines GGML_AVX_VNNI /
// __AVXVNNI__, which the QJL int8-sketch score kernel
// (qjl_score_qk_i8_avxvnni / qjl_score_avxvnni.c) keys off. cpuid leaf 7,
// sub-leaf 1, EAX[4]. Linux-only probe via /proc/cpuinfo (lscpu's "avx_vnni"
// flag is the kernel's name for this bit).
function hostHasAvxVnni() {
  if (process.platform !== "linux" || process.arch !== "x64") return false;
  try {
    const cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8");
    return /\bflags\b.*\bavx_vnni\b/.test(cpuinfo);
  } catch {
    return false;
  }
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

// Parse the major.minor CUDA toolkit version reported by `nvcc --version`,
// e.g. "Cuda compilation tools, release 12.6, V12.6.20" -> { major: 12, minor: 6 }.
// Returns null when nvcc is absent or the banner can't be parsed — callers
// must treat that as "assume the conservative arch list".
function nvccVersion() {
  if (!has("nvcc")) return null;
  const r = tryRun("nvcc", ["--version"], { capture: true });
  const m = (r.stdout || "").match(/release\s+(\d+)\.(\d+)/i);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

// Build the CUDA fat-binary arch list for cuda/cuda-fused targets. The base
// list (sm_80..sm_90a) is unconditional; the Blackwell datacenter (sm_100)
// and consumer (sm_120) virtual architectures are only appended when the
// installed nvcc actually knows about them — sm_100/sm_120 first compile in
// CUDA 12.8, and older nvcc rejects them with "Unsupported gpu architecture".
//   90a -> H200 / GH200 (the only arch with the TMA / WGMMA fast paths)
//   90  -> H100
//   89  -> Ada / RTX 4090 / L4
//   86  -> Ampere consumer / RTX 30xx
//   80  -> A100 / datacenter Ampere
//   100 -> Blackwell datacenter (B100/B200/GB200) — CUDA >= 12.8
//   120 -> Blackwell consumer (RTX 50xx) — CUDA >= 12.8
// Operators that target an older card (sm_75 Turing, sm_70 Volta) can
// override via ELIZA_DFLASH_CMAKE_FLAGS=-DCMAKE_CUDA_ARCHITECTURES=... which
// appends after this list and wins on a CMake conflict.
function cudaArchListFlag() {
  const archs = ["90a", "90", "89", "86", "80"];
  const v = nvccVersion();
  if (v && (v.major > 12 || (v.major === 12 && v.minor >= 8))) {
    archs.push("100", "120");
  }
  return `-DCMAKE_CUDA_ARCHITECTURES=${archs.join(";")}`;
}

// Build the ROCm/HIP fat-binary arch list for rocm targets. gfx1200/gfx1201
// (RDNA4 / RX 9070) only compile under ROCm >= 6.3; older hipcc rejects
// them, so they are gated the same way Blackwell is gated for CUDA.
//   gfx90a  -> MI250 / CDNA2
//   gfx942  -> MI300 / CDNA3
//   gfx110* -> RDNA3 desktop/laptop smoke hosts
//   gfx120* -> RDNA4 (RX 9070 / 9070 XT) — ROCm >= 6.3
function hipArchListFlag() {
  const archs = ["gfx90a", "gfx942", "gfx1100", "gfx1101", "gfx1102"];
  if (has("hipcc")) {
    const r = tryRun("hipcc", ["--version"], { capture: true });
    const m = (r.stdout || "").match(/HIP version:\s*(\d+)\.(\d+)/i);
    if (m && (Number(m[1]) > 6 || (Number(m[1]) === 6 && Number(m[2]) >= 3))) {
      archs.push("gfx1200", "gfx1201");
    }
  }
  return `-DCMAKE_HIP_ARCHITECTURES=${archs.join(";")}`;
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
// Why: the elizaOS/llama.cpp fork places QJL function definitions in
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
// TODO(elizaOS/llama.cpp): land an upstream fix that either (a) moves
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
        `the elizaOS/llama.cpp fork layout has changed. Without this patch ` +
        `Windows shared-lib builds will fail to link QJL symbols into ggml-base.dll.`,
    );
  }
  const qjlFileLines = QJL_GGML_BASE_LINK_FILES.map((f) => `            ${f}`).join(
    "\n",
  );
  const replacement = `            polar_centroids.h
            gguf.cpp
            ${sentinel}
            # PE/COFF requires every imported symbol to be resolved at
            # link time; the QJL definitions in ggml-cpu/qjl/ are referenced
            # from ggml.c (ggml-base), so on Windows shared-lib builds they
            # must also live in ggml-base. Linux/macOS use the original
            # ggml-cpu placement and ignore this duplicate. The list mirrors
            # QJL_GGML_BASE_LINK_FILES in kernel-patches/cpu-simd-kernels.mjs.
${qjlFileLines})
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
const VULKAN_HEADERS_REPO =
  "https://github.com/KhronosGroup/Vulkan-Headers.git";
const VULKAN_HEADERS_REF =
  process.env.ELIZA_DFLASH_VULKAN_HEADERS_REF || "v1.3.295";
const SPIRV_HEADERS_REPO = "https://github.com/KhronosGroup/SPIRV-Headers.git";
const SPIRV_HEADERS_REF =
  process.env.ELIZA_DFLASH_SPIRV_HEADERS_REF || "vulkan-sdk-1.3.296.0";

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
  if (
    explicitVulkan &&
    fs.existsSync(path.join(explicitVulkan, "vulkan", "vulkan.hpp"))
  ) {
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
  // ──────────────────────────────────────────────────────────────────
  // TODO ANCHORS for the Vulkan / CUDA / CPU kernel agents.
  // This function is the single owner of cmake flags. If you need a new
  // backend cmake flag (e.g. a Vulkan shader-int8 toggle, a CUDA
  // -DGGML_CUDA_F16=ON, a CPU -DGGML_LLAMAFILE knob), send a request via
  // your report and the build-script owner adds it here — do NOT inject
  // it via ELIZA_DFLASH_CMAKE_FLAGS in production paths.
  //   * VULKAN-AGENT TODO: extra flags for `linux-x64-vulkan` /
  //     `android-arm64-vulkan` / `windows-*-vulkan` graph-dispatch builds
  //     go in the `backend === "vulkan"` branch below.
  //   * CUDA-AGENT TODO: extra flags for `linux-x64-cuda` /
  //     `windows-x64-cuda` / `linux-aarch64-cuda` go in the
  //     `backend === "cuda"` branch (arch list is `cudaArchListFlag`).
  //   * CPU-AGENT TODO: SIMD / threading flags for `linux-x64-cpu`,
  //     `linux-aarch64-cpu`, `windows-arm64-cpu` go alongside the
  //     existing `backend === "cpu" && arch === "x64"` / `arm64` blocks
  //     in the `platform === "windows"` section (and a new linux-cpu
  //     block here if a non-native pin is ever needed).
  // ──────────────────────────────────────────────────────────────────
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
    //     the static-archive build needs compiled metallib bytes baked
    //     into the framework via .incbin.
    //   * Darwin desktop (this branch) sets it OFF so the metallib is
    //     compiled at build time into a sidecar default.metallib that
    //     ships next to llama-server. The kernel-patches/metal-kernels
    //     CMakeLists patch hooks into the non-EMBED add_custom_command
    //     so each standalone shader (turbo3/turbo4/turbo3_tcq/qjl/polar)
    //     is compiled into its own .air and merged into default.metallib
    //     alongside ggml-metal.air.
    //
    //     The EMBED path is patched by kernel-patches/metal-kernels.mjs
    //     to embed a compiled default.metallib instead of concatenated
    //     source. That keeps the standalone shader TUs separate and
    //     avoids duplicate block_* / constant declarations.
    flags.push("-DGGML_METAL_EMBED_LIBRARY=OFF");
  } else if (backend === "cuda") {
    flags[flags.indexOf("-DGGML_CUDA=OFF")] = "-DGGML_CUDA=ON";
    flags.push("-DGGML_CUDA_FA=ON", "-DGGML_CUDA_FA_ALL_QUANTS=ON");
    // Multi-arch fat-binary pin (see cudaArchListFlag). Without this the
    // build host's GPU (or sm_52 default on a GPU-less host) decides the
    // emitted PTX/SASS — wrong for a redistributable artifact, and the
    // canonical GH200 deployment needs sm_90a.
    flags.push(cudaArchListFlag());
  } else if (backend === "rocm") {
    flags[flags.indexOf("-DGGML_HIP=OFF")] = "-DGGML_HIP=ON";
    // Multi-arch fat-binary pin (see hipArchListFlag). Operators can
    // narrow/extend with ELIZA_DFLASH_CMAKE_FLAGS; those flags append
    // after this list and win on a CMake conflict.
    flags.push(hipArchListFlag());
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

  if (platform === "linux" && arch === "aarch64") {
    // Native arm64-Linux build (GH200 host, Ampere Altra, AWS Graviton).
    // targetCompatibility() already refuses this triple on x64 hosts —
    // there is no aarch64 cross-toolchain wired here — so this is always
    // a native build. CMAKE_SYSTEM_PROCESSOR is informational on a native
    // build but documents intent and keeps GGML_NATIVE's -mcpu probe and
    // any third-party CMake `if (... aarch64 ...)` checks honest. The CUDA
    // arch list (cudaArchListFlag) already leads with 90a for GH200/Hopper.
    flags.push("-DCMAKE_SYSTEM_PROCESSOR=aarch64");
  } else if (platform === "linux" && arch === "x64" && hostHasAvxVnni()) {
    // CPU-AGENT: native x86_64-Linux build on an Alder Lake / Arrow Lake (or
    // newer) host — turn on GGML_AVX_VNNI so the fork's ggml-cpu CMakeLists adds
    // -mavxvnni and defines GGML_AVX_VNNI / __AVXVNNI__. -march=native already
    // gives the compiler the ISA, but the explicit flag is what gates the QJL
    // int8-sketch score path (qjl_score_qk_i8_avxvnni) and any GGML_AVX_VNNI
    // `#if` blocks. Cross-builds keep it off — you can't sniff -march for a
    // different ABI, and AVX-VNNI is not the de-facto x86_64 baseline yet.
    flags.push("-DGGML_AVX_VNNI=ON");
  } else if (platform === "darwin" && arch === "x64") {
    // Intel-Mac build (`darwin-x64-metal`). Pin the slice explicitly so a
    // build that runs on an Apple-Silicon host (via the x86_64 toolchain)
    // still emits an x86_64 binary, and an Intel host stays x86_64.
    //
    // RISK — Intel-Mac GPUs (AMD Radeon Pro / Intel Iris) are NOT in the
    // Apple7+ family the standalone kernels were verified against on Apple
    // Silicon. The kernels assume threadgroup-of-32 == one SIMD-group and
    // `simd_sum` over those 32 lanes; AMD/Intel Mac drivers report
    // different SIMD-group widths and different `simd_sum` semantics, so a
    // clean build here is COMPILE-ONLY — not a verified path. Do not flip
    // `darwin-x64-metal` past TARGET-ONLY without an Intel-Mac
    // `metal_verify` run that diffs the numbers against the M4 Max
    // reference. See packages/inference/DEVICE_SUPPORT_GAP_2026-05-10.md row 3.
    flags.push("-DCMAKE_OSX_ARCHITECTURES=x86_64");
    console.log(
      "[dflash-build] darwin-x64-metal: building the Intel-Mac slice. " +
        "Intel/AMD Mac GPUs are not in the verified Apple7+ Metal family — " +
        "treat the artifact as COMPILE-ONLY until metal_verify runs on real " +
        "Intel-Mac hardware.",
    );
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
      flags.push("-DGGML_OPENMP=OFF", "-DBUILD_SHARED_LIBS=ON");
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
    // iOS static-archive build needs compiled metallib data baked in via
    // .incbin since there is no sidecar default.metallib next to a console
    // binary. The Metal patcher rewrites the EMBED_LIBRARY CMake branch to
    // compile ggml-metal.metal + the milady standalones into one metallib
    // before embedding it.
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
  if (process.arch === "arm64")
    return platform === "linux" ? "aarch64" : "arm64";
  return process.arch;
}

function defaultTarget() {
  const backend = detectBackend();
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = nodeArchToTripleArch(platform);
  return `${platform}-${arch}-${backend}`;
}

// True when `dir` is a git checkout we are not allowed to detach/reset/clone
// over — i.e. the in-repo submodule at packages/inference/llama.cpp. (A
// submodule's `.git` is a *file* containing `gitdir: ...`; a standalone clone's
// `.git` is a directory.)
function isSubmoduleCheckout(dir) {
  if (path.resolve(dir) === SUBMODULE_DIR) return true;
  try {
    return (
      fs.existsSync(path.join(dir, ".git")) &&
      fs.statSync(path.join(dir, ".git")).isFile()
    );
  } catch {
    return false;
  }
}

// True when the in-repo submodule checkout exists and has a worktree (a `.git`
// entry + a tracked source file). When this is the case the build defaults to
// it; otherwise it falls back to a per-user clone.
function submoduleCheckoutPresent() {
  try {
    return (
      fs.existsSync(path.join(SUBMODULE_DIR, ".git")) &&
      fs.existsSync(path.join(SUBMODULE_DIR, "CMakeLists.txt"))
    );
  } catch {
    return false;
  }
}

// The standalone (non-submodule) source-checkout cache. Renamed from
// buun-llama-cpp to milady-llama-cpp on the unified-fork migration; the new
// directory busts the old cache so a fresh ref pull is forced. Used only when
// the operator forces a standalone clone via ELIZA_DFLASH_LLAMA_CPP_REMOTE /
// _REF (or an explicit --cache-dir), or when the submodule isn't initialized.
function standaloneCacheDir() {
  return path.join(os.homedir(), ".cache", "eliza-dflash", "milady-llama-cpp");
}

// Decide the default build source: the in-repo submodule unless the operator
// forced a standalone clone via ELIZA_DFLASH_LLAMA_CPP_REMOTE / _REF.
function defaultSourceCheckoutDir() {
  if (!USING_FORK_OVERRIDE && submoduleCheckoutPresent()) return SUBMODULE_DIR;
  return standaloneCacheDir();
}

function parseArgs(argv) {
  const args = {
    cacheDir: defaultSourceCheckoutDir(),
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
          "github.com/ServeurpersoCom/omnivoice.cpp into the elizaOS/llama.cpp",
          "build, sharing one ggml pin and one kernel set.",
          `Pinned omnivoice commit: ${OMNIVOICE_REF}`,
          `Reconciled-out omnivoice ggml submodule: ${OMNIVOICE_GGML_REF}`,
          "See packages/app-core/scripts/omnivoice-fuse/README.md.",
          "",
          "Source: by default the in-repo submodule packages/inference/llama.cpp",
          `(elizaOS/llama.cpp @ ${REF}). Pass --ref / --cache-dir or set`,
          "ELIZA_DFLASH_LLAMA_CPP_REMOTE / _REF to build from a standalone clone",
          "(~/.cache/eliza-dflash/milady-llama-cpp) instead.",
          "",
          "Options:",
          "  --target <triple>      Build a specific target (repeatable).",
          "  --all                  Build every host-compatible target.",
          "  --dry-run              Print cmake invocations without running.",
          "  --backend <name>       Legacy single-target backend selector.",
          "  --ref <git-ref>        Branch/tag/SHA of the fork (standalone-clone mode only;",
          "                         the submodule is pinned to its gitlink commit).",
          "  --out-dir <path>       Override the output directory (single target).",
          "  --cache-dir <path>     Source checkout dir (forces standalone-clone mode).",
          "  --jobs N | -j N        Parallel build jobs.",
          "",
          "Environment:",
          "  ELIZA_DFLASH_LLAMA_CPP_REMOTE / ELIZA_DFLASH_LLAMA_CPP_REF",
          "                         Build from a standalone clone of the given fork/ref",
          "                         instead of the in-repo submodule.",
          "  ELIZA_DFLASH_LEGACY_DRAFTER_RUNTIME=0",
          "                         For darwin-arm64-metal only, opt out of the",
          "                         automatic spiritbuun/buun-llama-cpp runtime",
          "                         bridge that can load general.architecture=dflash-draft.",
          "                         Bridge CAPABILITIES.json is diagnostic and publishable=false.",
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
  if (isSubmoduleCheckout(cacheDir)) {
    // The in-repo submodule checkout. Do NOT detach/fetch/clone it — it is
    // pinned to a gitlink commit owned by the eliza repo, and `bun install`
    // already ran `git submodule update --init`. Just discard the kernel-patch
    // edits this script made on a prior build (tracked + untracked) so a fresh
    // artifact starts from the pristine submodule tree, then re-apply patches.
    if (!fs.existsSync(path.join(cacheDir, ".git"))) {
      throw new Error(
        `[dflash-build] the llama.cpp submodule at ${cacheDir} is not ` +
          `checked out. Run \`git submodule update --init --recursive ` +
          `${path.relative(process.cwd(), cacheDir)}\` (bun install does this ` +
          `automatically) or set ELIZA_DFLASH_LLAMA_CPP_REMOTE / _REF to build ` +
          `from a standalone clone instead.`,
      );
    }
    run("git", ["checkout", "--", "."], { cwd: cacheDir });
    // -x so the staged kernel sources (metal/vulkan/cuda standalones copied in
    // by the patch hooks) and the per-target build/ dir are wiped too.
    run("git", ["clean", "-fdx"], { cwd: cacheDir });
  } else if (fs.existsSync(path.join(cacheDir, ".git"))) {
    run("git", ["fetch", "--depth=1", "origin", ref], { cwd: cacheDir });
    run("git", ["checkout", "FETCH_HEAD"], { cwd: cacheDir });
    // This checkout is a generated build cache owned by this script. Always
    // reset tracked and untracked source edits before applying our patch set
    // so stale kernel-patch artifacts from prior builds cannot leak into a
    // new artifact.
    run("git", ["reset", "--hard", "FETCH_HEAD"], { cwd: cacheDir });
    run("git", ["clean", "-fd"], { cwd: cacheDir });
  } else {
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    run("git", ["clone", "--depth=1", "--branch", ref, REMOTE, cacheDir]);
  }
  const head = run("git", ["rev-parse", "HEAD"], {
    cwd: cacheDir,
    capture: true,
  });
  console.log(
    `[dflash-build] checkout ${head}${
      isSubmoduleCheckout(cacheDir)
        ? " (submodule packages/inference/llama.cpp)"
        : ""
    }`,
  );
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
//   * ggml-metal-ops.cpp / ggml-metal-device.m have smoke-tested dispatch
//     sites for GGML_OP_ATTN_SCORE_QJL, GGML_OP_ATTN_SCORE_TBQ
//     (TBQ3_0/TBQ4_0/TBQ3_TCQ), and GGML_OP_ATTN_SCORE_POLAR. Runtime-ready
//     Metal capability bits are still evidence-gated through
//     packages/inference/verify/metal-runtime-dispatch-evidence.json so a
//     future fork regression cannot be hidden by symbols in default.metallib.
//
//   * The EMBED_LIBRARY=ON branch (used by iOS targets) is also patched:
//     it compiles ggml-metal.metal + the milady standalones as separate
//     .air files, merges them into one default.metallib, and embeds those
//     compiled bytes. That avoids duplicate source declarations while
//     shipping the same five kernel symbols as the desktop sidecar.
//
//   * Vulkan: the 8 standalone .comp files are staged into
//     ggml/src/ggml-vulkan/vulkan-shaders/ (picked up by file(GLOB)),
//     vulkan-shaders-gen.cpp registers them via 8 string_to_spv() calls,
//     ggml-vulkan.cpp declares + creates 8 milady_* pipelines, and the
//     patcher wires GGML_OP_ATTN_SCORE_QJL/TBQ/POLAR graph dispatch for the
//     single-batch contiguous shapes covered by vulkan_dispatch_smoke.cpp.
//     Incomplete Vulkan artifacts remain publish-blocking: probeKernels()
//     requires runtime-dispatch evidence from a numeric built-fork graph
//     smoke on native Vulkan hardware before QJL/Polar/Turbo capability bits
//     can flip true.
function applyForkPatches(cacheDir, backend, target, { dryRun = false } = {}) {
  // Wave A1: mirror the verified standalone QJL CPU SIMD TUs (AVX-VNNI int8
  // score path, ARMv8.4 dotprod, runtime-cpuid dispatcher) over the fork's
  // stale ggml-cpu/qjl/ snapshot and wire them into the ggml-cpu build. Runs
  // on every target — the build source's source edits are discarded per build
  // (reset --hard for a standalone clone; checkout -- . + clean -fdx for the
  // submodule), so the mirror is the only way the new TUs reach the shipped
  // lib, and every target that compiles ggml-cpu (i.e. all of them) benefits.
  // Idempotent.
  patchCpuSimdKernelsImpl(cacheDir, { dryRun });
  // Wave D3 follow-up: mirror the standalone PolarQuant pre-Hadamard-
  // transposed dot TUs (polar_dot_preht_{ref,avx2,neon}.c + the runtime
  // cpu-feature dispatcher) over the fork's ggml-cpu/polarquant/ subdir
  // and wire them into the ggml-cpu build (POLARQUANT_HAVE_* defines so
  // the dispatcher knows which TUs were compiled). The fork already
  // defines block_q4_polar / GGML_TYPE_Q4_POLAR / polar_qjl_signs /
  // POLAR_Q4_CENTROIDS, so the _preht TUs add NEW symbols only — no
  // link-time collision. Idempotent.
  patchCpuPolarKernelsImpl(cacheDir, { dryRun });
  // Wave D3 follow-up: parallelize GGML_OP_ATTN_SCORE_QJL +
  // GGML_OP_FUSED_ATTN_QJL_TBQ over ith/nth (n_tasks bump + a real
  // disjoint-output split + per-task scratch). Both halves together.
  patchCpuThreadParallelismImpl(cacheDir, { dryRun });
  if (backend === "metal") {
    patchMetalKernelsImpl(cacheDir, { dryRun });
  }
  if (backend === "vulkan") {
    patchVulkanKernelsImpl(cacheDir, { dryRun, target });
  }
  // llama-server structured-output + DFlash verifier-stream patch (Eliza-1
  // voice swarm, W4): assert grammar_lazy / json_schema / response_format /
  // prefill_assistant are present in the fork's post-refactor server sources
  // (tools/server/server-task.cpp + server-common.cpp + …; upstream features —
  // hard-fail if the fork drifted to a base that predates them), and add the
  // `{ "verifier": { "rejected": [a, b] } }` SSE extension the runtime parses
  // for rollback-safe TTS. Idempotent via the
  // `// MILADY-DFLASH-VERIFIER-STREAM-V1` sentinel. Applies to every target
  // that ships `llama-server` (i.e. not the iOS / EMBED-only library builds).
  //
  // ELIZA_DFLASH_SKIP_SERVER_STRUCTURED_OUTPUT=1 is a documented,
  // local-diagnostics-only escape hatch (e.g. when bisecting against an old
  // pinned ELIZA_DFLASH_LLAMA_CPP_REF that predates the required upstream
  // features). It does NOT change the default build path and the resulting
  // binary is not publishable (the merged-route fused server still serves
  // text/DFlash + `/v1/audio/speech` from one process — the structured-output
  // surface is the only thing missing).
  if (!target || !target.startsWith("ios-")) {
    if (envFlag("ELIZA_DFLASH_SKIP_SERVER_STRUCTURED_OUTPUT")) {
      console.warn(
        "[dflash-build] ⚠️  ELIZA_DFLASH_SKIP_SERVER_STRUCTURED_OUTPUT=1 — " +
          "skipping the llama-server structured-output / verifier-stream patch. " +
          "This is a local-diagnostics-only hatch (e.g. an old pinned ref that " +
          "predates the required upstream features); the resulting binary is " +
          "not publishable.",
      );
    } else {
      patchServerStructuredOutputImpl(cacheDir, { dryRun });
    }
  }
  // Fused omnivoice TTS: mount `POST /v1/audio/speech` onto the same
  // `llama-server` that serves `/completion` + `/v1/chat/completions` + the
  // DFlash speculative loop (packages/inference/AGENTS.md §4 — one process,
  // not two over IPC; remaining-work-ledger P0 #3 merged-route item). The
  // route handler is guarded by `#ifdef MILADY_FUSE_OMNIVOICE` so non-fused
  // builds are byte-for-byte unchanged; the cmake-graft separately links
  // `omnivoice-core` into `llama-server` and sets that define for fused
  // targets. Idempotent via the route patch's own sentinel.
  if (isFusedTarget(target) && (!target || !target.startsWith("ios-"))) {
    patchServerOmnivoiceRouteImpl(cacheDir, { dryRun });
  }
  // ggml.c (in ggml-base) calls quantize_qjl1_256 /
  // dequantize_row_qjl1_256 / quantize_row_qjl1_256_ref, which live in
  // ggml-cpu/qjl/. Any build where ggml-base is its own shared object
  // linked with "undefined symbol = error" — Windows DLLs (PE/COFF
  // disallows unresolved DSO symbols at link time), darwin .dylib
  // (BUILD_SHARED_LIBS_DEFAULT=ON, `-undefined error`), Android .so
  // (lld defaults to erroring on undefined), and iOS static archives —
  // fails to link before a single kernel can run. Folding the QJL TUs
  // into ggml-base resolves the symbols at link time without breaking
  // the ggml-cpu build (the duplicate object files link cleanly because
  // they are part of the same shared object / archive at runtime).
  // Idempotent via the `# MILADY-WINDOWS-QJL-IN-GGML-BASE` sentinel
  // inside patchGgmlBaseForWindowsQjl(). Skipped only for the desktop
  // Linux x64/aarch64 targets, which keep llama.cpp's default static
  // ggml-base where the cross-library reference resolves at the final
  // executable link.
  if (
    target &&
    (target.startsWith("windows-") ||
      target.startsWith("darwin-") ||
      target.startsWith("ios-") ||
      target.startsWith("android-"))
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

function useLegacyDflashDrafterRuntime(target) {
  const { platform, arch, backend, fused } = parseTarget(target);
  const explicit = process.env.ELIZA_DFLASH_LEGACY_DRAFTER_RUNTIME;
  const enabled =
    explicit === undefined
      ? true
      : envFlag("ELIZA_DFLASH_LEGACY_DRAFTER_RUNTIME");
  return (
    enabled &&
    platform === "darwin" &&
    arch === "arm64" &&
    backend === "metal" &&
    !fused
  );
}

function legacyDflashDrafterSourceDir() {
  const explicit = process.env.ELIZA_DFLASH_LEGACY_DRAFTER_SOURCE_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(
    os.homedir(),
    ".cache",
    "eliza-dflash",
    "buun-llama-cpp-drafter-runtime",
  );
}

function legacyDflashDrafterBuildDir(sourceDir) {
  const explicit = process.env.ELIZA_DFLASH_LEGACY_DRAFTER_BUILD_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(sourceDir, "build", "metal");
}

function legacyDflashDrafterBinDir() {
  const explicit = process.env.ELIZA_DFLASH_LEGACY_DRAFTER_BIN_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(
    os.homedir(),
    ".cache",
    "eliza-dflash",
    "buun-llama-cpp",
    "build",
    "metal",
    "bin",
  );
}

function hasLegacyDflashDrafterBinaries(binDir) {
  return [
    "llama-server",
    "llama-cli",
    "llama-speculative-simple",
  ].every((name) => fs.existsSync(path.join(binDir, name)));
}

function sourceContainsDflashDraft(root) {
  const archPath = path.join(root, "src", "llama-arch.cpp");
  const specPath = path.join(root, "common", "speculative.cpp");
  return (
    fs.existsSync(path.join(root, "src", "models", "dflash_draft.cpp")) &&
    fs.existsSync(archPath) &&
    fs.existsSync(specPath) &&
    fs.readFileSync(archPath, "utf8").includes('"dflash-draft"') &&
    fs
      .readFileSync(specPath, "utf8")
      .includes("common_speculative_state_dflash")
  );
}

function ensureLegacyDflashDrafterCheckout(sourceDir) {
  if (fs.existsSync(path.join(sourceDir, ".git"))) {
    run("git", ["fetch", "--depth", "1", "origin", LEGACY_DFLASH_DRAFTER_REF], {
      cwd: sourceDir,
    });
    run("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: sourceDir });
  } else {
    fs.mkdirSync(path.dirname(sourceDir), { recursive: true });
    run("git", [
      "clone",
      "--filter=blob:none",
      LEGACY_DFLASH_DRAFTER_REMOTE,
      sourceDir,
    ]);
    run("git", ["fetch", "--depth", "1", "origin", LEGACY_DFLASH_DRAFTER_REF], {
      cwd: sourceDir,
    });
    run("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: sourceDir });
  }

  if (!sourceContainsDflashDraft(sourceDir)) {
    throw new Error(
      `[dflash-build] ${LEGACY_DFLASH_DRAFTER_REMOTE}@${LEGACY_DFLASH_DRAFTER_REF} ` +
        `did not expose the dflash-draft architecture needed by the local drafter GGUF`,
    );
  }
  return sourceDir;
}

function resolveLegacyDflashDrafterBuiltBinDir(buildDir) {
  const candidates = [
    path.join(buildDir, "bin", "Release"),
    path.join(buildDir, "bin", "Debug"),
    path.join(buildDir, "bin"),
  ];
  return candidates.find(hasLegacyDflashDrafterBinaries) ?? null;
}

function buildLegacyDflashDrafterRuntime({ args }) {
  const sourceDir = ensureLegacyDflashDrafterCheckout(
    legacyDflashDrafterSourceDir(),
  );
  const buildDir = legacyDflashDrafterBuildDir(sourceDir);
  fs.mkdirSync(buildDir, { recursive: true });
  run(
    "cmake",
    [
      "-S",
      sourceDir,
      "-B",
      buildDir,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DLLAMA_BUILD_TESTS=OFF",
      "-DLLAMA_BUILD_EXAMPLES=ON",
      "-DLLAMA_BUILD_SERVER=ON",
      "-DGGML_METAL=ON",
      "-DGGML_METAL_EMBED_LIBRARY=ON",
    ],
    { cwd: sourceDir },
  );
  run(
    "cmake",
    [
      "--build",
      buildDir,
      "--target",
      "llama-server",
      "llama-cli",
      "llama-speculative-simple",
      "-j",
      String(args.jobs),
    ],
    { cwd: sourceDir },
  );
  const binDir = resolveLegacyDflashDrafterBuiltBinDir(buildDir);
  if (!binDir) {
    throw new Error(
      `[dflash-build] legacy DFlash drafter runtime build did not produce ` +
        `llama-server, llama-cli, and llama-speculative-simple under ${buildDir}`,
    );
  }
  return {
    sourceDir,
    buildDir,
    binDir,
    commit: run("git", ["rev-parse", "HEAD"], {
      cwd: sourceDir,
      capture: true,
    }),
  };
}

function ensureLegacyDflashDrafterRuntime({ args }) {
  const binDir = legacyDflashDrafterBinDir();
  if (hasLegacyDflashDrafterBinaries(binDir)) {
    const sourceDir = fs.existsSync(
      path.join(path.resolve(binDir, "..", "..", ".."), ".git"),
    )
      ? path.resolve(binDir, "..", "..", "..")
      : null;
    return {
      binDir,
      sourceDir,
      buildDir: path.resolve(binDir, ".."),
      commit: sourceDir
        ? run("git", ["rev-parse", "HEAD"], {
            cwd: sourceDir,
            capture: true,
          })
        : "",
      reusedPrebuilt: true,
    };
  }
  return { ...buildLegacyDflashDrafterRuntime({ args }), reusedPrebuilt: false };
}

function writeLegacyDflashDrafterCapabilities({
  outDir,
  target,
  runtime,
  installedBaseNames,
}) {
  const { platform, arch, backend } = parseTarget(target);
  const kernels = {
    dflash: true,
    turbo3: false,
    turbo4: false,
    turbo3_tcq: false,
    qjl_full: false,
    polarquant: false,
    lookahead: true,
    ngramDraft: true,
  };
  const capabilities = {
    target,
    platform,
    arch,
    backend,
    fused: false,
    builtAt: new Date().toISOString(),
    fork: "spiritbuun/buun-llama-cpp",
    forkRemote: LEGACY_DFLASH_DRAFTER_REMOTE,
    forkRef: LEGACY_DFLASH_DRAFTER_REF,
    forkCommit: runtime.commit || null,
    kernels,
    publishable: false,
    missingRequiredKernels: requiredKernelsMissing(target, kernels),
    smokeOnlyIncompleteAllowed: true,
    shippedKernels: null,
    runtimeDispatch: {
      sourceOfTruth:
        "temporary Darwin Metal drafter runtime for loading general.architecture=dflash-draft",
      status: "dflash-draft-loader-only",
      requiredSmoke:
        "GGML_METAL_NO_RESIDENCY=1 node packages/inference/verify/dflash_drafter_runtime_smoke.mjs --allow-devices --ngl 99 --ngld 99 --spec-type dflash --temp 0 --tree-budget 0",
      blocker:
        "Milady v0.4.0 DFlash CLI surface does not register the dflash-draft model architecture.",
      notes:
        "The local repaired drafter also requires tokenizer.ggml.merges copied from the target GGUF.",
    },
    binaries: installedBaseNames,
    dflashDrafterRuntime: {
      sourceBinDir: runtime.binDir,
      sourceDir: runtime.sourceDir,
      buildDir: runtime.buildDir,
      reusedPrebuilt: Boolean(runtime.reusedPrebuilt),
      installedAt: new Date().toISOString(),
      nonPublishableReason:
        "runtime-repair path for local DFlash drafter verification only; not a full Eliza-1 kernel bundle",
    },
  };
  fs.writeFileSync(
    path.join(outDir, "CAPABILITIES.json"),
    `${JSON.stringify(capabilities, null, 2)}\n`,
  );
  return capabilities;
}

function installLegacyDflashDrafterRuntime({ target, outDir, args }) {
  const runtime = ensureLegacyDflashDrafterRuntime({ args });
  const executableBaseNames = [
    "llama-server",
    "llama-cli",
    "llama-speculative-simple",
  ];
  const installedNames = [];
  const installedBaseNames = [];

  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(runtime.binDir)) {
    const base = name.replace(/\.(exe)$/i, "");
    if (
      executableBaseNames.includes(base) ||
      isRuntimeLibrary(name) ||
      name === "default.metallib"
    ) {
      const dst = path.join(outDir, name);
      fs.rmSync(dst, { force: true });
      fs.cpSync(path.join(runtime.binDir, name), dst, {
        force: true,
        verbatimSymlinks: true,
      });
      installedNames.push(name);
      if (executableBaseNames.includes(base)) {
        fs.chmodSync(dst, 0o755);
        installedBaseNames.push(base);
      }
    }
  }

  const missing = executableBaseNames.filter(
    (name) => !fs.existsSync(path.join(outDir, name)),
  );
  if (missing.length > 0) {
    throw new Error(
      `[dflash-build] legacy DFlash drafter runtime install missing: ${missing.join(", ")}`,
    );
  }

  makeDarwinInstallSelfContained(outDir, installedNames, runtime.binDir);
  const capabilities = writeLegacyDflashDrafterCapabilities({
    outDir,
    target,
    runtime,
    installedBaseNames,
  });
  console.log(
    `[dflash-build] installed non-publishable DFlash drafter runtime -> ${outDir}`,
  );
  return capabilities;
}

// Probe a freshly-built llama-server for kernel availability.
//
// For host targets, run `llama-server --help` and grep for kernel-specific
// flags / cache-type names. For cross-compiled targets (e.g. Android) the
// binary cannot run on the host; introspect the build directory for compiled
// object files instead (e.g. ggml-cuda/turbo3.cu.o,
// ggml-metal/turbo3.metal.air, etc.).
function probeKernels(target, buildDir, outDir, cacheDir = null) {
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
      // The fork's CLI advertises tbq3_0/tbq4_0 as cache-type names (the
      // user-facing identifier for GGML_TYPE_TBQ3_0/_TBQ4_0). Also accept
      // the legacy `turbo3`/`turbo4` strings the original probe expected,
      // in case a future fork rev renames them back.
      kernels.turbo3 = /turbo3|tbq3_0/.test(lc);
      kernels.turbo4 = /turbo4|tbq4_0/.test(lc);
      kernels.turbo3_tcq = /turbo3[_-]?tcq|tcq|tbq3_tcq/.test(lc);
      kernels.qjl_full = /qjl[_-]?full|qjl|qjl1_256/.test(lc);
      kernels.polarquant = /polar(?:quant)?|q4[_-]?polar/.test(lc);
      // For Metal targets, also inspect default.metallib for kernel symbols.
      // This proves "the kernel is shipped", not that the kernel is reachable
      // from llama.cpp graph execution. The published `kernels` capability
      // map below intentionally stays dispatch-ready only; symbol-only
      // kernels are recorded in logs/README, not allowed to satisfy the
      // Eliza-1 runtime contract.
      if (backend === "metal") {
        const metallibPath = path.join(outDir, "default.metallib");
        if (fs.existsSync(metallibPath)) {
          const metallibBytes = fs.readFileSync(metallibPath);
          // .metallib is a Mach-O archive with embedded function names; a
          // straight buffer .indexOf works because the function names are
          // stored as zero-terminated C strings.
          const has = (sym) => metallibBytes.indexOf(sym) !== -1;
          if (has("kernel_turbo3_dot")) kernels.turbo3 = true;
          if (has("kernel_turbo4_dot")) kernels.turbo4 = true;
          if (has("kernel_turbo3_tcq_dot")) kernels.turbo3_tcq = true;
          if (
            has("kernel_attn_score_qjl1_256") ||
            has("kernel_get_rows_qjl1_256") ||
            has("kernel_mul_mv_qjl1_256_f32")
          ) {
            kernels.qjl_full = true;
          }
          if (
            has("kernel_get_rows_q4_polar") ||
            has("kernel_mul_mv_q4_polar_f32")
          ) {
            kernels.polarquant = true;
          }
        }
      }
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

  // Honesty gate: Metal/Vulkan standalone shaders can compile and be present
  // as symbols/pipelines while still being unreachable or semantically wrong
  // through generic llama.cpp ops. Do not let symbol presence satisfy
  // AGENTS.md §3. Metal runtime capabilities require both a shipped symbol and
  // packages/inference/verify/metal-runtime-dispatch-evidence.json evidence
  // from a numeric built-fork graph smoke. Any capability whose evidence is
  // absent or blocked remains false.
  if (backend === "metal") {
    const shipped = probeMetalShippedKernelSymbols(buildDir, outDir).symbols;
    const evidence = readMetalRuntimeDispatchEvidence();
    kernels.turbo3 = metalCapabilityRuntimeReady("turbo3", shipped, evidence);
    kernels.turbo4 = metalCapabilityRuntimeReady("turbo4", shipped, evidence);
    kernels.turbo3_tcq = metalCapabilityRuntimeReady(
      "turbo3_tcq",
      shipped,
      evidence,
    );
    kernels.qjl_full = metalCapabilityRuntimeReady(
      "qjl_full",
      shipped,
      evidence,
    );
    kernels.polarquant = metalCapabilityRuntimeReady(
      "polarquant",
      shipped,
      evidence,
    );
  } else if (backend === "vulkan") {
    const shipped = probeVulkanShippedKernelSymbols(
      buildDir,
      outDir,
      cacheDir,
    ).symbols;
    const evidence = readVulkanRuntimeDispatchEvidence();
    kernels.turbo3 = vulkanCapabilityRuntimeReady(
      "turbo3",
      shipped,
      evidence,
    );
    kernels.turbo4 = vulkanCapabilityRuntimeReady(
      "turbo4",
      shipped,
      evidence,
    );
    kernels.turbo3_tcq = vulkanCapabilityRuntimeReady(
      "turbo3_tcq",
      shipped,
      evidence,
    );
    kernels.qjl_full = vulkanCapabilityRuntimeReady(
      "qjl_full",
      shipped,
      evidence,
    );
    kernels.polarquant = vulkanCapabilityRuntimeReady(
      "polarquant",
      shipped,
      evidence,
    );
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

function buildIosRuntimeSymbolShim({ target, outDir }) {
  const { isSimulator } = parseTarget(target);
  const sdk = isSimulator ? "iphonesimulator" : "iphoneos";
  const source = path.join(
    __dirname,
    "ios-xcframework",
    "runtime-symbol-shim.c",
  );
  if (!fs.existsSync(source)) {
    throw new Error(`[dflash-build] iOS runtime symbol shim missing: ${source}`);
  }

  const sdkPath = run("xcrun", ["--sdk", sdk, "--show-sdk-path"], {
    capture: true,
  });
  const obj = path.join(outDir, "eliza-ios-runtime-shim.o");
  const archive = path.join(outDir, "libeliza-ios-runtime-shim.a");
  const minVersionFlag = isSimulator
    ? "-mios-simulator-version-min=14.0"
    : "-miphoneos-version-min=14.0";

  run("xcrun", [
    "--sdk",
    sdk,
    "clang",
    "-std=c11",
    "-arch",
    "arm64",
    "-isysroot",
    sdkPath,
    minVersionFlag,
    "-fvisibility=default",
    "-c",
    source,
    "-o",
    obj,
  ]);
  run("xcrun", ["--sdk", sdk, "ar", "rcs", archive, obj]);
  run("xcrun", ["--sdk", sdk, "ranlib", archive]);
  fs.rmSync(obj, { force: true });
  return archive;
}

// Per AGENTS.md §3, every Eliza-1 bundle MUST run dflash + turbo3 + turbo4 +
// turbo3_tcq + qjl + polar. probeKernels() returns the per-target detection
// map; this gate translates that into a hard failure when a required kernel is
// absent.
//
// Returns the list of missing-but-required kernels. An empty list means the
// target satisfies the contract.
function requiredKernelsMissing(target, kernels) {
  // Required for every shipped backend.
  const required = [
    "dflash",
    "turbo3",
    "turbo4",
    "turbo3_tcq",
    "qjl_full",
    "polarquant",
  ];
  return required.filter((k) => !kernels[k]);
}

function probeMetalShippedKernelSymbols(buildDir, outDir) {
  const shipped = {
    turbo3: false,
    turbo4: false,
    turbo3_tcq: false,
    qjl_full: false,
    polarquant: false,
  };
  const metallibs = [
    ...collectFilesUnder(buildDir, /\.metallib$/),
    ...collectFilesUnder(outDir, /\.metallib$/),
  ];
  for (const metallibPath of metallibs) {
    const bytes = fs.readFileSync(metallibPath);
    const has = (sym) => bytes.indexOf(sym) !== -1;
    if (has("kernel_turbo3_dot")) shipped.turbo3 = true;
    if (has("kernel_turbo4_dot")) shipped.turbo4 = true;
    if (has("kernel_turbo3_tcq_dot")) shipped.turbo3_tcq = true;
    if (
      has("kernel_attn_score_qjl1_256") ||
      has("kernel_get_rows_qjl1_256") ||
      has("kernel_mul_mv_qjl1_256_f32")
    ) {
      shipped.qjl_full = true;
    }
    if (has("kernel_get_rows_q4_polar") || has("kernel_mul_mv_q4_polar_f32")) {
      shipped.polarquant = true;
    }
  }
  return { metallibs, symbols: shipped };
}

function readMetalRuntimeDispatchEvidence() {
  try {
    const data = JSON.parse(
      fs.readFileSync(METAL_RUNTIME_DISPATCH_EVIDENCE, "utf8"),
    );
    return { path: METAL_RUNTIME_DISPATCH_EVIDENCE, data };
  } catch (err) {
    return {
      path: METAL_RUNTIME_DISPATCH_EVIDENCE,
      data: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function metalEvidenceForCapability(capabilityKey, evidence) {
  const kernels = evidence?.data?.kernels;
  if (!kernels || typeof kernels !== "object") return null;
  return (
    Object.values(kernels).find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        entry.runtimeCapabilityKey === capabilityKey,
    ) ?? null
  );
}

function metalEvidenceRuntimeReady(capabilityKey, evidence) {
  const entry = metalEvidenceForCapability(capabilityKey, evidence);
  return Boolean(
    entry?.runtimeReady === true && entry?.status === "runtime-ready",
  );
}

function metalCapabilityRuntimeReady(capabilityKey, shipped, evidence) {
  return Boolean(
    shipped?.[capabilityKey] &&
      metalEvidenceRuntimeReady(capabilityKey, evidence),
  );
}

function metalRuntimeDispatchKernelStatus(capabilityKey, shipped, evidence) {
  const entry = metalEvidenceForCapability(capabilityKey, evidence);
  const symbolShipped = Boolean(shipped?.[capabilityKey]);
  const runtimeReady = metalCapabilityRuntimeReady(
    capabilityKey,
    shipped,
    evidence,
  );
  const status = runtimeReady
    ? "runtime-ready"
    : symbolShipped
      ? (entry?.status ?? "symbol-shipped")
      : "missing-symbol";
  const detail = {
    status,
    runtimeReady,
  };
  if (entry?.graphOp) detail.graphOp = entry.graphOp;
  if (entry?.smokeTarget) detail.smokeTarget = entry.smokeTarget;
  if (entry?.smokeCommand) detail.smokeCommand = entry.smokeCommand;
  if (typeof entry?.maxDiff === "number") detail.maxDiff = entry.maxDiff;
  if (entry?.evidenceDate) detail.evidenceDate = entry.evidenceDate;
  if (entry?.blocker) detail.blocker = entry.blocker;
  if (entry?.requiredSmoke) detail.requiredSmoke = entry.requiredSmoke;
  if (entry?.notes) detail.notes = entry.notes;
  return detail;
}

function metalRuntimeDispatchStatus(shippedKernels) {
  const shipped = shippedKernels?.symbols ?? {};
  const evidence = readMetalRuntimeDispatchEvidence();
  return {
    sourceOfTruth:
      "dispatch-ready requires a built-fork GGML graph smoke, not just symbols in default.metallib",
    evidencePath: evidence.path,
    evidenceLoaded: Boolean(evidence.data),
    evidenceError: evidence.error ?? null,
    kernels: {
      turbo3: metalRuntimeDispatchKernelStatus("turbo3", shipped, evidence),
      turbo4: metalRuntimeDispatchKernelStatus("turbo4", shipped, evidence),
      turbo3_tcq: metalRuntimeDispatchKernelStatus(
        "turbo3_tcq",
        shipped,
        evidence,
      ),
      qjl_full: metalRuntimeDispatchKernelStatus("qjl_full", shipped, evidence),
      polarquant: metalRuntimeDispatchKernelStatus(
        "polarquant",
        shipped,
        evidence,
      ),
    },
  };
}

function readVulkanRuntimeDispatchEvidence() {
  try {
    const data = JSON.parse(
      fs.readFileSync(VULKAN_RUNTIME_DISPATCH_EVIDENCE, "utf8"),
    );
    return { path: VULKAN_RUNTIME_DISPATCH_EVIDENCE, data };
  } catch (err) {
    return {
      path: VULKAN_RUNTIME_DISPATCH_EVIDENCE,
      data: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function vulkanEvidenceForCapability(capabilityKey, evidence) {
  const kernels = evidence?.data?.kernels;
  if (!kernels || typeof kernels !== "object") return null;
  return (
    Object.values(kernels).find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        entry.runtimeCapabilityKey === capabilityKey,
    ) ?? null
  );
}

function vulkanEvidenceRuntimeReady(capabilityKey, evidence) {
  const entry = vulkanEvidenceForCapability(capabilityKey, evidence);
  return Boolean(
    entry?.runtimeReady === true && entry?.status === "runtime-ready",
  );
}

function vulkanCapabilityRuntimeReady(capabilityKey, shipped, evidence) {
  return Boolean(
    shipped?.[capabilityKey] &&
      vulkanEvidenceRuntimeReady(capabilityKey, evidence),
  );
}

function vulkanRuntimeDispatchKernelStatus(
  capabilityKey,
  shipped,
  sourceFiles,
  evidence,
  requiredSmoke,
) {
  const entry = vulkanEvidenceForCapability(capabilityKey, evidence);
  const symbolShipped = Boolean(shipped?.[capabilityKey]);
  const runtimeReady = vulkanCapabilityRuntimeReady(
    capabilityKey,
    shipped,
    evidence,
  );
  const status = runtimeReady
    ? "runtime-ready"
    : symbolShipped
      ? (entry?.status ?? "source-patched-pending-smoke")
      : "missing-symbol";
  const detail = {
    status,
    runtimeReady,
    sourceStaged: Boolean(sourceFiles?.[capabilityKey]),
    requiredSmoke,
  };
  if (entry?.graphOp) detail.graphOp = entry.graphOp;
  if (entry?.smokeTarget) detail.smokeTarget = entry.smokeTarget;
  if (entry?.smokeCommand) detail.smokeCommand = entry.smokeCommand;
  if (typeof entry?.maxDiff === "number") detail.maxDiff = entry.maxDiff;
  if (entry?.evidenceDate) detail.evidenceDate = entry.evidenceDate;
  if (entry?.blocker) detail.blocker = entry.blocker;
  if (entry?.notes) detail.notes = entry.notes;
  if (Array.isArray(entry?.graphRoutes)) detail.graphRoutes = entry.graphRoutes;
  return detail;
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function probeVulkanShippedKernelSymbols(buildDir, outDir, cacheDir) {
  const shaderNames = {
    turbo3: "turbo3",
    turbo4: "turbo4",
    turbo3_tcq: "turbo3_tcq",
    qjl_full: "qjl",
    polarquant: "polar",
  };
  const sourceDir = cacheDir
    ? path.join(cacheDir, "ggml", "src", "ggml-vulkan", "vulkan-shaders")
    : null;
  const sourceFiles = {};
  const symbols = {};
  for (const [capability, shader] of Object.entries(shaderNames)) {
    const sourcePath = sourceDir
      ? path.join(sourceDir, `${shader}.comp`)
      : null;
    sourceFiles[capability] =
      Boolean(sourcePath && fs.existsSync(sourcePath)) &&
      readIfExists(sourcePath).includes("MILADY-VK-DISPATCH-PATCH-V1");
    symbols[capability] = false;
  }

  const patchTargets = cacheDir
    ? [
        path.join(
          cacheDir,
          "ggml",
          "src",
          "ggml-vulkan",
          "vulkan-shaders",
          "vulkan-shaders-gen.cpp",
        ),
        path.join(cacheDir, "ggml", "src", "ggml-vulkan", "ggml-vulkan.cpp"),
      ]
    : [];
  const patchSentinels = patchTargets.map((targetPath) => ({
    target: targetPath,
    present:
      fs.existsSync(targetPath) &&
      readIfExists(targetPath).includes("MILADY-VK-DISPATCH-PATCH-V1"),
  }));

  const artifactFiles = [
    ...collectFilesUnder(buildDir, /\.(hpp|h|cpp|o|obj|spv|a|so|dylib|dll)$/),
    ...collectFilesUnder(outDir, /\.(hpp|h|cpp|o|obj|spv|a|so|dylib|dll)$/),
  ];
  // Build the haystack from the small text-ish artifacts (generated C
  // arrays land in .cpp/.h, SPIR-V blobs are .spv) plus any object/library
  // that is small enough to slurp. Joining every .a/.so/.dylib/.dll into
  // one string blows past Node's max string length on a full Vulkan build
  // (libggml-vulkan.so + the static libs are hundreds of MB combined), so
  // skip anything over a per-file cap — the `milady_<shader>` C array and
  // `pipeline_milady_<shader>` source references are always present in the
  // generated .cpp/.h regardless, and .spv presence is covered by the
  // basename check below.
  const ARTIFACT_SLURP_CAP_BYTES = 16 * 1024 * 1024;
  const artifactText = artifactFiles
    .map((file) => {
      try {
        if (fs.statSync(file).size > ARTIFACT_SLURP_CAP_BYTES) return "";
        return fs.readFileSync(file).toString("latin1");
      } catch {
        return "";
      }
    })
    .join("\n");

  for (const [capability, shader] of Object.entries(shaderNames)) {
    const generatedSymbol = `milady_${shader}`;
    symbols[capability] =
      sourceFiles[capability] ||
      artifactText.includes(`${generatedSymbol}_data`) ||
      artifactText.includes(`${generatedSymbol}_len`) ||
      artifactText.includes(`pipeline_milady_${shader}`) ||
      artifactFiles.some((file) => path.basename(file).includes(shader));
  }

  return {
    sourceDir,
    sourceFiles,
    patchSentinels,
    artifactFiles: artifactFiles.map((file) => path.relative(buildDir, file)),
    symbols,
  };
}

function vulkanRuntimeDispatchStatus(shippedKernels) {
  const shipped = shippedKernels?.symbols ?? {};
  const sourceFiles = shippedKernels?.sourceFiles ?? {};
  const evidence = readVulkanRuntimeDispatchEvidence();
  const mk = (key, shader) =>
    vulkanRuntimeDispatchKernelStatus(
      key,
      shipped,
      sourceFiles,
      evidence,
      `vulkan-dispatch-smoke must route ${shader} through ggml-vulkan graph execution and match the fixture/reference`,
    );
  return {
    sourceOfTruth:
      "dispatch-ready requires a built-fork GGML Vulkan graph smoke, not SPIR-V files or pipeline slots",
    evidencePath: evidence.path,
    evidenceLoaded: Boolean(evidence.data),
    evidenceError: evidence.error ?? null,
    smokeTargets: {
      nativeLinux: "make -C packages/inference/verify vulkan-native-smoke",
      androidDevice: "make -C packages/inference/verify android-vulkan-smoke",
      builtForkGraph: "make -C packages/inference/verify vulkan-dispatch-smoke",
    },
    kernels: {
      turbo3: mk("turbo3", "milady_turbo3"),
      turbo4: mk("turbo4", "milady_turbo4"),
      turbo3_tcq: mk("turbo3_tcq", "milady_turbo3_tcq"),
      qjl_full: mk("qjl_full", "GGML_OP_ATTN_SCORE_QJL / milady_qjl"),
      polarquant: mk("polarquant", "Q4_POLAR / milady_polar"),
    },
  };
}

function writeCapabilities({
  outDir,
  target,
  buildDir,
  cacheDir,
  forkCommit,
  binaries,
  omnivoice = null,
}) {
  const { platform, arch, backend, fused } = parseTarget(target);
  const kernels = probeKernels(target, buildDir, outDir, cacheDir);
  const missing = requiredKernelsMissing(target, kernels);
  const shippedKernels =
    backend === "metal"
      ? probeMetalShippedKernelSymbols(buildDir, outDir)
      : backend === "vulkan"
        ? probeVulkanShippedKernelSymbols(buildDir, outDir, cacheDir)
        : null;
  const runtimeDispatch =
    backend === "metal"
      ? metalRuntimeDispatchStatus(shippedKernels)
      : backend === "vulkan"
        ? vulkanRuntimeDispatchStatus(shippedKernels)
        : null;
  const allowUnverifiedVulkanBuild =
    backend === "vulkan" &&
    (process.env.ELIZA_DFLASH_ALLOW_UNVERIFIED_VULKAN_BUILD === "1" ||
      process.env.ELIZA_DFLASH_ALLOW_INCOMPLETE_KERNELS_FOR_SMOKE === "1");
  const capabilities = {
    target,
    platform,
    arch,
    backend,
    fused: Boolean(fused),
    builtAt: new Date().toISOString(),
    fork: "elizaOS/llama.cpp",
    forkCommit,
    kernels,
    publishable: missing.length === 0,
    missingRequiredKernels: missing,
    smokeOnlyIncompleteAllowed: missing.length > 0 && allowUnverifiedVulkanBuild,
    shippedKernels,
    runtimeDispatch,
    binaries,
    omnivoice,
  };
  fs.writeFileSync(
    path.join(outDir, "CAPABILITIES.json"),
    `${JSON.stringify(capabilities, null, 2)}\n`,
  );
  if (missing.length > 0) {
    if (allowUnverifiedVulkanBuild) {
      console.warn(
        `[dflash-build] target=${target} built with unverified Vulkan runtime kernels: ${missing.join(", ")}. ` +
          `This is allowed only for the graph-dispatch smoke bootstrap; CAPABILITIES.json is diagnostic, publishable=false, and must not be published until vulkan-runtime-dispatch-evidence.json is generated and the target is rebuilt without the unverified-build env override.`,
      );
      return capabilities;
    }
    throw new Error(
      `[dflash-build] target=${target} missing required kernels: ${missing.join(", ")}. ` +
        `AGENTS.md §3 forbids shipping an Eliza-1 binary without the full ` +
        `dflash + turbo3 + turbo4 + turbo3_tcq + qjl + polar kernel set. CAPABILITIES.json ` +
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

function cmakeBuildTargetsFor(target) {
  const { platform, backend, fused } = parseTarget(target);
  const isIos = platform === "ios";
  const targets = isIos
    ? ["llama", "ggml", "ggml-base", "ggml-cpu", "ggml-metal"]
    : fused
      ? fusedCmakeBuildTargets()
      : ["llama-server", "llama-cli", "llama-speculative-simple"];

  // The non-EMBED Metal CMakeLists creates an `add_custom_target(ggml-metal-lib
  // ALL DEPENDS .../default.metallib)` but `cmake --build --target X Y Z`
  // builds ONLY the listed targets and skips everything in ALL. Without
  // ggml-metal-lib in the explicit target list the metallib never gets
  // assembled and the Wave-5 milady-shipped/*.air merge step never fires.
  if (backend === "metal" && !isIos) {
    targets.push("ggml-metal-lib");
  }

  return targets;
}

// Build a single target. Returns the resulting CAPABILITIES.json object.
function buildTarget({ target, args, ctx }) {
  const { platform, backend, fused } = parseTarget(target);
  const outDir = targetOutDir(target, args.outDirOverride);
  const buildDir = path.join(args.cacheDir, "build", target);
  if (useLegacyDflashDrafterRuntime(target)) {
    if (args.dryRun) {
      console.log(
        `[dflash-build] (dry-run) target=${target} legacy-dflash-drafter-runtime=true`,
      );
      console.log(
        `  install ${legacyDflashDrafterBinDir()} -> ${outDir}`,
      );
      return null;
    }
    return installLegacyDflashDrafterRuntime({ target, outDir, args });
  }
  const flags = cmakeFlagsForTarget(target, ctx);

  // Fused targets graft omnivoice.cpp's `src/` + `tools/` into the
  // llama.cpp tree, append a CMake snippet that declares the fused
  // shared library + server, and add `-DMILADY_FUSE_OMNIVOICE=ON`.
  // The non-fused targets are unchanged.
  let omnivoiceInfo = null;
  if (fused) {
    if (args.dryRun) {
      console.log(`[dflash-build] (dry-run) target=${target} fused=true`);
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
    const dryTargets = cmakeBuildTargetsFor(target);
    const isDryRunMultiConfig = platform === "windows" || platform === "ios";
    console.log(
      `  cmake --build ${buildDir}${isDryRunMultiConfig ? " --config Release" : ""} --target ${dryTargets.join(" ")} -j ${args.jobs}`,
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
  const cmakeBuildTargets = cmakeBuildTargetsFor(target);

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
    const shimArchive = buildIosRuntimeSymbolShim({ target, outDir });
    const shimName = path.basename(shimArchive);
    installedNames.push(shimName);
    installedBaseNames.push(shimName.replace(/^lib|\.a$/g, ""));
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
  // families plus the libelizainference ABI v1 entry points landed in
  // the produced shared library. Per
  // packages/inference/AGENTS.md §3, missing fusion is a hard error
  // with no fallback.
  let omnivoiceVerification = null;
  if (fused) {
    omnivoiceVerification = verifyFusedSymbols({ outDir, target });
    console.log(
      `[dflash-build] omnivoice-fuse symbol-verify: ` +
        `library=${omnivoiceVerification.library} ` +
        `llama=${omnivoiceVerification.llamaSymbolCount} ` +
        `omnivoice=${omnivoiceVerification.omnivoiceSymbolCount} ` +
        `abi=${omnivoiceVerification.abiSymbolCount}`,
    );
  }

  const capabilities = writeCapabilities({
    outDir,
    target,
    buildDir,
    cacheDir: args.cacheDir,
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
    `[dflash-build] installed ${target} binaries to ${outDir} (kernels: ${
      Object.entries(capabilities.kernels)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(", ") || "none"
    })`,
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
  // mingw-w64 toolchain file when at least one windows-x64 target is
  // queued. windows-arm64 targets do NOT trigger mingw probing because
  // the bundled discovery only handles x86_64-w64-mingw32; arm64 needs
  // either a native MSVC arm64 host or a user-supplied
  // MINGW_TOOLCHAIN_FILE pointing at clang/LLVM aarch64-w64-mingw32.
  const willBuildWindows =
    args.all ||
    (args.targets && args.targets.some((t) => t.startsWith("windows-x64-"))) ||
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

  const legacyDrafterRuntimeOnly = targets.every((target) =>
    useLegacyDflashDrafterRuntime(target),
  );

  if (!args.dryRun) {
    if (args.targets && args.targets.length > 0 && !args.all) {
      for (const target of targets) {
        const compat = targetCompatibility(target, ctx);
        if (!compat.ok) {
          throw new Error(
            `target ${target} is not buildable: ${compat.reason}`,
          );
        }
      }
    }
    ctx.forkCommit = legacyDrafterRuntimeOnly
      ? ""
      : ensureCheckout(args.cacheDir, args.ref);
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
      console.log(`[dflash-build] skip target=${target}: ${compat.reason}`);
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
  const detail =
    process.env.ELIZA_DFLASH_DEBUG_STACK === "1" &&
    err instanceof Error &&
    err.stack
      ? err.stack
      : err instanceof Error
        ? err.message
        : String(err);
  console.error(
    `[dflash-build] ${detail}`,
  );
  process.exit(1);
}
