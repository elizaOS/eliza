#!/usr/bin/env node
// stage-elizavoice-lib.mjs
//
// Phase 3a: cross-build the fused fork voice library
// (`libelizainference.so` — the omnivoice `elizainference` target with VAD,
// wake-word, speaker, and diarizer fused at ABI v7) for Android arm64-v8a
// with the NDK (BIONIC, not musl/zig), and stage the stripped .so into the
// app's jniLibs so the externalNativeBuild JNI shim (libelizavoicejni.so) can
// link it and the APK packages it.
//
// The build statically links ggml/llama/mtmd into libelizainference.so so the
// resulting .so has NO external NEEDED deps beyond bionic libc/libm/libdl —
// zero SONAME collision with the existing musl jniLibs (libeliza_bun.so etc).
//
// Usage:
//   node packages/app-core/scripts/stage-elizavoice-lib.mjs [--abi arm64-v8a]
//
// Env:
//   ANDROID_HOME / ANDROID_SDK_ROOT  Android SDK root (NDK under ndk/<version>)
//   ELIZA_NDK_VERSION                NDK version dir (default: highest installed)
//
// Output:
//   packages/app-core/platforms/android/app/src/main/jniLibs/<abi>/libelizainference.so

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> app-core -> packages -> eliza repo root
const repoRoot = path.resolve(__dirname, "../../..");

function log(msg) {
  process.stdout.write(`[stage-elizavoice-lib] ${msg}\n`);
}

function die(msg) {
  process.stderr.write(`[stage-elizavoice-lib] ERROR: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { abi: "arm64-v8a" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--abi") out.abi = argv[++i];
  }
  return out;
}

const ABI_TO_PLATFORM = {
  "arm64-v8a": "android-23",
};

function resolveSdk() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk || !existsSync(sdk)) {
    die("ANDROID_HOME / ANDROID_SDK_ROOT not set or missing");
  }
  return sdk;
}

function resolveNdk(sdk) {
  if (process.env.ELIZA_NDK_VERSION) {
    const p = path.join(sdk, "ndk", process.env.ELIZA_NDK_VERSION);
    if (!existsSync(p)) die(`ELIZA_NDK_VERSION ${process.env.ELIZA_NDK_VERSION} not found under ${path.join(sdk, "ndk")}`);
    return p;
  }
  const ndkRoot = path.join(sdk, "ndk");
  if (!existsSync(ndkRoot)) die(`No NDK under ${ndkRoot}`);
  const versions = readdirSync(ndkRoot)
    .filter((d) => statSync(path.join(ndkRoot, d)).isDirectory())
    .sort();
  if (versions.length === 0) die(`No NDK versions under ${ndkRoot}`);
  return path.join(ndkRoot, versions[versions.length - 1]);
}

function ndkTool(ndk, name) {
  const prebuilt = path.join(ndk, "toolchains", "llvm", "prebuilt");
  const hosts = readdirSync(prebuilt);
  for (const host of hosts) {
    const bin = path.join(prebuilt, host, "bin", name);
    if (existsSync(bin)) return bin;
  }
  die(`NDK tool ${name} not found under ${prebuilt}`);
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

const { abi } = parseArgs(process.argv.slice(2));
const platform = ABI_TO_PLATFORM[abi];
if (!platform) die(`unsupported abi ${abi} (Phase 3a: arm64-v8a only)`);

const sdk = resolveSdk();
const ndk = resolveNdk(sdk);
const toolchain = path.join(ndk, "build", "cmake", "android.toolchain.cmake");
if (!existsSync(toolchain)) die(`NDK cmake toolchain missing: ${toolchain}`);
log(`NDK: ${ndk}`);

const forkSrc = path.join(
  repoRoot,
  "plugins/plugin-local-inference/native/llama.cpp",
);
if (!existsSync(path.join(forkSrc, "tools/omnivoice/CMakeLists.txt"))) {
  die(`fork omnivoice CMakeLists missing under ${forkSrc} — run git submodule update --init --recursive`);
}

const buildDir = path.join(repoRoot, ".cache", "elizavoice-android", abi);
mkdirSync(buildDir, { recursive: true });

// Configure: static-link ggml/llama/mtmd into the SHARED elizainference .so.
// LLAMA_BUILD_TOOLS=OFF + LLAMA_BUILD_MTMD=ON ensures the mtmd target exists
// before tools/omnivoice configures (the fork's top-level CMakeLists orders
// the mtmd embed hook before omnivoice so `if(TARGET mtmd)` is satisfied).
run("cmake", [
  "-S", forkSrc,
  "-B", buildDir,
  "-G", "Ninja",
  `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
  `-DANDROID_ABI=${abi}`,
  `-DANDROID_PLATFORM=${platform}`,
  "-DCMAKE_BUILD_TYPE=Release",
  "-DBUILD_SHARED_LIBS=OFF",
  "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
  "-DGGML_NATIVE=OFF",
  "-DGGML_OPENMP=OFF",
  "-DLLAMA_BUILD_OMNIVOICE=ON",
  "-DLLAMA_BUILD_MTMD=ON",
  "-DLLAMA_BUILD_COMMON=ON",
  "-DLLAMA_BUILD_TOOLS=OFF",
  "-DLLAMA_BUILD_EXAMPLES=OFF",
  "-DLLAMA_BUILD_TESTS=OFF",
  "-DLLAMA_BUILD_SERVER=OFF",
  "-DLLAMA_CURL=OFF",
]);

let jobs = 4;
try {
  jobs = parseInt(execFileSync("nproc", { encoding: "utf8" }).trim(), 10) || 4;
} catch {
  jobs = 4;
}
run("cmake", ["--build", buildDir, "--target", "elizainference", "-j", String(jobs)]);

const builtSo = path.join(buildDir, "bin", "libelizainference.so");
if (!existsSync(builtSo)) die(`build did not produce ${builtSo}`);

// Strip + stage.
const strip = ndkTool(ndk, "llvm-strip");
const jniDir = path.join(
  repoRoot,
  "packages/app-core/platforms/android/app/src/main/jniLibs",
  abi,
);
mkdirSync(jniDir, { recursive: true });
const staged = path.join(jniDir, "libelizainference.so");
run(strip, ["--strip-unneeded", builtSo, "-o", staged]);

// Verify the staged .so is bionic arm64 + exports the FFI symbols.
const readelf = ndkTool(ndk, "llvm-readelf");
const dyn = execFileSync(readelf, ["--dyn-syms", staged], { encoding: "utf8" });
const symCount = (dyn.match(/eliza_inference_/g) || []).length;
const needed = execFileSync(readelf, ["-d", staged], { encoding: "utf8" })
  .split("\n")
  .filter((l) => l.includes("NEEDED"))
  .map((l) => (l.match(/\[([^\]]+)\]/) || [])[1])
  .filter(Boolean);
const muslNeeded = needed.filter((n) => /musl/i.test(n));
if (symCount === 0) die("staged .so exports no eliza_inference_* symbols");
if (muslNeeded.length > 0) die(`staged .so has musl NEEDED deps: ${muslNeeded.join(", ")}`);

log(`staged ${staged}`);
log(`  eliza_inference_* exported symbols: ${symCount}`);
log(`  NEEDED (bionic): ${needed.join(", ")}`);
log("done");
