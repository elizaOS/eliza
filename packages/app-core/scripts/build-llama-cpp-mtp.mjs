#!/usr/bin/env node
/**
 * build-llama-cpp-mtp.mjs — per-target static llama.cpp slice builder.
 *
 * Compiles the in-repo elizaOS/llama.cpp fork (TurboQuant + QJL + PolarQuant +
 * MTP + the eliza Metal kernels) into the per-platform *static* archives that
 * `ios-xcframework/build-xcframework.mjs` packages into the
 * `LlamaCpp.xcframework` consumed by `llama-cpp-capacitor`.
 *
 * Output layout (consumed by build-xcframework.mjs loadSlice()):
 *
 *   $ELIZA_STATE_DIR/local-inference/bin/mtp/<target>/
 *     libllama.a, libggml.a, libggml-base.a, libggml-cpu.a, libggml-metal.a, …
 *     include/llama.h, ggml.h, ggml-*.h
 *     CAPABILITIES.json
 *
 * The runtime ABI bridge symbols (`llama_init_context`, `eliza_inference_*`)
 * are NOT produced here — they are compiled per-slice from
 * `ios-xcframework/runtime-symbol-shim.c` by the xcframework assembler. This
 * builder produces the kernel-bearing GGML/llama static archives only.
 *
 * AGENTS.md §3 (plugins/plugin-local-inference/native/AGENTS.md): the produced
 * archives MUST carry every required Eliza-1 kernel
 * (TurboQuant turbo3/turbo4, QJL, PolarQuant, MTP). A missing kernel symbol is
 * a hard build error — no CAPABILITIES.json is written, so the consuming
 * `ensureMtpIosTarget()` / build-xcframework.mjs both fail closed. There is no
 * fallback to a stock (kernel-less) framework.
 *
 * Usage:
 *   node build-llama-cpp-mtp.mjs --target ios-arm64-metal
 *   node build-llama-cpp-mtp.mjs --target ios-arm64-simulator-metal
 *   node build-llama-cpp-mtp.mjs --list
 *
 * Env overrides:
 *   ELIZA_STATE_DIR                 install root (default ~/.eliza) — MUST match
 *                                   run-mobile-build.mjs mtpTargetOutDir()
 *   ELIZA_MTP_LLAMA_CPP_SRC         override fork source tree
 *   ELIZA_IOS_DEPLOYMENT_TARGET     iOS min version (default 16.0)
 *   ELIZA_MTP_FORCE_REBUILD=1       ignore a cached slice and rebuild
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/app-core/scripts → repo root
const repoRoot = path.resolve(here, "..", "..", "..");

// ── State dir — MUST mirror run-mobile-build.mjs elizaStateDirForBuild() and
//    ios-xcframework/build-xcframework.mjs elizaStateDir() EXACTLY, otherwise
//    the slice lands where nothing looks for it.
const STATE_DIR =
  process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza");

const DEPLOYMENT_TARGET =
  process.env.ELIZA_IOS_DEPLOYMENT_TARGET?.trim() || "16.0";

// ── Fork source. The canonical fork is the in-repo submodule; the vendored
//    ios-deps tree is the historical fallback. Both carry the eliza kernels.
const FORK_SRC_CANDIDATES = [
  process.env.ELIZA_MTP_LLAMA_CPP_SRC?.trim(),
  path.join(repoRoot, "plugins", "plugin-local-inference", "native", "llama.cpp"),
  path.join(repoRoot, "packages", "native", "ios-deps", "llama.cpp", "src"),
].filter(Boolean);

const SUPPORTED_TARGETS = [
  "ios-arm64-metal",
  "ios-arm64-simulator-metal",
  "ios-arm64-metal-fused",
  "ios-arm64-simulator-metal-fused",
];

/** Per-target recipe. The iOS device + simulator slices differ only by SDK.
 *  The `-fused` variants additionally build the OmniVoice TTS + Qwen3-ASR FFI
 *  (the eliza_inference_* voice ABI = libelizainference) and libmtmd into the
 *  slice, so the iOS XCFramework carries the real voice runtime instead of the
 *  fail-closed runtime-symbol shim. */
const TARGETS = {
  "ios-arm64-metal": { sdk: "iphoneos", isSimulator: false, fused: false },
  "ios-arm64-simulator-metal": {
    sdk: "iphonesimulator",
    isSimulator: true,
    fused: false,
  },
  "ios-arm64-metal-fused": { sdk: "iphoneos", isSimulator: false, fused: true },
  "ios-arm64-simulator-metal-fused": {
    sdk: "iphonesimulator",
    isSimulator: true,
    fused: true,
  },
};

