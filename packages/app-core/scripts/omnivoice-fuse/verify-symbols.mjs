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
  "ov_duration_sec_to_tokens",
]);

const STUB_MARKERS = Object.freeze([
  "libelizainference-stub",
  "not implemented in stub",
]);

function pickToolForPlatform(target) {
  // target is e.g. "darwin-arm64-metal-fused", "linux-x64-vulkan-fused", etc.
  if (target.startsWith("darwin-")) {
    return { cmd: "nm", args: ["-gU"] };
  }
  if (target.startsWith("windows-")) {
    return { cmd: "x86_64-w64-mingw32-objdump", args: ["-T"] };
  }
  // Linux + cross targets that emit ELF.
  return { cmd: "nm", args: ["-D", "--defined-only"] };
}

function locateFusedLibrary({ outDir, target }) {
  const candidates = [];
  if (target.startsWith("darwin-")) {
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

function dumpSymbols({ tool, file }) {
  const result = spawnSync(tool.cmd, [...tool.args, file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.error) {
    throw new Error(
      `[omnivoice-fuse] symbol-verify: ${tool.cmd} failed to run on ${file}: ${result.error.message}`,
    );
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(
      `[omnivoice-fuse] symbol-verify: ${tool.cmd} ${tool.args.join(" ")} ${file} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
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
      `[omnivoice-fuse] symbol-verify: otool failed to inspect load commands for ${file}: ${result.error.message}`,
    );
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(
      `[omnivoice-fuse] symbol-verify: otool -l ${file} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
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
    if (result.error || (typeof result.status === "number" && result.status !== 0)) {
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
 *   - The library MUST export every `eliza_inference_*` ABI v2 symbol
 *     declared in `ffi.h`; otherwise the JS/Bun bridge can dlopen a
 *     half-fused artifact and only fail later at voice activation.
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
  "eliza_inference_free_string",
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
      `[omnivoice-fuse] fused library not found in ${outDir}; the fused build did not link libelizainference for target=${target}`,
    );
  }
  const stubMarker = binaryContainsAnyMarker(lib, STUB_MARKERS);
  if (stubMarker) {
    throw new Error(
      `[omnivoice-fuse] symbol-verify: ${lib} contains stub marker '${stubMarker}' — refusing to accept stub-only libelizainference as a fused OmniVoice runtime`,
    );
  }
  if (/_stub\.(dylib|so|dll)$/i.test(path.basename(lib))) {
    throw new Error(
      `[omnivoice-fuse] symbol-verify: ${lib} is the stub library; fused targets must install libelizainference without the _stub suffix`,
    );
  }

  const tool = pickToolForPlatform(target);
  const symbols = dumpSymbols({ tool, file: lib });

  const llamaCount = countExportedSymbolFamily(symbols, "llama");
  const omnivoiceCount = countExportedSymbolFamily(symbols, "ov");
  // macOS re-exports libllama via LC_REEXPORT_DYLIB; ELF (Linux/Android)
  // carries it as a DT_NEEDED dependency that the loader pulls into the
  // same process — both satisfy the "one llama.cpp build, one process"
  // contract without baking a duplicate copy of llama into the fused lib.
  const llamaReexported = target.startsWith("darwin-")
    ? hasDarwinReexportedLlama(lib)
    : !target.startsWith("windows-") && hasElfNeededLlama(lib);

  if (llamaCount === 0 && !llamaReexported) {
    throw new Error(
      `[omnivoice-fuse] symbol-verify: libelizainference at ${lib} has no llama_* exports and does not link libllama — text inference is missing from the fused artifact`,
    );
  }
  if (omnivoiceCount === 0) {
    throw new Error(
      `[omnivoice-fuse] symbol-verify: libelizainference at ${lib} has no ov_* exports — TTS is missing from the fused artifact`,
    );
  }
  const missingOmnivoiceSymbols = REQUIRED_OMNIVOICE_SYMBOLS.filter(
    (name) => !hasExportedSymbol(symbols, name),
  );
  if (missingOmnivoiceSymbols.length > 0) {
    throw new Error(
      `[omnivoice-fuse] symbol-verify: libelizainference at ${lib} is missing required OmniVoice ABI symbol(s): ${missingOmnivoiceSymbols.join(", ")}. The artifact is not a real omnivoice.cpp-backed libelizainference build.`,
    );
  }
  const missingAbiSymbols = REQUIRED_ELIZA_INFERENCE_SYMBOLS.filter(
    (name) => !hasExportedSymbol(symbols, name),
  );
  if (missingAbiSymbols.length > 0) {
    throw new Error(
      `[omnivoice-fuse] symbol-verify: libelizainference at ${lib} is missing ABI v2 symbol(s): ${missingAbiSymbols.join(", ")}. Rebuild the fused target against packages/app-core/scripts/omnivoice-fuse/ffi.h.`,
    );
  }

  // Optional fused-server check: it's expected, but the route-mount work
  // is a TODO (see cmake-graft.mjs). If it exists, verify its symbol
  // families too — the executable must drag in omnivoice-core, not just
  // llama. If it doesn't exist, that's also acceptable for now (the
  // shared library is the contract surface for the bridges).
  let serverReport = null;
  const server = locateFusedServer({ outDir, target });
  if (server) {
    const serverSyms = dumpSymbols({ tool, file: server });
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
      throw new Error(`[omnivoice-fuse] unknown verify-symbols arg: ${arg}`);
    }
  }
  if (!args.outDir) throw new Error("[omnivoice-fuse] --out-dir is required");
  if (!args.target) throw new Error("[omnivoice-fuse] --target is required");
  return args;
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  try {
    const report = verifyFusedSymbols(args);
    const line = args.json
      ? JSON.stringify(report, null, 2)
      : `[omnivoice-fuse] symbol-verify PASS: ${report.library} llama=${report.llamaSymbolCount}${report.llamaReexported ? " (reexported)" : ""} omnivoice=${report.omnivoiceSymbolCount} abi=${report.abiSymbolCount}`;
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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
