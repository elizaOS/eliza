#!/usr/bin/env node
// eliza/packages/app-core/scripts/aosp/compile-libllama.mjs —
// cross-compile llama.cpp into a musl-linked libllama.so for the
// AOSP-bound privileged-system-app APK shipped by an elizaOS host or
// any white-label fork built on it.
//
// Why musl, not the regular Android NDK toolchain:
//   AOSP system-app builds ship a self-contained bun-on-Android
//   process (see scripts/spike-android-agent/bootstrap.sh +
//   eliza/packages/app-core/scripts/lib/stage-android-agent.mjs).
//   That process loads bun-linux-{x64,aarch64}-musl from inside the
//   APK, runs through ld-musl-{x86_64,aarch64}.so.1 (the Alpine musl
//   loader), and links libstdc++.so.6 / libgcc_s.so.1 from Alpine
//   v3.21. It is not bionic. NDK clang produces bionic-linked ELFs
//   that depend on libc.so / libdl.so symbols the musl loader doesn't
//   expose, so dlopen() of an NDK-compiled libllama.so inside the bun
//   process fails with "undefined symbol" the moment libllama touches
//   a libc primitive.
//
//   Requirement: libllama.so MUST be a musl-linked shared object whose
//   external dependencies are limited to ld-musl, libstdc++.so.6, and
//   libgcc_s.so.1 — all three of which the APK already ships per ABI.
//
// Toolchain choice:
//   We use `zig cc --target={aarch64,x86_64}-linux-musl` for cross-compilation.
//   Zig bundles a complete musl libc, libc++, and cross-toolchain for both
//   architectures, which avoids the (otherwise multi-step) work of building
//   a musl-cross-make toolchain on the build host. Bun itself uses zig for
//   its musl Android targets, so the resulting ABI matches what bun expects
//   when it dlopen()s libllama.so via bun:ffi at runtime.
//
//   Arm64/aarch64-musl is pinned to zig 0.13.x. Earlier versions ship older
//   libc++ headers that miss <bit> / <span> shims llama.cpp's CMake feature
//   checks rely on, and newer host toolchains have regressed this lane (zig
//   0.16's lld SIGSEGVs the aarch64-linux-musl link). Keep that target on the
//   tested 0.13 line until the upstream linker crash is cleared.
//
// llama.cpp pin (matches the fork the runtime loads via
// plugins/plugin-aosp-local-inference/src/aosp-local-inference-bootstrap.ts):
//   fork:   https://github.com/elizaOS/llama.cpp
//   tag:    v1.0.0-eliza           (the kernel-complete v0.4.0-eliza tree,
//                                   re-tagged on the elizaOS org rename)
//   commit: 08032d57e15574f2a7ca19fc3f29510c8673d590
//
//   This tree adds the W4-B CUDA QJL + PolarQuant Q4 + TBQ3_TCQ kernels
//   on top of the earlier eliza-lineage tags. The CUDA paths only matter
//   for the linux-x64-cuda host target (the AOSP arm64 path stays
//   CPU-only), but the pin is shared so both AOSP and host build paths
//   land on identical kernel sources. A rebase onto a newer upstream is a
//   deferred effort — see docs/porting/upstream-rebase-plan.md.
//
//   v0.2.0-eliza (subset of this pin) added MTP speculative decoding
//   CLI surface (--spec-type mtp, --spec-draft-n-min/max, n_drafted_total
//   / n_drafted_accepted_total Prometheus counters) on top of v0.1.0-eliza.
//
// Why this fork (not stock ggml-org/llama.cpp b8198):
//   The Eliza fork composes four techniques onto upstream b8198:
//
//     - TBQ3_0 (slot 43) + TBQ4_0 (slot 44) — 3-bit / 4-bit TurboQuant V-cache.
//       Cherry-picked from apothic/llama.cpp-1bit-turboquant @ b2b5273.
//       block_tbq3_0 packs 32 floats into 14 bytes vs 64 bytes for fp16
//       (4–4.6× reduction). KV cache is the dominant memory consumer on
//       long contexts on phones, so this is the difference between
//       "Eliza-1 loads but OOMs after 1k tokens" and "Eliza-1 loads and chats".
//     - QJL1_256 (slot 46) — 1-bit JL-transform K-cache (256 sketch dims,
//       34 bytes/block). From W1-A's QJL series.
//     - Q4_POLAR (slot 47) — 4-bit PolarQuant weight quantization. From
//       W1-B's Polar series. Bumped from upstream slot 45 to 47 because
//       slot 46 is now QJL.
//     - Metal kernel sources (.metal) for TBQ3_0/TBQ4_0/TBQ3_TCQ/QJL/Polar
//       under ggml/src/ggml-metal/eliza-kernels/. Source-only landing —
//       dispatcher wiring is the next agent's job.
//
//   The CPU implementations of all four techniques (NEON for arm64, AVX2
//   for x86_64, scalar fallback) are baked into the fork at
//   ggml/src/ggml-cpu/qjl/* and ggml/src/ggml-cpu/quants-polar.c. Mobile
//   is CPU-only via the bun:ffi musl path, so these are what makes the
//   fork useful on phones at all.
//
//   The fork is based on llama.cpp b8198 (much newer than the prior b4500
//   pin), so it inherits the post-2024 sampler-chain API
//   (`llama_sampler_chain_init`, `llama_sampler_init_greedy`, etc.) and the
//   renamed model/vocab API (`llama_model_load_from_file`,
//   `llama_init_from_model`, `llama_model_get_vocab`, `llama_vocab_eos`,
//   `llama_vocab_is_eog`) the adapter binds against. One drift versus
//   b4500: `llama_context_params.flash_attn` (bool) → `flash_attn_type`
//   (enum). The shim no longer exposes a `set_flash_attn` setter (the
//   adapter never called it anyway).
//
// Output (per ABI):
//   packages/app/android/app/src/main/assets/agent/{abi}/libllama.so
//   packages/app/android/app/src/main/assets/agent/{abi}/libggml.so
//   packages/app/android/app/src/main/assets/agent/{abi}/libggml-cpu.so
//   packages/app/android/app/src/main/assets/agent/{abi}/libggml-base.so
//   packages/app/android/app/src/main/assets/agent/{abi}/llama-server          (MTP spec-decode HTTP server)
//   (with --target *-fused: libelizainference.so — the fused FFI lib)
//
// libllama.so has NEEDED entries on the entire libggml family (see
// `readelf -d`); the dynamic linker resolves them from the per-ABI asset
// dir via the LD_LIBRARY_PATH ElizaAgentService.java sets at process
// launch. ABIs: arm64-v8a (real phones), x86_64 (cuttlefish + emulators),
// and riscv64 (cf_riscv64_phone + future riscv64 hardware).
//
// libllama.so + the libggml*.so family are NOT loaded directly by any TS
// adapter anymore — the runtime loads the fused libelizainference.so. But
// the fused lib `target_link_libraries(elizainference PUBLIC llama)` against
// the SHARED libllama.so, so libllama.so + libggml*.so remain runtime
// DT_NEEDED dependencies of libelizainference.so and MUST keep building +
// staging. The old bun:ffi struct-by-value shims (libeliza-llama-shim.so +
// libeliza-llama-speculative-shim.so), consumed by the now-deleted
// aosp-llama-adapter.ts, have been retired from this builder.
//
// Approximate build cost on a modern Linux x86_64 builder (16 cores, NVMe):
//   - llama.cpp clone:    ~30 s, ~150 MB working tree.
//   - per-ABI configure:  ~10 s.
//   - per-ABI compile:    ~2-3 minutes.
//   - per-ABI strip:      <1 s.
//   - libllama.so size:   ~5-10 MB stripped per ABI (varies with zig
//                         baseline ISA selection).
//
// Idempotent: cached clone + cached build dirs skip rework. Bumping the
// pinned tag in LLAMA_CPP_TAG / LLAMA_CPP_COMMIT busts the cache.
//
// CI portability:
//   The script self-bootstraps everything it needs. On a clean machine with
//   only `zig` and `cmake` on PATH, it:
//     1. Writes per-ABI `zig-cc` / `zig-cxx` driver scripts to
//        ${cacheDir}/zig-driver/{abi}/. CMake invokes its CMAKE_C_COMPILER as
//        a single binary with whatever args it wants; if we passed `zig` with
//        --target=... in CMAKE_C_FLAGS, zig parses `--target=...` as an
//        unknown top-level subcommand and fails its compiler probe. The
//        driver scripts shim `zig cc --target=<triple>` so cmake sees a
//        regular cc-style compiler.
//     2. Patches `ggml/src/ggml.c` so `<execinfo.h>` is only included on glibc
//        Linux. Upstream b3490 includes it under a bare `__linux__` guard;
//        musl libc does not provide that header, and the include explodes the
//        compile. The current pin (b4500+) already gates the include on
//        `__GLIBC__`, so the patch detects this and no-ops. On older pins
//        the patch rewrites the include guard.
//     3. Strips libllama.so / libggml.so out-of-place. zig 0.13's
//        `zig objcopy --strip-all <src> <dst>` truncates dst to 0 before
//        reading src when src == dst; the in-place pattern leaves an empty
//        file. We strip to `<file>.stripped` and rename.
//     4. Co-copies the entire libggml*.so family alongside libllama.so.
//        On b4500 libllama.so has NEEDED entries for libggml.so,
//        libggml-cpu.so, and libggml-base.so; the dynamic linker resolves
//        all three from the same dir at runtime via the LD_LIBRARY_PATH
//        ElizaAgentService.java sets. Without the co-copy, dlopen fails
//        with "libggml-base.so: cannot open shared object file" (or
//        whichever NEEDED sibling is missing).
//     5. Configures cmake with `-DCMAKE_SKIP_BUILD_RPATH=TRUE` so the
//        resulting .so files don't bake an absolute RUNPATH to the
//        build-host cache dir. Without this, every shipped APK leaks
//        `/home/<builder>/.cache/...` as a hardcoded RUNPATH and the
//        runtime dynamic linker tries (and fails) to look there before
//        falling back to LD_LIBRARY_PATH.
//
// Failure mode:
//   If zig is missing, this script exits with code 1 and prints the exact
//   install command. We never silently skip — an APK that ships without
//   libllama.so but with ELIZA_LOCAL_LLAMA=1 would fail at first inference
//   call (Commandment 8: don't hide broken pipelines behind fallbacks).
//
// Repo-root resolution:
//   The script defaults `--assets-dir` to the first app shell found under
//   `<repoRoot>/packages/app`, `<repoRoot>/apps/app`, or
//   `<repoRoot>/eliza/packages/app`, then appends
//   `android/app/src/main/assets/agent`. `--cache-dir` defaults to
//   `~/.cache/eliza-android-agent/llama-cpp-<tag>`.
//   `<repoRoot>` is derived from this script's location: walk up from
//   `eliza/packages/app-core/scripts/aosp/` to the host repo root by
//   default, but when the parent host repo invokes this via the
//   `eliza/` submodule the same algorithm finds the host repo root
//   (it stops at the first ancestor that has a `package.json`).

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { androidArm64SimdCmakeFlags } from "../build-helpers/arm64-simd.mjs";
import {
  fusedCmakeBuildTargets,
  fusedExtraCmakeFlags,
} from "../build-helpers/omnivoice-merged.mjs";
import { verifyFusedSymbols } from "../build-helpers/verify-fused-symbols.mjs";
import { patchVulkanKernels } from "../kernel-patches/vulkan-kernels.mjs";
import { resolveRepoRootFromImportMeta } from "../lib/repo-root.mjs";
import {
  compareSemver,
  resolveAndroidNdkHostDir,
  resolveDefaultAndroidAssetsDir as resolveDefaultAndroidAssetsDirForRoot,
  resolveHomebrewFormulaIncludeDirs,
} from "./compile-libllama-paths.mjs";
import { main as compileShimMain } from "./compile-shim.mjs";

