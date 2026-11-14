#!/usr/bin/env node
// Build + stage the desktop generic-GGUF runtime (#8808 C3).
//
//   node build.mjs
//
// 1. Builds the vendored llama.cpp as a shared lib (Metal on macOS).
// 2. Compiles shim.cpp (the thin C ABI bun:ffi binds) linking libllama.
// 3. Stages libllama + ggml + the shim into
//    <stateDir>/local-inference/lib/generic-llama/ with @loader_path rpaths so
//    the runtime resolves one self-contained directory.
//
// Idempotent: skips the llama.cpp build when build/bin/libllama* already exists.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LLAMA = path.join(HERE, "..", "llama.cpp");
const BUILD = path.join(LLAMA, "build");
const BIN = path.join(BUILD, "bin");

const stateDir =
  process.env.ELIZA_STATE_DIR ||
  process.env.ELIZA_STATE_DIR ||
  path.join(homedir(), ".local", "state", "eliza");
const STAGE = path.join(stateDir, "local-inference", "lib", "generic-llama");

function sh(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function hasLib(dir, prefix) {
  return (
    existsSync(dir) &&
    readdirSync(dir).some(
      (f) => f.startsWith(prefix) && f.endsWith(".dylib"),
    )
  );
}

// 1. llama.cpp shared build (skip if already built).
if (!hasLib(BIN, "libllama")) {
  const isMac = platform() === "darwin";
  sh("cmake", [
    "-B",
    BUILD,
    "-DBUILD_SHARED_LIBS=ON",
    isMac ? "-DGGML_METAL=ON" : "-DGGML_METAL=OFF",
    "-DLLAMA_CURL=OFF",
    "-DLLAMA_BUILD_TESTS=OFF",
    "-DLLAMA_BUILD_EXAMPLES=OFF",
    "-DLLAMA_BUILD_SERVER=OFF",
    "-DCMAKE_BUILD_TYPE=Release",
  ], LLAMA);
  sh("cmake", ["--build", BUILD, "--config", "Release", "-j", "8", "--target", "llama"], LLAMA);
}

// 2. Stage libllama + ggml into one directory.
mkdirSync(STAGE, { recursive: true });
for (const f of readdirSync(BIN)) {
  if (
    (f.startsWith("libllama") || f.startsWith("libggml")) &&
    f.endsWith(".dylib")
  ) {
    copyFileSync(path.join(BIN, f), path.join(STAGE, f));
  }
}

// 3. Compile the shim linking the staged libllama, rpath @loader_path so it
//    resolves its sibling dylibs from the stage dir at load time.
const shimOut = path.join(STAGE, "libeglshim.dylib");
sh("clang++", [
  "-std=c++17",
  "-O2",
  "-shared",
  "-fPIC",
  "-o",
  shimOut,
  path.join(HERE, "shim.cpp"),
  "-I",
  path.join(LLAMA, "include"),
  "-I",
  path.join(LLAMA, "ggml", "include"),
  "-L",
  STAGE,
  "-lllama",
  "-Wl,-rpath,@loader_path",
]);

console.log(`[eliza-generic-llama] staged → ${shimOut}`);
