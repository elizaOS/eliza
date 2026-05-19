#!/usr/bin/env node
/**
 * build-omnivoice.mjs — build the libomnivoice shared library used by
 * `@elizaos/plugin-omnivoice` via `bun:ffi`.
 *
 * Mirrors the policy of build-llama-cpp-dflash.mjs (build the GGML-based
 * native lib using the user's system cmake + toolchain, no sudo, no
 * download) but targets the omnivoice.cpp subtree at
 * `packages/inference/omnivoice.cpp`.
 *
 * Usage:
 *   node packages/inference/build-omnivoice.mjs            # build for host
 *   node packages/inference/build-omnivoice.mjs --dry-run  # plan only
 *   node packages/inference/build-omnivoice.mjs --clean    # wipe build/
 *
 * Env knobs:
 *   OMNIVOICE_BACKEND     auto (default) | metal | cuda | vulkan | cpu
 *   OMNIVOICE_BUILD_DIR   override build directory (default: build)
 *   OMNIVOICE_JOBS        parallel jobs (default: os.cpus().length)
 *   OMNIVOICE_TARGET      host (default) | android-arm64-cpu | android-x86_64-cpu |
 *                         android-riscv64-cpu | linux-arm64-cpu | linux-x86_64-cpu |
 *                         linux-riscv64-cpu
 *                         When set to anything other than `host`, cross-compile
 *                         libomnivoice.so for the requested arch via
 *                         `zig cc --target=<arch>-linux-musl` (same toolchain
 *                         used by packages/app-core/scripts/aosp/compile-libllama.mjs).
 *                         The cross-build always uses the cpu backend regardless of
 *                         OMNIVOICE_BACKEND (no Metal/CUDA/Vulkan path for these
 *                         on-device cross targets).
 *   ZIG_BIN               override the `zig` binary used for cross-builds
 *                         (default: `zig` on PATH). riscv64 cross-builds require
 *                         Zig 0.14.0+; earlier versions do not accept
 *                         `-march=rv64gc` and will fail to configure.
 *
 * Output (when cross-compiling):
 *   build-<target>/libomnivoice.so   — riscv64 / arm64 / x86_64 musl-linked .so
 *
 * The cross-build is the on-device path: it produces a libomnivoice.so that
 * loads inside the Eliza bun-on-Android / bun-on-riscv64 process alongside
 * libllama.so emitted by compile-libllama.mjs. The host path remains the
 * desktop dev default (cmake picks up the system toolchain).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OMNIVOICE_DIR = path.join(__dirname, "omnivoice.cpp");
const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has("--dry-run");
const CLEAN = ARGS.has("--clean");

function log(msg) {
  process.stdout.write(`[build-omnivoice] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[build-omnivoice] error: ${msg}\n`);
  process.exit(1);
}

// Cross-compile target matrix. Mirrors the precedent set by
// packages/app-core/scripts/aosp/compile-libllama.mjs ABI_TARGETS so the
// libomnivoice.so produced here is link-compatible with the libllama.so /
// libggml.so emitted by that script (same Zig-bundled musl libc + libc++,
// same triple selection, same rv64gc/lp64d baseline). riscv64 is the
// motivating addition (Wave 2 set the precedent); arm64/x86_64 cross are
// included for symmetry so an operator on a non-host platform (e.g.
// linux-x86_64 build host targeting an arm64 phone) has a single path.
export const CROSS_TARGETS = Object.freeze({
  "android-arm64-cpu": { arch: "arm64", zigTarget: "aarch64-linux-musl" },
  "android-x86_64-cpu": { arch: "x86_64", zigTarget: "x86_64-linux-musl" },
  "android-riscv64-cpu": { arch: "riscv64", zigTarget: "riscv64-linux-musl" },
  "linux-arm64-cpu": { arch: "arm64", zigTarget: "aarch64-linux-musl" },
  "linux-x86_64-cpu": { arch: "x86_64", zigTarget: "x86_64-linux-musl" },
  "linux-riscv64-cpu": { arch: "riscv64", zigTarget: "riscv64-linux-musl" },
});

function resolveTarget() {
  const raw = process.env.OMNIVOICE_TARGET?.trim();
  if (!raw || raw === "host") return null;
  const entry = CROSS_TARGETS[raw];
  if (!entry) {
    fail(
      `unknown OMNIVOICE_TARGET=${raw}. Supported: host, ${Object.keys(
        CROSS_TARGETS,
      ).join(", ")}`,
    );
  }
  return { name: raw, ...entry };
}

function detectBackend(target) {
  // Cross-compile targets are CPU-only — there is no Metal/CUDA/Vulkan
  // toolchain wrapped behind zig cc, and the on-device path (Android /
  // riscv64 phone / etc.) wants a CPU build anyway. Silently forcing cpu
  // here keeps the legacy OMNIVOICE_BACKEND knob from accidentally
  // selecting a host-only backend for an on-device build.
  if (target) return "cpu";
  const explicit = process.env.OMNIVOICE_BACKEND?.toLowerCase();
  if (
    explicit === "metal" ||
    explicit === "cuda" ||
    explicit === "vulkan" ||
    explicit === "cpu"
  ) {
    return explicit;
  }
  if (process.platform === "darwin") return "metal";
  // crude nvcc detection — same pattern build-llama-cpp-dflash.mjs uses.
  // We do NOT shell out to `which` here; presence in PATH is enough.
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    if (existsSync(path.join(dir, "nvcc"))) return "cuda";
  }
  return "cpu";
}

function platformFlags(backend) {
  switch (backend) {
    case "metal":
      return ["-DGGML_METAL=ON", "-DGGML_BLAS=OFF"];
    case "cuda":
      return ["-DGGML_CUDA=ON", "-DGGML_NATIVE=ON"];
    case "vulkan":
      return ["-DGGML_VULKAN=ON"];
    case "cpu":
    default:
      return ["-DGGML_NATIVE=ON"];
  }
}

function expectedLibName(target) {
  // Cross-targets always emit a Linux/Android .so regardless of build host.
  if (target) return "libomnivoice.so";
  if (process.platform === "darwin") return "libomnivoice.dylib";
  if (process.platform === "win32") return "omnivoice.dll";
  return "libomnivoice.so";
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? process.cwd(),
      stdio: "inherit",
      env: opts.env ?? process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${cmd} ${args.join(" ")} exited with code ${code ?? "null"}`,
          ),
        );
      }
    });
  });
}

/**
 * Write per-target `zig-cc` / `zig-cxx` driver scripts and return their paths.
 * Mirrors `ensureZigDrivers()` in packages/app-core/scripts/aosp/compile-libllama.mjs
 * — the same shape of driver that wraps `zig cc/c++ --target=<triple>` into a
 * single binary CMake can probe.
 *
 * riscv64 needs an extra arg-filtering step on Zig 0.13. The omnivoice.cpp
 * ggml subtree's `ggml/src/ggml-cpu/CMakeLists.txt` adds
 * `-march=rv64gcv_zfh_zvfh_zicbop_zihintpause -mabi=lp64d` as soon as
 * `CMAKE_SYSTEM_PROCESSOR=riscv64` is set (it does not respect GGML_NATIVE=OFF
 * for this codepath). Zig 0.13's bundled LLVM rejects the extended
 * `rv64gcv_zfh_...` ISA string with `unknown CPU` — same root cause
 * compile-libllama.mjs documents. The fix is the same: filter `-march=` /
 * `-mabi=` out of the argv before forwarding to `zig cc/c++`. The triple
 * `riscv64-linux-musl` already selects the rv64gc/lp64d baseline, which
 * matches the scalar-parity build that compile-libllama.mjs's Wave 1 produces.
 *
 * On Zig 0.14+ the LLVM bundled with it accepts the GCC-style ISA string
 * (including the `_zfh_zvfh_zicbop_zihintpause` extension suffix), so
 * ZIG_RISCV64_MARCH_PASSTHROUGH=1 disables the filter and lets the RVV
 * intrinsic codepaths in ggml/src/ggml-cpu/arch/riscv/quants.c get compiled.
 */
