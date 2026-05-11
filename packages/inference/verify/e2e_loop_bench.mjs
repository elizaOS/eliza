#!/usr/bin/env bun
/*
 * e2e_loop_bench.mjs — Eliza-1 end-to-end mic→speech voice-loop benchmark.
 *
 * Drives the *real* fused runtime — the omnivoice-grafted `llama-server`
 * (`/completion` + `/v1/audio/speech` + the in-process DFlash speculative
 * loop) and `libelizainference.{so,dylib}`'s ASR FFI — through one or more
 * complete voice turns:
 *
 *     WAV (mic) → ASR transcribe (FFI) → text generate w/ DFlash spec decode
 *       → phrase chunker → OmniVoice TTS (HTTP /v1/audio/speech) → PCM out
 *
 * It measures, per turn and aggregated:
 *   - ASR latency + WER (vs the reference text the WAV was synthesized from)
 *   - first-token latency (ASR-done → first decoded text token, SSE)
 *   - decode tokens/sec
 *   - DFlash acceptance rate (n_drafted_accepted / n_drafted from /metrics)
 *   - first-audio latency (first text token → first PCM sample of the first phrase)
 *   - TTS RTF (wall-seconds / audio-seconds)
 *   - total turn latency (mic-in → last PCM sample)
 *   - peak RSS (server VmHWM via /proc, when available)
 *   - barge-in cancel latency (in-flight TTS HTTP request abort → stop consuming)
 *
 * `--turns 30` runs the 30-turn endurance variant: 30 loops, asserts no
 * crash / no monotone RSS leak, and asserts peak RSS stays inside the
 * manifest's `ramBudgetMb.recommended`.
 *
 * Hard requirements (per packages/inference/AGENTS.md §4 / §8): one process,
 * one llama.cpp build, one GGML pin — text + DFlash + TTS all in the fused
 * `llama-server`; ASR via the fused FFI library; no second model process.
 *
 * Honesty: a backend whose fused build is not installed, or a bundle whose
 * artifacts are missing, produces `status: "needs-bundle"` / `"needs-build"`
 * with a reason and null metrics — never a fabricated pass.
 *
 *   bun packages/inference/verify/e2e_loop_bench.mjs \
 *     --bundle ~/.eliza/local-inference/models/eliza-1-0_6b.bundle \
 *     --tier 0_6b --backend cpu [--turns 1] [--wav a.wav,b.wav] [--report out.json]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    bundle: process.env.ELIZA_E2E_BUNDLE || "",
    tier: process.env.ELIZA_E2E_TIER || "",
    backend: process.env.ELIZA_E2E_BACKEND || "cpu", // cpu | vulkan | cuda
    binDir: process.env.ELIZA_E2E_BIN_DIR || "",
    wavs: (process.env.ELIZA_E2E_WAVS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    turns: Number.parseInt(process.env.ELIZA_E2E_TURNS || "1", 10),
    nPredict: Number.parseInt(process.env.ELIZA_E2E_N_PREDICT || "40", 10),
    threads: Number.parseInt(
      process.env.ELIZA_E2E_THREADS || String(Math.min(os.cpus().length, 12)),
      10,
    ),
    ctx: Number.parseInt(process.env.ELIZA_E2E_CTX || "2048", 10),
    ngl: process.env.ELIZA_E2E_NGL || "0",
    startTimeoutS: Number.parseInt(
      process.env.ELIZA_E2E_START_TIMEOUT || "180",
      10,
    ),
    turnTimeoutS: Number.parseInt(
      process.env.ELIZA_E2E_TURN_TIMEOUT || "240",
      10,
    ),
    report: process.env.ELIZA_E2E_REPORT || "",
    quiet: process.env.ELIZA_E2E_QUIET === "1",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    if (a === "--bundle" || a === "--bundle-dir") args.bundle = next();
    else if (a === "--tier") args.tier = next();
    else if (a === "--backend") args.backend = next();
    else if (a === "--bin-dir") args.binDir = next();
    else if (a === "--wav" || a === "--wavs")
      args.wavs = next()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--turns") args.turns = Number.parseInt(next(), 10);
    else if (a === "--n-predict") args.nPredict = Number.parseInt(next(), 10);
    else if (a === "--threads") args.threads = Number.parseInt(next(), 10);
    else if (a === "--ctx") args.ctx = Number.parseInt(next(), 10);
    else if (a === "--ngl") args.ngl = next();
    else if (a === "--report") args.report = next();
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: bun packages/inference/verify/e2e_loop_bench.mjs --bundle <dir> --tier <id> [--backend cpu|vulkan|cuda] [--turns N] [--wav a,b] [--report out.json]",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const log = (q) => (...m) => {
  if (!q) console.log("[e2e-loop]", ...m);
};

// --------------------------------------------------------------------------
// Discovery
// --------------------------------------------------------------------------

function stateRoot() {
  return (
    process.env.ELIZA_STATE_DIR?.trim() ||
    process.env.MILADY_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".eliza")
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

/**
 * Find the fused `llama-server` build dir for the requested backend. We
 * require a *fused* build (`fused: true` in CAPABILITIES.json) because the
 * AGENTS.md §4 contract is one fused process — a stock build can't serve
 * `/v1/audio/speech`.
 */