// ── AGENTS.md §3 required-kernel symbol patterns. These mirror
//    ios-xcframework/build-xcframework.mjs REQUIRED_IOS_KERNEL_SYMBOLS so the
//    build-time gate is identical to the packaging-time gate.
const REQUIRED_KERNELS = [
  { id: "qjl", pattern: /qjl1?[_-]?(256|score|attn|quantize|dequantize)/i },
  { id: "polarquant", pattern: /q4[_-]?polar|polar[_-]?(quant|dot)/i },
  { id: "mtp", pattern: /mtp|flash[_-]?attn[_-]?ext/i },
  { id: "turbo3", pattern: /turbo3(?!_tcq)/i },
  { id: "turbo4", pattern: /turbo4/i },
];

// ── Fused-only: the OmniVoice TTS + Qwen3-ASR FFI symbol set that distinguishes
//    a real libelizainference (ABI v4) from the fail-closed runtime shim. These
//    mirror the eliza_inference_* half of ios-xcframework/build-xcframework.mjs
//    REQUIRED_IOS_KERNEL_SYMBOLS plus an mtmd presence probe (the ASR path wraps
//    mtmd_*). The `_?` allows the Mach-O leading-underscore in `nm` output.
const REQUIRED_FUSED_SYMBOLS = [
  "eliza_inference_create",
  "eliza_inference_destroy",
  "eliza_inference_mmap_acquire",
  "eliza_inference_tts_synthesize",
  "eliza_inference_asr_transcribe",
  "mtmd_init_from_file",
].map((symbol) => ({
  symbol,
  pattern: new RegExp(`(?:^|\\s)_?${symbol}\\b`, "m"),
}));

function log(msg) {
  process.stdout.write(`\x1b[35m[mtp-build]\x1b[0m ${msg}\n`);
}
function die(msg) {
  process.stderr.write(`\x1b[31m[mtp-build:err]\x1b[0m ${msg}\n`);
  process.exit(1);
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (r.error) die(`${cmd} failed to spawn: ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} ${args.join(" ")} → exit ${r.status}`);
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return "";
  return r.stdout || "";
}

function resolveForkSrc() {
  for (const candidate of FORK_SRC_CANDIDATES) {
    if (fs.existsSync(path.join(candidate, "CMakeLists.txt"))) return candidate;
  }
  die(
    `no llama.cpp fork checkout found. Run \`git submodule update --init --recursive\`.\n` +
      `Looked in:\n  ${FORK_SRC_CANDIDATES.join("\n  ")}`,
  );
}

function forkRevision(srcDir) {
  return (
    capture("git", ["-C", srcDir, "describe", "--always", "--dirty"]).trim() ||
    "unknown"
  );
}

function pickGenerator() {
  // Ninja is single-config and much faster; fall back to Unix Makefiles.
  return spawnSync("ninja", ["--version"], { stdio: "ignore" }).status === 0
    ? "Ninja"
    : "Unix Makefiles";
}

/** Concatenated `nm -g` + `strings` over every produced archive in the slice. */
function dumpArchiveSymbols(archives) {
  const chunks = [];
  for (const archive of archives) {
    chunks.push(capture("nm", ["-g", archive]));
    chunks.push(capture("strings", [archive]));
  }
  return chunks.join("\n");
}

/** Return the ids of required kernels NOT present in the archive symbol text. */
function requiredKernelsMissing(symbolsText) {
  return REQUIRED_KERNELS.filter((k) => !k.pattern.test(symbolsText)).map(
    (k) => k.id,
  );
}

function copyHeaders(srcDir, outDir) {
  const incOut = path.join(outDir, "include");
  fs.rmSync(incOut, { recursive: true, force: true });
  fs.mkdirSync(incOut, { recursive: true });
  for (const incDir of [
    path.join(srcDir, "include"),
    path.join(srcDir, "ggml", "include"),
  ]) {
    if (!fs.existsSync(incDir)) continue;
    for (const name of fs.readdirSync(incDir)) {
      if (!name.endsWith(".h")) continue;
      fs.copyFileSync(path.join(incDir, name), path.join(incOut, name));
    }
  }
}