function ensureZigDrivers(target, driverDir) {
  mkdirSync(driverDir, { recursive: true });
  const zigBin = process.env.ZIG_BIN?.trim() || "zig";
  const passthrough =
    process.env.ZIG_RISCV64_MARCH_PASSTHROUGH?.trim() === "1";
  const ccPath = path.join(driverDir, "zig-cc");
  const cxxPath = path.join(driverDir, "zig-cxx");
  const arPath = path.join(driverDir, "zig-ar");
  const ranlibPath = path.join(driverDir, "zig-ranlib");

  // riscv64 arg-filter for Zig 0.13 — strip the GCC-style ISA strings the
  // vendored ggml-cpu CMakeLists hardcodes. See header comment above for
  // the precedent in compile-libllama.mjs. Filter logic walks $@ via the
  // POSIX `set --` idiom so quotes and spaces in cmake-emitted args
  // survive intact.
  const riscv64ArgFilter =
    target.arch === "riscv64" && !passthrough
      ? "_n=$#\n" +
        "i=0\n" +
        "while [ $i -lt $_n ]; do\n" +
        "  arg=$1\n" +
        "  shift\n" +
        "  i=$((i+1))\n" +
        "  case \"$arg\" in\n" +
        "    -march=rv64gc|-march=rv64gc*) ;;\n" +
        "    -mabi=lp64d|-mabi=lp64) ;;\n" +
        "    *) set -- \"$@\" \"$arg\" ;;\n" +
        "  esac\n" +
        "done\n"
      : "";

  const ccBody =
    riscv64ArgFilter +
    `exec "${zigBin}" cc --target=${target.zigTarget} "$@"\n`;
  const cxxBody =
    riscv64ArgFilter +
    `exec "${zigBin}" c++ --target=${target.zigTarget} "$@"\n`;

  writeFileSync(ccPath, `#!/bin/sh\n${ccBody}`);
  writeFileSync(cxxPath, `#!/bin/sh\n${cxxBody}`);
  writeFileSync(arPath, `#!/bin/sh\nexec "${zigBin}" ar "$@"\n`);
  writeFileSync(ranlibPath, `#!/bin/sh\nexec "${zigBin}" ranlib "$@"\n`);
  chmodSync(ccPath, 0o755);
  chmodSync(cxxPath, 0o755);
  chmodSync(arPath, 0o755);
  chmodSync(ranlibPath, 0o755);
  return { ccPath, cxxPath, arPath, ranlibPath };
}