export {
  compareSemver,
  resolveAndroidNdkHostDir,
  resolveHomebrewFormulaIncludeDirs,
};

const here = path.dirname(fileURLToPath(import.meta.url));
// Walk up from `eliza/packages/app-core/scripts/aosp/` until we hit
// the host repo root (the directory with a top-level `package.json`).
// On a parent-host invocation that's `<host-root>`; when running
// inside the elizaOS source checkout it's the elizaOS repo root.
const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const RECURSIVE_CLEANUP_SCRIPT = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

// elizaOS/llama.cpp @ 33c888a7b. Composes TBQ (apothic) +
// QJL (W1-A) + Q4_POLAR (W1-B) + Metal sources (W1-D) + MTP spec-decode
// (W2) + W3-B fused CPU kernels + W4-B CUDA QJL/Polar/TBQ3_TCQ kernels onto
// upstream b9213. See docs/porting/unified-fork-strategy.md for the full
// migration story.
//
// The fork ships in-tree as the git submodule at
// plugins/plugin-local-inference/native/llama.cpp (next to the MTP build at
// scripts/build-llama-cpp-mtp.mjs — same pinned commit so both build paths
// land on identical kernels). When that
// submodule is initialized this path defaults to it (no clone needed); pass
// `--src-dir` to point at another checkout, or `--cache-dir` to force a
// standalone clone of `${LLAMA_CPP_REMOTE}` at `${LLAMA_CPP_TAG}`.
//
// Pre-2026-05-09 the AOSP path consumed apothic/llama.cpp-1bit-turboquant
// directly and applied vendored QJL + PolarQuant patch series via
// scripts/aosp/llama-cpp-patches/apply-patches.mjs at build time. That
// flow is now replaced by a single canonical fork — the patches are
// baked in. apply-patches.mjs is kept around for one release as a
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
export const MIN_ZIG_VERSION = "0.13.0";
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

