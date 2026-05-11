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
//   Minimum tested: zig 0.13.0. Earlier versions ship older libc++ headers
//   that miss <bit> / <span> shims llama.cpp's CMake feature checks rely on.
//
// llama.cpp pin (matches plugins/plugin-aosp-local-inference/src/aosp-llama-adapter.ts):
//   fork:   https://github.com/elizaOS/llama.cpp
//   tag:    v0.4.0-milady          (milady/integration HEAD)
//   commit: 08032d57e15574f2a7ca19fc3f29510c8673d590
//
//   v0.4.0-milady adds W4-B CUDA QJL + PolarQuant Q4 + TBQ3_TCQ kernels
//   on top of v0.3.0-milady. The CUDA paths only matter for the
//   linux-x64-cuda host target (the AOSP arm64 path stays CPU-only),
//   but the pin is shared so both AOSP and host build paths land on
//   identical kernel sources.
//
//   v0.2.0-milady (subset of this pin) added DFlash speculative decoding
//   CLI surface (--spec-type dflash, --draft-min-prob alias, n_drafted_total
//   / n_drafted_accepted_total Prometheus counters) on top of v0.1.0-milady.
//
// Why this fork (not stock ggml-org/llama.cpp b8198):
//   The Milady fork composes four techniques onto upstream b8198:
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
//       under ggml/src/ggml-metal/milady-kernels/. Source-only landing —
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
//   apps/app/android/app/src/main/assets/agent/{abi}/libllama.so
//   apps/app/android/app/src/main/assets/agent/{abi}/libggml.so
//   apps/app/android/app/src/main/assets/agent/{abi}/libggml-cpu.so
//   apps/app/android/app/src/main/assets/agent/{abi}/libggml-base.so
//   apps/app/android/app/src/main/assets/agent/{abi}/libeliza-llama-shim.so
//   apps/app/android/app/src/main/assets/agent/{abi}/llama-server          (DFlash spec-decode HTTP server)
//
// libllama.so has NEEDED entries on the entire libggml family (see
// `readelf -d`); the dynamic linker resolves them from the per-ABI asset
// dir via the LD_LIBRARY_PATH ElizaAgentService.java sets at process
// launch. ABIs: arm64-v8a (real phones) and x86_64 (cuttlefish + emulators).
//
// libeliza-llama-shim.so is the bun:ffi struct-by-value workaround: a
// thin C wrapper (llama-shim/eliza_llama_shim.c next to this script)
// that converts llama.cpp's struct-by-value entry points into
// pointer-style equivalents bun:ffi can speak. NEEDED-links
// libllama.so; resolved from the same asset dir at runtime.
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
//   The script defaults `--assets-dir` to
//   `<repoRoot>/apps/app/android/app/src/main/assets/agent` and
//   `--cache-dir` to `~/.cache/eliza-android-agent/llama-cpp-<tag>`.
//   `<repoRoot>` is derived from this script's location: walk up from
//   `eliza/packages/app-core/scripts/aosp/` to the host repo root by
//   default, but when the parent host repo invokes this via the
//   `eliza/` submodule the same algorithm finds the host repo root
//   (it stops at the first ancestor that has a `package.json`).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "../lib/repo-root.mjs";
import { main as compileShimMain } from "./compile-shim.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Walk up from `eliza/packages/app-core/scripts/aosp/` until we hit
// the host repo root (the directory with a top-level `package.json`).
// On a parent-host invocation that's `<host-root>`; when running
// inside the elizaOS source checkout it's the elizaOS repo root.
const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);

// elizaOS/llama.cpp @ v0.4.0-milady (milady/integration HEAD).
// Composes TBQ (apothic) + QJL (W1-A) + Q4_POLAR (W1-B) + Metal sources
// (W1-D) + DFlash spec-decode (W2) + W3-B fused CPU kernels + W4-B CUDA
// QJL/Polar/TBQ3_TCQ kernels onto upstream b8198. See
// docs/porting/unified-fork-strategy.md for the full migration story.
//
// Pre-2026-05-09 the AOSP path consumed apothic/llama.cpp-1bit-turboquant
// directly and applied vendored QJL + PolarQuant patch series via
// scripts/aosp/llama-cpp-patches/apply-patches.mjs at build time. That
// flow is now replaced by a single canonical fork — the patches are
// baked in. apply-patches.mjs is kept around for one release as a
// rollback path; see scripts/aosp/llama-cpp-patches/README.md.
export const LLAMA_CPP_TAG = "v0.4.0-milady";
export const LLAMA_CPP_COMMIT = "08032d57e15574f2a7ca19fc3f29510c8673d590";
export const LLAMA_CPP_REMOTE =
  "https://github.com/elizaOS/llama.cpp.git";
