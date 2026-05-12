#!/usr/bin/env node
// eliza/packages/app-core/scripts/aosp/compile-shim.mjs —
// cross-compile the SIGSYS-handler shim + the musl loader-wrapper for
// the AOSP-bound privileged-system-app APK shipped by an elizaOS host
// or any white-label fork built on it.
//
// Why this exists:
//   Android's app seccomp filter on x86_64 traps every legacy
//   non-AT-suffixed syscall (access, poll, dup2, pipe, ...) regardless of
//   whether the BUN_FEATURE_FLAG_* knobs ElizaAgentService.java exports
//   are set — those only steer bun's own modern fastpaths. Bun's static
//   musl runtime (and zig's inline-asm primitives baked into the bun
//   binary) issues those legacy syscalls anyway, which makes the agent
//   die with SIGSYS the moment it touches the filesystem. We can't
//   change the kernel-side filter from userspace, so the workaround is
//   a SIGSYS handler that emulates the trapped syscall via its AT-form
//   sibling and returns the kernel-ABI return value back into the
//   trapped thread's RAX.
//
//   See seccomp-shim/sigsys-handler.c for the full coverage matrix
//   (24 syscalls, all x86_64) and the production-landing checklist.
//
// What this script produces (per ABI):
//   <abiCacheDir>/libsigsys-handler.so   — LD_PRELOAD'd by loader-wrap
//   <abiCacheDir>/<ld-musl-...so.1>      — drop-in for the real musl loader
//
// ARM64 has a separate, narrower shim source (`sigsys-handler-arm64.c`)
// covering the *new*-syscall case rather than the legacy non-AT case:
// bun's event loop calls `epoll_pwait2` (#441, Linux 5.11+) on every
// tick, and Android's arm64 `untrusted_app` seccomp filter traps it
// with SIGSYS. The arm64 shim translates that trap back to the older
// `epoll_pwait` (#22). The x86_64 shim's full 24-syscall legacy table
// does NOT apply to arm64 — that kernel ABI omits those numbers
// entirely, so musl's aarch64 wrappers never invoke them.
//
// Staging:
//   `stage-android-agent.mjs` reads from <cacheDir>/seccomp-shim/x86_64/
//   when present and:
//     1. Renames the Alpine-extracted ld-musl-x86_64.so.1 to .so.1.real.
//     2. Writes our loader-wrap as ld-musl-x86_64.so.1.
//     3. Writes libsigsys-handler.so alongside.
//   Idempotent: if the wrapper is already in place we leave it alone.
//
// Toolchain:
//   Same `zig cc --target=x86_64-linux-musl` cross-compile path that
//   compile-libllama.mjs uses. The shim is musl-linked so it matches
//   the bun-on-Android runtime ABI. We reuse compile-libllama's
//   `ensureZigDrivers()` so cmake-style invocation patterns work
//   uniformly.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ensureZigDrivers, probeZig } from "./compile-libllama.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Each target has its own SIGSYS-handler source file because the shim
 * decodes trapped registers from arch-specific `ucontext_t.uc_mcontext`
 * layouts (x86_64's `gregs[REG_RAX]` vs arm64's `regs[0]`) and re-issues
 * the replacement syscall via arch-specific inline `svc 0` / `syscall`
 * asm. The shim sources `#error` on the wrong arch to prevent silent
 * miscompiles. The loader-wrap binary is portable across ABIs (only
 * AT-form syscalls).
 */
export const SHIM_ABI_TARGETS = [
  {
    androidAbi: "x86_64",
    zigTarget: "x86_64-linux-musl",
    realLoaderName: "ld-musl-x86_64.so.1",
    shimSource: "sigsys-handler.c",
  },
  {
    androidAbi: "arm64-v8a",
    zigTarget: "aarch64-linux-musl",
    realLoaderName: "ld-musl-aarch64.so.1",
    shimSource: "sigsys-handler-arm64.c",
  },
];

