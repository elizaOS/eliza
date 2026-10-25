#!/usr/bin/env node
// Build the self-contained ggml YOLOv8 native library (libyolo.<ext>).
//
//   bun native/yolo.cpp/build.mjs           # configure + build (Release)
//
// Produces  native/yolo.cpp/build/libyolo.{dll,dylib,so}  — the exact path the
// FFI loader (src/native/yolo-ffi.ts) probes. ggml is linked statically, so the
// artifact has no external ggml.dll/.so dependency.
//
// Requirements: CMake >= 3.20 and a C/C++ toolchain.
//   - Windows: Visual Studio 2022 Build Tools (MSVC).
//   - macOS:   Xcode command line tools (clang). Pass --metal for the GPU path.
//   - Linux:   gcc/clang. Ninja is used when available.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, "build");
const isWin = process.platform === "win32";
const args = process.argv.slice(2);
const withMetal = args.includes("--metal");
const withCuda = args.includes("--cuda");

function run(cmd, cmdArgs) {
  console.error(`> ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n[yolo build] FAILED: ${cmd} exited ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

function hasNinja() {
  const r = spawnSync("ninja", ["--version"], { stdio: "ignore" });
  return r.status === 0;
}

const configure = [
  "-S",
  HERE,
  "-B",
  BUILD,
  "-Wno-dev",
  "-DGGML_NATIVE=OFF",
  "-DGGML_OPENMP=OFF",
];
if (withMetal) configure.push("-DYOLO_WITH_METAL=ON");
if (withCuda) configure.push("-DYOLO_WITH_CUDA=ON", "-DGGML_CUDA=ON");

if (isWin) {
  configure.push("-G", "Visual Studio 17 2022", "-A", "x64");
} else {
  configure.push("-DCMAKE_BUILD_TYPE=Release");
  if (hasNinja()) configure.push("-G", "Ninja");
}

run("cmake", configure);
run("cmake", ["--build", BUILD, "--config", "Release", "--target", "yolo"]);

const ext = isWin ? "dll" : process.platform === "darwin" ? "dylib" : "so";
const artifact = join(BUILD, `libyolo.${ext}`);
if (!existsSync(artifact)) {
  // Some generators ignore the per-config output dir override; locate it.
  const found = readdirSync(BUILD, { recursive: true }).find((f) =>
    String(f).endsWith(`libyolo.${ext}`),
  );
  console.error(
    found
      ? `[yolo build] artifact at ${join(BUILD, String(found))} (expected ${artifact})`
      : `[yolo build] WARNING: libyolo.${ext} not found under ${BUILD}`,
  );
} else {
  console.error(`[yolo build] OK: ${artifact}`);
}