function discoverEngine(backend, explicitBinDir) {
  const root = path.join(stateRoot(), "local-inference", "bin", "dflash");
  if (explicitBinDir) {
    return validateEngineDir(explicitBinDir, backend);
  }
  if (!fs.existsSync(root)) {
    return { ok: false, reason: `${root} does not exist (no managed builds)` };
  }
  const plat = platformTag();
  const prefer = `${plat}-${backend}-fused`;
  const dirs = fs
    .readdirSync(root)
    .filter((d) => fs.statSync(path.join(root, d)).isDirectory())
    .filter((d) => d.startsWith(plat));
  // Exact backend-fused first, then any fused on this platform.
  const exact = dirs.find((d) => d === prefer);
  const anyFused = dirs.filter((d) => d.includes("-fused"));
  const pick = exact || anyFused.find((d) => d.includes(`-${backend}-`)) || anyFused[0];
  if (!pick) {
    return {
      ok: false,
      reason: `no fused build dir for ${plat} backend=${backend} under ${root} (have: ${dirs.join(", ") || "none"})`,
    };
  }
  return validateEngineDir(path.join(root, pick), backend);
}

function validateEngineDir(dir, backend) {
  const server = path.join(dir, "llama-server");
  const lib = path.join(dir, libName());
  if (!fs.existsSync(server)) {
    return { ok: false, reason: `${server} missing (not a built fused dir)` };
  }
  let caps = null;
  const capsPath = path.join(dir, "CAPABILITIES.json");
  if (fs.existsSync(capsPath)) {
    try {
      caps = JSON.parse(fs.readFileSync(capsPath, "utf8"));
    } catch {
      caps = null;
    }
  }
  const fused = caps?.fused === true || (caps?.omnivoice ?? null) !== null || dir.includes("-fused");
  if (!fused) {
    return { ok: false, reason: `${dir} is not an omnivoice-fused build (no /v1/audio/speech route)` };
  }
  return {
    ok: true,
    dir,
    server,
    lib: fs.existsSync(lib) ? lib : null,
    speculative: fs.existsSync(path.join(dir, "llama-speculative-simple"))
      ? path.join(dir, "llama-speculative-simple")
      : null,
    backend: caps?.backend || backend,
    caps,
  };
}

function firstExisting(...c) {
  return c.find((p) => p && fs.existsSync(p)) || null;
}

function bundleFiles(bundleDir, tier) {
  const text = firstExisting(
    ...fs
      .readdirSync(path.join(bundleDir, "text"))
      .filter((f) => f.endsWith(".gguf"))
      .sort()
      .map((f) => path.join(bundleDir, "text", f)),
  );
  const drafter = firstExisting(
    ...fs
      .readdirSync(path.join(bundleDir, "dflash"))
      .filter((f) => f.endsWith(".gguf"))
      .map((f) => path.join(bundleDir, "dflash", f)),
  );
  const ttsDir = path.join(bundleDir, "tts");
  const ttsGgufs = fs.existsSync(ttsDir)
    ? fs.readdirSync(ttsDir).filter((f) => f.endsWith(".gguf"))
    : [];
  const ttsTok = ttsGgufs.find((f) => /token/i.test(f));
  const ttsBase = ttsGgufs.find((f) => !/token/i.test(f)) || ttsGgufs[0];
  let manifest = null;
  const manifestPath = path.join(bundleDir, "eliza-1.manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      manifest = null;
    }
  }
  return {
    text,
    drafter,
    ttsModel: ttsBase ? path.join(ttsDir, ttsBase) : null,
    ttsCodec: ttsTok ? path.join(ttsDir, ttsTok) : null,
    asr: firstExisting(
      path.join(bundleDir, "asr", "eliza-1-asr.gguf"),
      ...(fs.existsSync(path.join(bundleDir, "asr"))
        ? fs
            .readdirSync(path.join(bundleDir, "asr"))
            .filter((f) => f.endsWith(".gguf") && !/mmproj/i.test(f))
            .map((f) => path.join(bundleDir, "asr", f))
        : []),
    ),
    manifest,
    tier: manifest?.tier || tier,
    ramRecommendedMb: manifest?.ramBudgetMb?.recommended ?? null,
    ramMinMb: manifest?.ramBudgetMb?.min ?? null,
  };
}

function isRealGguf(p, minBytes = 1_000_000) {
  if (!p || !fs.existsSync(p)) return false;
  try {
    if (fs.statSync(p).size < minBytes) return false;
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf.toString("utf8") === "GGUF";
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// WAV helpers (16-bit PCM read/write + simple linear resample)
// --------------------------------------------------------------------------

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
    const sz = buf.readUInt32LE(off + 4);
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
      dataLen = sz;
    }
    off = body + sz + (sz % 2);
  }
  if (!fmt || dataOff < 0) throw new Error(`${file}: missing fmt/data chunk`);
  if (fmt.bitsPerSample !== 16) {
    throw new Error(`${file}: only 16-bit PCM supported (got ${fmt.bitsPerSample})`);
  }
  const nFrames = Math.floor(dataLen / 2 / fmt.channels);
  const mono = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i += 1) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c += 1) {
      acc += buf.readInt16LE(dataOff + (i * fmt.channels + c) * 2);
    }
    mono[i] = acc / fmt.channels / 32768;
  }
  return { sampleRate: fmt.sampleRate, samples: mono };
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