const LOADER_WRAP_SOURCE_PATH = path.join(
  here,
  "seccomp-shim",
  "loader-wrap.c",
);

export function parseArgs(argv) {
  const args = {
    cacheDir: path.join(
      os.homedir(),
      ".cache",
      "eliza-android-agent",
      "seccomp-shim",
    ),
    abis: SHIM_ABI_TARGETS.map((t) => t.androidAbi),
    skipIfPresent: false,
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
    if (arg === "--cache-dir") {
      args.cacheDir = path.resolve(readFlagValue(arg, i));
      i += 1;
    } else if (arg === "--abi") {
      const value = readFlagValue(arg, i);
      const valid = SHIM_ABI_TARGETS.map((t) => t.androidAbi);
      if (!valid.includes(value)) {
        throw new Error(
          `--abi must be one of ${valid.join(", ")} (got: ${value}).`,
        );
      }
      args.abis = [value];
      i += 1;
    } else if (arg === "--skip-if-present") {
      args.skipIfPresent = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node eliza/packages/app-core/scripts/aosp/compile-shim.mjs " +
          "[--cache-dir <PATH>] [--abi <x86_64|arm64-v8a>] [--skip-if-present]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
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
 * Build `libsigsys-handler.so` for one ABI under the per-ABI cache dir.
 *
 * The shim is a `-shared -fPIC` musl-linked object loaded via
 * LD_PRELOAD by the loader-wrap binary. It installs a SIGSYS handler
 * at constructor time that emulates 24 legacy syscalls via their
 * AT-suffixed equivalents — see the source file's header comment.
 *
 * Exported for unit testing.
 */
export function buildSigsysShimForAbi({
  cacheDir,
  abi,
  shimSourcePath,
  zigBin = "zig",
  log = console.log,
  spawn = run,
}) {
  const target = SHIM_ABI_TARGETS.find((t) => t.androidAbi === abi);
  if (!target) {
    throw new Error(
      `[compile-shim] Unknown ABI: ${abi}. Only ${SHIM_ABI_TARGETS.map((t) => t.androidAbi).join(", ")} need a shim.`,
    );
  }
  const resolvedShimSource =
    shimSourcePath ?? path.join(here, "seccomp-shim", target.shimSource);
  if (!fs.existsSync(resolvedShimSource)) {
    throw new Error(
      `[compile-shim] ${target.shimSource} not found at ${resolvedShimSource}.`,
    );
  }
  const abiCacheDir = path.join(cacheDir, abi);
  fs.mkdirSync(abiCacheDir, { recursive: true });
  const { ccPath } = ensureZigDrivers({ cacheDir, abi, zigBin });
  const out = path.join(abiCacheDir, "libsigsys-handler.so");

  log(
    `[compile-shim] Compiling libsigsys-handler.so for ${abi} (${target.zigTarget})`,
  );
  // -shared + -fPIC: position-independent shared object.
  // -O2: parity with bun's release optimisation level.
  // -Wl,--disable-new-dtags: don't bake build-host RUNPATH (we're loaded
  //   via LD_PRELOAD anyway, RUNPATH is irrelevant, but keep the flag
  //   for symmetry with libeliza-llama-shim.so so future audit tools
  //   don't see drift).
  spawn(
    ccPath,
    [
      "-shared",
      "-fPIC",
      "-O2",
      "-Wl,--disable-new-dtags",
      "-o",
      out,
      resolvedShimSource,
    ],
    {},
  );
  if (!fs.existsSync(out)) {
    throw new Error(
      `[compile-shim] Compile reported success but ${out} is missing.`,
    );
  }
  const size = fs.statSync(out).size;
  if (size === 0) {
    throw new Error(`[compile-shim] Produced an empty libsigsys-handler.so.`);
  }
  log(`[compile-shim] Built libsigsys-handler.so for ${abi} (${size} bytes).`);
  return out;
}

/**
 * Build the static-musl `loader-wrap` binary for one ABI under the
 * per-ABI cache dir.
 *
 * The wrapper drops in for `ld-musl-x86_64.so.1` so ElizaAgentService.java's
 * existing `findMuslLoader` + ProcessBuilder spawn line transparently
 * picks it up. At runtime it:
 *   1. Locates the real loader at `<self>.real`.
 *   2. Prepends `<self-dir>/libsigsys-handler.so` to LD_PRELOAD.
 *   3. execve's the real loader with the original argv.
 *
 * Built `-static` so it has no NEEDED entries — the wrapper itself runs
 * before any dynamic linker is even consulted.
 *
 * Exported for unit testing.
 */
export function buildLoaderWrapForAbi({
  cacheDir,
  abi,
  loaderWrapSourcePath = LOADER_WRAP_SOURCE_PATH,
  zigBin = "zig",
  log = console.log,
  spawn = run,
}) {
  const target = SHIM_ABI_TARGETS.find((t) => t.androidAbi === abi);
  if (!target) {
    throw new Error(`[compile-shim] Unknown ABI: ${abi}.`);
  }
  if (!fs.existsSync(loaderWrapSourcePath)) {
    throw new Error(
      `[compile-shim] loader-wrap.c not found at ${loaderWrapSourcePath}.`,
    );
  }
  const abiCacheDir = path.join(cacheDir, abi);
  fs.mkdirSync(abiCacheDir, { recursive: true });
  const { ccPath } = ensureZigDrivers({ cacheDir, abi, zigBin });
  // Output filename must match the loader filename it replaces. We
  // stage by name in stage-android-agent.mjs.
  const out = path.join(abiCacheDir, target.realLoaderName);

  log(
    `[compile-shim] Compiling loader-wrap (${target.realLoaderName}) for ${abi}`,
  );
  spawn(
    ccPath,
    [
      "-O2",
      "-static",
      "-Wl,--disable-new-dtags",
      "-o",
      out,
      loaderWrapSourcePath,
    ],
    {},
  );
  if (!fs.existsSync(out)) {
    throw new Error(
      `[compile-shim] Loader wrap compile reported success but ${out} is missing.`,
    );
  }
  const size = fs.statSync(out).size;
  if (size === 0) {
    throw new Error(`[compile-shim] Produced an empty loader-wrap binary.`);
  }
  log(
    `[compile-shim] Built ${target.realLoaderName} for ${abi} (${size} bytes).`,
  );
  return out;
}

/**
 * Locate compiled shim artifacts for a given ABI under the cache dir.
 * Returns absolute paths when both the shim and the loader-wrap exist;
 * `null` when either is missing (callers should fall back to the
 * legacy no-shim path on that ABI).
 */
export function locateCompiledShim({ cacheDir, abi }) {
  const target = SHIM_ABI_TARGETS.find((t) => t.androidAbi === abi);
  if (!target) return null;
  const abiCacheDir = path.join(cacheDir, abi);
  const shim = path.join(abiCacheDir, "libsigsys-handler.so");
  const wrap = path.join(abiCacheDir, target.realLoaderName);
  if (!fs.existsSync(shim) || !fs.existsSync(wrap)) return null;
  return { shim, wrap, realLoaderName: target.realLoaderName };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const zigVersion = probeZig();
  console.log(`[compile-shim] Found zig ${zigVersion}`);

  for (const abi of args.abis) {
    if (args.skipIfPresent) {
      const located = locateCompiledShim({ cacheDir: args.cacheDir, abi });
      if (located) {
        console.log(
          `[compile-shim] ${abi}: already present at ${located.shim} + ${located.wrap}; skipping.`,
        );
        continue;
      }
    }
    buildSigsysShimForAbi({ cacheDir: args.cacheDir, abi });
    buildLoaderWrapForAbi({ cacheDir: args.cacheDir, abi });
  }
  console.log(
    `[compile-shim] Built SIGSYS shim + loader-wrap for ${args.abis.join(", ")}.`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await main();
}