function collectArchives(buildDir, outDir) {
  // CMake scatters the static libs across ggml/src/** and src/. Find every
  // lib(llama|ggml)*.a and stage one copy per basename into the slice dir.
  const found = capture("find", [buildDir, "-name", "lib*.a", "-type", "f"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) =>
      // Fused slices also stage libmtmd*.a (Qwen3-ASR projector) and
      // libelizainference*.a (the eliza_inference_* voice ABI). NOT
      // libomnivoice*.a — elizainference_static already compiles the omnivoice
      // CORE sources, so staging both would duplicate those objects when the
      // xcframework assembler merges every .a with `libtool -static`.
      /^lib(llama|ggml|mtmd|elizainference)[^/]*\.a$/.test(path.basename(p)),
    );
  if (found.length === 0) {
    die(
      `no lib(llama|ggml)*.a archives produced in ${buildDir} — ` +
        `check that -DBUILD_SHARED_LIBS=OFF took effect`,
    );
  }
  const staged = [];
  const seen = new Set();
  for (const src of found) {
    const base = path.basename(src);
    if (seen.has(base)) continue;
    seen.add(base);
    const dst = path.join(outDir, base);
    fs.copyFileSync(src, dst);
    staged.push(dst);
  }
  return staged;
}

function buildTarget(target) {
  const t = TARGETS[target];
  if (!t) {
    die(
      `unknown target: ${target}\nsupported: ${SUPPORTED_TARGETS.join(", ")}`,
    );
  }
  if (process.platform !== "darwin") {
    die("iOS slice builds require a macOS host with Xcode + Metal toolchain.");
  }

  const outDir = path.join(STATE_DIR, "local-inference", "bin", "mtp", target);
  const capabilitiesPath = path.join(outDir, "CAPABILITIES.json");
  if (
    fs.existsSync(capabilitiesPath) &&
    process.env.ELIZA_MTP_FORCE_REBUILD !== "1"
  ) {
    log(`reusing cached slice: ${outDir}`);
    return outDir;
  }

  const srcDir = resolveForkSrc();
  const revision = forkRevision(srcDir);
  log(`target=${target} sdk=${t.sdk} fork=${revision}`);
  log(`source: ${srcDir}`);

  const buildDir = path.join(
    STATE_DIR,
    "local-inference",
    "mtp-build",
    target,
  );
  if (process.env.ELIZA_MTP_FORCE_REBUILD === "1") {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const generator = pickGenerator();
  log(`cmake configure (${generator}, static, Metal embed)`);
  run("cmake", [
    "-S",
    srcDir,
    "-B",
    buildDir,
    "-G",
    generator,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_SYSTEM_NAME=iOS",
    "-DCMAKE_OSX_ARCHITECTURES=arm64",
    `-DCMAKE_OSX_SYSROOT=${t.sdk}`,
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${DEPLOYMENT_TARGET}`,
    // Static archives — the xcframework packager merges them with libtool.
    "-DBUILD_SHARED_LIBS=OFF",
    // Metal + the eliza kernel set embedded as a compiled metallib
    // (ggml-metal/CMakeLists.txt ELIZA-KERNEL-EMBED-PATCH-V1).
    "-DGGML_METAL=ON",
    "-DGGML_METAL_EMBED_LIBRARY=ON",
    "-DGGML_METAL_USE_BF16=ON",
    "-DGGML_ACCELERATE=ON",
    "-DGGML_BLAS=OFF",
    "-DGGML_OPENMP=OFF",
    "-DGGML_NATIVE=OFF",
    // Libraries only; no CLIs/servers/tests on the slice path.
    "-DLLAMA_BUILD_EXAMPLES=OFF",
    "-DLLAMA_BUILD_TOOLS=OFF",
    "-DLLAMA_BUILD_TESTS=OFF",
    "-DLLAMA_BUILD_SERVER=OFF",
    "-DLLAMA_CURL=OFF",
    // Fused voice slice: build the standalone libmtmd (the Qwen3-ASR audio
    // projector the eliza_inference ASR path wraps). The omnivoice subtree is
    // already configured (LLAMA_BUILD_OMNIVOICE defaults ON); we only need the
    // elizainference_static + mtmd targets, built by name below.
    ...(t.fused ? ["-DLLAMA_BUILD_MTMD=ON"] : []),
  ]);

  // Build ONLY the static library targets. The default `all` target also
  // builds the fork's omnivoice/common example executables; on the iphoneos
  // SDK those link as signed app bundles and fail without provisioning. The
  // library targets carry the full kernel set and need no signing.
  const buildTargets = ["llama", "ggml", "ggml-base", "ggml-cpu", "ggml-metal"];
  if (t.fused) {
    // mtmd (Qwen3-ASR projector) + the STATIC eliza_inference_* FFI archive.
    // NOT omnivoice-tts / omnivoice-codec: those CLIs include audio-io.h
    // (miniaudio device IO) and link as signed app bundles that fail iphoneos.
    // Building by explicit target name (never the `all` target) is exactly how
    // those CLIs are excluded.
    buildTargets.push("mtmd", "elizainference_static");
  }
  log(
    `cmake build (static libraries only) — compiles the Metal kernel set${
      t.fused ? " + OmniVoice/Qwen3-ASR voice FFI" : ""
    }`,
  );
  run("cmake", [
    "--build",
    buildDir,
    "--config",
    "Release",
    "--parallel",
    String(os.cpus().length),
    "--target",
    ...buildTargets,
  ]);

  const archives = collectArchives(buildDir, outDir);
  copyHeaders(srcDir, outDir);

  // AGENTS.md §3 gate: every required kernel symbol must be present in the
  // produced archives or the slice is rejected (no CAPABILITIES.json written).
  const symbolsText = dumpArchiveSymbols(archives);
  const missing = requiredKernelsMissing(symbolsText);
  if (missing.length > 0) {
    die(
      `AGENTS.md §3 kernel audit FAILED for ${target}: missing ${missing.join(", ")}.\n` +
        `The static archives do not carry every required Eliza-1 kernel; refusing to\n` +
        `write CAPABILITIES.json. Archives:\n  ${archives.join("\n  ")}`,
    );
  }

  // Fused-only: prove the REAL OmniVoice TTS + Qwen3-ASR FFI (the eliza_inference_*
  // voice ABI v4) and the mtmd projector are present in the staged archives, so
  // the xcframework assembler's real-vs-fail-closed-shim decision (keyed off
  // CAPABILITIES.omnivoice != null) is backed by actual symbols. The fork at
  // this revision is ABI v4 (TTS/ASR/VAD); it has no eliza_inference_llm_stream_*
  // (on-device text streaming) yet, so that symbol is intentionally NOT gated
  // here — add it once the fork ships the text-streaming ABI.
  if (t.fused) {
    const missingFused = REQUIRED_FUSED_SYMBOLS.filter(
      (s) => !s.pattern.test(symbolsText),
    ).map((s) => s.symbol);
    if (missingFused.length > 0) {
      die(
        `fused voice-ABI audit FAILED for ${target}: missing ${missingFused.join(", ")}.\n` +
          `libelizainference / libmtmd did not carry the eliza_inference_* + mtmd_*\n` +
          `voice symbol set; refusing to write CAPABILITIES.json. Archives:\n  ${archives.join("\n  ")}`,
      );
    }
  }

  const capabilities = {
    schema: "eliza-1.mtp-slice/v1",
    target,
    sdk: t.sdk,
    arch: "arm64",
    isSimulator: t.isSimulator,
    deploymentTarget: DEPLOYMENT_TARGET,
    builtAt: new Date().toISOString(),
    fork: { path: srcDir, revision },
    kernels: Object.fromEntries(REQUIRED_KERNELS.map((k) => [k.id, true])),
    archives: archives.map((a) => path.basename(a)),
    // The xcframework assembler reads `omnivoice == null` as "use the
    // fail-closed runtime symbol shim". Fused slices carry the real
    // libelizainference (OmniVoice TTS + Qwen3-ASR FFI), so they advertise a
    // non-null capability object → the assembler compiles the shim with
    // -DELIZA_IOS_REAL_ELIZAINFERENCE=1 (dropping the stub voice bodies) and the
    // real symbols resolve from the staged archive.
    omnivoice: t.fused
      ? {
          abiVersion: 4,
          library: "libelizainference",
          tts: "omnivoice",
          asr: "qwen3-asr",
          vad: "silero",
        }
      : null,
  };
  fs.writeFileSync(
    capabilitiesPath,
    `${JSON.stringify(capabilities, null, 2)}\n`,
  );

  log(
    `✔ ${target}: ${archives.length} archives + headers + CAPABILITIES.json → ${outDir}`,
  );
  return outDir;
}

function main() {
  const argv = process.argv.slice(2);
  let target = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") target = argv[++i];
    else if (a === "--list") {
      for (const k of SUPPORTED_TARGETS) {
        process.stdout.write(`  ${k} → ${TARGETS[k].sdk}\n`);
      }
      return;
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(
        `Usage: build-llama-cpp-mtp.mjs --target <${SUPPORTED_TARGETS.join("|")}>\n`,
      );
      return;
    } else if (!target && !a.startsWith("--")) {
      target = a;
    } else {
      die(`unknown argument: ${a}`);
    }
  }
  if (!target) {
    die(`--target is required. Supported: ${SUPPORTED_TARGETS.join(", ")}`);
  }
  const out = buildTarget(target);
  process.stdout.write(`OUTDIR=${out}\n`);
}

main();
