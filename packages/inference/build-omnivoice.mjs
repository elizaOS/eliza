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
 *   node packages/inference/build-omnivoice.mjs            # build
 *   node packages/inference/build-omnivoice.mjs --dry-run  # plan only
 *   node packages/inference/build-omnivoice.mjs --clean    # wipe build/
 *
 * Env knobs:
 *   OMNIVOICE_BACKEND     auto (default) | metal | cuda | vulkan | cpu
 *   OMNIVOICE_BUILD_DIR   override build directory (default: build)
 *   OMNIVOICE_JOBS        parallel jobs (default: os.cpus().length)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

function detectBackend() {
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

function expectedLibName() {
  if (process.platform === "darwin") return "libomnivoice.dylib";
  if (process.platform === "win32") return "omnivoice.dll";
  return "libomnivoice.so";
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? process.cwd(),
      stdio: "inherit",
      env: process.env,
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

async function main() {
  if (!existsSync(OMNIVOICE_DIR)) {
    fail(`omnivoice.cpp directory missing: ${OMNIVOICE_DIR}`);
  }
  if (!existsSync(path.join(OMNIVOICE_DIR, "CMakeLists.txt"))) {
    fail(`CMakeLists.txt not found in ${OMNIVOICE_DIR}`);
  }

  const buildDir = process.env.OMNIVOICE_BUILD_DIR ?? "build";
  const buildPath = path.join(OMNIVOICE_DIR, buildDir);
  const backend = detectBackend();
  const jobs = process.env.OMNIVOICE_JOBS ?? String(os.cpus().length);

  const configureArgs = [
    "-S",
    OMNIVOICE_DIR,
    "-B",
    buildPath,
    "-DOMNIVOICE_SHARED=ON",
    "-DCMAKE_BUILD_TYPE=Release",
    ...platformFlags(backend),
  ];
  const buildArgs = ["--build", buildPath, "--target", "omnivoice", "-j", jobs];

  log(`omnivoice.cpp at ${OMNIVOICE_DIR}`);
  log(`backend: ${backend}`);
  log(`build dir: ${buildPath}`);
  log(`jobs: ${jobs}`);
  log(`expected output: ${path.join(buildPath, expectedLibName())}`);

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

  const out = path.join(buildPath, expectedLibName());
  if (!existsSync(out)) {
    fail(`build completed but ${out} is missing`);
  }
  log(`built ${out}`);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