// Pinned zig series (MAJOR.MINOR) for the aarch64/x86_64 `*-linux-musl`
// cross-link that produces the Android/cuttlefish + fused (libelizainference)
// libs. zig 0.16 bundles an LLVM whose `lld` SIGSEGVs while linking the
// aarch64-linux-musl shared object — a host-toolchain regression that aborts
// the link with no actionable diagnostic (it looks like an OOM / random crash,
// not a config error). zig 0.13.x links these targets cleanly, so we pin the
// series rather than only enforcing a floor: a newer-is-fine `>=` check would
// silently route an operator's `brew install zig` (0.16) straight into the
// SIGSEGV. This is intentionally a series pin, not an exact-patch pin — any
// 0.13.x patch release links fine. The riscv64 RVV path keeps its own
// MIN_ZIG_RVV_VERSION floor (it needs 0.14+ for the RVV ISA string) and is a
// distinct musl triple, so it is exempt from this pin (see
// `assertZigPinForTargets`). An operator who has independently verified their
// zig's lld links aarch64-linux-musl can override with
// ELIZA_ALLOW_UNPINNED_ZIG=1, but the default refuses the broken toolchain.
export const PINNED_ZIG_SERIES_FOR_MUSL_LINK = "0.13";
// zig triples whose lld link is covered by the 0.13.x pin above. riscv64 is
// deliberately absent: its RVV build path requires 0.14+ and is gated by
// MIN_ZIG_RVV_VERSION instead.
export const PINNED_ZIG_LINK_TRIPLES = Object.freeze([
  "aarch64-linux-musl",
  "x86_64-linux-musl",
]);
export const ALLOW_UNPINNED_ZIG_ENV = "ELIZA_ALLOW_UNPINNED_ZIG";

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

