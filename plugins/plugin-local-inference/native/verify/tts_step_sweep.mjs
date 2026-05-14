#!/usr/bin/env bun

/*
 * Focused OmniVoice TTS step/chunk sweep.
 *
 * Measures /v1/audio/speech wall time, audio RTF, and ASR round-trip WER for
 * fixed phrases without running the full mic -> text -> speech loop each row.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function parseArgs(argv) {
  const args = {
    bundle: process.env.ELIZA_TTS_SWEEP_BUNDLE || "",
    backend: process.env.ELIZA_TTS_SWEEP_BACKEND || "metal",
    binDir: process.env.ELIZA_TTS_SWEEP_BIN_DIR || "",
    report: process.env.ELIZA_TTS_SWEEP_REPORT || "",
    audioDir: process.env.ELIZA_TTS_SWEEP_AUDIO_DIR || "",
    steps: (process.env.ELIZA_TTS_SWEEP_STEPS || "4,6,8,10,12,16")
      .split(",")
      .map((s) => Number.parseInt(s, 10))
      .filter(Number.isFinite),
    chunkStep: Number.parseInt(
      process.env.ELIZA_TTS_SWEEP_CHUNK_STEP || "8",
      10,
    ),
    ngl: process.env.ELIZA_TTS_SWEEP_NGL || "99",
    threads: Number.parseInt(
      process.env.ELIZA_TTS_SWEEP_THREADS ||
        String(Math.min(os.cpus().length, 12)),
      10,
    ),
    ctx: Number.parseInt(process.env.ELIZA_TTS_SWEEP_CTX || "2048", 10),
    ggmlBackend: process.env.GGML_BACKEND || "",
    skipChunkSweep: process.env.ELIZA_TTS_SWEEP_SKIP_CHUNK_SWEEP === "1",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    if (a === "--bundle") args.bundle = next();
    else if (a === "--backend") args.backend = next();
    else if (a === "--bin-dir") args.binDir = next();
    else if (a === "--report") args.report = next();
    else if (a === "--audio-dir") args.audioDir = next();
    else if (a === "--steps")
      args.steps = next()
        .split(",")
        .map((s) => Number.parseInt(s, 10))
        .filter(Number.isFinite);
    else if (a === "--chunk-step") args.chunkStep = Number.parseInt(next(), 10);
    else if (a === "--ngl") args.ngl = next();
    else if (a === "--threads") args.threads = Number.parseInt(next(), 10);
    else if (a === "--ctx") args.ctx = Number.parseInt(next(), 10);
    else if (a === "--ggml-backend") args.ggmlBackend = next();
    else if (a === "--skip-chunk-sweep") args.skipChunkSweep = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: bun packages/inference/verify/tts_step_sweep.mjs --bundle <dir> [--report out.json] [--steps 4,6,8] [--skip-chunk-sweep]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function stateRoot() {
  return (
    process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza")
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

function discoverEngine(backend, explicitBinDir) {
  if (explicitBinDir) return validateEngineDir(explicitBinDir);
  const root = path.join(stateRoot(), "local-inference", "bin", "dflash");
  const plat = platformTag();
  const prefer = `${plat}-${backend}-fused`;
  const dirs = fs.existsSync(root)
    ? fs
        .readdirSync(root)
        .filter((d) => fs.statSync(path.join(root, d)).isDirectory())
    : [];
  const pick =
    dirs.find((d) => d === prefer) ||
    dirs.find(
      (d) =>
        d.startsWith(plat) && d.includes(`-${backend}`) && d.includes("-fused"),
    );
  if (!pick) throw new Error(`no fused ${backend} build under ${root}`);
  return validateEngineDir(path.join(root, pick));
}

function validateEngineDir(dir) {
  const server = path.join(dir, "llama-server");
  const lib = path.join(dir, libName());
  if (!fs.existsSync(server)) throw new Error(`${server} missing`);
  if (!fs.existsSync(lib)) throw new Error(`${lib} missing`);
  let caps = null;
  const capsPath = path.join(dir, "CAPABILITIES.json");
  if (fs.existsSync(capsPath))
    caps = JSON.parse(fs.readFileSync(capsPath, "utf8"));
  return { dir, server, lib, backend: caps?.backend || null, caps };
}

function firstExisting(...candidates) {
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function bundleFiles(bundleDir) {
  const textDir = path.join(bundleDir, "text");
  const dflashDir = path.join(bundleDir, "dflash");
  const ttsDir = path.join(bundleDir, "tts");
  const asrDir = path.join(bundleDir, "asr");
  const ttsGgufs = fs.readdirSync(ttsDir).filter((f) => f.endsWith(".gguf"));
  return {
    text: firstExisting(
      ...fs
        .readdirSync(textDir)
        .filter((f) => f.endsWith(".gguf"))
        .sort()
        .map((f) => path.join(textDir, f)),
    ),
    drafter: firstExisting(
      ...fs
        .readdirSync(dflashDir)
        .filter((f) => f.endsWith(".gguf"))
        .map((f) => path.join(dflashDir, f)),
    ),
    ttsModel: path.join(
      ttsDir,
      ttsGgufs.find((f) => !/token/i.test(f)) || ttsGgufs[0],
    ),
    ttsCodec: path.join(
      ttsDir,
      ttsGgufs.find((f) => /token/i.test(f)) || ttsGgufs[0],
    ),
    asr: firstExisting(
      path.join(asrDir, "eliza-1-asr.gguf"),
      ...fs
        .readdirSync(asrDir)
        .filter((f) => f.endsWith(".gguf") && !/mmproj/i.test(f))
        .map((f) => path.join(asrDir, f)),
    ),
    manifest: fs.existsSync(path.join(bundleDir, "eliza-1.manifest.json"))
      ? JSON.parse(
          fs.readFileSync(
            path.join(bundleDir, "eliza-1.manifest.json"),
            "utf8",
          ),
        )
      : null,
  };
}

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
  if (!r.length) return h.length ? 1 : 0;
  const dp = Array.from({ length: r.length + 1 }, () =>
    new Array(h.length + 1).fill(0),
  );
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
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + samples.length * 2, 4);
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
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

async function waitHealthy(port, child) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`llama-server exited ${child.exitCode}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 200 && j.status === "ok") return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("llama-server health timeout");
}

async function loadFfi(libPath, libDir) {
  const sep = path.delimiter;
  process.env.LD_LIBRARY_PATH = `${libDir}${sep}${process.env.LD_LIBRARY_PATH || ""}`;
  if (process.platform === "darwin")
    process.env.DYLD_LIBRARY_PATH = `${libDir}${sep}${process.env.DYLD_LIBRARY_PATH || ""}`;
  const ffi = await import("bun:ffi");
  const T = ffi.FFIType;
  const lib = ffi.dlopen(libPath, {
    eliza_inference_create: { args: [T.cstring, T.ptr], returns: T.ptr },
    eliza_inference_destroy: { args: [T.ptr], returns: T.void },
    eliza_inference_mmap_acquire: {
      args: [T.ptr, T.cstring, T.ptr],
      returns: T.i32,
    },
    eliza_inference_asr_transcribe: {
      args: [T.ptr, T.ptr, T.usize, T.i32, T.ptr, T.usize, T.ptr],
      returns: T.i32,
    },
    eliza_inference_free_string: { args: [T.usize], returns: T.void },
  });
  return { ffi, lib, s: lib.symbols };
}

function readErrAndFree(ffi, s, ptrBuf) {
  let p = 0n;
  try {
    p = ffi.read.ptr(ptrBuf, 0);
  } catch {}
  if (!p || p === 0n) return "(no diagnostic)";
  let msg = "(unreadable diagnostic)";
  try {
    msg = ffi.CString(p);
  } catch {}
  try {
    s.eliza_inference_free_string(p);
  } catch {}
  return msg;
}

function asrTranscribeFloat32(ffiCtx, ffi, s, samples, sampleRate) {
  const pcm16k = resampleLinear(samples, sampleRate, 16000);
  const pcmBuf = Buffer.from(
    pcm16k.buffer,
    pcm16k.byteOffset,
    pcm16k.byteLength,
  );
  const outBuf = Buffer.alloc(4096);
  const errBuf = Buffer.alloc(8);
  errBuf.fill(0);
  const t0 = performance.now();
  const rc = s.eliza_inference_asr_transcribe(
    ffiCtx,
    ffi.ptr(pcmBuf),
    BigInt(pcm16k.length),
    16000,
    ffi.ptr(outBuf),
    BigInt(outBuf.length),
    ffi.ptr(errBuf),
  );
  const latencyMs = performance.now() - t0;
  if (rc < 0)
    throw new Error(
      `asr_transcribe rc=${rc}: ${readErrAndFree(ffi, s, errBuf)}`,
    );
  return { latencyMs, transcript: outBuf.toString("utf8", 0, rc).trim() };
}

async function synth(port, text, step, duration) {
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: text,
      response_format: "pcm",
      num_step: step,
      duration,
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok)
    throw new Error(
      `/v1/audio/speech ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  const sampleRate = Number(res.headers.get("x-sample-rate") || "24000");
  const samples = new Float32Array(await res.arrayBuffer());
  const wallMs = performance.now() - t0;
  const audioSec = samples.length / sampleRate;
  return {
    sampleRate,
    samples,
    wallMs,
    audioSec,
    rtf: wallMs / 1000 / audioSec,
  };
}

const round1 = (x) =>
  x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10;
const round4 = (x) =>
  x == null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000;
const mean = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const max = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(x));
  return v.length ? Math.max(...v) : null;
};

function parseCodecBackendLog(logText) {
  const fallback = logText.match(
    /\[PipelineCodec\] Metal codec fallback: requested=([^\s]+) selected=([^\s]+) reason=([^\n]+)/,
  );
  const loaded = logText.match(
    /\[PipelineCodec\] Loaded codec: sr=(\d+) hop=(\d+) backend=([^\s]+)/,
  );
  return {
    metalCodecFallback: !!fallback,
    requestedBackend: fallback?.[1] ?? null,
    selectedBackend: fallback?.[2] ?? loaded?.[3] ?? null,
    reason: fallback?.[3]?.trim() ?? null,
    sampleRate: loaded ? Number(loaded[1]) : null,
    hopLength: loaded ? Number(loaded[2]) : null,
  };
}

async function main() {
  if (typeof Bun === "undefined")
    throw new Error("tts_step_sweep.mjs requires Bun");
  const args = parseArgs(process.argv.slice(2));
  if (!args.bundle) throw new Error("--bundle is required");
  const bundleDir = path.resolve(args.bundle);
  const engine = discoverEngine(args.backend, args.binDir);
  const files = bundleFiles(bundleDir);
  const audioDir =
    args.audioDir ||
    path.join(
      path.dirname(
        args.report ||
          path.join(__dirname, "bench_results", "tts-step-sweep.json"),
      ),
      "tts-step-sweep-audio",
    );
  fs.mkdirSync(audioDir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-tts-sweep-"));
  const port = 30000 + Math.floor(Math.random() * 20000);
  let child = null;
  let ffiState = null;
  let ffiCtx = null;
  try {
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: `${engine.dir}${path.delimiter}${process.env.LD_LIBRARY_PATH || ""}`,
      DYLD_LIBRARY_PATH: `${engine.dir}${path.delimiter}${process.env.DYLD_LIBRARY_PATH || ""}`,
      ELIZA_OMNIVOICE_MODEL: files.ttsModel,
      ELIZA_OMNIVOICE_CODEC: files.ttsCodec,
      ELIZA_DFLASH_SKIP_SERVER_STRUCTURED_OUTPUT: "1",
    };
    if (args.ggmlBackend) env.GGML_BACKEND = args.ggmlBackend;
    const serverArgs = [
      "-m",
      files.text,
      "-md",
      files.drafter,
      "--spec-type",
      "dflash",
      "--draft-min",
      "2",
      "--draft-max",
      "6",
      "--port",
      String(port),
      "-c",
      String(args.ctx),
      "-cd",
      String(args.ctx),
      "-ngl",
      String(args.ngl),
      "-t",
      String(args.threads),
      "--no-warmup",
      "--metrics",
    ];
    const srvLog = fs.createWriteStream(path.join(tmpDir, "server.log"));
    child = spawn(engine.server, serverArgs, {
      cwd: engine.dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(srvLog);
    child.stderr.pipe(srvLog);
    await waitHealthy(port, child);

    ffiState = await loadFfi(engine.lib, engine.dir);
    const { ffi, s } = ffiState;
    const errBuf = Buffer.alloc(8);
    errBuf.fill(0);
    ffiCtx = s.eliza_inference_create(
      Buffer.from(`${bundleDir}\0`, "utf8"),
      ffi.ptr(errBuf),
    );
    if (!ffiCtx || (typeof ffiCtx === "bigint" && ffiCtx === 0n)) {
      throw new Error(
        `eliza_inference_create failed: ${readErrAndFree(ffi, s, errBuf)}`,
      );
    }
    const asrErr = Buffer.alloc(8);
    asrErr.fill(0);
    const asrRc = s.eliza_inference_mmap_acquire(
      ffiCtx,
      Buffer.from("asr\0", "utf8"),
      ffi.ptr(asrErr),
    );
    if (asrRc < 0)
      throw new Error(
        `mmap_acquire(asr) rc=${asrRc}: ${readErrAndFree(ffi, s, asrErr)}`,
      );

    const stepPhrase = {
      id: "chunk4_meeting",
      text: "The meeting is to",
      duration: 1.18,
      kind: "step-sweep",
    };
    const capitalPhrase = {
      id: "chunk4_capital",
      text: "The capital of France",
      duration: 1.18,
      kind: "step-sweep",
    };
    const chunkCases = [
      stepPhrase,
      {
        id: "chunk8_roadmap",
        text: "The meeting is to discuss the product roadmap",
        duration: 1.94,
        kind: "chunk-sweep",
      },
      {
        id: "chunk12_roadmap",
        text: "The meeting is to discuss the product roadmap before lunch",
        duration: 2.51,
        kind: "chunk-sweep",
      },
    ];
    const cases = [
      ...args.steps.flatMap((step) =>
        [stepPhrase, capitalPhrase].map((c) => ({ ...c, step })),
      ),
      ...(args.skipChunkSweep
        ? []
        : chunkCases
            .filter((c) => c.id !== stepPhrase.id)
            .map((c) => ({ ...c, step: args.chunkStep }))),
    ];

    await synth(port, "warm up.", 8, 0.8);
    const rows = [];
    for (const c of cases) {
      const r = await synth(port, c.text, c.step, c.duration);
      const file = path.join(audioDir, `${c.id}-steps${c.step}.wav`);
      writeWav16(file, r.samples, r.sampleRate);
      let asr = null;
      let asrError = null;
      try {
        asr = asrTranscribeFloat32(ffiCtx, ffi, s, r.samples, r.sampleRate);
      } catch (err) {
        asrError = err?.message || String(err);
      }
      if (
        asr &&
        normalizeWords(c.text).length > 0 &&
        normalizeWords(asr.transcript).length === 0
      ) {
        asrError = asrError || "ASR returned empty transcript";
      }
      const asrWer = asr ? round4(wordErrorRate(c.text, asr.transcript)) : 1;
      rows.push({
        id: c.id,
        kind: c.kind,
        text: c.text,
        steps: c.step,
        durationHintSec: c.duration,
        audioSec: round4(r.audioSec),
        wallMs: round1(r.wallMs),
        rtf: round4(r.rtf),
        asrLatencyMs: asr ? round1(asr.latencyMs) : null,
        asrTranscript: asr?.transcript ?? null,
        asrWer,
        asrError,
        audioPath: file,
      });
      console.log(
        `[tts-sweep] ${c.id} steps=${c.step} rtf=${rows.at(-1).rtf} wer=${asrWer == null ? "n/a" : asrWer}`,
      );
    }

    const logText = fs.existsSync(path.join(tmpDir, "server.log"))
      ? fs.readFileSync(path.join(tmpDir, "server.log"), "utf8")
      : "";
    const report = {
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
      request: {
        backend: args.backend,
        ggmlBackend: args.ggmlBackend || null,
        steps: args.steps,
        chunkStep: args.chunkStep,
        ngl: args.ngl,
        skipChunkSweep: args.skipChunkSweep,
      },
      bundle: { dir: bundleDir, tier: files.manifest?.tier || null },
      engine: {
        dir: engine.dir,
        backend: engine.backend,
        caps: engine.caps?.kernels || null,
      },
      codecBackend: parseCodecBackendLog(logText),
      summary: {
        stepSweep: args.steps.map((step) => {
          const v = rows.filter(
            (r) => r.kind === "step-sweep" && r.steps === step,
          );
          return {
            steps: step,
            meanRtf: round4(mean(v.map((r) => r.rtf))),
            meanAsrWer: round4(mean(v.map((r) => r.asrWer))),
            maxAsrWer: max(v.map((r) => r.asrWer)),
            asrFailures: v.filter((r) => r.asrError).length,
          };
        }),
        chunkSweep: args.skipChunkSweep
          ? []
          : rows.filter(
              (r) =>
                r.kind === "chunk-sweep" ||
                (r.id === stepPhrase.id && r.steps === args.chunkStep),
            ),
      },
      rows,
    };
    const reportPath =
      args.report ||
      path.join(
        __dirname,
        "bench_results",
        `tts-step-sweep-${new Date().toISOString().slice(0, 10)}.json`,
      );
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[tts-sweep] wrote ${reportPath}`);
  } finally {
    try {
      if (ffiCtx && ffiState) ffiState.s.eliza_inference_destroy(ffiCtx);
      if (ffiState?.lib?.close) ffiState.lib.close();
    } catch {}
    if (child && child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error("[tts-sweep] FATAL:", err?.stack || String(err));
  process.exit(1);
});