function writeWav16(file, samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

// --------------------------------------------------------------------------
// WER (Levenshtein over normalized word lists)
// --------------------------------------------------------------------------

function normalizeWords(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
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
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[r.length][h.length] / r.length;
}

// --------------------------------------------------------------------------
// Phrase chunker — punctuation boundary + max-token cap (mirrors the runtime
// phrase-chunker contract: punctuation OR an N-token cap).
// --------------------------------------------------------------------------

function chunkPhrases(text, maxTokens = 8) {
  const out = [];
  const parts = text.split(/([.!?,;:]+)/);
  let cur = "";
  let tokCount = 0;
  const flush = () => {
    const t = cur.trim();
    if (t) out.push(t);
    cur = "";
    tokCount = 0;
  };
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i];
    if (!seg) continue;
    if (/^[.!?,;:]+$/.test(seg)) {
      cur += seg;
      flush();
      continue;
    }
    const words = seg.split(/\s+/).filter(Boolean);
    for (const w of words) {
      cur += (cur && !/\s$/.test(cur) ? " " : "") + w;
      tokCount += 1;
      if (tokCount >= maxTokens) flush();
    }
  }
  flush();
  return out.length ? out : [text.trim()].filter(Boolean);
}

// --------------------------------------------------------------------------
// FFI: libelizainference ASR + TTS-cancel (bun:ffi)
// --------------------------------------------------------------------------

async function loadFfi(libPath, libDir) {
  // Bun re-exports libllama symbols through libelizainference; the SONAMEd
  // deps live next to it. Set DYLD/LD path so the loader resolves them.
  const sep = path.delimiter;
  const cur = process.env.LD_LIBRARY_PATH || "";
  process.env.LD_LIBRARY_PATH = cur ? `${libDir}${sep}${cur}` : libDir;
  if (process.platform === "darwin") {
    const c2 = process.env.DYLD_LIBRARY_PATH || "";
    process.env.DYLD_LIBRARY_PATH = c2 ? `${libDir}${sep}${c2}` : libDir;
  }
  const ffi = await import("bun:ffi");
  const T = ffi.FFIType;
  const lib = ffi.dlopen(libPath, {
    eliza_inference_abi_version: { args: [], returns: T.cstring },
    eliza_inference_create: { args: [T.cstring, T.ptr], returns: T.ptr },
    eliza_inference_destroy: { args: [T.ptr], returns: T.void },
    eliza_inference_mmap_acquire: { args: [T.ptr, T.cstring, T.ptr], returns: T.i32 },
    eliza_inference_mmap_evict: { args: [T.ptr, T.cstring, T.ptr], returns: T.i32 },
    eliza_inference_asr_transcribe: {
      args: [T.ptr, T.ptr, T.usize, T.i32, T.ptr, T.usize, T.ptr],
      returns: T.i32,
    },
    eliza_inference_tts_synthesize: {
      args: [T.ptr, T.cstring, T.usize, T.ptr, T.ptr, T.usize, T.ptr],
      returns: T.i32,
    },
    eliza_inference_tts_stream_supported: { args: [], returns: T.i32 },
    eliza_inference_cancel_tts: { args: [T.ptr, T.ptr], returns: T.i32 },
    eliza_inference_free_string: { args: [T.usize], returns: T.void },
  });
  const s = lib.symbols;
  const abi = s.eliza_inference_abi_version();
  return { ffi, lib, s, abi: typeof abi === "string" ? abi : String(abi) };
}

function readErrAndFree(ffi, s, ptrBuf) {
  // ptrBuf is a 8-byte buffer holding the out_error char* the C side wrote.
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
    /* leave default */
  }
  try {
    s.eliza_inference_free_string(p);
  } catch {
    /* best-effort */
  }
  return msg;
}

// --------------------------------------------------------------------------
// HTTP helpers against the fused llama-server
// --------------------------------------------------------------------------

async function httpJson(url, body, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

async function waitHealthy(port, timeoutS, child, logFn) {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`llama-server exited (code ${child.exitCode}) before becoming healthy`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.status === 200) {
        const j = await r.json().catch(() => ({}));
        if (j.status === "ok") return true;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`llama-server not healthy after ${timeoutS}s`);
}