export const MIN_ZIG_VERSION = "0.13.0";

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
];

export function parseArgs(argv) {
  const args = {
    androidAssetsDir: path.join(
      repoRoot,
      "apps",
      "app",
      "android",
      "app",
      "src",
      "main",
      "assets",
      "agent",
    ),
    cacheDir: path.join(
      os.homedir(),
      ".cache",
      "eliza-android-agent",
      `llama-cpp-${LLAMA_CPP_TAG}`,
    ),
    abis: ABI_TARGETS.map((t) => t.androidAbi),
    skipIfPresent: false,
    jobs: Math.max(1, Math.min(os.cpus().length, 8)),
    srcDir: null,
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
      i += 1;
    } else if (arg === "--src-dir") {
      args.srcDir = path.resolve(readFlagValue(arg, i));
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
          "[--abi <arm64-v8a|x86_64>] [--jobs <N>] [--skip-if-present]\n" +
          "  --src-dir <PATH>  Use an existing llama.cpp / buun-llama-cpp checkout\n" +
          "                    instead of cloning. The directory's HEAD is used as-is;\n" +
          "                    the pinned LLAMA_CPP_TAG/COMMIT in this script is ignored.\n" +
          "                    Use this to build the spiritbuun/buun-llama-cpp fork\n" +
          "                    (TurboQuant KV-cache + DFlash kernels).",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

/**
 * Compare two semver-ish version strings (zig follows MAJOR.MINOR.PATCH for
 * stable releases; dev builds add `-dev.NNN+sha` which we strip).
 * Returns negative when `a < b`, positive when `a > b`, zero on equal.
 */
export function compareSemver(a, b) {
  const norm = (v) =>
    String(v)
      .replace(/^v/, "")
      .split(/[-+]/)[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const aa = norm(a);
  const bb = norm(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
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
    return cacheDir;
  }
  if (!fs.existsSync(path.join(cacheDir, ".git"))) {
    log(
      `[compile-libllama] Cloning llama.cpp ${LLAMA_CPP_TAG} into ${cacheDir}`,
    );
    fs.rmSync(cacheDir, { recursive: true, force: true });
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
 * the QJL kernel sources vendored from `packages/native-plugins/qjl-cpu/`,
 * the type-traits + op-dispatch wiring, and the `tests/test-qjl-cache.cpp`
 * synthetic-graph test.
 *
 * Series selection is scoped: today only `qjl` is applied here. The
 * `polarquant` series under the same directory exists but conflicts with
 * `qjl` over the GGML_TYPE_COUNT tag (PolarQuant claims id 45, QJL
 * claims 46) and is owned by a separate landing. When that series is
 * unified with QJL, append it here.
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
export function ensureZigDrivers({ cacheDir, abi, zigBin = "zig" }) {
  const target = ABI_TARGETS.find((t) => t.androidAbi === abi);
  if (!target) {
    throw new Error(`[compile-libllama] Unknown ABI: ${abi}`);
  }
  const driverDir = path.join(cacheDir, "zig-driver", abi);
  fs.mkdirSync(driverDir, { recursive: true });
  const ccPath = path.join(driverDir, "zig-cc");
  const cxxPath = path.join(driverDir, "zig-cxx");
  // Quote zigBin so a path with spaces still works. The driver runs under
  // /bin/sh which is POSIX-portable across Linux, macOS, Alpine.
  const ccBody =
    "#!/bin/sh\n" +
    "# Auto-generated by eliza/packages/app-core/scripts/aosp/compile-libllama.mjs.\n" +
    "# Do not edit — regenerated on every build.\n" +
    `exec "${zigBin}" cc --target=${target.zigTarget} "$@"\n`;
  const cxxBody =
    "#!/bin/sh\n" +
    "# Auto-generated by eliza/packages/app-core/scripts/aosp/compile-libllama.mjs.\n" +
    "# Do not edit — regenerated on every build.\n" +
    `exec "${zigBin}" c++ --target=${target.zigTarget} "$@"\n`;
  fs.writeFileSync(ccPath, ccBody, "utf8");
  fs.writeFileSync(cxxPath, cxxBody, "utf8");
  fs.chmodSync(ccPath, 0o755);
  fs.chmodSync(cxxPath, 0o755);
  return { ccPath, cxxPath };
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
}) {
  const target = ABI_TARGETS.find((t) => t.androidAbi === abi);
  if (!target) {
    throw new Error(`[compile-libllama] Unknown ABI: ${abi}`);
  }
  const buildDir = path.join(srcDir, `build-${abi}`);
  fs.mkdirSync(buildDir, { recursive: true });

  // Per-ABI driver scripts that wrap `zig cc --target=<triple>` so cmake's
  // single-binary compiler probe works. See ensureZigDrivers() for why
  // passing `--target=` via CMAKE_C_FLAGS doesn't work on its own.
  const { ccPath, cxxPath } = ensureZigDrivers({ cacheDir, abi, zigBin });

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
      // llama-server is required for the AOSP DFlash speculative-decode path
      // (target + drafter share one process; aosp-llama-adapter.ts spawns this
      // binary and routes inference over the OpenAI-compatible HTTP API). The
      // server target also pulls in the JSON/HTTP common-lib pieces, but adds
      // ~1.5 MB stripped per ABI; small price relative to the spec-decode
      // throughput win.
      "-DLLAMA_BUILD_SERVER=ON",
      "-DLLAMA_CURL=OFF",
      `-DCMAKE_C_COMPILER=${ccPath}`,
      `-DCMAKE_CXX_COMPILER=${cxxPath}`,
      // No launcher — the driver scripts do all the wrapping themselves.
      "-DCMAKE_C_COMPILER_LAUNCHER=",
      "-DCMAKE_CXX_COMPILER_LAUNCHER=",
      "-DCMAKE_SYSTEM_NAME=Linux",
      `-DCMAKE_SYSTEM_PROCESSOR=${target.cmakeProcessor}`,
      // Disable host-arch-specific ISA so the resulting .so loads on any
      // device of the target ABI. The default tunes for the build host's
      // native cpu, which is wrong for a cross-build.
      "-DGGML_NATIVE=OFF",
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
    ],
    {},
  );

  log(`[compile-libllama] Compiling libllama for ${abi} with -j${jobs}`);
  spawn(
    "cmake",
    ["--build", buildDir, "--target", "llama", "-j", String(jobs)],
    {},
  );

  // llama-server target. Built in a second --target invocation so a future
  // operator can disable it via a flag without touching the libllama target.
  // The target name is `llama-server` on the apothic fork (verified against
  // the upstream b8198 examples/server/CMakeLists.txt: `add_executable(
  // ${TARGET} server.cpp ...)` with `set(TARGET llama-server)`).
  log(`[compile-libllama] Compiling llama-server for ${abi} with -j${jobs}`);
  spawn(
    "cmake",
    ["--build", buildDir, "--target", "llama-server", "-j", String(jobs)],
    {},
  );

  // libllama.so and the ggml shared-library family are all transitive build
  // products of the `llama` target. b4500's NEEDED chain (verified via
  // `readelf -d`):
  //   libllama.so -> libggml.so, libggml-cpu.so, libggml-base.so, libc.so
  //   libggml.so   -> libggml-cpu.so, libggml-base.so, libc.so
  // We co-copy every libggml*.so we find under the build tree alongside
  // libllama.so so the dynamic linker resolves the whole graph from the
  // per-ABI asset dir at runtime (LD_LIBRARY_PATH set by
  // ElizaAgentService.java).
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

  fs.mkdirSync(abiAssetDir, { recursive: true });
  const llamaOut = path.join(abiAssetDir, "libllama.so");
  fs.copyFileSync(builtLlama, llamaOut);
  const ggmlOuts = builtGgmlLibs.map((src) => {
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
  //
  // Cost: ~5MB per ABI of duplicated content (the .so and .so.0 are
  // identical). APK build dedupes identical files automatically; even
  // without dedup this is well under the per-ABI .so budget.
  const sonameAliases = [];
  for (const out of [llamaOut, ...ggmlOuts]) {
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
        `DFlash speculative decode on AOSP requires it; rebuild with -DLLAMA_BUILD_SERVER=ON.`,
    );
  }

  const stripTargets = [...ggmlOuts, llamaOut, ...sonameAliases];
  if (llamaServerOut) stripTargets.push(llamaServerOut);
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
  // Re-chmod llama-server after strip — system strip may reset perms.
  if (llamaServerOut) fs.chmodSync(llamaServerOut, 0o755);
  return { llama: llamaOut, ggml: ggmlOuts, llamaServer: llamaServerOut };
}

/**
 * Compile `llama-shim/eliza_llama_shim.c` (next to this script) into
 * `<abiAssetDir>/libeliza-llama-shim.so`. The shim provides
 * pointer-style wrappers around llama.cpp's struct-by-value entry
 * points that bun:ffi cannot call directly. See the file's header for
 * the full rationale.
 *
 * Linkage:
 *   - Compiled with the same per-ABI zig driver used for llama.cpp
 *     (musl-linked, matches the bun-on-Android runtime ABI).
 *   - NEEDED-links libllama.so via `-L<abiAssetDir> -lllama`. Runtime
 *     resolution comes through the per-ABI LD_LIBRARY_PATH that the
 *     privileged AOSP system app's agent service sets — same mechanism
 *     libllama.so uses to find libggml*.so.
 *   - RUNPATH stripped (`-Wl,--disable-new-dtags` + no -rpath) so we don't
 *     bake in a build-host path.
 *
 * Output: `<abiAssetDir>/libeliza-llama-shim.so`, stripped to ~10-30 KB.
 *
 * Exported for tests so we can assert the compile invocation arguments
 * without running zig end-to-end.
 */
export function buildShimForAbi({
  cacheDir,
  abi,
  abiAssetDir,
  shimSourcePath = path.join(here, "llama-shim", "eliza_llama_shim.c"),
  llamaIncludeDir,
  zigBin = "zig",
  log = console.log,
  spawn = run,
}) {
  if (!fs.existsSync(shimSourcePath)) {
    throw new Error(
      `[compile-libllama] Shim source not found at ${shimSourcePath}. ` +
        `Restore eliza/packages/app-core/scripts/aosp/llama-shim/eliza_llama_shim.c.`,
    );
  }
  if (!fs.existsSync(llamaIncludeDir)) {
    throw new Error(
      `[compile-libllama] llama.h include dir missing at ${llamaIncludeDir}. ` +
        `Did the llama.cpp checkout fail?`,
    );
  }
  const llamaSo = path.join(abiAssetDir, "libllama.so");
  if (!fs.existsSync(llamaSo)) {
    throw new Error(
      `[compile-libllama] Cannot link shim: ${llamaSo} is missing. ` +
        `Run buildLibllamaForAbi() before buildShimForAbi().`,
    );
  }

  const { ccPath } = ensureZigDrivers({ cacheDir, abi, zigBin });
  const shimOut = path.join(abiAssetDir, "libeliza-llama-shim.so");

  // llama.h transitively includes ggml.h, which lives under ggml/include/
  // in the llama.cpp tree (separate from the llama include dir). We pass
  // both -I flags so the compiler resolves the full header chain.
  const ggmlIncludeDir = path.resolve(llamaIncludeDir, "..", "ggml", "include");
  if (!fs.existsSync(path.join(ggmlIncludeDir, "ggml.h"))) {
    throw new Error(
      `[compile-libllama] ggml.h missing under ${ggmlIncludeDir}. ` +
        `llama.h transitively includes it; the layout of the cached ` +
        `llama.cpp checkout may have changed.`,
    );
  }

  log(
    `[compile-libllama] Compiling libeliza-llama-shim.so for ${abi} (NEEDED libllama.so)`,
  );
  // -fPIC + -shared: build a position-independent shared object.
  // -O2: matches llama.cpp's release optimization level.
  // -I<include>: pick up llama.h from the cached llama.cpp checkout, and
  //   ggml.h from the ggml/include sibling.
  // -L<abiAssetDir> -lllama: resolve libllama.so for the link step. The
  //   resulting .so has NEEDED libllama.so; runtime resolution is via
  //   LD_LIBRARY_PATH set by ElizaAgentService.java.
  // -Wl,--disable-new-dtags + no -rpath: don't bake a RUNPATH that points
  //   at the build-host cache dir.
  spawn(
    ccPath,
    [
      "-shared",
      "-fPIC",
      "-O2",
      `-I${llamaIncludeDir}`,
      `-I${ggmlIncludeDir}`,
      `-L${abiAssetDir}`,
      "-Wl,--disable-new-dtags",
      "-o",
      shimOut,
      shimSourcePath,
      "-lllama",
    ],
    {},
  );

  if (!fs.existsSync(shimOut)) {
    throw new Error(
      `[compile-libllama] Shim compile reported success but ${shimOut} is missing.`,
    );
  }
  const sizeBefore = fs.statSync(shimOut).size;
  const stripped = stripBinary({ filePath: shimOut, zigBin, log });
  if (stripped) {
    const sizeAfter = fs.statSync(shimOut).size;
    if (sizeAfter === 0) {
      throw new Error(
        `[compile-libllama] Strip produced an empty libeliza-llama-shim.so ` +
          `(was ${sizeBefore} bytes). This is the zig objcopy in-place ` +
          `truncation bug — the script is supposed to strip out-of-place.`,
      );
    }
    log(
      `[compile-libllama] Stripped libeliza-llama-shim.so for ${abi} ` +
        `(${sizeBefore} -> ${sizeAfter} bytes).`,
    );
  }
  return shimOut;
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
  // Fallback: system strip. GNU coreutils strip is in-place safe.
  const systemStripResult = spawnSync("strip", ["--strip-all", filePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (systemStripResult.status === 0) return true;
  log(
    `[compile-libllama] WARN: could not strip ${filePath}; shipping with debug symbols.`,
  );
  return false;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  // Probe toolchain first so we fail loudly before doing any work.
  const zigVersion = probeZig();
  console.log(`[compile-libllama] Found zig ${zigVersion}`);

  let allPresent = true;
  for (const abi of args.abis) {
    const llama = path.join(args.androidAssetsDir, abi, "libllama.so");
    const ggml = path.join(args.androidAssetsDir, abi, "libggml.so");
    const shim = path.join(
      args.androidAssetsDir,
      abi,
      "libeliza-llama-shim.so",
    );
    const llamaServer = path.join(args.androidAssetsDir, abi, "llama-server");
    if (
      !fs.existsSync(llama) ||
      !fs.existsSync(ggml) ||
      !fs.existsSync(shim) ||
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

  let srcDir;
  let srcDescription;
  if (args.srcDir) {
    if (!fs.existsSync(path.join(args.srcDir, "CMakeLists.txt"))) {
      throw new Error(
        `[compile-libllama] --src-dir ${args.srcDir} does not contain a CMakeLists.txt; ` +
          `expected a llama.cpp / buun-llama-cpp checkout.`,
      );
    }
    srcDir = args.srcDir;
    let headRef = "(unknown)";
    try {
      headRef = fs.readFileSync(path.join(srcDir, ".git", "HEAD"), "utf8").trim();
    } catch {}
    console.log(
      `[compile-libllama] Using --src-dir ${srcDir} (HEAD: ${headRef}); ` +
        `pinned tag ${LLAMA_CPP_TAG} ignored.`,
    );
    srcDescription = `external src-dir ${srcDir}`;
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
    buildLibllamaForAbi({
      srcDir,
      cacheDir: args.cacheDir,
      abi,
      abiAssetDir,
      jobs: args.jobs,
      log: console.log,
      spawn: run,
    });
    // Compile the bun:ffi struct-by-value shim against the freshly built
    // libllama.so. Has to come AFTER the llama build because it links
    // against -lllama from <abiAssetDir>.
    buildShimForAbi({
      cacheDir: args.cacheDir,
      abi,
      abiAssetDir,
      llamaIncludeDir: path.join(srcDir, "include"),
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

  console.log(
    `[compile-libllama] Built libllama.so + libeliza-llama-shim.so + llama-server for ` +
      `${args.abis.join(", ")} (${srcDescription}).`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await main();
}
