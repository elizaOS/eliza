#!/usr/bin/env bun
/*
 * kokoro_e2e_loop_bench.mjs - small-tier Eliza-1 Kokoro voice-loop harness.
 *
 * This is intentionally separate from e2e_loop_bench.mjs, which drives the
 * fused OmniVoice TTS HTTP route. The small tiers (0_8b, 2b, 4b) are Kokoro
 * TTS tiers, so this harness measures the real path:
 *
 *   WAV mic input -> fused ASR FFI -> llama-server text generation
 *     -> optional embedding probe -> Kokoro ONNX TTS
 *
 * When no WAV is supplied, the harness creates a self-labelled Kokoro mic WAV
 * first, records that provenance, and keeps ASR WER out of the external-WER
 * lane. Missing models/builds produce structured needs-* reports instead of
 * fabricated passes.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SMALL_TIERS = new Set(["0_8b", "2b", "4b"]);
const DEFAULT_PHRASES = [
  "hello there",
  "what is the capital of france",
  "tell me a short fact about the ocean",
];

function findRepoRoot(startDir) {
  let current = startDir;
  while (true) {
    if (
      fs.existsSync(path.join(current, "package.json")) &&
      fs.existsSync(path.join(current, "plugins", "plugin-local-inference"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`could not locate repo root from ${startDir}`);
    current = parent;
  }
}

const REPO_ROOT = findRepoRoot(__dirname);
const REPORTS_ROOT = path.join(__dirname, "..", "reports");

function parseArgs(argv) {
  const defaultBackend = process.platform === "darwin" ? "metal" : "cpu";
  const args = {
    tier: process.env.ELIZA_KOKORO_E2E_TIER || "0_8b",
    bundle: process.env.ELIZA_KOKORO_E2E_BUNDLE || "",
    backend: process.env.ELIZA_KOKORO_E2E_BACKEND || defaultBackend,
    binDir: process.env.ELIZA_KOKORO_E2E_BIN_DIR || "",
    dylib: process.env.ELIZA_KOKORO_E2E_DYLIB || "",
    wavs: splitList(process.env.ELIZA_KOKORO_E2E_WAVS || ""),
    refs: splitList(process.env.ELIZA_KOKORO_E2E_REFS || "", "|"),
    turns: intEnv("ELIZA_KOKORO_E2E_TURNS", 1),
    nPredict: intEnv("ELIZA_KOKORO_E2E_N_PREDICT", 32),
    threads: intEnv("ELIZA_KOKORO_E2E_THREADS", Math.min(os.cpus().length, 12)),
    ctx: intEnv("ELIZA_KOKORO_E2E_CTX", 2048),
    ngl:
      process.env.ELIZA_KOKORO_E2E_NGL ||
      (defaultBackend === "cpu" ? "0" : "99"),
    startTimeoutS: intEnv("ELIZA_KOKORO_E2E_START_TIMEOUT", 180),
    turnTimeoutS: intEnv("ELIZA_KOKORO_E2E_TURN_TIMEOUT", 240),
    voice: process.env.ELIZA_KOKORO_E2E_VOICE || "af_bella",
    report: process.env.ELIZA_KOKORO_E2E_REPORT || "",
    saveAudio: process.env.ELIZA_KOKORO_E2E_SAVE_AUDIO !== "0",
    skipEmbedding: process.env.ELIZA_KOKORO_E2E_SKIP_EMBEDDING === "1",
    preflightOnly: false,
    json: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    if (a === "--tier") args.tier = next();
    else if (a === "--bundle" || a === "--bundle-dir") args.bundle = next();
    else if (a === "--backend") args.backend = next();
    else if (a === "--bin-dir") args.binDir = next();
    else if (a === "--dylib") args.dylib = next();
    else if (a === "--wav" || a === "--wavs") args.wavs = splitList(next());
    else if (a === "--ref" || a === "--refs") args.refs = splitList(next(), "|");
    else if (a === "--turns") args.turns = Number.parseInt(next(), 10);
    else if (a === "--n-predict") args.nPredict = Number.parseInt(next(), 10);
    else if (a === "--threads") args.threads = Number.parseInt(next(), 10);
    else if (a === "--ctx") args.ctx = Number.parseInt(next(), 10);
    else if (a === "--ngl") args.ngl = next();
    else if (a === "--voice") args.voice = next();
    else if (a === "--report") args.report = next();
    else if (a === "--skip-embedding") args.skipEmbedding = true;
    else if (a === "--no-save-audio") args.saveAudio = false;
    else if (a === "--preflight-only") args.preflightOnly = true;
    else if (a === "--json") args.json = true;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  bun plugins/plugin-local-inference/native/verify/kokoro_e2e_loop_bench.mjs \\
    --tier 0_8b|2b|4b [--bundle <eliza-1-tier.bundle>] [--backend metal|cpu|vulkan|cuda]

Options:
  --wav a.wav[,b.wav]     External mic WAV(s). Pair with --ref "text|text".
  --ref "text|text"       References for WER. Without --wav, used as Kokoro mic seed text.
  --skip-embedding        Do not run the optional embedding probe.
  --preflight-only        Resolve artifacts/builds and write a non-gating preflight report.
  --report out.json       Report path. Default: native/reports/local-e2e/<date>/e2e-loop-kokoro-*.json
`);
}

function splitList(value, sep = ",") {
  return String(value || "")
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function stateRoot() {
  return process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza");
}

function defaultBundle(tier) {
  return path.join(
    stateRoot(),
    "local-inference",
    "models",
    `eliza-1-${tier}.bundle`,
  );
}

function platformTag() {
  const sys =
    { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform] ||
    process.platform;
  const arch = { x64: "x64", arm64: "arm64" }[process.arch] || process.arch;
  return `${sys}-${arch}`;
}

function libName() {
  if (process.platform === "darwin") return "libelizainference.dylib";
  if (process.platform === "win32") return "libelizainference.dll";
  return "libelizainference.so";
}

function discoverEngine(args) {
  const root = path.join(stateRoot(), "local-inference", "bin", "dflash");
  const candidates = [];
  if (args.binDir) candidates.push(path.resolve(args.binDir));
  const plat = platformTag();
  const preferred = [
    `${plat}-${args.backend}-fused`,
    `${plat}-${args.backend}`,
  ];
  for (const name of preferred) candidates.push(path.join(root, name));
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root)) {
      if (entry.startsWith(plat) && entry.includes(args.backend)) {
        candidates.push(path.join(root, entry));
      }
    }
  }

  for (const dir of unique(candidates)) {
    const server = path.join(dir, "llama-server");
    const dylib = args.dylib ? path.resolve(args.dylib) : path.join(dir, libName());
    if (fs.existsSync(server)) {
      return {
        ok: true,
        dir,
        server,
        dylib: fs.existsSync(dylib) ? dylib : null,
        caps: readJson(path.join(dir, "CAPABILITIES.json")),
      };
    }
  }
  return {
    ok: false,
    reason: `no llama-server for ${plat}/${args.backend} under ${root}`,
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function firstExisting(...candidates) {
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function ggufsIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.gguf$/i.test(f))
    .map((f) => path.join(dir, f));
}

function contextRank(file) {
  const m = path.basename(file).match(/-(\d+)k\.gguf$/i);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function isRealGguf(file, minBytes = 1_000_000) {
  if (!file || !fs.existsSync(file)) return false;
  try {
    if (fs.statSync(file).size < minBytes) return false;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf.toString("utf8") === "GGUF";
  } catch {
    return false;
  }
}

function resolveBundleFiles(bundleDir, tier) {
  const manifest = readJson(path.join(bundleDir, "eliza-1.manifest.json"));
  const text = ggufsIn(path.join(bundleDir, "text")).sort(
    (a, b) => contextRank(a) - contextRank(b) || a.localeCompare(b),
  )[0] || null;
  const drafter = ggufsIn(path.join(bundleDir, "dflash"))[0] || null;
  const asrDir = path.join(bundleDir, "asr");
  const ttsRoot = path.join(bundleDir, "tts", "kokoro");
  const voicesDir = path.join(ttsRoot, "voices");
  const kokoroModel =
    firstExisting(
      path.join(ttsRoot, "model_q4.onnx"),
      path.join(ttsRoot, "model_quantized.onnx"),
      path.join(ttsRoot, "kokoro-v1.0.int8.onnx"),
      path.join(ttsRoot, "model.onnx"),
      path.join(ttsRoot, "kokoro-v1.0.onnx"),
    ) || null;
  const embeddingDir = path.join(bundleDir, "embedding");
  const dedicatedEmbedding = ggufsIn(embeddingDir).sort()[0] || null;
  return {
    manifest,
    tier: manifest?.tier || tier,
    text,
    drafter,
    asr: firstExisting(
      path.join(asrDir, "eliza-1-asr.gguf"),
      ...ggufsIn(asrDir).filter((f) => !/mmproj|proj/i.test(path.basename(f))),
    ),
    asrMmproj: firstExisting(
      path.join(asrDir, "eliza-1-asr-mmproj.gguf"),
      ...ggufsIn(asrDir).filter((f) => /mmproj|proj/i.test(path.basename(f))),
    ),
    kokoro: {
      root: ttsRoot,
      modelPath: kokoroModel,
      modelFile: kokoroModel ? path.basename(kokoroModel) : null,
      voicesDir,
      voices: fs.existsSync(voicesDir)
        ? fs.readdirSync(voicesDir).filter((f) => f.endsWith(".bin")).sort()
        : [],
      modelSha256: kokoroSha256(bundleDir, kokoroModel),
    },
    embedding: {
      model: dedicatedEmbedding || text,
      mode: dedicatedEmbedding ? "dedicated" : text ? "pooled-text" : "missing",
    },
  };
}

function kokoroSha256(bundleDir, kokoroModel) {
  if (!kokoroModel) return null;
  const evidence = readJson(path.join(bundleDir, "evidence", "kokoro-assets.json"));
  const rel = path.relative(bundleDir, kokoroModel).replaceAll(path.sep, "/");
  const row = evidence?.files?.find((f) => f?.bundle_path === rel);
  return typeof row?.sha256 === "string" ? row.sha256 : null;
}

function missingArtifacts(files, engine) {
  const missing = [];
  if (!isRealGguf(files.text)) missing.push("text GGUF");
  if (!isRealGguf(files.asr)) missing.push("asr/eliza-1-asr.gguf");
  if (!isRealGguf(files.asrMmproj, 1_000)) missing.push("asr/eliza-1-asr-mmproj.gguf");
  if (!files.kokoro.modelPath || !fs.existsSync(files.kokoro.modelPath)) {
    missing.push("tts/kokoro/model_q4.onnx");
  }
  if (!fs.existsSync(files.kokoro.voicesDir) || files.kokoro.voices.length === 0) {
    missing.push("tts/kokoro/voices/*.bin");
  }
  if (!engine.ok) missing.push("llama-server build");
  if (engine.ok && !engine.dylib) missing.push(`ASR FFI ${libName()}`);
  return missing;
}

function nowDate() {
  return new Date().toISOString().slice(0, 10);
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function defaultReportPath(tier) {
  return path.join(
    REPORTS_ROOT,
    "local-e2e",
    nowDate(),
    `e2e-loop-kokoro-${tier}-${timestamp()}.json`,
  );
}

function preflightReportPath(tier) {
  return path.join(
    __dirname,
    "bench_results",
    `kokoro-e2e-preflight-${tier}-${timestamp()}.json`,
  );
}

async function pickPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("no port assigned"));
      });
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitHealthy(port, timeoutS, child) {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`llama-server exited before /health (code ${child.exitCode})`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.status === 200) {
        const json = await res.json().catch(() => ({}));
        if (json.status === "ok") return true;
      }
    } catch {
      // Not ready yet.
    }
    await sleep(500);
  }
  throw new Error(`llama-server not healthy after ${timeoutS}s`);
}

function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${file}: not a RIFF/WAVE file`);
  }
  let off = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataOff = body;
      dataLen = size;
    }
    off = body + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error(`${file}: missing fmt/data chunk`);
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(`${file}: only PCM16 WAV is supported`);
  }
  const nFrames = Math.floor(dataLen / 2 / fmt.channels);
  const samples = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < fmt.channels; ch += 1) {
      sum += buf.readInt16LE(dataOff + (i * fmt.channels + ch) * 2);
    }
    samples[i] = sum / fmt.channels / 32768;
  }
  return { sampleRate: fmt.sampleRate, samples };
}

function writeWav16(file, samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

function resampleLinear(samples, fromHz, toHz) {
  if (fromHz === toHz) return samples;
  const ratio = toHz / fromHz;
  const out = new Float32Array(Math.max(1, Math.round(samples.length * ratio)));
  for (let i = 0; i < out.length; i += 1) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

function normalizeWords(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9'\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function wordErrorRate(ref, hyp) {
  const r = normalizeWords(ref);
  const h = normalizeWords(hyp);
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  const dp = Array.from({ length: r.length + 1 }, () => new Array(h.length + 1).fill(0));
  for (let i = 0; i <= r.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= h.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= r.length; i += 1) {
    for (let j = 1; j <= h.length; j += 1) {
      const cost = r[i - 1] === h[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[r.length][h.length] / r.length;
}

async function loadFfi(libPath, libDir) {
  const sep = path.delimiter;
  process.env.LD_LIBRARY_PATH = [libDir, process.env.LD_LIBRARY_PATH || ""]
    .filter(Boolean)
    .join(sep);
  if (process.platform === "darwin") {
    process.env.DYLD_LIBRARY_PATH = [libDir, process.env.DYLD_LIBRARY_PATH || ""]
      .filter(Boolean)
      .join(sep);
  }
  const ffi = await import("bun:ffi");
  const T = ffi.FFIType;
  const lib = ffi.dlopen(libPath, {
    eliza_inference_abi_version: { args: [], returns: T.cstring },
    eliza_inference_create: { args: [T.cstring, T.ptr], returns: T.ptr },
    eliza_inference_destroy: { args: [T.ptr], returns: T.void },
    eliza_inference_mmap_acquire: { args: [T.ptr, T.cstring, T.ptr], returns: T.i32 },
    eliza_inference_asr_transcribe: {
      args: [T.ptr, T.ptr, T.usize, T.i32, T.ptr, T.usize, T.ptr],
      returns: T.i32,
    },
    eliza_inference_free_string: { args: [T.usize], returns: T.void },
  });
  const abi = lib.symbols.eliza_inference_abi_version();
  return { ffi, lib, s: lib.symbols, abi: typeof abi === "string" ? abi : String(abi) };
}

function readErrAndFree(ffi, s, ptrBuf) {
  let p;
  try {
    p = ffi.read.ptr(ptrBuf, 0);
  } catch {
    p = 0n;
  }
  if (!p || p === 0n) return "(no diagnostic)";
  let msg = "(unreadable diagnostic)";
  try {
    msg = ffi.CString(p);
  } catch {
    // Keep default.
  }
  try {
    s.eliza_inference_free_string(p);
  } catch {
    // Best effort.
  }
  return msg;
}

function createFfiContext(ffiState, bundleDir) {
  const { ffi, s } = ffiState;
  const errBuf = Buffer.alloc(8);
  errBuf.fill(0);
  const ctx = s.eliza_inference_create(Buffer.from(`${bundleDir}\0`, "utf8"), ffi.ptr(errBuf));
  if (!ctx || (typeof ctx === "bigint" && ctx === 0n)) {
    throw new Error(`eliza_inference_create failed: ${readErrAndFree(ffi, s, errBuf)}`);
  }
  const acquireErr = Buffer.alloc(8);
  acquireErr.fill(0);
  const rc = s.eliza_inference_mmap_acquire(
    ctx,
    Buffer.from("asr\0", "utf8"),
    ffi.ptr(acquireErr),
  );
  if (rc < 0) throw new Error(`mmap_acquire("asr") rc=${rc}: ${readErrAndFree(ffi, s, acquireErr)}`);
  return ctx;
}

function asrTranscribe(ffiState, ctx, samples, sampleRate) {
  const { ffi, s } = ffiState;
  const pcm16k = resampleLinear(samples, sampleRate, 16000);
  const pcmBuf = Buffer.from(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength);
  const outBytes = 4096;
  const outBuf = Buffer.alloc(outBytes);
  const errBuf = Buffer.alloc(8);
  errBuf.fill(0);
  const started = performance.now();
  const rc = s.eliza_inference_asr_transcribe(
    ctx,
    ffi.ptr(pcmBuf),
    BigInt(pcm16k.length),
    16000,
    ffi.ptr(outBuf),
    BigInt(outBytes),
    ffi.ptr(errBuf),
  );
  const latencyMs = performance.now() - started;
  if (rc < 0) {
    throw new Error(`asr_transcribe rc=${rc}: ${readErrAndFree(ffi, s, errBuf)}`);
  }
  return {
    latencyMs,
    transcript: outBuf.toString("utf8", 0, rc).trim(),
  };
}

async function createKokoro(files, voiceId) {
  const kokoro = await import("../../src/services/voice/kokoro/index.ts");
  const layout = {
    root: files.kokoro.root,
    modelFile: files.kokoro.modelFile,
    voicesDir: files.kokoro.voicesDir,
    sampleRate: 24000,
  };
  const runtime = new kokoro.KokoroOnnxRuntime({
    layout,
    expectedSha256: files.kokoro.modelSha256,
  });
  const backend = new kokoro.KokoroTtsBackend({
    layout,
    defaultVoiceId: voiceId,
    runtime,
    streamingChunkSamples: Math.floor(layout.sampleRate / 4),
  });
  return { backend, runtime, layout, module: kokoro };
}

async function synthesizeKokoro(backend, text, voiceId, audioPath = null) {
  const chunks = [];
  let total = 0;
  let sampleRate = backend.sampleRate;
  let firstChunkMs = null;
  const started = performance.now();
  await backend.synthesizeStream({
    phrase: {
      id: `kokoro-e2e-${Date.now()}`,
      text,
      fromIndex: 0,
      toIndex: text.length,
    },
    preset: { id: "kokoro-e2e", voiceId },
    cancelSignal: { cancelled: false },
    onChunk: ({ pcm, sampleRate: sr, isFinal }) => {
      sampleRate = sr || sampleRate;
      if (!isFinal && pcm.length > 0) {
        if (firstChunkMs === null) firstChunkMs = performance.now() - started;
        const copy = new Float32Array(pcm.length);
        copy.set(pcm);
        chunks.push(copy);
        total += copy.length;
      }
      return false;
    },
  });
  const wallMs = performance.now() - started;
  const merged = new Float32Array(total);
  let off = 0;
  for (const chunk of chunks) {
    merged.set(chunk, off);
    off += chunk.length;
  }
  if (audioPath) writeWav16(audioPath, merged, sampleRate);
  const audioSec = total / sampleRate;
  return {
    text,
    sampleRate,
    samples: merged,
    audioSec,
    wallMs,
    firstChunkMs,
    rtf: audioSec > 0 ? wallMs / 1000 / audioSec : null,
    chunks: chunks.length,
    audioPath,
  };
}

async function fetchSpecCounters(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.status !== 200) return { drafted: null, accepted: null };
    const text = await res.text();
    const pick = (re) => {
      const m = text.match(re);
      return m ? Number(m[1]) : null;
    };
    return {
      drafted: pick(/llamacpp:n_drafted_total\s+([\d.]+)/),
      accepted: pick(/llamacpp:n_drafted_accepted_total\s+([\d.]+)/),
    };
  } catch {
    return { drafted: null, accepted: null };
  }
}

async function streamCompletion(port, prompt, nPredict, timeoutS) {
  const started = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutS * 1000);
  let firstTokenMs = null;
  let content = "";
  let tokensSeen = 0;
  let timings = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/completion`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        n_predict: nPredict,
        temperature: 0,
        stream: true,
        cache_prompt: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`/completion HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of event.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;
          let obj;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue;
          }
          if (typeof obj.content === "string" && obj.content.length > 0) {
            if (firstTokenMs === null) firstTokenMs = performance.now() - started;
            content += obj.content;
            tokensSeen += 1;
          }
          if (obj.timings) timings = obj.timings;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const wallMs = performance.now() - started;
  return {
    content: content.trim(),
    firstTokenMs,
    tokensSeen,
    wallMs,
    predictedN: timings?.predicted_n ?? tokensSeen,
    decodeTokPerSec:
      timings?.predicted_per_second ??
      (tokensSeen > 0 ? (tokensSeen * 1000) / wallMs : null),
  };
}

async function startTextServer(engine, files, args, log) {
  const port = await pickPort();
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [engine.dir, process.env.LD_LIBRARY_PATH || ""].filter(Boolean).join(path.delimiter),
    DYLD_LIBRARY_PATH: [engine.dir, process.env.DYLD_LIBRARY_PATH || ""].filter(Boolean).join(path.delimiter),
    ELIZA_DFLASH_SKIP_SERVER_STRUCTURED_OUTPUT: "1",
  };
  const serverArgs = [
    "-m",
    files.text,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "-c",
    String(args.ctx),
    "-ngl",
    String(args.ngl),
    "-t",
    String(args.threads),
    "--no-warmup",
    "--metrics",
  ];
  const drafterReady = isRealGguf(files.drafter, 10_000_000);
  if (drafterReady) {
    serverArgs.push(
      "-md",
      files.drafter,
      "--spec-type",
      "dflash",
      "--spec-draft-n-min",
      "2",
      "--spec-draft-n-max",
      "6",
    );
  }
  log(`starting text server port=${port} text=${path.basename(files.text)} dflash=${drafterReady}`);
  const child = spawn(engine.server, serverArgs, {
    cwd: engine.dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logText = "";
  child.stdout.on("data", (chunk) => {
    logText += chunk.toString();
    if (logText.length > 20000) logText = logText.slice(-20000);
  });
  child.stderr.on("data", (chunk) => {
    logText += chunk.toString();
    if (logText.length > 20000) logText = logText.slice(-20000);
  });
  await waitHealthy(port, args.startTimeoutS, child);
  return { child, port, drafterReady, getLog: () => logText };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  await sleep(400);
  if (child.exitCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best effort for a child we started.
    }
  }
}

async function runEmbeddingProbe(engine, files, args, text, log) {
  if (args.skipEmbedding) {
    return { status: "skipped", reason: "--skip-embedding", model: files.embedding.model, mode: files.embedding.mode };
  }
  if (!isRealGguf(files.embedding.model)) {
    return { status: "unavailable", reason: "no embedding or pooled-text GGUF", model: files.embedding.model, mode: files.embedding.mode };
  }
  const port = await pickPort();
  const serverArgs = [
    "-m",
    files.embedding.model,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--ctx-size",
    String(Math.max(512, Math.min(args.ctx, 4096))),
    "--embedding",
    "--pooling",
    "last",
    "--threads",
    String(args.threads),
    "--n-gpu-layers",
    String(args.ngl),
  ];
  const child = spawn(engine.server, serverArgs, {
    cwd: engine.dir,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: [engine.dir, process.env.LD_LIBRARY_PATH || ""].filter(Boolean).join(path.delimiter),
      DYLD_LIBRARY_PATH: [engine.dir, process.env.DYLD_LIBRARY_PATH || ""].filter(Boolean).join(path.delimiter),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logText = "";
  child.stdout.on("data", (chunk) => {
    logText += chunk.toString();
    if (logText.length > 12000) logText = logText.slice(-12000);
  });
  child.stderr.on("data", (chunk) => {
    logText += chunk.toString();
    if (logText.length > 12000) logText = logText.slice(-12000);
  });
  const coldStarted = performance.now();
  try {
    await waitHealthy(port, args.startTimeoutS, child);
    const coldLoadMs = performance.now() - coldStarted;
    const started = performance.now();
    const res = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: [text || "hello there"] }),
      signal: AbortSignal.timeout(args.turnTimeoutS * 1000),
    });
    const body = await res.text();
    if (!res.ok) {
      return {
        status: "unavailable",
        reason: `/v1/embeddings HTTP ${res.status}: ${body.slice(0, 200)}`,
        model: files.embedding.model,
        mode: files.embedding.mode,
        coldLoadMs: round1(coldLoadMs),
      };
    }
    const json = JSON.parse(body);
    const embedding = json?.data?.[0]?.embedding;
    return {
      status: Array.isArray(embedding) ? "ok" : "unavailable",
      reason: Array.isArray(embedding) ? null : "embedding endpoint returned no vector",
      mode: files.embedding.mode,
      model: files.embedding.model,
      coldLoadMs: round1(coldLoadMs),
      latencyMs: round1(performance.now() - started),
      dimensions: Array.isArray(embedding) ? embedding.length : null,
    };
  } catch (err) {
    return {
      status: "unavailable",
      reason: err instanceof Error ? err.message : String(err),
      mode: files.embedding.mode,
      model: files.embedding.model,
      serverLog: logText.split("\n").slice(-80).join("\n"),
    };
  } finally {
    log(`embedding probe status check complete`);
    await stopChild(child);
  }
}

async function prepareMicInputs(args, kokoroBackend, audioDir, voiceId) {
  if (args.wavs.length > 0) {
    return args.wavs.map((file, index) => {
      const wav = readWav(file);
      return {
        file: path.resolve(file),
        sampleRate: wav.sampleRate,
        samples: wav.samples,
        refText: args.refs[index] || null,
        source: "external_wav_txt",
      };
    });
  }
  const refs = args.refs.length > 0 ? args.refs : DEFAULT_PHRASES;
  const out = [];
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const audioPath = audioDir
      ? path.join(audioDir, `kokoro-mic-${String(i + 1).padStart(2, "0")}.wav`)
      : null;
    const tts = await synthesizeKokoro(kokoroBackend, ref, voiceId, audioPath);
    const pcm16k = resampleLinear(tts.samples, tts.sampleRate, 16000);
    if (audioPath) writeWav16(audioPath, pcm16k, 16000);
    out.push({
      file: audioPath,
      sampleRate: 16000,
      samples: pcm16k,
      refText: ref,
      source: "kokoro_self_labelled_mic",
      micSynthesis: stripSamples(tts),
    });
  }
  return out;
}

function stripSamples(tts) {
  const { samples: _samples, ...rest } = tts;
  return {
    ...rest,
    wallMs: round1(rest.wallMs),
    firstChunkMs: round1(rest.firstChunkMs),
    audioSec: round2(rest.audioSec),
    rtf: round4(rest.rtf),
  };
}

async function runTurn(opts, turnIndex) {
  const {
    port,
    ffiState,
    ffiCtx,
    mic,
    args,
    kokoroBackend,
    voiceId,
    audioDir,
  } = opts;
  const turnStarted = performance.now();
  const asr = asrTranscribe(ffiState, ffiCtx, mic.samples, mic.sampleRate);
  const wer = mic.refText ? wordErrorRate(mic.refText, asr.transcript) : null;
  const before = await fetchSpecCounters(port);
  const prompt = asr.transcript || mic.refText || "hello there";
  const gen = await streamCompletion(port, prompt, args.nPredict, args.turnTimeoutS);
  const after = await fetchSpecCounters(port);
  const drafted =
    before.drafted != null && after.drafted != null ? Math.max(0, after.drafted - before.drafted) : null;
  const accepted =
    before.accepted != null && after.accepted != null ? Math.max(0, after.accepted - before.accepted) : null;
  const dflashAcceptance =
    drafted != null && accepted != null && drafted > 0 ? accepted / drafted : null;
  const generatedText = gen.content.trim();
  const ttsText = generatedText || asr.transcript || mic.refText || "hello there";
  const responsePath = audioDir
    ? path.join(audioDir, `kokoro-response-turn-${String(turnIndex).padStart(2, "0")}.wav`)
    : null;
  const ttsStartedAt = performance.now();
  const tts = await synthesizeKokoro(kokoroBackend, ttsText, voiceId, responsePath);
  const firstAudioFromMicMs =
    tts.firstChunkMs == null ? null : ttsStartedAt - turnStarted + tts.firstChunkMs;
  return {
    turn: turnIndex,
    mic: {
      file: mic.file,
      source: mic.source,
      refText: mic.refText,
      audioSec: round2(mic.samples.length / mic.sampleRate),
      sampleRate: mic.sampleRate,
      micSynthesis: mic.micSynthesis ?? null,
    },
    asr: {
      latencyMs: round1(asr.latencyMs),
      transcript: asr.transcript,
      wer: wer == null ? null : round4(wer),
    },
    gen: {
      firstTokenMs: round1(gen.firstTokenMs),
      wallMs: round1(gen.wallMs),
      decodeTokPerSec: round2(gen.decodeTokPerSec),
      predictedN: gen.predictedN,
      tokensSeen: gen.tokensSeen,
      content: generatedText,
      textGeneratedOk: generatedText.length > 0 && gen.firstTokenMs != null,
    },
    dflash: {
      drafted,
      accepted,
      acceptanceRate: round4(dflashAcceptance),
    },
    tts: stripSamples(tts),
    firstAudioFromMicMs: round1(firstAudioFromMicMs),
    totalTurnMs: round1(performance.now() - turnStarted),
  };
}

function summarize(turns, embedding, drafterReady) {
  const dflashDraftedTotal = turns.reduce((sum, turn) => sum + (turn.dflash.drafted || 0), 0);
  const dflashAcceptedTotal = turns.reduce((sum, turn) => sum + (turn.dflash.accepted || 0), 0);
  const flowCompletedOk =
    turns.length > 0 &&
    turns.every(
      (turn) =>
        turn.asr.transcript.length > 0 &&
        turn.gen.textGeneratedOk === true &&
        turn.tts.audioSec > 0,
    );
  return {
    turns: turns.length,
    flowCompletedOk,
    asrLatencyMsMedian: round1(median(turns.map((turn) => turn.asr.latencyMs))),
    asrWerMean: round4(mean(turns.map((turn) => turn.asr.wer))),
    asrWerByTurn: turns.map((turn) => turn.asr.wer),
    firstTokenMsMedian: round1(median(turns.map((turn) => turn.gen.firstTokenMs))),
    firstTokenMsP50: round1(median(turns.map((turn) => turn.gen.firstTokenMs))),
    decodeTokPerSecMedian: round2(median(turns.map((turn) => turn.gen.decodeTokPerSec))),
    firstAudioFromMicMsMedian: round1(median(turns.map((turn) => turn.firstAudioFromMicMs))),
    ttsFirstChunkMsMedian: round1(median(turns.map((turn) => turn.tts.firstChunkMs))),
    ttsRtfMedian: round4(median(turns.map((turn) => turn.tts.rtf))),
    ttsRtfMean: round4(mean(turns.map((turn) => turn.tts.rtf))),
    totalTurnMsMedian: round1(median(turns.map((turn) => turn.totalTurnMs))),
    dflashDraftedTotal,
    dflashAcceptedTotal,
    dflashAcceptanceRateOverall:
      dflashDraftedTotal > 0 ? round4(dflashAcceptedTotal / dflashDraftedTotal) : null,
    requiredOptimizations: {
      dflashDraftingActive: drafterReady ? dflashDraftedTotal > 0 : null,
      streamingTtsActive: true,
    },
    embedding,
  };
}

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const round4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);

function median(values) {
  const xs = values.filter((v) => v != null).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function mean(values) {
  const xs = values.filter((v) => v != null);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
}

function relative(file) {
  return file ? path.relative(process.cwd(), file) : null;
}

function baseReport(args, bundleDir, files, engine) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    harness: path.relative(REPO_ROOT, __filename),
    voiceLoop: {
      backend: "kokoro",
      supportedTiers: [...SMALL_TIERS],
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || null,
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
    },
    request: {
      tier: args.tier,
      backend: args.backend,
      turns: args.turns,
      nPredict: args.nPredict,
      ctx: args.ctx,
      ngl: args.ngl,
      wavs: args.wavs.length,
      refs: args.refs.length,
      skipEmbedding: args.skipEmbedding,
    },
    bundle: {
      dir: bundleDir,
      tier: files.tier,
      ramBudgetMb: files.manifest?.ramBudgetMb ?? null,
    },
    artifacts: {
      text: relative(files.text),
      drafter: relative(files.drafter),
      asr: relative(files.asr),
      asrMmproj: relative(files.asrMmproj),
      kokoroModel: relative(files.kokoro.modelPath),
      kokoroVoiceCount: files.kokoro.voices.length,
      embeddingModel: relative(files.embedding.model),
      embeddingMode: files.embedding.mode,
    },
    engine: engine.ok
      ? {
          dir: engine.dir,
          server: engine.server,
          dylib: engine.dylib,
          fused: engine.caps?.fused ?? null,
          backend: engine.caps?.backend ?? args.backend,
          kernels: engine.caps?.kernels ?? null,
        }
      : null,
  };
}

function statusFromError(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (/onnxruntime-node|Cannot find package/i.test(message)) return "needs-kokoro-runtime";
  if (/kokoro/i.test(message) && /missing|not found|sha-?256/i.test(message)) return "needs-kokoro";
  if (/llama-server|health|completion|embedding/i.test(message)) return "needs-build";
  return "failed";
}

function writeReport(report, args) {
  const reportPath = args.preflightOnly
    ? args.report || preflightReportPath(args.tier)
    : args.report || defaultReportPath(args.tier);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const withPath = {
    ...report,
    reportPath: path.relative(process.cwd(), reportPath),
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(withPath, null, 2)}\n`);
  return { ...withPath, absoluteReportPath: reportPath };
}

async function run() {
  if (typeof Bun === "undefined") {
    throw new Error("kokoro_e2e_loop_bench.mjs requires Bun");
  }
  const args = parseArgs(process.argv.slice(2));
  const log = (...parts) => {
    if (!args.quiet) console.log("[kokoro-e2e]", ...parts);
  };
  if (!SMALL_TIERS.has(args.tier)) {
    const bundleDir = path.resolve(args.bundle || defaultBundle(args.tier));
    const files = fs.existsSync(bundleDir) ? resolveBundleFiles(bundleDir, args.tier) : { tier: args.tier, manifest: null, kokoro: { voices: [] }, embedding: {} };
    const report = writeReport(
      {
        ...baseReport(args, bundleDir, files, { ok: false }),
        status: "not-applicable",
        reason: `tier ${args.tier} is not a Kokoro-only small tier`,
        e2eLoopOk: null,
      },
      args,
    );
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else log(`wrote ${report.absoluteReportPath}`);
    return report;
  }

  const bundleDir = path.resolve(args.bundle || defaultBundle(args.tier));
  if (!fs.existsSync(bundleDir)) throw new Error(`bundle dir not found: ${bundleDir}`);
  const files = resolveBundleFiles(bundleDir, args.tier);
  const engine = discoverEngine(args);
  const pre = {
    ...baseReport(args, bundleDir, files, engine),
    preflight: {
      missing: missingArtifacts(files, engine),
    },
  };
  if (pre.preflight.missing.length > 0) {
    const report = writeReport(
      {
        ...pre,
        status: engine.ok ? "needs-bundle" : "needs-build",
        reason: `missing required artifact(s): ${pre.preflight.missing.join(", ")}`,
        e2eLoopOk: false,
      },
      args,
    );
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else log(`wrote ${report.absoluteReportPath}`);
    return report;
  }
  if (args.preflightOnly) {
    const report = writeReport(
      {
        ...pre,
        status: "preflight-ok",
        reason: null,
        e2eLoopOk: null,
      },
      args,
    );
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else log(`preflight ok; wrote ${report.absoluteReportPath}`);
    return report;
  }

  const audioDir = args.saveAudio
    ? path.join(REPORTS_ROOT, "local-e2e", nowDate(), "audio", `kokoro-${args.tier}-${timestamp()}`)
    : null;
  let textServer = null;
  let ffiState = null;
  let ffiCtx = null;
  let kokoroRuntime = null;
  try {
    const voiceId = files.kokoro.voices.includes(`${args.voice}.bin`)
      ? args.voice
      : path.basename(files.kokoro.voices[0], ".bin");
    const kokoro = await createKokoro(files, voiceId);
    kokoroRuntime = kokoro.runtime;
    const micInputs = await prepareMicInputs(args, kokoro.backend, audioDir, voiceId);
    ffiState = await loadFfi(engine.dylib, engine.dir);
    ffiCtx = createFfiContext(ffiState, bundleDir);
    textServer = await startTextServer(engine, files, args, log);

    const turns = [];
    for (let i = 0; i < Math.max(1, args.turns); i += 1) {
      const mic = micInputs[i % micInputs.length];
      const turn = await runTurn(
        {
          port: textServer.port,
          ffiState,
          ffiCtx,
          mic,
          args,
          kokoroBackend: kokoro.backend,
          voiceId,
          audioDir,
        },
        i + 1,
      );
      turns.push(turn);
      log(
        `turn ${i + 1}: asr=${turn.asr.latencyMs}ms firstTok=${turn.gen.firstTokenMs}ms ttsRTF=${turn.tts.rtf} total=${turn.totalTurnMs}ms`,
      );
    }
    await stopChild(textServer.child);
    textServer = null;

    const embeddingText = turns[0]?.gen?.content || turns[0]?.asr?.transcript || turns[0]?.mic?.refText || "hello there";
    const embedding = await runEmbeddingProbe(engine, files, args, embeddingText, log);
    const summary = summarize(turns, embedding, textServer?.drafterReady ?? isRealGguf(files.drafter, 10_000_000));
    const e2eLoopOk = summary.flowCompletedOk;
    const optimizationReadyOk =
      summary.requiredOptimizations.streamingTtsActive === true &&
      (summary.requiredOptimizations.dflashDraftingActive !== false);
    const report = writeReport(
      {
        ...pre,
        status: e2eLoopOk ? (optimizationReadyOk ? "ok" : "needs-optimization") : "failed",
        reason: e2eLoopOk
          ? optimizationReadyOk
            ? null
            : "Kokoro loop completed, but DFlash drafting was not active where a drafter was present"
          : "Kokoro ASR/text/TTS loop did not complete",
        e2eLoopOk,
        thirtyTurnOk: args.turns >= 30 ? e2eLoopOk : null,
        flowCompletedOk: summary.flowCompletedOk,
        optimizationReadyOk,
        requiredOptimizations: summary.requiredOptimizations,
        voiceLoop: {
          ...pre.voiceLoop,
          backend: "kokoro",
          runtime: kokoroRuntime?.id ?? "onnx",
          voiceId,
          micInputSource: micInputs[0]?.source ?? null,
          audioDir,
        },
        summary,
        turns,
      },
      args,
    );
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
      log(`wrote ${report.absoluteReportPath}`);
      log(
        `RESULT tier=${args.tier} status=${report.status} e2eOk=${report.e2eLoopOk} ` +
          `asr=${summary.asrLatencyMsMedian}ms wer=${summary.asrWerMean} ` +
          `firstTok=${summary.firstTokenMsMedian}ms ttsRTF=${summary.ttsRtfMedian} ` +
          `embedding=${embedding.status}`,
      );
    }
    return report;
  } catch (err) {
    const report = writeReport(
      {
        ...pre,
        status: statusFromError(err),
        reason: err instanceof Error ? err.message : String(err),
        e2eLoopOk: false,
        serverExitCode: textServer?.child?.exitCode ?? null,
        serverLog: textServer?.getLog ? textServer.getLog().split("\n").slice(-100).join("\n") : null,
      },
      args,
    );
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else log(`wrote ${report.absoluteReportPath}; status=${report.status}: ${report.reason}`);
    return report;
  } finally {
    try {
      if (ffiCtx && ffiState) ffiState.s.eliza_inference_destroy(ffiCtx);
      if (ffiState?.lib?.close) ffiState.lib.close();
    } catch {
      // Best effort.
    }
    if (kokoroRuntime) {
      try {
        kokoroRuntime.dispose();
      } catch {
        // Best effort.
      }
    }
    if (textServer?.child) await stopChild(textServer.child);
  }
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error("[kokoro-e2e] FATAL:", err?.stack || String(err));
    process.exit(1);
  },
);
