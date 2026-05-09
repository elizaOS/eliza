#!/usr/bin/env node
/**
 * Build the DFlash-capable llama-server fork used by local inference.
 *
 * Upstream ggml-org/llama.cpp does not yet ship DFlash. This script builds
 * spiritbuun/buun-llama-cpp into:
 *   $ELIZA_STATE_DIR/local-inference/bin/dflash/<platform>-<arch>-<backend>/
 *
 * Backend selection:
 *   macOS           -> Metal
 *   Linux + nvcc    -> CUDA
 *   Linux + rocminfo/hipcc -> ROCm/HIP
 *   otherwise       -> CPU
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const REMOTE =
  process.env.ELIZA_DFLASH_LLAMA_CPP_REMOTE ||
  "https://github.com/spiritbuun/buun-llama-cpp.git";
const REF = process.env.ELIZA_DFLASH_LLAMA_CPP_REF || "master";
const MIN_COMMIT = "b9d01582b";

function stateDir() {
  return process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza");
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
    throw new Error(`${cmd} ${args.join(" ")} failed with ${result.status}${detail}`);
  }
  return result.stdout?.trim() ?? "";
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

function cmakeFlagsForBackend(backend) {
  const flags = ["-DGGML_NATIVE=ON", "-DLLAMA_BUILD_TESTS=OFF"];
  if (backend === "metal") {
    flags.push("-DGGML_METAL=ON");
  } else if (backend === "cuda") {
    flags.push(
      "-DGGML_CUDA=ON",
      "-DGGML_CUDA_FA=ON",
      "-DGGML_CUDA_FA_ALL_QUANTS=ON",
    );
  } else if (backend === "rocm" || backend === "hip") {
    flags.push("-DGGML_HIP=ON");
  }
  const extra = process.env.ELIZA_DFLASH_CMAKE_FLAGS?.trim();
  if (extra) flags.push(...extra.split(/\s+/).filter(Boolean));
  return flags;
}

function parseArgs(argv) {
  const backend = detectBackend();
  const platformKey = `${process.platform}-${process.arch}-${backend}`;
  const root = path.join(stateDir(), "local-inference");
  const args = {
    cacheDir: path.join(os.homedir(), ".cache", "eliza-dflash", "buun-llama-cpp"),
    outDir: path.join(root, "bin", "dflash", platformKey),
    backend,
    ref: REF,
    jobs: Math.max(1, Math.min(os.cpus().length, 16)),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === "--cache-dir") args.cacheDir = path.resolve(next());
    else if (arg === "--out-dir") args.outDir = path.resolve(next());
    else if (arg === "--backend") args.backend = next();
    else if (arg === "--ref") args.ref = next();
    else if (arg === "--jobs" || arg === "-j") args.jobs = Number.parseInt(next(), 10);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node packages/app-core/scripts/build-llama-cpp-dflash.mjs [--backend cuda|metal|rocm|cpu] [--ref <git-ref>] [--out-dir <path>] [--jobs N]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function ensureCheckout(cacheDir, ref) {
  if (fs.existsSync(path.join(cacheDir, ".git"))) {
    run("git", ["fetch", "--depth=1", "origin", ref], { cwd: cacheDir });
  } else {
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    run("git", ["clone", "--depth=1", "--branch", ref, REMOTE, cacheDir]);
  }
  run("git", ["checkout", "FETCH_HEAD"], { cwd: cacheDir });
  const head = run("git", ["rev-parse", "HEAD"], { cwd: cacheDir, capture: true });
  console.log(`[dflash-build] checkout ${head}`);
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", MIN_COMMIT, "HEAD"], {
    cwd: cacheDir,
    stdio: "ignore",
  });
  if (ancestor.status !== 0) {
    console.warn(
      `[dflash-build] warning: HEAD does not contain minimum known-good DFlash/SWA commit ${MIN_COMMIT}`,
    );
  }
}

function build(args) {
  if (!has("git")) throw new Error("git is required");
  if (!has("cmake")) throw new Error("cmake is required");

  ensureCheckout(args.cacheDir, args.ref);
  const buildDir = path.join(args.cacheDir, "build", args.backend);
  fs.mkdirSync(buildDir, { recursive: true });
  run("cmake", ["-B", buildDir, ...cmakeFlagsForBackend(args.backend)], {
    cwd: args.cacheDir,
  });
  run(
    "cmake",
    ["--build", buildDir, "--target", "llama-server", "llama-cli", "llama-speculative-simple", "-j", String(args.jobs)],
    { cwd: args.cacheDir },
  );

  const binDir = path.join(buildDir, "bin");
  fs.mkdirSync(args.outDir, { recursive: true });
  for (const name of ["llama-server", "llama-cli", "llama-speculative-simple"]) {
    const src = path.join(binDir, name);
    const dst = path.join(args.outDir, name);
    if (!fs.existsSync(src)) throw new Error(`missing built binary: ${src}`);
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
  }
  console.log(`[dflash-build] installed ${args.backend} binaries to ${args.outDir}`);
  console.log(`[dflash-build] set ELIZA_DFLASH_ENABLED=1 to force this backend, or leave it unset for auto-detect from the managed path.`);
}

try {
  build(parseArgs(process.argv.slice(2)));
} catch (err) {
  console.error(`[dflash-build] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