function crossConfigureArgs(target, buildPath, drivers) {
  // -DGGML_NATIVE=OFF: don't probe the build host (zig cc reports x86_64
  //   features that don't apply to the riscv64/arm64 target).
  // -DGGML_OPENVINO=OFF: OpenVINO has no riscv64 / on-device path. Same
  //   posture compile-libllama.mjs takes for the AOSP fused builds.
  // -DCMAKE_SYSTEM_NAME=Linux: match the musl-linux ELF target the resulting
  //   libomnivoice.so will run inside (bun-on-Android uses Alpine musl;
  //   bun-on-riscv64 uses an Alpine-musl-equivalent loader).
  // -DCMAKE_SYSTEM_PROCESSOR=<arch>: same arch token as compile-libllama.mjs.
  // -DOMNIVOICE_SHARED=ON / -DBUILD_SHARED_LIBS=ON: produce libomnivoice.so
  //   (the FFI target). Static is a non-goal — bun:ffi dlopens the .so.
  const riscv64ScalarDefaults =
    target.arch === "riscv64"
      ? [
          // Scalar-parity riscv64 defaults — match the Wave 1 precedent
          // set by packages/app-core/scripts/aosp/compile-libllama.mjs.
          // Zig 0.13's LLVM rejects the extended ISA strings these flags
          // produce; Wave 2 turned them back on for Zig 0.14 by setting
          // ZIG_RISCV64_MARCH_PASSTHROUGH=1 (which lets the rv64gcv_zfh_...
          // march string survive the driver). Until that env knob is set
          // we ship the scalar build, which is what the AOSP riscv64
          // libllama / libggml emits today.
          "-DGGML_RVV=OFF",
          "-DGGML_RV_ZFH=OFF",
          "-DGGML_RV_ZVFH=OFF",
          "-DGGML_RV_ZVFBFWMA=OFF",
          "-DGGML_RV_ZICBOP=OFF",
          "-DGGML_RV_ZIHINTPAUSE=OFF",
          "-DGGML_XTHEADVECTOR=OFF",
          "-DGGML_CPU_RISCV64_SPACEMIT=OFF",
        ]
      : [];

  return [
    "-S",
    OMNIVOICE_DIR,
    "-B",
    buildPath,
    "-DOMNIVOICE_SHARED=ON",
    "-DBUILD_SHARED_LIBS=ON",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DGGML_NATIVE=OFF",
    "-DGGML_OPENVINO=OFF",
    "-DCMAKE_SYSTEM_NAME=Linux",
    `-DCMAKE_SYSTEM_PROCESSOR=${target.arch === "arm64" ? "aarch64" : target.arch}`,
    `-DCMAKE_C_COMPILER=${drivers.ccPath}`,
    `-DCMAKE_CXX_COMPILER=${drivers.cxxPath}`,
    `-DCMAKE_AR=${drivers.arPath}`,
    `-DCMAKE_RANLIB=${drivers.ranlibPath}`,
    ...riscv64ScalarDefaults,
  ];
}

