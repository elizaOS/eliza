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
// What this script produces (per ABI, x86_64 only):
//   <abiCacheDir>/libsigsys-handler.so   — LD_PRELOAD'd by loader-wrap
//   <abiCacheDir>/loader-wrap            — drop-in for ld-musl-x86_64.so.1
//
// ARM64 is intentionally skipped — its kernel ABI provides only the
// AT-suffixed syscalls, so musl's wrappers never invoke a legacy form
// the seccomp filter could trap on. The shim's x86_64 inline asm and
// `REG_RAX` greg index would not even compile for arm64. See
// `seccomp-shim/sigsys-handler.c` header for the full rationale.
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
 * Only x86_64 needs the SIGSYS shim. ARM64's kernel ABI omits every
 * legacy non-AT syscall the filter could trap on; the shim source
 * actually `#error`s on non-x86_64 to prevent silent miscompiles.
 */
export const SHIM_ABI_TARGETS = [
  {
    androidAbi: "x86_64",
    zigTarget: "x86_64-linux-musl",
    realLoaderName: "ld-musl-x86_64.so.1",
  },
];

const SHIM_SOURCE_PATH = path.join(here, "seccomp-shim", "sigsys-handler.c");
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
          `--abi must be one of ${valid.join(", ")} (got: ${value}). ` +
            `arm64-v8a doesn't need a SIGSYS shim — see compile-shim.mjs header.`,
        );
      }
      args.abis = [value];
      i += 1;
    } else if (arg === "--skip-if-present") {
      args.skipIfPresent = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node eliza/packages/app-core/scripts/aosp/compile-shim.mjs " +
          "[--cache-dir <PATH>] [--abi <x86_64>] [--skip-if-present]",
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
  shimSourcePath = SHIM_SOURCE_PATH,
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
  if (!fs.existsSync(shimSourcePath)) {
    throw new Error(
      `[compile-shim] sigsys-handler.c not found at ${shimSourcePath}.`,
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
      shimSourcePath,
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