async function fetchSpecCounters(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/metrics`, {
      signal: AbortSignal.timeout(3000),
    });
    if (r.status !== 200) return { drafted: null, accepted: null };
    const t = await r.text();
    const m = (re) => {
      const x = t.match(re);
      return x ? Number(x[1]) : null;
    };
    return {
      drafted: m(/llamacpp:n_drafted_total\s+([\d.]+)/),
      accepted: m(/llamacpp:n_drafted_accepted_total\s+([\d.]+)/),
    };
  } catch {
    return { drafted: null, accepted: null };
  }
}

function peakRssMb(pid) {
  if (process.platform !== "linux") return null;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/VmHWM:\s+(\d+)\s+kB/);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// SSE streaming completion — measures first-token + decode tok/s
// --------------------------------------------------------------------------

async function streamCompletion(port, prompt, nPredict, turnTimeoutS) {
  const t0 = performance.now();
  let firstTokenMs = null;
  let content = "";
  let tokensSeen = 0;
  let timings = null;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), turnTimeoutS * 1000);
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
      const t = await res.text().catch(() => "");
      throw new Error(`/completion HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const ev = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of ev.split("\n")) {
          const l = line.trim();
          if (!l.startsWith("data:")) continue;
          const payload = l.slice(5).trim();
          if (payload === "[DONE]") continue;
          let obj;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue;
          }
          if (typeof obj.content === "string" && obj.content.length) {
            if (firstTokenMs === null) firstTokenMs = performance.now() - t0;
            content += obj.content;
            tokensSeen += 1;
          }
          if (obj.timings) timings = obj.timings;
          if (obj.stop === true || obj.stopped_eos || obj.stopped_limit) {
            if (obj.timings) timings = obj.timings;
          }
        }
      }
    }
  } finally {
    clearTimeout(to);
  }
  const wallMs = performance.now() - t0;
  return {
    content: content.trim(),
    firstTokenMs,
    tokensSeen,
    wallMs,
    decodeTokPerSec: timings?.predicted_per_second ?? (tokensSeen > 0 ? (tokensSeen * 1000) / wallMs : null),
    predictedN: timings?.predicted_n ?? tokensSeen,
    promptTokPerSec: timings?.prompt_per_second ?? null,
  };
}

// --------------------------------------------------------------------------
// TTS phrase synthesis via /v1/audio/speech (raw f32 PCM)
// --------------------------------------------------------------------------

