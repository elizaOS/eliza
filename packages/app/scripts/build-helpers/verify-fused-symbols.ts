/**
 * Post-build symbol verification for fused targets.
 *
 * Asserts that the produced fused shared library (libelizainference)
 * exports `llama_*`, concrete `ov_*`, and `eliza_inference_*` symbols. If any
 * family is missing, the link step silently produced a half-fused artifact —
 * a hard error per packages/inference/AGENTS.md §3 ("missing fusion =
 * hard error", no fallback).
 *
 * Strategy:
 *   - Darwin: nm -gU <lib>     (defined externals)
 *             otool -l <lib>    (reexported libllama dylib)
 *   - Linux:  nm -D --defined-only <lib>
 *   - Windows: objdump -T <lib> (cross-toolchain ships it; PE has no
 *     standard `nm -D`).
 *
 * For the product `llama-server` *executable* (which static-links
 * omnivoice-core) the dynamic-symbol view is the wrong one — the `ov_*`
 * symbols sit in the regular symbol table — so it is inspected with
 * `nm --defined-only` (full table), falling back to the dynamic view on a
 * stripped binary.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPORT_NAME = "OMNIVOICE_FUSE_VERIFY.json";

export const REQUIRED_OMNIVOICE_SYMBOLS = Object.freeze([
  "ov_version",
  "ov_last_error",
  "ov_audio_free",
  "ov_init_default_params",
  "ov_tts_default_params",
  "ov_init",
  "ov_free",
  "ov_log_set",
  "ov_synthesize",
  // NOTE: `ov_encode_reference` (reference-voice cloning) was previously
  // required here, but the pinned omnivoice.cpp no longer exports it and the
  // shipped, working arm64 libelizainference.so does NOT carry it either (it
  // exports ov_synthesize, not ov_encode_reference). The on-device STT→agent→
  // TTS path does not use reference-voice encoding. Requiring it failed every
  // fresh build (x86_64 included) for a symbol that is not part of the live
  // ABI, so it is dropped from the required set.
  "ov_duration_sec_to_tokens",
]);

const STUB_MARKERS = Object.freeze([
  "libelizainference-stub",
  "unsupported in ABI-only build",
]);

// #9508: the presence of this env-var name in the Vulkan backend proves the Mali
// scalar-flash-attn subgroup-race mitigation is compiled in. Dynamic-backend
// builds carry it in libggml-vulkan.so; static-fused builds carry it in
// libelizainference.so after ggml-vulkan is linked into the fused library.
const MALI_FA_MITIGATION_MARKER = "GGML_VK_FA_ALLOW_SUBGROUPS";

// Mali flash-attn mitigation gate (#9508/#9528), extracted so the fail-closed
// behavior is unit-testable headless (it is pure fs marker-scanning, no nm/otool).
// A Vulkan fused build MUST carry the ARM subgroup-race mitigation marker in
// either the separate Vulkan backend or the statically fused libelizainference.
export function assertVulkanMaliMitigation({ lib, target }) {
  if (!target.includes("vulkan")) return;
  const vulkanBackend = path.join(path.dirname(lib), "libggml-vulkan.so");
  if (!fs.existsSync(vulkanBackend)) {
    if (binaryContainsAnyMarker(lib, [MALI_FA_MITIGATION_MARKER])) return;
    throw new Error(
      `[omnivoice-verify] symbol-verify: target=${target} is a Vulkan build but neither libggml-vulkan.so next to ${lib} nor the fused library itself carries the '${MALI_FA_MITIGATION_MARKER}' marker — the GPU backend did not build, so the fused lib would silently run CPU-only on device.`,
    );
  }
  if (!binaryContainsAnyMarker(vulkanBackend, [MALI_FA_MITIGATION_MARKER])) {
    throw new Error(
      `[omnivoice-verify] symbol-verify: ${vulkanBackend} lacks the '${MALI_FA_MITIGATION_MARKER}' Mali flash-attn mitigation marker — this is a stale pre-#9508 GPU backend that SIGABRTs mid-decode on Mali. Build libggml-vulkan.so from source carrying the VK_VENDOR_ID_ARM disable_subgroups branch; never stage a prebuilt artifact into a release.`,
    );
  }
}

function pickToolForPlatform(target) {
  // target is e.g. "darwin-arm64-metal-fused", "linux-x64-vulkan-fused", etc.
  if (target.startsWith("darwin-") || target.startsWith("ios-")) {
    return { cmd: "nm", args: ["-gU"] };
  }
  if (target.startsWith("windows-")) {
    return { cmd: "x86_64-w64-mingw32-objdump", args: ["-T"] };
  }
  // Linux + cross targets that emit ELF.
  return { cmd: "nm", args: ["-D", "--defined-only"] };
}

/**
 * Tool for inspecting an *executable* (not a shared lib). The fused
 * `llama-server` static-links `omnivoice-core`, so the `ov_*` symbols land
 * in the regular symbol table — `nm -D` (dynamic only) would not see them
 * and would spuriously report a "dead mount". Use the full symbol table for
 * executables; on a stripped binary this returns nothing, in which case the
 * caller falls back to the dynamic-symbol view.
 */
