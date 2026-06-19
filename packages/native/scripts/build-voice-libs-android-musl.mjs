#!/usr/bin/env bun
/**
 * Cross-compile the Android arm64 voice native libs (`libsilero_vad.so`,
 * `libvoice_classifier.so`) as **musl**-linked shared objects, using
 * `zig cc --target=aarch64-linux-musl`.
 *
 * Why musl, not the Android NDK (this is the load-bearing reason):
 *   The on-device Eliza agent is a **bun** process that runs through the
 *   bundled Alpine **musl** loader (`ld-musl-aarch64.so.1`) — see
 *   `packages/app-core/scripts/aosp/compile-libllama.mjs`. When bun's `dlopen`
 *   (bun:ffi) loads a `.so`, it resolves symbols against **musl** libc, NOT
 *   bionic. The Android NDK toolchain emits a startup-CRT reference to
 *   `__register_atfork@LIBC` (a bionic-only symbol). musl libc does not export
 *   it, so an NDK-built voice `.so` fails to load in the agent with:
 *     "Error relocating libsilero_vad.so: __register_atfork: symbol not found".
 *   A musl-linked build (these libs are pure scalar C, NEEDED=libc.so only)
 *   has no such reference and loads cleanly under the bun musl loader. This is
 *   the same constraint that already forces libllama.so to be a musl build.
 *
 * Output: `<plugin>/build-android-arm64-musl/lib<name>.so`. Stage these into
 * `packages/app-core/platforms/android/app/src/main/jniLibs/arm64-v8a/` (the
 * APK extracts them into the app nativeLibraryDir, which ElizaAgentService
 * exports as $ELIZA_SILERO_VAD_LIB / $ELIZA_VOICE_CLASSIFIER_LIB). The .so
 * binaries stay untracked build artifacts.
 *
 * Requires: `zig` (>= 0.13.0) on PATH. No Android NDK needed.
 *
 * Usage: bun packages/native/scripts/build-voice-libs-android-musl.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const TARGET = "aarch64-linux-musl";
const NATIVE_ROOT = path.resolve(import.meta.dir, "..");

/** Each voice native lib: pure-C sources under `src/`, public headers under `include/`. */
const LIBS = [
  { plugin: "silero-vad-cpp", soname: "libsilero_vad.so" },
  { plugin: "voice-classifier-cpp", soname: "libvoice_classifier.so" },
];

function zigVersion() {
  try {
    return execFileSync("zig", ["version"], { encoding: "utf8" }).trim();
  } catch {
    console.error(
      "[build-voice-libs-musl] FATAL: `zig` not found on PATH. Install zig >= 0.13.0.",
    );
    process.exit(1);
  }
}

function buildLib(plugin, soname) {
  const pluginDir = path.join(NATIVE_ROOT, "plugins", plugin);
  const srcDir = path.join(pluginDir, "src");
  const includeDir = path.join(pluginDir, "include");
  if (!existsSync(srcDir)) {
    throw new Error(`[build-voice-libs-musl] no src/ under ${pluginDir}`);
  }
  const sources = readdirSync(srcDir)
    .filter((f) => f.endsWith(".c"))
    .map((f) => path.join(srcDir, f));
  if (sources.length === 0) {
    throw new Error(`[build-voice-libs-musl] no .c sources in ${srcDir}`);
  }
  const outDir = path.join(pluginDir, "build-android-arm64-musl");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, soname);

  const args = [
    "cc",
    `--target=${TARGET}`,
    "-shared",
    "-fPIC",
    "-O2",
    "-std=c11",
    `-I${includeDir}`,
    `-I${srcDir}`,
    `-Wl,-soname,${soname}`,
    ...sources,
    "-lm",
    "-o",
    outPath,
  ];
  console.log(
    `[build-voice-libs-musl] ${plugin}: zig ${args.slice(0, 6).join(" ")} … (${sources.length} sources) → ${outPath}`,
  );
  execFileSync("zig", args, { stdio: "inherit" });
  return outPath;
}

console.log(`[build-voice-libs-musl] zig ${zigVersion()} → target ${TARGET}`);
for (const { plugin, soname } of LIBS) {
  const out = buildLib(plugin, soname);
  console.log(`[build-voice-libs-musl] built ${out}`);
}
console.log(
  "[build-voice-libs-musl] done. Stage the .so into " +
    "packages/app-core/platforms/android/app/src/main/jniLibs/arm64-v8a/ and rebuild the APK.",
);