async function synthPhrasePcm(port, text, turnTimeoutS) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), turnTimeoutS * 1000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: text, response_format: "pcm" }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`/v1/audio/speech HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const sr = Number(res.headers.get("x-sample-rate") || "24000");
    const ab = await res.arrayBuffer();
    const wallMs = performance.now() - t0;
    const samples = new Float32Array(ab);
    const audioSec = samples.length / sr;
    return { sampleRate: sr, samples, audioSec, wallMs, rtf: audioSec > 0 ? wallMs / 1000 / audioSec : null };
  } finally {
    clearTimeout(to);
  }
}

// --------------------------------------------------------------------------
// One voice turn
// --------------------------------------------------------------------------

async function runTurn(opts, turnIdx) {
  const { port, ffiCtx, ffi, s, wav, refText, nPredict, turnTimeoutS, logFn } = opts;
  const turnT0 = performance.now();

  // 1) ASR: feed the WAV's mono PCM (resampled to 16 kHz) to the FFI.
  const pcm16k = resampleLinear(wav.samples, wav.sampleRate, 16000);
  const pcmBuf = Buffer.from(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength);
  const outBytes = 4096;
  const outBuf = Buffer.alloc(outBytes);
  const errBuf = Buffer.alloc(8);
  errBuf.fill(0);
  const asrT0 = performance.now();
  const rc = s.eliza_inference_asr_transcribe(
    ffiCtx,
    ffi.ptr(pcmBuf),
    BigInt(pcm16k.length),
    16000,
    ffi.ptr(outBuf),
    BigInt(outBytes),
    ffi.ptr(errBuf),
  );
  const asrMs = performance.now() - asrT0;
  if (rc < 0) {
    throw new Error(`asr_transcribe rc=${rc}: ${readErrAndFree(ffi, s, errBuf)}`);
  }
  const transcript = outBuf.toString("utf8", 0, rc).trim();
  const wer = refText ? wordErrorRate(refText, transcript) : null;
  logFn(`turn ${turnIdx}: ASR ${asrMs.toFixed(0)}ms -> ${JSON.stringify(transcript)} (wer=${wer == null ? "n/a" : wer.toFixed(3)})`);

  // 2) Text generation with DFlash spec decoding (counters reset by diffing /metrics).
  const before = await fetchSpecCounters(port);
  const prompt = transcript.length > 0 ? transcript : (refText || "Hello.");
  const gen = await streamCompletion(port, prompt, nPredict, turnTimeoutS);
  const after = await fetchSpecCounters(port);
  let dflashAccept = null;
  let dDrafted = null;
  let dAccepted = null;
  if (
    before.drafted != null &&
    after.drafted != null &&
    before.accepted != null &&
    after.accepted != null
  ) {
    dDrafted = after.drafted - before.drafted;
    dAccepted = after.accepted - before.accepted;
    if (dDrafted > 0) dflashAccept = dAccepted / dDrafted;
  }
  logFn(
    `turn ${turnIdx}: gen firstTok=${gen.firstTokenMs == null ? "n/a" : gen.firstTokenMs.toFixed(0)}ms tok/s=${gen.decodeTokPerSec == null ? "n/a" : gen.decodeTokPerSec.toFixed(1)} n=${gen.predictedN} dflash=${dflashAccept == null ? "n/a" : `${dAccepted}/${dDrafted}=${dflashAccept.toFixed(3)}`}`,
  );

  // 3) Phrase chunker + 4) TTS per phrase. First-audio = ASR-done → first PCM
  //    sample of the first phrase (the streaming-handoff latency the runtime
  //    optimizes); also report it relative to the first text token.
  const phrases = chunkPhrases(gen.content || prompt);
  const ttsRuns = [];
  let firstPhrasePcm = null;
  const ttsLoopT0 = performance.now();
  for (const ph of phrases) {
    const r = await synthPhrasePcm(port, ph, turnTimeoutS);
    ttsRuns.push({ phrase: ph, audioSec: r.audioSec, wallMs: r.wallMs, rtf: r.rtf });
    if (firstPhrasePcm === null) firstPhrasePcm = r;
  }
  const ttsTotalWallMs = performance.now() - ttsLoopT0;
  const totalAudioSec = ttsRuns.reduce((a, r) => a + r.audioSec, 0);
  const ttsRtf = totalAudioSec > 0 ? ttsTotalWallMs / 1000 / totalAudioSec : null;
  // first-audio relative to mic-in (ASR start) and to first text token.
  const firstAudioFromMicMs = ttsLoopT0 - turnT0 + (firstPhrasePcm ? firstPhrasePcm.wallMs : 0);
  // Approximate: we can't tap the mid-stream PCM-sample timestamp through
  // the batch HTTP route, so first-audio is "first phrase fully synthesized"
  // — the conservative end of the streaming-handoff window. Documented.
  const firstAudioFromTokenMs =
    gen.firstTokenMs == null ? null : firstAudioFromMicMs - asrMs - gen.firstTokenMs;

  const totalTurnMs = performance.now() - turnT0;
  logFn(
    `turn ${turnIdx}: ${phrases.length} phrase(s) audio=${totalAudioSec.toFixed(2)}s RTF=${ttsRtf == null ? "n/a" : ttsRtf.toFixed(2)} firstAudio≈${firstAudioFromMicMs.toFixed(0)}ms total=${totalTurnMs.toFixed(0)}ms`,
  );

  return {
    turn: turnIdx,
    asr: { latencyMs: round1(asrMs), transcript, wer: wer == null ? null : round4(wer) },
    gen: {
      firstTokenMs: gen.firstTokenMs == null ? null : round1(gen.firstTokenMs),
      decodeTokPerSec: gen.decodeTokPerSec == null ? null : round2(gen.decodeTokPerSec),
      predictedN: gen.predictedN,
      promptTokPerSec: gen.promptTokPerSec == null ? null : round2(gen.promptTokPerSec),
      content: gen.content,
    },
    dflash: {
      drafted: dDrafted,
      accepted: dAccepted,
      acceptanceRate: dflashAccept == null ? null : round4(dflashAccept),
    },
    tts: {
      phrases: phrases.length,
      audioSec: round2(totalAudioSec),
      wallMs: round1(ttsTotalWallMs),
      rtf: ttsRtf == null ? null : round4(ttsRtf),
      perPhrase: ttsRuns.map((r) => ({ ...r, audioSec: round2(r.audioSec), wallMs: round1(r.wallMs), rtf: r.rtf == null ? null : round4(r.rtf) })),
    },
    firstAudioFromMicMs: round1(firstAudioFromMicMs),
    firstAudioFromTokenMs: firstAudioFromTokenMs == null ? null : round1(firstAudioFromTokenMs),
    totalTurnMs: round1(totalTurnMs),
  };
}

// --------------------------------------------------------------------------
// Barge-in cancel latency. Two probes:
//  (a) HTTP: start a long TTS request, abort the fetch, time how fast we
//      stop consuming (the "PCM ring buffer drains immediately" surrogate
//      on the client/sink side — what a real mic-detected-speech barge-in
//      does to the playback path).
//  (b) FFI: if the build implements streaming TTS, kick a stream and call
//      eliza_inference_cancel_tts; otherwise record it as unsupported (the
//      ABI v2 streaming/cancel symbols are stubbed on the batch-only build).
// --------------------------------------------------------------------------

async function measureBargeIn(port, ffiCtx, ffi, s) {
  // (a) client-side abort latency
  const longText =
    "Here is a fairly long answer that I will keep speaking for several seconds so that we can interrupt it partway through and measure how quickly the audio path stops consuming bytes after the barge in signal arrives.";
  const ctrl = new AbortController();
  const reqP = fetch(`http://127.0.0.1:${port}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: longText, response_format: "pcm" }),
    signal: ctrl.signal,
  }).catch((e) => ({ aborted: true, err: String(e) }));
  // Let it get going, then "barge in".
  await new Promise((r) => setTimeout(r, 60));
  const cancelT0 = performance.now();
  ctrl.abort();
  await reqP; // resolves immediately on abort
  const httpAbortMs = performance.now() - cancelT0;

  // (b) native cancel
  let ttsStreamSupported = false;
  let nativeCancelMs = null;
  let nativeCancelRc = null;
  try {
    ttsStreamSupported = s.eliza_inference_tts_stream_supported() === 1;
  } catch {
    ttsStreamSupported = false;
  }
  // cancel_tts is always safe to call (cancelling nothing is not an error).
  try {
    const errBuf = Buffer.alloc(8);
    errBuf.fill(0);
    const c0 = performance.now();
    nativeCancelRc = s.eliza_inference_cancel_tts(ffiCtx, ffi.ptr(errBuf));
    nativeCancelMs = performance.now() - c0;
  } catch {
    nativeCancelRc = null;
  }
  return {
    httpAbortMs: round2(httpAbortMs),
    nativeCancelMs: nativeCancelMs == null ? null : round2(nativeCancelMs),
    nativeCancelRc,
    ttsStreamSupported,
    note: ttsStreamSupported
      ? "build implements streaming TTS — cancel_tts hard-stops an in-flight forward pass at the next kernel boundary"
      : "batch-only TTS build (eliza_inference_tts_stream_supported()==0); barge-in measured as the client/sink-side HTTP abort latency (the PCM-ring-drain surrogate). cancel_tts is a no-op here.",
  };
}

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const round4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);