export const ABI_TARGETS = [
  {
    androidAbi: "arm64-v8a",
    zigTarget: "aarch64-linux-musl",
    cmakeProcessor: "aarch64",
  },
  {
    androidAbi: "x86_64",
    zigTarget: "x86_64-linux-musl",
    cmakeProcessor: "x86_64",
  },
  {
    androidAbi: "riscv64",
    zigTarget: "riscv64-linux-musl",
    cmakeProcessor: "riscv64",
  },
];

/**
 * Map a list of Android ABI directory names (`arm64-v8a` | `x86_64` |
 * `riscv64`) to the distinct zig cross-link triples (`zigTarget`) they build
 * through. Used to decide which targets the zig-series pin applies to. Throws
 * on an unknown ABI rather than silently dropping it.
 *
 * Exported for tests.
 *
 * @param {readonly string[]} abis
 * @returns {string[]}
 */
export function zigTriplesForAbis(abis) {
  const triples = new Set();
  for (const abi of abis) {
    const target = ABI_TARGETS.find((t) => t.androidAbi === abi);
    if (!target) {
      throw new Error(
        `[compile-libllama] unknown Android ABI ${abi}; expected one of ${ABI_TARGETS.map(
          (t) => t.androidAbi,
        ).join(", ")}.`,
      );
    }
    triples.add(target.zigTarget);
  }
  return [...triples];
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
  return [
    "-DGGML_VULKAN=ON",
    `-DVulkan_INCLUDE_DIR=${incRoot}`,
    `-DVulkan_GLSLC_EXECUTABLE=${glslc}`,
    `-DVulkan_LIBRARY=${libVulkan}`,
    `-DSPIRV-Headers_DIR=${spirvConfigDir}`,
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
      "# Generated by compile-libllama.mjs (#9508): package-config shim over",
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
        "Usage: node eliza/packages/app-core/scripts/aosp/compile-libllama.mjs " +
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
          "  --dry-run         Print the cmake invocation + graft steps + expected\n" +
          "                    output layout WITHOUT running cmake/ndk. Honored for\n" +
          "                    every --target.\n" +
          "  --src-dir <PATH>  Use an existing llama.cpp checkout instead of the\n" +
          "                    in-repo submodule / a fresh clone. The directory's HEAD\n" +
          "                    is used as-is; the pinned LLAMA_CPP_TAG/COMMIT is ignored.\n" +
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
 * Probe the build host for a usable zig toolchain. Returns the absolute path
 * to the zig binary on success, or throws an Error with an install hint
 * tailored to the host OS. We require zig >= MIN_ZIG_VERSION because earlier
 * versions are missing libc++ headers llama.cpp's CMake checks rely on.
 *
 * Exported for unit tests.
 */
export function probeZig({
  spawn = spawnSync,
  platform = process.platform,
} = {}) {
  const probe = spawn("zig", ["version"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (probe.error || probe.status !== 0) {
    const installHint =
      platform === "darwin"
        ? "brew install zig"
        : platform === "linux"
          ? "snap install zig --classic --beta\n  or download a tarball from https://ziglang.org/download/ and put `zig` on PATH"
          : "see https://ziglang.org/download/";
    throw new Error(
      `[compile-libllama] zig is required to cross-compile libllama.so for the AOSP build, but was not found on PATH.\n` +
        `Install zig >= ${MIN_ZIG_VERSION} and re-run:\n  ${installHint}\n` +
        `(zig is what we use to produce musl-linked binaries that match the bun-on-Android runtime ABI; ` +
        `the regular Android NDK clang produces bionic-linked binaries that the musl loader cannot dlopen.)`,
    );
  }
  const version = probe.stdout.trim();
  if (compareSemver(version, MIN_ZIG_VERSION) < 0) {
    throw new Error(
      `[compile-libllama] zig ${version} is too old; need >= ${MIN_ZIG_VERSION}.\n` +
        `Earlier zig releases ship libc++ headers that miss the <bit>/<span> shims llama.cpp ` +
        `feature-checks during configure. Upgrade zig and re-run.`,
    );
  }
  return version;
}

/**
 * Extract the MAJOR.MINOR series from a zig version string. `0.13.0` -> `0.13`,
 * `0.13.0-dev.46+abc` -> `0.13`. Returns `null` for an unparseable input so
 * callers can decide how to treat a missing/garbage version.
 *
 * Exported for tests.
 *
 * @param {string} version
 * @returns {string | null}
 */
export function zigSeries(version) {
  if (typeof version !== "string") return null;
  const parts = version
    .replace(/^v/, "")
    .split(/[-+]/)[0]
    .split(".")
    .map((n) => Number.parseInt(n, 10));
  if (
    parts.length < 2 ||
    !Number.isFinite(parts[0]) ||
    !Number.isFinite(parts[1])
  ) {
    return null;
  }
  return `${parts[0]}.${parts[1]}`;
}

/**
 * Enforce the zig-series pin (PINNED_ZIG_SERIES_FOR_MUSL_LINK) for any requested
 * target whose link goes through one of PINNED_ZIG_LINK_TRIPLES (the
 * aarch64/x86_64 `*-linux-musl` Android / fused libs). zig 0.16's bundled lld
 * SIGSEGVs that link, so a plain `>=` floor is not enough — we must reject a
 * newer-but-broken toolchain too. riscv64-only target sets are exempt (their
 * RVV path needs 0.14+, gated separately by MIN_ZIG_RVV_VERSION).
 *
 * Pure + deterministic: takes the detected version + the resolved triple list +
 * env, throws on a pin violation, returns nothing on success. No side effects.
 *
 * Exported for tests.
 *
 * @param {object} params
 * @param {string} params.version    zig version string from probeZig().
 * @param {readonly string[]} params.zigTriples  the `zigTarget` triples the run
 *   will cross-link (e.g. ["aarch64-linux-musl"]).
 * @param {NodeJS.ProcessEnv} [params.env]
 */
export function assertZigPinForTargets({
  version,
  zigTriples,
  env = process.env,
}) {
  const pinnedTriples = zigTriples.filter((t) =>
    PINNED_ZIG_LINK_TRIPLES.includes(t),
  );
  if (pinnedTriples.length === 0) {
    // No pinned-link triple in this run (e.g. riscv64-only) — nothing to pin.
    return;
  }
  if (env[ALLOW_UNPINNED_ZIG_ENV] === "1") {
    console.warn(
      `[compile-libllama] ${ALLOW_UNPINNED_ZIG_ENV}=1 set; skipping the zig ` +
        `${PINNED_ZIG_SERIES_FOR_MUSL_LINK}.x pin for ${pinnedTriples.join(", ")} ` +
        `(zig ${version}). Only safe if you have verified this zig's lld links ` +
        `aarch64-linux-musl without SIGSEGV.`,
    );
    return;
  }
  const series = zigSeries(version);
  if (series !== PINNED_ZIG_SERIES_FOR_MUSL_LINK) {
    throw new Error(
      `[compile-libllama] zig ${version} (series ${series ?? "unknown"}) is not ` +
        `the pinned zig ${PINNED_ZIG_SERIES_FOR_MUSL_LINK}.x required to link ` +
        `${pinnedTriples.join(", ")}.\n` +
        `zig 0.16's bundled lld SIGSEGVs the aarch64-linux-musl link, aborting ` +
        `the fused/Android build with no actionable diagnostic; zig 0.13.x links ` +
        `it cleanly. Install zig ${PINNED_ZIG_SERIES_FOR_MUSL_LINK}.x and re-run:\n` +
        `  download the 0.13.x tarball from https://ziglang.org/download/ and put ` +
        `\`zig\` on PATH (the package-manager \`zig\` is frequently 0.16).\n` +
        `If you have independently verified your zig's lld links ` +
        `aarch64-linux-musl, override with ${ALLOW_UNPINNED_ZIG_ENV}=1.`,
    );
  }
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
 * Run the vendored patch applier (`llama-cpp-patches/apply-patches.mjs`)
 * against the cached llama.cpp checkout. The applier is idempotent: it
 * checks each patch with `git apply --check -R` first and skips any that
 * are already on the tree, so cache reuse stays correct across pin bumps
 * and across partial-failure re-runs.
 *
 * Patches under `llama-cpp-patches/qjl/` add `GGML_TYPE_QJL1_256` (=46),
 * the QJL kernel sources vendored from `packages/native/plugins/qjl-cpu/`,
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
  const applierPath = path.join(here, "llama-cpp-patches", "apply-patches.mjs");
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
 * Write per-ABI `zig-cc` / `zig-cxx` driver scripts under
 * `${cacheDir}/zig-driver/${abi}/` and return their absolute paths.
 *
 * Why we need a driver instead of `-DCMAKE_C_COMPILER=zig` plus
 * `--target=...` in CMAKE_C_FLAGS:
 *   CMake invokes its CMAKE_C_COMPILER as a single binary, e.g.
 *     `zig --target=aarch64-linux-musl -c -o test.o test.c`
 *   zig parses `--target=aarch64-linux-musl` as an unknown top-level
 *   subcommand and bails before it even sees `-c`. The compiler probe
 *   fails and configure aborts. The fix is to wrap zig in a tiny driver
 *   that always front-prepends the `cc` / `c++` subcommand and the
 *   `--target=` flag, so cmake's invocation pattern just works.
 *
 * Driver scripts are written fresh on every run (they're cheap and
 * stateless), so a stale cache from an older script version doesn't
 * leak into a new one.
 *
 * Exported for unit testing.
 */
export function ensureZigDrivers({
  cacheDir,
  abi,
  zigBin = "zig",
  riscv64MarchPassthrough = false,
}) {
  const target = ABI_TARGETS.find((t) => t.androidAbi === abi);
  if (!target) {
    throw new Error(`[compile-libllama] Unknown ABI: ${abi}`);
  }
  const driverDir = path.join(cacheDir, "zig-driver", abi);
  fs.mkdirSync(driverDir, { recursive: true });
  const ccPath = path.join(driverDir, "zig-cc");
  const cxxPath = path.join(driverDir, "zig-cxx");

  // riscv64 needs an extra arg-filtering step on Zig 0.13. The vendored
  // llama.cpp's ggml-cpu CMakeLists hardcodes `-march=rv64gc -mabi=lp64d`
  // (and adds extension suffixes when GGML_RVV / GGML_RV_ZFH / etc. are ON).
  // Zig 0.13's bundled LLVM doesn't accept `-march=rv64gc` as a GCC-style
  // ISA string — it tries to translate it to `-mcpu=` and bails with
  // "unknown CPU: 'rv64gc'". The triple `riscv64-linux-musl` already
  // selects the rv64gc/lp64d baseline as Zig's triple-derived CPU, so
  // stripping these flags is byte-for-byte equivalent to the intended
  // build when RVV is OFF.
  //
  // On Zig 0.14+ (`riscv64MarchPassthrough=true`) we leave every
  // `-march=` / `-mabi=` flag alone: Zig 0.14's LLVM accepts the
  // GCC-style ISA string with the full `_zfh_zvfh_zicbop_zihintpause`
  // extension suffix, which is exactly what flips the RVV intrinsic
  // codepaths on in ggml/src/ggml-cpu/arch/riscv/quants.c.
  //
  // Filter logic: walk the argv via the POSIX `set --` idiom (no eval —
  // CMake escapes embedded quotes in -DGGML_VERSION=\"0.12.0\", and a
  // naive `eval exec "..."` collapses them and the C preprocessor sees
  // `0.12.0` as a malformed numeric literal). Each non-stripped arg is
  // re-pushed onto $@ in place; the final `exec "$zig" cc ... "$@"`
  // forwards the whole array with every quote and space preserved.
  const riscv64ArgFilter =
    abi === "riscv64" && !riscv64MarchPassthrough
      ? "_n=$#\n" +
        "i=0\n" +
        "while [ $i -lt $_n ]; do\n" +
        "  arg=$1\n" +
        "  shift\n" +
        "  i=$((i+1))\n" +
        '  case "$arg" in\n' +
        "    -march=rv64gc|-march=rv64gc_*) ;;\n" +
        "    -mabi=lp64d|-mabi=lp64) ;;\n" +
        '    *) set -- "$@" "$arg" ;;\n' +
        "  esac\n" +
        "done\n"
      : null;

  // arm64: the ggml-cpu CMakeLists emits the GCC-style ISA string
  // `-march=armv8.2-a+dotprod+fp16` (from GGML_CPU_ARM_ARCH). Zig 0.13's
  // bundled LLVM rejects that for the aarch64 target — it tries to translate
  // `armv8.2-a` to a `-mcpu=` value and dies with "unknown CPU: 'armv8.2'"
  // (the same class of breakage the riscv64 filter handles). Zig instead
  // speaks `-mcpu=<cpu>+<feature>` with its OWN feature names. Rewrite the
  // GCC `-march=armv8.x-a+...` into the equivalent zig `-mcpu=generic+...`:
  // dotprod→dotprod, i8mm→i8mm, fp16→fullfp16. This sets exactly the same
  // __ARM_FEATURE_DOTPROD / __ARM_FEATURE_MATMUL_INT8 /
  // __ARM_FEATURE_FP16_VECTOR_ARITHMETIC macros (verified), so the live QJL
  // NEON-dotprod / i8mm / fp16 kernel bodies survive preprocessing and the
  // ggml ARM-feature configure probes pass. Any other `-march=` is passed
  // through untouched (there shouldn't be one for arm64).
  const arm64ArgFilter =
    abi === "arm64-v8a"
      ? "_n=$#\n" +
        "i=0\n" +
        "while [ $i -lt $_n ]; do\n" +
        "  arg=$1\n" +
        "  shift\n" +
        "  i=$((i+1))\n" +
        '  case "$arg" in\n' +
        "    -march=armv8.*-a+*)\n" +
        '      _feats=""\n' +
        `      case "$arg" in *+dotprod*) _feats="\${_feats}+dotprod" ;; esac\n` +
        `      case "$arg" in *+i8mm*) _feats="\${_feats}+i8mm" ;; esac\n` +
        `      case "$arg" in *+fp16*) _feats="\${_feats}+fullfp16" ;; esac\n` +
        `      set -- "$@" "-mcpu=generic\${_feats}" ;;\n` +
        '    *) set -- "$@" "$arg" ;;\n' +
        "  esac\n" +
        "done\n"
      : null;

  const argFilter = riscv64ArgFilter ?? arm64ArgFilter;
  const exec =
    argFilter !== null
      ? (subcmd) =>
          argFilter +
          `exec "${zigBin}" ${subcmd} --target=${target.zigTarget} "$@"\n`
      : (subcmd) =>
          `exec "${zigBin}" ${subcmd} --target=${target.zigTarget} "$@"\n`;

  // Quote zigBin so a path with spaces still works. The driver runs under
  // /bin/sh which is POSIX-portable across Linux, macOS, Alpine.
  const ccBody =
    "#!/bin/sh\n" +
    "# Auto-generated by eliza/packages/app-core/scripts/aosp/compile-libllama.mjs.\n" +
    "# Do not edit — regenerated on every build.\n" +
    exec("cc");
  const cxxBody =
    "#!/bin/sh\n" +
    "# Auto-generated by eliza/packages/app-core/scripts/aosp/compile-libllama.mjs.\n" +
    "# Do not edit — regenerated on every build.\n" +
    exec("c++");
  fs.writeFileSync(ccPath, ccBody, "utf8");
  fs.writeFileSync(cxxPath, cxxBody, "utf8");
  fs.chmodSync(ccPath, 0o755);
  fs.chmodSync(cxxPath, 0o755);

  // CMake archives the cross-compiled ELF `.o` files with CMAKE_AR/CMAKE_RANLIB.
  // Its default is the host toolchain's `ar`/`ranlib` — on a macOS build host
  // that is cctools `/usr/bin/ar`, which cannot read aarch64-linux ELF objects:
  // it warns "not a mach-o file" and writes an EMPTY 96-byte archive. libllama.a
  // / libggml*.a then contain zero objects, and the fused libelizainference.so
  // links with every `llama_*` symbol left undefined — text inference silently
  // absent (caught only downstream by verify-fused-symbols). zig bundles
  // llvm-ar/llvm-ranlib, which archive ELF objects on any host, so route
  // CMAKE_AR/RANLIB through `zig ar` / `zig ranlib`. Archiving is object-format
  // agnostic, so these shims need neither `--target` nor the `-march` rewrite.
  const arPath = path.join(driverDir, "zig-ar");
  const ranlibPath = path.join(driverDir, "zig-ranlib");
  const arBody =
    "#!/bin/sh\n" +
    "# Auto-generated by eliza/packages/app-core/scripts/aosp/compile-libllama.mjs.\n" +
    "# Do not edit — regenerated on every build.\n" +
    `exec "${zigBin}" ar "$@"\n`;
  const ranlibBody =
    "#!/bin/sh\n" +
    "# Auto-generated by eliza/packages/app-core/scripts/aosp/compile-libllama.mjs.\n" +
    "# Do not edit — regenerated on every build.\n" +
    `exec "${zigBin}" ranlib "$@"\n`;
  fs.writeFileSync(arPath, arBody, "utf8");
  fs.writeFileSync(ranlibPath, ranlibBody, "utf8");
  fs.chmodSync(arPath, 0o755);
  fs.chmodSync(ranlibPath, 0o755);

  return { ccPath, cxxPath, arPath, ranlibPath };
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
}) {
  const target = ABI_TARGETS.find((t) => t.androidAbi === abi);
  if (!target) {
    throw new Error(`[compile-libllama] Unknown ABI: ${abi}`);
  }
  const buildDir = path.join(srcDir, `build-${abi}`);
  fs.mkdirSync(buildDir, { recursive: true });

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
  // baseline, which keeps ggml's dotprod/i8mm/fp16 NEON kernels AND the eliza
  // QJL NEON-dotprod kernel dead. Pin the armv8.2-a+dotprod+fp16 floor (no i8mm — see arm64-simd.mjs) and
  // flip the QJL dispatch define so the Pixel-class Tensor G4 actually runs the
  // accelerated paths. See build-helpers/arm64-simd.mjs for the full rationale.
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

  log(
    `[compile-libllama] Configuring llama.cpp for ${abi} (${target.zigTarget}) in ${buildDir}`,
  );
  spawn(
    "cmake",
    [
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
    ],
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
  // Non-fatal for the library build: llama-server is the optional AOSP
  // MTP/spec-decode HTTP path, but the required in-process libs below
  // (libllama.so/libggml*.so and, for fused targets, libelizainference.so) are
  // verified separately. On the musl cross-link this target can fail to resolve
  // its httplib/OpenSSL deps (undefined `httplib::*` / `SSLClient` symbols).
  // In that case stage-android-agent warns about the missing server and runtime
  // falls back to the non-MTP path instead of losing the whole native build.
  log(`[compile-libllama] Compiling llama-server for ${abi} with -j${jobs}`);
  try {
    spawn(
      "cmake",
      ["--build", buildDir, "--target", "llama-server", "-j", String(jobs)],
      {},
    );
  } catch (err) {
    log(
      `[compile-libllama] WARN: llama-server failed to build for ${abi}; ` +
        `continuing — it bundles nothing into the APK and libllama.so/libelizainference.so are unaffected. ` +
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
 * No-op shim retained for backward compatibility with callers that still
 * import `applyOmnivoiceGraft`. H2.c collapsed the W3-3 deprecation runway:
 * the legacy clone-and-graft path is gone; OmniVoice is built exclusively
 * from the merged in-fork tree at `tools/omnivoice/`.
 *
 * Returns a minimal info object so log lines that surface fields like
 * `commit` or `sourceCount` keep their shape; the merged tree's source
 * count is fixed at build time and recorded by `verifyFusedSymbols`.
 */
export function applyOmnivoiceGraft({ srcDir: _srcDir, log = console.log }) {
  log(
    "[compile-libllama] omnivoice: merged in-fork path (legacy graft removed)",
  );
  return { mode: "merged", source: "tools/omnivoice" };
}

/**
 * Stage prebuilt LiteRT-LM `.litertlm` text artifacts into the on-device
 * bundle assets, parallel to the `.so` libs this script stages and the `.gguf`
 * models `stage-default-models.mjs` stages. The destination is
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
  const cmakeFlags = [
    "-S",
    srcDir,
    "-B",
    buildDir,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DBUILD_SHARED_LIBS=ON",
    "-DLLAMA_BUILD_EXAMPLES=OFF",
    "-DLLAMA_BUILD_TESTS=OFF",
    "-DLLAMA_BUILD_SERVER=ON",
    "-DLLAMA_CURL=OFF",
    `-DCMAKE_C_COMPILER=${ccPath}`,
    `-DCMAKE_CXX_COMPILER=${cxxPath}`,
    `-DCMAKE_AR=${arPath}`,
    `-DCMAKE_RANLIB=${ranlibPath}`,
    "-DCMAKE_C_COMPILER_LAUNCHER=",
    "-DCMAKE_CXX_COMPILER_LAUNCHER=",
    "-DCMAKE_SYSTEM_NAME=Linux",
    `-DCMAKE_SYSTEM_PROCESSOR=${abiTarget.cmakeProcessor}`,
    "-DGGML_NATIVE=OFF",
  ];
  // riscv64 build flags must show up in dry-run output too — the real
  // buildLibllamaForAbi() resolves these from the detected Zig version and
  // operators reading the dry-run plan should see the byte-exact list that
  // will be passed. resolveRiscv64BuildPlan() falls back to scalar when zig
  // is not installed (dry-run is allowed on toolchain-less boxes), so the
  // plan reported here mirrors what a build invocation would actually emit
  // on the same host.
  if (parsed.androidAbi === "riscv64") {
    const plan = resolveRiscv64BuildPlan({ env: process.env, isDryRun: true });
    log(
      `  riscv64 plan: zig=${plan.zigVersion ?? "unknown"} ` +
        `rvv=${plan.rvv ? "ON" : "OFF"} ` +
        `all-variants=${plan.allVariants ? "ON" : "OFF"} ` +
        `reason=${plan.reason}`,
    );
    cmakeFlags.push(
      ...riscv64CmakeFlagsForPlan({ abi: parsed.androidAbi, plan }),
    );
  }
  // arm64-v8a SIMD floor (dotprod/i8mm/fp16 + QJL NEON-dotprod dispatch) — the
  // real buildLibllamaForAbi() emits these too; surface them in the dry-run.
  cmakeFlags.push(...androidArm64SimdCmakeFlags(parsed.androidAbi));
  cmakeFlags.push(
    "-DCMAKE_SKIP_BUILD_RPATH=TRUE",
    "-DCMAKE_SKIP_INSTALL_RPATH=TRUE",
    "-DCMAKE_BUILD_WITH_INSTALL_RPATH=TRUE",
    "-DCMAKE_INSTALL_RPATH=",
  );
  if (parsed.fused) {
    cmakeFlags.push(...fusedExtraCmakeFlags());
  }
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
  // Staged into the APK by stage-android-agent.mjs: the wrapper takes the
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

  // omnivoice.cpp clone lives at <cacheRoot>/omnivoice.cpp; we use the parent
  // of the llama.cpp cache dir so both clones live under one cache root, the
  // same shape the mtp build path uses (cacheRoot=path.dirname(args.cacheDir)).
  const omnivoiceCacheRoot = path.dirname(args.cacheDir);

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
      if (parsed.fused) {
        console.log(
          `  fused-graft cacheRoot=${omnivoiceCacheRoot} (omnivoice.cpp clone)`,
        );
      }
      continue;
    }

    // Pre-cmake: run the omnivoice graft for fused targets. Same call
    // sequence as the mtp linux-x64-cpu-fused path; the graft is
    // toolchain-agnostic (CMake snippet + source layout).
    let omnivoiceInfo = null;
    if (parsed.fused) {
      omnivoiceInfo = applyOmnivoiceGraft({
        srcDir,
        omnivoiceCacheRoot,
        log: console.log,
      });
    }

    // Vulkan target: graft the eliza-1 qjl/polar Vulkan compute shaders +
    // ggml-vulkan dispatch patches into the source, and assemble the
    // GGML_VULKAN CMake flags (NDK glslc + headers + aarch64 loader). The
    // libggml-vulkan.so the build emits is glob-staged alongside the rest of
    // the libggml family by buildLibllamaForAbi.
    let vulkanCmakeFlags = [];
    if (parsed.backend === "vulkan") {
      console.log(
        `[compile-libllama] Patching eliza-1 Vulkan kernels into ${srcDir} for ${parsed.target}`,
      );
      patchVulkanKernels(srcDir, { target: parsed.target });
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
      if (omnivoiceInfo) {
        console.log(
          `[compile-libllama] omnivoice mode=${omnivoiceInfo.mode ?? "merged"} source=${omnivoiceInfo.source ?? "tools/omnivoice"}`,
        );
      }
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