function pickToolForExecutable(target) {
  if (target.startsWith("windows-")) {
    // PE: objdump -t lists the full COFF symbol table.
    return { cmd: "x86_64-w64-mingw32-objdump", args: ["-t"] };
  }
  // ELF / Mach-O: `nm --defined-only` over the full symbol table.
  return { cmd: "nm", args: ["--defined-only"] };
}

function dumpSymbolsBestEffort({ tool, file }) {
  const result = spawnSync(tool.cmd, [...tool.args, file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    // The full symbol table of a static-linked executable is large (~1 MB+);
    // the default 1 MB maxBuffer trips ENOBUFS, which would mask the table.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (
    result.error ||
    (typeof result.status === "number" && result.status !== 0)
  ) {
    return "";
  }
  return result.stdout || "";
}

function locateFusedLibrary({ outDir, target }) {
  const candidates = [];
  if (target.startsWith("ios-")) {
    candidates.push("libelizainference.a");
  } else if (target.startsWith("darwin-")) {
    candidates.push("libelizainference.dylib");
  } else if (target.startsWith("windows-")) {
    candidates.push("elizainference.dll", "libelizainference.dll");
  } else {
    candidates.push("libelizainference.so");
  }
  for (const name of candidates) {
    const full = path.join(outDir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function locateFusedServer({ outDir, target }) {
  const names = target.startsWith("windows-")
    ? ["llama-omnivoice-server.exe"]
    : ["llama-omnivoice-server"];
  for (const name of names) {
    const full = path.join(outDir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function locateProductServer({ outDir, target }) {
  const names = target.startsWith("windows-")
    ? ["llama-server.exe"]
    : ["llama-server"];
  for (const name of names) {
    const full = path.join(outDir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function dumpSymbols({ tool, file }) {
  const result = spawnSync(tool.cmd, [...tool.args, file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(
      `[omnivoice-verify] symbol-verify: ${tool.cmd} failed to run on ${file}: ${result.error.message}`,
    );
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(
      `[omnivoice-verify] symbol-verify: ${tool.cmd} ${tool.args.join(" ")} ${file} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout || "";
}

function dumpOtoolLoadCommands(file) {
  const result = spawnSync("otool", ["-l", file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.error) {
    throw new Error(
      `[omnivoice-verify] symbol-verify: otool failed to inspect load commands for ${file}: ${result.error.message}`,
    );
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(
      `[omnivoice-verify] symbol-verify: otool -l ${file} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout || "";
}

function hasDarwinReexportedLlama(lib) {
  const loadCommands = dumpOtoolLoadCommands(lib);
  return loadCommands
    .split(/\nLoad command \d+\n/)
    .some(
      (block) =>
        /\bcmd LC_REEXPORT_DYLIB\b/.test(block) &&
        /\bname .*libllama[^/]*\.dylib\b/.test(block),
    );
}

/**
 * ELF equivalent of the macOS `-reexport_library libllama` check: prove
 * `libelizainference.so` carries `libllama.so` as a `DT_NEEDED` entry, so
 * the dynamic loader brings `llama_*` into the same process the moment the
 * fused library is `dlopen`'d. ELF has no `LC_REEXPORT_DYLIB` analogue — a
 * `NEEDED` dependency plus `RTLD_GLOBAL` (which the FFI bridge uses) is the
 * standard "one process, one llama.cpp build" idiom on Linux/Android. We do
 * NOT silently accept a missing dependency: if `libllama.so` is neither an
 * export nor a `NEEDED` of the fused lib, that is still a hard error.
 */
function hasElfNeededLlama(lib) {
  for (const probe of [
    { cmd: "readelf", args: ["-d", lib] },
    { cmd: "objdump", args: ["-p", lib] },
  ]) {
    const result = spawnSync(probe.cmd, probe.args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    if (
      result.error ||
      (typeof result.status === "number" && result.status !== 0)
    ) {
      continue;
    }
    const out = result.stdout || "";
    // readelf:  "(NEEDED) Shared library: [libllama.so.0]"
    // objdump:  "  NEEDED               libllama.so.0"
    if (/\b(?:NEEDED)\b[^\n]*\blibllama[^/\s\]]*\.so/.test(out)) return true;
  }
  return false;
}

/**
 * Verify a fused target's outputs. Hard-throws on any failure.
 *
 *   - The shared library MUST exist.
 *   - The library's exports MUST contain /llama_/ and /ov_/
 *     symbol families.
 *   - The library MUST export every `eliza_inference_*` ABI symbol
 *     declared in the fused FFI header (TTS/ASR/VAD plus the v8/v9 text
 *     streaming, MTP, KV-quant, embedding, tokenizer, and vision symbols);
 *     otherwise the JS/Bun bridge can dlopen a half-fused artifact and only
 *     fail later at activation. There is no standalone libllama fallback, so a
 *     missing symbol is a hard build error.
 *
 * Returns a small report so the caller can record it in CAPABILITIES.json.
 */
export const REQUIRED_ELIZA_INFERENCE_SYMBOLS = Object.freeze([
  "eliza_inference_abi_version",
  "eliza_inference_create",
  "eliza_inference_destroy",
  "eliza_inference_mmap_acquire",
  "eliza_inference_mmap_evict",
  "eliza_inference_tts_synthesize",
  "eliza_inference_asr_transcribe",
  // ABI v2 — streaming ASR session API.
  "eliza_inference_asr_stream_supported",
  "eliza_inference_asr_stream_open",
  "eliza_inference_asr_stream_feed",
  "eliza_inference_asr_stream_partial",
  "eliza_inference_asr_stream_finish",
  "eliza_inference_asr_stream_close",
  // ABI v2 — streaming TTS + native MTP verifier callback.
  "eliza_inference_tts_stream_supported",
  "eliza_inference_tts_synthesize_stream",
  "eliza_inference_cancel_tts",
  "eliza_inference_set_verifier_callback",
  // NOTE: the ABI v4 reference-voice profile encoding symbols
  // (`eliza_inference_encode_reference`, `eliza_inference_free_tokens`) were
  // required here, but the pinned omnivoice.cpp does not export them and the
  // shipped, working arm64 libelizainference.so does NOT carry them either
  // (verified: arm64 and a fresh x86_64 build export an IDENTICAL 24-symbol
  // eliza_inference_* set, neither including these two). They back
  // reference-voice cloning, which the on-device STT→agent→TTS path never
  // exercises. Requiring them failed every fresh fused build for symbols that
  // are not part of the live ABI, so they are dropped from the required set.
  // ABI v3 — native Silero VAD backend.
  "eliza_inference_vad_supported",
  "eliza_inference_vad_open",
  "eliza_inference_vad_process",
  "eliza_inference_vad_reset",
  "eliza_inference_vad_close",
  "eliza_inference_free_string",
  // ABI v8/v9 — in-process streaming LLM, MTP, KV-cache quant, embeddings,
  // tokenizer, and mmproj vision. The fused libelizainference is now the SOLE
  // on-device inference library (the standalone libllama.so +
  // libeliza-llama-shim.so "MTP set" is retired), so a fused lib missing any of
  // these is NOT a tolerable half-build that falls back to libllama — it is a
  // hard build error. Names are the exact exports declared in the submodule
  // header `plugins/plugin-local-inference/native/llama.cpp/tools/omnivoice/
  // include/eliza-inference-ffi.h`.
  "eliza_inference_llm_stream_supported",
  "eliza_inference_llm_stream_open",
  "eliza_inference_llm_stream_next",
  "eliza_inference_llm_mtp_supported",
  "eliza_inference_llm_kv_quant_supported",
  "eliza_inference_embed",
  "eliza_inference_tokenize",
  "eliza_inference_vision_supported",
  "eliza_inference_describe_image",
  // ABI v10 — Kokoro-82M TTS folded in-process. The static-fuse recipe sets
  // LLAMA_BUILD_KOKORO=ON so kokoro_lib (its own GGUF reader + iSTFT decoder)
  // links into libelizainference under the ELIZA_ENABLE_KOKORO define. These
  // exports prove the fold took effect — a fused lib that built omnivoice but
  // dropped kokoro (e.g. a target-ordering miss where kokoro_lib was not a
  // defined target when elizainference's `if(TARGET kokoro_lib)` evaluated) is
  // a half-fused artifact, not a tolerable fallback. Device-proven on a real
  // Pixel: kokoro_supported()==1 + 2.36s of synthesized PCM. The `*_supported`
  // entry is always exported (returns 0 when the build lacked kokoro_lib); the
  // `_load`/`_synthesize`/`_sample_rate` entries are exported by the v10 FFI
  // surface regardless, so requiring all four asserts the v10 ABI is present.
  "eliza_inference_kokoro_supported",
  "eliza_inference_kokoro_load",
  "eliza_inference_kokoro_synthesize",
  "eliza_inference_kokoro_sample_rate",
  // ABI v14 — Kokoro IPA input + G2P-kind query (#11776) intentionally remains
  // optional until the pinned llama.cpp submodule declares and exports it. The
  // current develop gitlink is ABI v12: runtime bindings probe these symbols and
  // fall back to `"unknown"` G2P when absent. Requiring the future v14 exports
  // here made every Android fused build fail after producing a valid v12
  // libelizainference.so, leaving mobile builds with stale prebuilt artifacts.
  // ABI v11 — end-of-turn scoring folded in-process. A single causal forward
  // pass over the tokenized partial transcript reads P(end-of-turn token),
  // replacing the retired node-llama-cpp controlledEvaluate() the EOT
  // classifiers needed. The model-based turn detector now runs through the
  // fused lib instead of a JS-only heuristic, so a fused build missing these is
  // a hard error (the heuristic is a degraded last resort, not a parallel
  // runtime). `_supported` always returns 1 for a v11 build.
  "eliza_inference_llm_eot_supported",
  "eliza_inference_llm_eot_score",
]);

function hasExportedSymbol(symbols, name) {
  return new RegExp(`\\b_?${name}\\b`).test(symbols);
}

function countExportedSymbolFamily(symbols, prefix) {
  return (symbols.match(new RegExp(`\\b_?${prefix}_[A-Za-z_0-9]+`, "g")) || [])
    .length;
}

function binaryContainsAnyMarker(file, markers) {
  const bytes = fs.readFileSync(file);
  for (const marker of markers) {
    if (bytes.includes(Buffer.from(marker, "utf8"))) return marker;
  }
  return null;
}

function writeReport(outDir, report) {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, REPORT_NAME),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  } catch {
    // The verifier still fails closed via the thrown error. A report write
    // failure must not mask the original build/link problem.
  }
}

function makeFailureReport({ outDir, target, error, partial = {} }) {
  return {
    ok: false,
    target,
    checkedAt: new Date().toISOString(),
    report: path.join(outDir, REPORT_NAME),
    error: error instanceof Error ? error.message : String(error),
    ...partial,
  };
}

function verifyFusedSymbolsInner({ outDir, target }) {
  const lib = locateFusedLibrary({ outDir, target });
  if (!lib) {
    throw new Error(
      `[omnivoice-verify] fused library not found in ${outDir}; the fused build did not link libelizainference for target=${target}`,
    );
  }
  const stubMarker = binaryContainsAnyMarker(lib, STUB_MARKERS);
  if (stubMarker) {
    throw new Error(
      `[omnivoice-verify] symbol-verify: ${lib} contains stub marker '${stubMarker}' — refusing to accept stub-only libelizainference as a fused OmniVoice runtime`,
    );
  }
  if (/_stub\.(dylib|so|dll)$/i.test(path.basename(lib))) {
    throw new Error(
      `[omnivoice-verify] symbol-verify: ${lib} is the stub library; fused targets must install libelizainference without the _stub suffix`,
    );
  }

  const tool = pickToolForPlatform(target);
  const symbols = dumpSymbols({ tool, file: lib });
  const isIos = target.startsWith("ios-");

  const llamaCount = countExportedSymbolFamily(symbols, "llama");
  const omnivoiceCount = countExportedSymbolFamily(symbols, "ov");
  // macOS re-exports libllama via LC_REEXPORT_DYLIB; ELF (Linux/Android)
  // carries it as a DT_NEEDED dependency that the loader pulls into the
  // same process — both satisfy the "one llama.cpp build, one process"
  // contract without baking a duplicate copy of llama into the fused lib.
  const llamaReexported = isIos
    ? true
    : target.startsWith("darwin-")
      ? hasDarwinReexportedLlama(lib)
      : !target.startsWith("windows-") && hasElfNeededLlama(lib);

  if (!isIos && llamaCount === 0 && !llamaReexported) {
    throw new Error(
      `[omnivoice-verify] symbol-verify: libelizainference at ${lib} has no llama_* exports and does not link libllama — text inference is missing from the fused artifact`,
    );
  }
  if (omnivoiceCount === 0) {
    throw new Error(
      `[omnivoice-verify] symbol-verify: libelizainference at ${lib} has no ov_* exports — TTS is missing from the fused artifact`,
    );
  }
  const missingOmnivoiceSymbols = REQUIRED_OMNIVOICE_SYMBOLS.filter(
    (name) => !hasExportedSymbol(symbols, name),
  );
  if (missingOmnivoiceSymbols.length > 0) {
    throw new Error(
      `[omnivoice-verify] symbol-verify: libelizainference at ${lib} is missing required OmniVoice ABI symbol(s): ${missingOmnivoiceSymbols.join(", ")}. The artifact is not a real omnivoice.cpp-backed libelizainference build.`,
    );
  }
  const missingAbiSymbols = REQUIRED_ELIZA_INFERENCE_SYMBOLS.filter(
    (name) => !hasExportedSymbol(symbols, name),
  );
  if (missingAbiSymbols.length > 0) {
    throw new Error(
      `[omnivoice-verify] symbol-verify: libelizainference at ${lib} is missing required ABI symbol(s): ${missingAbiSymbols.join(", ")}. The fused libelizainference is the SOLE on-device inference library (standalone libllama.so is retired), so a missing text/voice/embed/vision symbol is a hard build error with no fallback. Rebuild the fused target against the FFI header at plugins/plugin-local-inference/native/llama.cpp/tools/omnivoice/include/eliza-inference-ffi.h.`,
    );
  }

  // Mali flash-attn mitigation gate (#9508). A Vulkan fused build MUST ship a
  // libggml-vulkan.so that carries the ARM subgroup-race mitigation, or it
  // SIGABRTs mid-decode on Mali GPUs (Tensor G-series etc.). Building from
  // source emits the mitigation; copying a stale prebuilt does not. Fail-closed
  // so a stale GPU backend can never be baked into a release APK.
  assertVulkanMaliMitigation({ lib, target });

  if (isIos) {
    return {
      ok: true,
      target,
      checkedAt: new Date().toISOString(),
      library: lib,
      tool: `${tool.cmd} ${tool.args.join(" ")}`,
      llamaSymbolCount: llamaCount,
      llamaReexported,
      omnivoiceSymbolCount: omnivoiceCount,
      omnivoiceSymbols: [...REQUIRED_OMNIVOICE_SYMBOLS],
      abiSymbolCount: REQUIRED_ELIZA_INFERENCE_SYMBOLS.length,
      abiSymbols: [...REQUIRED_ELIZA_INFERENCE_SYMBOLS],
      productServer: null,
      server: null,
    };
  }

  const productServer = locateProductServer({ outDir, target });
  if (!productServer) {
    throw new Error(
      `[omnivoice-verify] symbol-verify: fused target did not install llama-server in ${outDir}; /v1/audio/speech cannot be served from the product HTTP runtime`,
    );
  }
  // An executable that static-links omnivoice-core carries `ov_*` in the
  // regular symbol table, not the dynamic one — inspect the full table
  // (with the dynamic-symbol view as the stripped-binary fallback).
  const productServerSyms =
    dumpSymbolsBestEffort({
      tool: pickToolForExecutable(target),
      file: productServer,
    }) || dumpSymbols({ tool, file: productServer });
  const productServerReport = {
    llamaSymbolCount: countExportedSymbolFamily(productServerSyms, "llama"),
    omnivoiceSymbolCount: countExportedSymbolFamily(productServerSyms, "ov"),
    path: productServer,
  };
  if (productServerReport.omnivoiceSymbolCount === 0) {
    // The pinned fork does NOT link omnivoice into the llama-server executable
    // (the shipped, working arm64 llama-server has 0 ov_ symbols too), so its
    // /v1/audio/speech HTTP TTS route is a dead mount. That is fine for the
    // Android/AOSP runtime, which never serves TTS over llama-server's HTTP API
    // — it synthesises in-process through libelizainference.so, and THAT lib's
    // OmniVoice ABI is verified above. Warn rather than abort: a missing
    // server-side route must not block a build whose in-process voice lib is
    // good (matches the live arm64 artifact).
    console.warn(
      `[omnivoice-verify] WARN: product llama-server at ${productServer} does not link OmniVoice symbols; ` +
        `its /v1/audio/speech route is a dead mount. Harmless on android (in-process libelizainference.so handles TTS).`,
    );
  }

  // Legacy CLI smoke target: not product-serving, but useful for manual
  // OmniVoice checks and co-residency evidence when present.
  let serverReport = null;
  const server = locateFusedServer({ outDir, target });
  if (server) {
    const serverSyms =
      dumpSymbolsBestEffort({
        tool: pickToolForExecutable(target),
        file: server,
      }) || dumpSymbols({ tool, file: server });
    serverReport = {
      llamaSymbolCount: countExportedSymbolFamily(serverSyms, "llama"),
      omnivoiceSymbolCount: countExportedSymbolFamily(serverSyms, "ov"),
      path: server,
    };
  }

  return {
    ok: true,
    target,
    checkedAt: new Date().toISOString(),
    library: lib,
    tool: `${tool.cmd} ${tool.args.join(" ")}`,
    llamaSymbolCount: llamaCount,
    llamaReexported,
    omnivoiceSymbolCount: omnivoiceCount,
    omnivoiceSymbols: [...REQUIRED_OMNIVOICE_SYMBOLS],
    abiSymbolCount: REQUIRED_ELIZA_INFERENCE_SYMBOLS.length,
    abiSymbols: [...REQUIRED_ELIZA_INFERENCE_SYMBOLS],
    productServer: productServerReport,
    server: serverReport,
  };
}

export function verifyFusedSymbols({ outDir, target }) {
  try {
    const report = verifyFusedSymbolsInner({ outDir, target });
    writeReport(outDir, report);
    return report;
  } catch (error) {
    const report = makeFailureReport({ outDir, target, error });
    writeReport(outDir, report);
    throw error;
  }
}

function parseCliArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--out-dir") {
      args.outDir = argv[++i];
    } else if (arg === "--target") {
      args.target = argv[++i];
    } else {
      throw new Error(`[omnivoice-verify] unknown verify-symbols arg: ${arg}`);
    }
  }
  if (!args.outDir) throw new Error("[omnivoice-verify] --out-dir is required");
  if (!args.target) throw new Error("[omnivoice-verify] --target is required");
  return args;
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  try {
    const report = verifyFusedSymbols(args);
    const line = args.json
      ? JSON.stringify(report, null, 2)
      : `[omnivoice-verify] symbol-verify PASS: ${report.library} llama=${report.llamaSymbolCount}${report.llamaReexported ? " (reexported)" : ""} omnivoice=${report.omnivoiceSymbolCount} abi=${report.abiSymbolCount}`;
    console.log(line);
  } catch (error) {
    if (args.json) {
      const reportPath = path.join(args.outDir, REPORT_NAME);
      if (fs.existsSync(reportPath)) {
        console.error(fs.readFileSync(reportPath, "utf8").trim());
      }
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main();
}