function median(xs) {
  const v = xs.filter((x) => x != null).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function mean(xs) {
  const v = xs.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function maxOf(xs) {
  const v = xs.filter((x) => x != null);
  return v.length ? Math.max(...v) : null;
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

function nowTag() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const logFn = log(args.quiet);
  if (typeof Bun === "undefined") {
    throw new Error("e2e_loop_bench.mjs requires Bun (bun:ffi for the ASR/TTS-cancel calls)");
  }
  if (!args.bundle) throw new Error("--bundle <dir> is required");
  const bundleDir = path.resolve(args.bundle);
  if (!fs.existsSync(bundleDir)) throw new Error(`bundle dir not found: ${bundleDir}`);

  const engine = discoverEngine(args.backend, args.binDir);
  const files = bundleFiles(bundleDir, args.tier);
  const tier = files.tier || args.tier || "unknown";

  const baseReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    harness: path.relative(REPO_ROOT, __filename),
    host: {
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || null,
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
    },
    request: { tier, backend: args.backend, turns: args.turns, nPredict: args.nPredict },
    bundle: { dir: bundleDir, tier, ramBudgetMb: files.manifest?.ramBudgetMb ?? null },
    engine: engine.ok ? { dir: engine.dir, backend: engine.backend, fused: true, caps: engine.caps?.kernels ?? null } : null,
  };

  // Preconditions — produce honest needs-* statuses, not fake passes.
  if (!engine.ok) {
    const out = { ...baseReport, status: "needs-build", reason: `no fused ${args.backend} build: ${engine.reason}`, e2eLoopOk: false };
    return finish(out, args, logFn);
  }
  if (!engine.lib) {
    const out = { ...baseReport, status: "needs-build", reason: `fused build at ${engine.dir} has no ${libName()} (ASR FFI library missing)`, e2eLoopOk: false };
    return finish(out, args, logFn);
  }
  if (!isRealGguf(files.text) || !isRealGguf(files.drafter, 10_000_000) || !isRealGguf(files.ttsModel) || !isRealGguf(files.ttsCodec) || !isRealGguf(files.asr, 1_000_000)) {
    const out = {
      ...baseReport,
      status: "needs-bundle",
      reason: "bundle is missing one of text/drafter/tts-model/tts-codec/asr GGUFs (stand-in or incomplete)",
      bundleArtifacts: {
        text: !!isRealGguf(files.text),
        drafter: !!isRealGguf(files.drafter, 10_000_000),
        ttsModel: !!isRealGguf(files.ttsModel),
        ttsCodec: !!isRealGguf(files.ttsCodec),
        asr: !!isRealGguf(files.asr, 1_000_000),
      },
      e2eLoopOk: false,
    };
    return finish(out, args, logFn);
  }

  // --- Pick / generate the mic WAVs. If none supplied, synthesize reference
  //     phrases via the fused TTS route (24 kHz f32 → 16 kHz 16-bit WAV) and
  //     use them as the "mic" input. Reference text drives WER.
  const REF_PHRASES = [
    "What is the capital of France?",
    "Schedule a meeting for tomorrow at three in the afternoon.",
    "Tell me a short fact about the ocean.",
  ];
  let micWavs = []; // { file, samples, sampleRate, refText }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-e2e-mic-"));
  let serverChild = null;
  let port = 0;
  let ffiState = null;
  let ffiCtx = null;
  try {
    // --- start the fused llama-server (text + drafter + omnivoice) ---
    port = 30000 + Math.floor(Math.random() * 20000);
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: `${engine.dir}${path.delimiter}${process.env.LD_LIBRARY_PATH || ""}`,
      DYLD_LIBRARY_PATH: `${engine.dir}${path.delimiter}${process.env.DYLD_LIBRARY_PATH || ""}`,
      ELIZA_OMNIVOICE_MODEL: files.ttsModel,
      ELIZA_OMNIVOICE_CODEC: files.ttsCodec,
      ELIZA_DFLASH_SKIP_SERVER_STRUCTURED_OUTPUT: "1",
    };
    const serverArgs = [
      "-m", files.text,
      "-md", files.drafter,
      "--spec-type", "dflash",
      "--draft-min", "2", "--draft-max", "6",
      "--port", String(port),
      "-c", String(args.ctx), "-cd", String(args.ctx),
      "-ngl", String(args.ngl),
      "-t", String(args.threads),
      "--no-warmup",
      "--metrics",
    ];
    logFn(`starting fused llama-server: ${path.basename(engine.dir)} port=${port} text=${path.basename(files.text)} drafter=${path.basename(files.drafter)}`);
    const srvLog = fs.createWriteStream(path.join(tmpDir, "server.log"));
    serverChild = spawn(engine.server, serverArgs, { cwd: engine.dir, env, stdio: ["ignore", "pipe", "pipe"] });
    serverChild.stdout.pipe(srvLog);
    serverChild.stderr.pipe(srvLog);
    await waitHealthy(port, args.startTimeoutS, serverChild, logFn);
    logFn(`server healthy (pid ${serverChild.pid})`);

    // --- synthesize mic WAVs if none supplied ---
    if (args.wavs.length > 0) {
      for (const w of args.wavs) {
        const wav = readWav(w);
        micWavs.push({ file: w, samples: wav.samples, sampleRate: wav.sampleRate, refText: null });
      }
    } else {
      for (let i = 0; i < REF_PHRASES.length; i += 1) {
        const ph = REF_PHRASES[i];
        const r = await synthPhrasePcm(port, ph, args.turnTimeoutS);
        const w16 = resampleLinear(r.samples, r.sampleRate, 16000);
        const file = path.join(tmpDir, `mic-${i}.wav`);
        writeWav16(file, w16, 16000);
        micWavs.push({ file, samples: w16, sampleRate: 16000, refText: ph });
        logFn(`synthesized mic WAV ${i}: ${ph.slice(0, 40)}... (${r.audioSec.toFixed(2)}s)`);
      }
    }
    if (micWavs.length === 0) throw new Error("no mic WAVs available (synthesis produced nothing)");

    // --- FFI: create the inference context anchored at the bundle ---
    ffiState = await loadFfi(engine.lib, engine.dir);
    logFn(`libelizainference ABI=${ffiState.abi}`);
    const { ffi, s } = ffiState;
    {
      const errBuf = Buffer.alloc(8);
      errBuf.fill(0);
      ffiCtx = s.eliza_inference_create(Buffer.from(`${bundleDir}\0`, "utf8"), ffi.ptr(errBuf));
      if (!ffiCtx || (typeof ffiCtx === "bigint" && ffiCtx === 0n)) {
        throw new Error(`eliza_inference_create failed: ${readErrAndFree(ffi, s, errBuf)}`);
      }
    }
    // Acquire the ASR + TTS regions (voice-on). text/dflash are kept hot by
    // the library itself; acquire is idempotent.
    for (const region of ["text", "dflash", "asr", "tts"]) {
      const errBuf = Buffer.alloc(8);
      errBuf.fill(0);
      const rc = s.eliza_inference_mmap_acquire(ffiCtx, Buffer.from(`${region}\0`, "utf8"), ffi.ptr(errBuf));
      if (rc < 0) {
        const msg = readErrAndFree(ffi, s, errBuf);
        // text/dflash on the library are best-effort warm hints; only asr is mandatory for this bench.
        if (region === "asr") throw new Error(`mmap_acquire("asr") rc=${rc}: ${msg}`);
        logFn(`mmap_acquire("${region}") rc=${rc} (non-fatal): ${msg}`);
      }
    }

    // --- run the turns ---
    const turnReports = [];
    let bargeIn = null;
    const rssSamples = [];
    const totalTurns = Math.max(1, args.turns);
    for (let t = 0; t < totalTurns; t += 1) {
      const mic = micWavs[t % micWavs.length];
      const turnReport = await runTurn(
        { port, ffiCtx, ffi, s, wav: mic, refText: mic.refText, nPredict: args.nPredict, turnTimeoutS: args.turnTimeoutS, logFn },
        t + 1,
      );
      turnReports.push(turnReport);
      const rss = peakRssMb(serverChild.pid);
      if (rss != null) {
        rssSamples.push(rss);
        turnReport.serverPeakRssMb = rss;
      }
      // measure barge-in once, around turn 1 (cheap, doesn't disturb the loop)
      if (t === 0) bargeIn = await measureBargeIn(port, ffiCtx, ffi, s);
      if (serverChild.exitCode !== null) {
        throw new Error(`llama-server died mid-loop (exit ${serverChild.exitCode}) at turn ${t + 1}`);
      }
    }

    const finalPeakRss = peakRssMb(serverChild.pid);
    const peakRss = maxOf([...rssSamples, finalPeakRss]);
    const ramRec = files.manifest?.ramBudgetMb?.recommended ?? null;
    // Endurance leak heuristic: the RSS in the last quarter of the run should
    // not be dramatically (>1.5×) above the RSS in the first quarter.
    let leakSuspected = false;
    if (totalTurns >= 8 && rssSamples.length >= 8) {
      const q = Math.floor(rssSamples.length / 4);
      const firstQ = mean(rssSamples.slice(0, q));
      const lastQ = mean(rssSamples.slice(-q));
      if (firstQ != null && lastQ != null && lastQ > firstQ * 1.5) leakSuspected = true;
    }
    const ramWithinBudget = ramRec == null ? null : peakRss == null ? null : peakRss <= ramRec;

    const summary = {
      turns: totalTurns,
      asrLatencyMsMedian: round1(median(turnReports.map((r) => r.asr.latencyMs))),
      asrWerMean: round4(mean(turnReports.map((r) => r.asr.wer))),
      asrWerByTurn: turnReports.map((r) => r.asr.wer),
      firstTokenMsMedian: round1(median(turnReports.map((r) => r.gen.firstTokenMs))),
      firstTokenMsP50: round1(median(turnReports.map((r) => r.gen.firstTokenMs))),
      decodeTokPerSecMedian: round2(median(turnReports.map((r) => r.gen.decodeTokPerSec))),
      dflashAcceptanceRateMean: round4(mean(turnReports.map((r) => r.dflash.acceptanceRate))),
      dflashDraftedTotal: turnReports.reduce((a, r) => a + (r.dflash.drafted || 0), 0),
      dflashAcceptedTotal: turnReports.reduce((a, r) => a + (r.dflash.accepted || 0), 0),
      firstAudioFromMicMsMedian: round1(median(turnReports.map((r) => r.firstAudioFromMicMs))),
      firstAudioFromTokenMsMedian: round1(median(turnReports.map((r) => r.firstAudioFromTokenMs))),
      ttsRtfMedian: round4(median(turnReports.map((r) => r.tts.rtf))),
      ttsRtfMean: round4(mean(turnReports.map((r) => r.tts.rtf))),
      totalTurnMsMedian: round1(median(turnReports.map((r) => r.totalTurnMs))),
      bargeInCancelMs: bargeIn ? bargeIn.httpAbortMs : null,
      serverPeakRssMb: peakRss,
      ramBudgetRecommendedMb: ramRec,
      ramWithinBudget,
      leakSuspected,
    };
    const dflashOverall =
      summary.dflashDraftedTotal > 0 ? round4(summary.dflashAcceptedTotal / summary.dflashDraftedTotal) : null;
    summary.dflashAcceptanceRateOverall = dflashOverall;

    const e2eLoopOk = turnReports.length > 0 &&
      turnReports.every((r) => r.gen.firstTokenMs != null && r.tts.audioSec != null && r.tts.audioSec > 0 && r.totalTurnMs != null);
    const thirtyTurnOk = totalTurns >= 30 ? e2eLoopOk && !leakSuspected && (ramWithinBudget !== false) : null;

    const out = {
      ...baseReport,
      status: "ok",
      e2eLoopOk,
      thirtyTurnOk,
      summary,
      bargeIn,
      turns: turnReports,
      serverLog: fs.existsSync(path.join(tmpDir, "server.log"))
        ? fs.readFileSync(path.join(tmpDir, "server.log"), "utf8").split("\n").slice(-30).join("\n")
        : null,
    };
    return finish(out, args, logFn);
  } finally {
    // teardown FFI then server
    try {
      if (ffiCtx && ffiState) {
        const { s } = ffiState;
        try { s.eliza_inference_destroy(ffiCtx); } catch { /* best-effort */ }
      }
      if (ffiState?.lib?.close) ffiState.lib.close();
    } catch { /* best-effort */ }
    if (serverChild && serverChild.exitCode === null) {
      try { serverChild.kill("SIGTERM"); } catch { /* best-effort */ }
      await new Promise((r) => setTimeout(r, 300));
      if (serverChild.exitCode === null) {
        try { serverChild.kill("SIGKILL"); } catch { /* best-effort */ }
      }
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function finish(report, args, logFn) {
  const reportPath =
    args.report ||
    path.join(__dirname, "bench_results", `e2e_loop_${nowTag()}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  // Merge if a file already exists for the day (one file, multiple
  // tier/backend runs keyed by tier+backend).
  let merged = report;
  if (!args.report && fs.existsSync(reportPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      const runs = Array.isArray(prev.runs) ? prev.runs : prev.run ? [prev] : [prev];
      const key = (r) => `${r?.request?.tier}|${r?.request?.backend}|${r?.request?.turns}`;
      const filtered = runs.filter((r) => key(r) !== key(report));
      merged = { schemaVersion: 1, generatedAt: new Date().toISOString(), runs: [...filtered, report] };
    } catch {
      merged = { schemaVersion: 1, generatedAt: new Date().toISOString(), runs: [report] };
    }
  } else if (!args.report) {
    merged = { schemaVersion: 1, generatedAt: new Date().toISOString(), runs: [report] };
  }
  fs.writeFileSync(reportPath, `${JSON.stringify(merged, null, 2)}\n`);
  logFn(`wrote ${reportPath}`);
  if (report.status === "ok") {
    const s = report.summary;
    logFn(
      `RESULT tier=${report.request.tier} backend=${report.request.backend} turns=${s.turns} ` +
        `asr=${s.asrLatencyMsMedian}ms/wer${s.asrWerMean} firstTok=${s.firstTokenMsMedian}ms ` +
        `tok/s=${s.decodeTokPerSecMedian} dflash=${s.dflashAcceptanceRateOverall} ` +
        `firstAudio≈${s.firstAudioFromMicMsMedian}ms ttsRTF=${s.ttsRtfMedian} total=${s.totalTurnMsMedian}ms ` +
        `peakRSS=${s.serverPeakRssMb}MB bargeIn=${s.bargeInCancelMs}ms e2eOk=${report.e2eLoopOk}` +
        (report.thirtyTurnOk != null ? ` thirtyTurnOk=${report.thirtyTurnOk}` : ""),
    );
  } else {
    logFn(`RESULT status=${report.status}: ${report.reason}`);
  }
  // The bench exits 0 whenever it produced its output (including needs-*),
  // matching the eval-suite honesty contract; a non-zero exit means a harness
  // crash. Callers gate on `status` / `e2eLoopOk` in the JSON.
  return report;
}

main().then(
  (r) => process.exit(0),
  (err) => {
    console.error("[e2e-loop] FATAL:", err?.stack || String(err));
    process.exit(1);
  },
);
