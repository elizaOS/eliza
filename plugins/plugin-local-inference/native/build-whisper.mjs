#!/usr/bin/env node
/**
 * build-whisper.mjs — build whisper.cpp into `libwhisper.{so,dylib,dll}`
 * + the `whisper-cli` executable for Eliza's ASR path.
 *
 * The shared library is what `plugins/plugin-local-inference/src/services/
 * voice/whisper-cpp-asr.ts` dlopens via `bun:ffi`. The CLI executable
 * matches the subprocess-shape the previous OpenVINO Python worker
 * implemented so legacy code paths (and ad-hoc bench / debug invocations)
 * still work without a JS-side FFI loader present.
 *
 * Mirrors the policy and the cross-compile matrix of build-omnivoice.mjs:
 * the user's system cmake + toolchain are used for the host path; the
 * cross-compile targets reuse the Zig-bundled musl libc + libc++ that
 * `packages/app-core/scripts/aosp/compile-libllama.mjs` already drives,
 * so libwhisper.so and libllama.so are link-compatible on the same
 * Android / Linux musl ABI.
 *
 * whisper.cpp source resolution:
 *   1. `--src=<dir>` / env `WHISPER_SRC_DIR`.
 *   2. submodule at `plugins/plugin-local-inference/native/whisper.cpp/`.
 *   3. fallback clone to `~/.cache/eliza-whisper-cpp/whisper.cpp` (depth 1,
 *      tag `v1.7.4`).
 *
 * Usage:
 *   node plugins/plugin-local-inference/native/build-whisper.mjs            # build for host
 *   node plugins/plugin-local-inference/native/build-whisper.mjs --dry-run  # plan only
 *   node plugins/plugin-local-inference/native/build-whisper.mjs --clean    # wipe build/
 *
 * Env knobs:
 *   WHISPER_BACKEND       auto (default) | metal | cuda | vulkan | cpu
 *   WHISPER_BUILD_DIR     override build directory (default: build-whisper)
 *   WHISPER_JOBS          parallel jobs (default: os.cpus().length)
 *   WHISPER_TARGET        host (default) | android-{arm64,x86_64,riscv64}-cpu
 *                                       | linux-{arm64,x86_64,riscv64}-cpu
 *                                       | darwin-arm64-metal
 *                         When set to anything other than `host`, cross-compile
 *                         libwhisper.so for the requested arch via
 *                         `zig cc --target=<arch>-linux-musl` (same toolchain
 *                         used by compile-libllama.mjs / build-omnivoice.mjs).
 *                         The cross-build always uses the cpu backend
 *                         regardless of WHISPER_BACKEND (no Metal/CUDA/Vulkan
 *                         path for these on-device cross targets).
 *   ZIG_BIN               override the `zig` binary used for cross-builds
 *                         (default: `zig` on PATH). riscv64 cross-builds
 *                         require Zig 0.14.0+ for the rv64gcv_zfh_... ISA
 *                         passthrough; earlier versions fall back to the
 *                         scalar baseline (same posture as build-omnivoice.mjs).
 *   WHISPER_SRC_DIR       override path to whisper.cpp source checkout.
 *
 * Outputs:
 *   host build:  ${WHISPER_BUILD_DIR}/whisper-cpp-build/src/libwhisper.{so,dylib,dll}
 *                ${WHISPER_BUILD_DIR}/whisper-cpp-build/bin/whisper-cli
 *                ${WHISPER_BUILD_DIR}/libwhisper_eliza_adapter.{so,dylib,dll}
 *   cross build: build-whisper-<target>/whisper-cpp-build/src/libwhisper.so
 *                build-whisper-<target>/whisper-cpp-build/bin/whisper-cli
 *                build-whisper-<target>/libwhisper_eliza_adapter.so
 *
 * The whisper-eliza-adapter shared library is what
 * `plugins/plugin-local-inference/src/services/voice/whisper-cpp-asr.ts`
 * dlopens via `bun:ffi` — it exposes a flat C ABI (open / transcribe / close)
 * so the JS side does not have to materialise whisper.cpp's
 * whisper_full_params / whisper_context_params structs.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NATIVE_DIR = __dirname;
const ADAPTER_DIR = path.join(NATIVE_DIR, "whisper-eliza-adapter");
const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has("--dry-run");
const CLEAN = ARGS.has("--clean");
// `--src=<path>` argv parsing kept simple — no other flags carry values.
let CLI_SRC_DIR = null;
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--src=")) {
    CLI_SRC_DIR = arg.slice("--src=".length);
  }
}

// Pin to a known-good whisper.cpp release. v1.7.4 (2026-02) is the last tag
// with a working `add_subdirectory(ggml)` build that exposes both the
// `whisper` shared library target and the `whisper-cli` example binary.
const WHISPER_DEFAULT_TAG = "v1.7.4";
const WHISPER_REMOTE = "https://github.com/ggerganov/whisper.cpp.git";

function log(msg) {
  process.stdout.write(`[build-whisper] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[build-whisper] error: ${msg}\n`);
  process.exit(1);
}

// Cross-compile target matrix. Mirrors build-omnivoice.mjs + compile-libllama.mjs
// so libwhisper.so / libllama.so / libomnivoice.so are emitted for the same
// musl-linked Linux/Android ABIs.
export const CROSS_TARGETS = Object.freeze({
  "android-arm64-cpu": { arch: "arm64", zigTarget: "aarch64-linux-musl" },
  "android-x86_64-cpu": { arch: "x86_64", zigTarget: "x86_64-linux-musl" },
  "android-riscv64-cpu": { arch: "riscv64", zigTarget: "riscv64-linux-musl" },
  "linux-arm64-cpu": { arch: "arm64", zigTarget: "aarch64-linux-musl" },
  "linux-x86_64-cpu": { arch: "x86_64", zigTarget: "x86_64-linux-musl" },
  "linux-riscv64-cpu": { arch: "riscv64", zigTarget: "riscv64-linux-musl" },
});

function resolveTarget() {
  const raw = process.env.WHISPER_TARGET?.trim();
  if (!raw || raw === "host") return null;
  const entry = CROSS_TARGETS[raw];
  if (!entry) {
    fail(
      `unknown WHISPER_TARGET=${raw}. Supported: host, ${Object.keys(
        CROSS_TARGETS,
      ).join(", ")}`,
    );
  }
  return { name: raw, ...entry };
}

function detectBackend(target) {
  // Cross-targets are CPU-only — no Metal/CUDA/Vulkan toolchain wraps through
  // zig cc, and the on-device path (Android / riscv64 phone / etc.) wants a
  // CPU build anyway. Forcing cpu here keeps WHISPER_BACKEND from accidentally
  // selecting a host-only backend for an on-device build.
  if (target) return "cpu";
  const explicit = process.env.WHISPER_BACKEND?.toLowerCase();
  if (
    explicit === "metal" ||
    explicit === "cuda" ||
    explicit === "vulkan" ||
    explicit === "cpu"
  ) {
    return explicit;
  }
  if (process.platform === "darwin") return "metal";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    if (existsSync(path.join(dir, "nvcc"))) return "cuda";
  }
  return "cpu";
}

function platformFlags(backend) {
  // whisper.cpp exposes the same GGML_* CMake variables as llama.cpp /
  // omnivoice.cpp (it uses the same ggml submodule). Mirror build-omnivoice.mjs.
  switch (backend) {
    case "metal":
      return ["-DGGML_METAL=ON", "-DGGML_BLAS=OFF", "-DWHISPER_METAL=ON"];
    case "cuda":
      // Pin a buildable CUDA arch unless the caller overrides it. Without this,
      // ggml auto-detects the host GPU's compute capability — on a Blackwell
      // card (sm_120) with an older CUDA toolkit (nvcc < 12.8) that yields
      // `nvcc fatal: Unsupported gpu architecture 'compute_120'` and breaks the
      // whole build. sm_89 SASS + PTX JITs forward onto newer GPUs at runtime.
      return [
        "-DGGML_CUDA=ON",
        "-DGGML_NATIVE=ON",
        `-DCMAKE_CUDA_ARCHITECTURES=${process.env.CMAKE_CUDA_ARCHITECTURES || process.env.CUDAARCHS || "89"}`,
      ];
    case "vulkan":
      return ["-DGGML_VULKAN=ON"];
    case "cpu":
    default:
      return ["-DGGML_NATIVE=ON"];
  }
}

function resolveSourceDir() {
  // 1. explicit override.
  const cliOrEnv = CLI_SRC_DIR ?? process.env.WHISPER_SRC_DIR?.trim();
  if (cliOrEnv) {
    if (!existsSync(path.join(cliOrEnv, "CMakeLists.txt"))) {
      fail(
        `WHISPER_SRC_DIR=${cliOrEnv} does not contain a CMakeLists.txt — point it at a whisper.cpp checkout root.`,
      );
    }
    return cliOrEnv;
  }
  // 2. in-tree submodule.
  const submodule = path.join(NATIVE_DIR, "whisper.cpp");
  if (existsSync(path.join(submodule, "CMakeLists.txt"))) {
    return submodule;
  }
  // 3. fallback clone under ~/.cache/eliza-whisper-cpp/whisper.cpp.
  const cacheRoot = path.join(os.homedir(), ".cache", "eliza-whisper-cpp");
  const cacheDir = path.join(cacheRoot, "whisper.cpp");
  if (existsSync(path.join(cacheDir, "CMakeLists.txt"))) {
    return cacheDir;
  }
  if (DRY_RUN) {
    log(
      `[dry-run] would clone ${WHISPER_REMOTE} @ ${WHISPER_DEFAULT_TAG} into ${cacheDir}`,
    );
    return cacheDir;
  }
  mkdirSync(cacheRoot, { recursive: true });
  log(`cloning ${WHISPER_REMOTE} @ ${WHISPER_DEFAULT_TAG} into ${cacheDir}`);
  const res = spawnSync(
    "git",
    [
      "clone",
      "--depth",
      "1",
      "--branch",
      WHISPER_DEFAULT_TAG,
      WHISPER_REMOTE,
      cacheDir,
    ],
    { stdio: "inherit" },
  );
  if (res.status !== 0) {
    fail(
      `clone of ${WHISPER_REMOTE} failed (offline or network blocked). Either provide WHISPER_SRC_DIR=<path> or run \`git submodule update --init plugins/plugin-local-inference/native/whisper.cpp\` once.`,
    );
  }
  return cacheDir;
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
 * Same pattern as `ensureZigDrivers()` in build-omnivoice.mjs and the
 * Wave-1 precedent in compile-libllama.mjs — wraps `zig cc/c++ --target=<triple>`
 * into a single binary CMake can probe. riscv64 needs the `-march=` /
 * `-mabi=` filter on Zig 0.13 (whisper.cpp pulls the same ggml-cpu CMakeLists
 * as omnivoice.cpp); ZIG_RISCV64_MARCH_PASSTHROUGH=1 disables the filter on
 * Zig 0.14+ where the GCC-style ISA string is accepted.
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

function crossConfigureArgs(target, srcDir, buildPath, drivers) {
  const riscv64ScalarDefaults =
    target.arch === "riscv64"
      ? [
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
    ADAPTER_DIR,
    "-B",
    buildPath,
    `-DWHISPER_CPP_SRC_DIR=${srcDir}`,
    "-DWHISPER_ELIZA_ADAPTER_USE_SUBDIR=ON",
    "-DBUILD_SHARED_LIBS=ON",
    "-DWHISPER_BUILD_EXAMPLES=ON",
    "-DWHISPER_BUILD_SERVER=OFF",
    "-DWHISPER_BUILD_TESTS=OFF",
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
  const target = resolveTarget();
  const srcDir = resolveSourceDir();
  const buildDir =
    process.env.WHISPER_BUILD_DIR ??
    (target ? `build-whisper-${target.name}` : "build-whisper");
  const buildPath = path.isAbsolute(buildDir)
    ? buildDir
    : path.join(NATIVE_DIR, buildDir);
  const backend = detectBackend(target);
  const jobs = process.env.WHISPER_JOBS ?? String(os.cpus().length);

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
    configureArgs = crossConfigureArgs(target, srcDir, buildPath, drivers);
  } else {
    configureArgs = [
      "-S",
      ADAPTER_DIR,
      "-B",
      buildPath,
      `-DWHISPER_CPP_SRC_DIR=${srcDir}`,
      "-DWHISPER_ELIZA_ADAPTER_USE_SUBDIR=ON",
      "-DBUILD_SHARED_LIBS=ON",
      "-DWHISPER_BUILD_EXAMPLES=ON",
      "-DWHISPER_BUILD_SERVER=OFF",
      "-DWHISPER_BUILD_TESTS=OFF",
      "-DCMAKE_BUILD_TYPE=Release",
      ...platformFlags(backend),
    ];
  }
  // `whisper` is the shared-library target; `whisper-cli` is the CLI
  // example; `whisper_eliza_adapter` is the FFI-facing thin C ABI sitting
  // between bun:ffi and libwhisper. All three are built in one cmake run.
  const buildArgs = [
    "--build",
    buildPath,
    ...(process.platform === "win32" ? ["--config", "Release"] : []),
    "--target",
    "whisper",
    "--target",
    "whisper-cli",
    "--target",
    "whisper_eliza_adapter",
    "-j",
    jobs,
  ];

  log(`whisper.cpp source at ${srcDir}`);
  log(`target: ${target?.name ?? "host"}`);
  log(`backend: ${backend}`);
  log(`build dir: ${buildPath}`);
  log(`jobs: ${jobs}`);

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

  // whisper.cpp lands under whisper-cpp-build/ (the add_subdirectory binary dir
  // name used by the adapter CMakeLists). Probe a few generator-dependent
  // locations for both the upstream lib and the adapter we link on top.
  const subBuild = path.join(buildPath, "whisper-cpp-build");
  const libCandidates = target
    ? [
        path.join(subBuild, "src", "libwhisper.so"),
        path.join(subBuild, "libwhisper.so"),
      ]
    : process.platform === "darwin"
      ? [
          path.join(subBuild, "src", "libwhisper.dylib"),
          path.join(subBuild, "libwhisper.dylib"),
        ]
      : process.platform === "win32"
        ? [
            // CMake on Windows routes shared library outputs (whisper.dll,
            // ggml.dll etc.) to RUNTIME_OUTPUT_DIRECTORY = <buildPath>/bin/
            // and into a <config>/ subdir under MSBuild. Search those first,
            // then fall back to the layout the Linux/macOS branches expect.
            // Observed in CI: "whisper.vcxproj -> ...build-whisper/bin/Debug/whisper.dll".
            path.join(buildPath, "bin", "Release", "whisper.dll"),
            path.join(buildPath, "bin", "Debug", "whisper.dll"),
            path.join(buildPath, "bin", "whisper.dll"),
            path.join(subBuild, "src", "Release", "whisper.dll"),
            path.join(subBuild, "src", "Debug", "whisper.dll"),
            path.join(subBuild, "src", "whisper.dll"),
            path.join(subBuild, "Release", "whisper.dll"),
            path.join(subBuild, "Debug", "whisper.dll"),
            path.join(subBuild, "whisper.dll"),
          ]
        : [
            path.join(subBuild, "src", "libwhisper.so"),
            path.join(subBuild, "libwhisper.so"),
          ];
  const libOut = libCandidates.find((p) => existsSync(p));
  if (!libOut) {
    fail(
      `build completed but no libwhisper.{so,dylib,dll} found. Searched: ${libCandidates.join(", ")}`,
    );
  }
  log(`built ${libOut}`);

  const adapterCandidates = target
    ? [
        path.join(buildPath, "libwhisper_eliza_adapter.so"),
      ]
    : process.platform === "darwin"
      ? [path.join(buildPath, "libwhisper_eliza_adapter.dylib")]
      : process.platform === "win32"
        ? [
            path.join(buildPath, "Release", "whisper_eliza_adapter.dll"),
            path.join(buildPath, "Debug", "whisper_eliza_adapter.dll"),
            path.join(buildPath, "whisper_eliza_adapter.dll"),
          ]
        : [path.join(buildPath, "libwhisper_eliza_adapter.so")];
  const adapterOut = adapterCandidates.find((p) => existsSync(p));
  if (!adapterOut) {
    fail(
      `build completed but no libwhisper_eliza_adapter.{so,dylib,dll} found. Searched: ${adapterCandidates.join(", ")}`,
    );
  }
  log(`built ${adapterOut}`);

  const cliCandidates =
    process.platform === "win32"
      ? [
          path.join(buildPath, "bin", "Release", "whisper-cli.exe"),
          path.join(buildPath, "bin", "Debug", "whisper-cli.exe"),
          path.join(buildPath, "bin", "whisper-cli.exe"),
          path.join(subBuild, "bin", "Release", "whisper-cli.exe"),
          path.join(subBuild, "bin", "Debug", "whisper-cli.exe"),
          path.join(subBuild, "bin", "whisper-cli.exe"),
          path.join(subBuild, "Release", "whisper-cli.exe"),
          path.join(subBuild, "Debug", "whisper-cli.exe"),
          path.join(subBuild, "whisper-cli.exe"),
        ]
      : [
          path.join(buildPath, "bin", "whisper-cli"),
          path.join(subBuild, "bin", "whisper-cli"),
          path.join(subBuild, "whisper-cli"),
        ];
  const cliOut = cliCandidates.find((p) => existsSync(p));
  if (cliOut) {
    log(`built ${cliOut}`);
  } else {
    log(
      `warning: whisper-cli not found — the FFI path still works, but legacy subprocess callers will fail`,
    );
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