async function main() {
  if (!existsSync(OMNIVOICE_DIR)) {
    fail(`omnivoice.cpp directory missing: ${OMNIVOICE_DIR}`);
  }
  if (!existsSync(path.join(OMNIVOICE_DIR, "CMakeLists.txt"))) {
    fail(`CMakeLists.txt not found in ${OMNIVOICE_DIR}`);
  }

  const target = resolveTarget();
  const buildDir =
    process.env.OMNIVOICE_BUILD_DIR ??
    (target ? `build-${target.name}` : "build");
  const buildPath = path.join(OMNIVOICE_DIR, buildDir);
  const backend = detectBackend(target);
  const jobs = process.env.OMNIVOICE_JOBS ?? String(os.cpus().length);

  let configureArgs;
  if (target) {
    const driverDir = path.join(buildPath, ".zig-driver");
    if (!DRY_RUN) {
      mkdirSync(buildPath, { recursive: true });
    }
    const drivers = DRY_RUN
      ? {
          ccPath: path.join(driverDir, "zig-cc"),
          cxxPath: path.join(driverDir, "zig-cxx"),
          arPath: path.join(driverDir, "zig-ar"),
          ranlibPath: path.join(driverDir, "zig-ranlib"),
        }
      : ensureZigDrivers(target, driverDir);
    configureArgs = crossConfigureArgs(target, buildPath, drivers);
  } else {
    configureArgs = [
      "-S",
      OMNIVOICE_DIR,
      "-B",
      buildPath,
      "-DOMNIVOICE_SHARED=ON",
      "-DCMAKE_BUILD_TYPE=Release",
      ...platformFlags(backend),
    ];
  }
  const buildArgs = ["--build", buildPath, "--target", "omnivoice", "-j", jobs];

  log(`omnivoice.cpp at ${OMNIVOICE_DIR}`);
  log(`target: ${target?.name ?? "host"}`);
  log(`backend: ${backend}`);
  log(`build dir: ${buildPath}`);
  log(`jobs: ${jobs}`);
  log(`expected output: ${path.join(buildPath, expectedLibName(target))}`);

  if (CLEAN) {
    log("--clean: removing build dir");
    if (DRY_RUN) {
      log(`[dry-run] rm -rf ${buildPath}`);
    } else {
      await rm(buildPath, { recursive: true, force: true });
    }
  }

  log(`cmake ${configureArgs.join(" ")}`);
  log(`cmake ${buildArgs.join(" ")}`);

  if (DRY_RUN) {
    log("--dry-run: skipping cmake invocation");
    return;
  }

  await run("cmake", configureArgs);
  await run("cmake", buildArgs);

  const out = path.join(buildPath, expectedLibName(target));
  if (!existsSync(out)) {
    fail(`build completed but ${out} is missing`);
  }
  log(`built ${out}`);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
