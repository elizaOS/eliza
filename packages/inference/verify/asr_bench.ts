#!/usr/bin/env bun
/**
 * ASR WER + TTS→ASR self-labelled loopback bench for the Eliza-1 fused
 * inference library.
 *
 * Drives the local TTS ABI (`eliza_inference_tts_synthesize`) to create
 * speech from accepted or model-generated text labels, then drives the
 * batch ASR ABI (`eliza_inference_asr_transcribe`) over the synthesized
 * audio, computes word-error-rate against the text that produced the audio,
 * and reports latency + real-time factor (audio-seconds / wall-seconds —
 * higher is faster than realtime). This is a self-labelled loopback harness,
 * not a real recorded-speech WER measurement.
 *
 * It writes two artifacts:
 *
 *   - `packages/inference/verify/bench_results/asr_<date>.json` — the raw
 *     per-utterance bench rows + aggregate WER/RTF/backend.
 *   - the eval-suite `evals/asr-wer.json` shape (schemaVersion 1, metric
 *     "asr_wer", op "<=", wer/passed/gateThreshold) at `--eval-out` when
 *     given — the same blob `packages/training/scripts/eval/eliza1_eval_suite.py`
 *     would emit, so the publish gate can consume it.
 *
 * Labelled set: by default synthesized on the fly via the same library's TTS
 * path from a fixed phrase list. Pass `--prompt` / `--prompt-file` to accept
 * explicit text labels, or `--generate-prompts N` to ask the local text model
 * for short labels before TTS. Pass `--wav-dir <dir>` to bench against
 * external WAV+`.txt` pairs instead; only that mode is real recorded WER.
 *
 * Usage:
 *   bun packages/inference/verify/asr_bench.ts \
 *     --dylib ~/.eliza/local-inference/bin/dflash/linux-x64-cpu-fused/libelizainference.so \
 *     --bundle ~/.eliza/local-inference/models/eliza-1-0_8b.bundle \
 *     --backend cpu --out packages/inference/verify/bench_results/asr_2026-05-11.json
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { loadElizaInferenceFfi } from "../../app-core/src/services/local-inference/voice/ffi-bindings";

/* --------------------------------- args --------------------------------- */

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  if (i >= 0) {
    const v = process.argv[i + 1];
    if (!v) throw new Error(`${name} requires a value`);
    return v;
  }
  return fallback;
}
function args(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name) {
      const v = process.argv[i + 1];
      if (!v) throw new Error(`${name} requires a value`);
      out.push(v);
      i++;
    }
  }
  return out;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

const HOME = process.env.HOME ?? "";
const PLATFORM = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
const ARCH = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
const DEFAULT_BACKEND = process.platform === "darwin" ? "metal" : "cpu";
function dylibName(): string {
  if (process.platform === "darwin") return "libelizainference.dylib";
  if (process.platform === "win32") return "libelizainference.dll";
  return "libelizainference.so";
}
function defaultDylib(backend: string): string {
  return `${HOME}/.eliza/local-inference/bin/dflash/${PLATFORM}-${ARCH}-${backend}-fused/${dylibName()}`;
}
const backend = arg("--backend", DEFAULT_BACKEND);
const dylib = arg(
  "--dylib",
  defaultDylib(backend),
);
const bundle = arg("--bundle", `${HOME}/.eliza/local-inference/models/eliza-1-0_8b.bundle`);
const outPath = arg(
  "--out",
  path.resolve(__dirname, "bench_results", `tts_asr_self_labelled_${new Date().toISOString().slice(0, 10)}.json`),
);
const evalOut = arg("--eval-out", "");
const wavDir = arg("--wav-dir", "");
const promptFile = arg("--prompt-file", "");
const generatedPromptCount = Number(arg("--generate-prompts", "0"));
const binDir = arg("--bin-dir", path.dirname(dylib));
const saveAudioDir = arg("--save-audio-dir", "");
const gateThreshold = Number(arg("--gate", "0.1"));
const verbose = flag("--verbose");

/* ------------------------- text normalization --------------------------- */

/**
 * Standard ASR-eval text normalization: lowercase, strip punctuation,
 * collapse whitespace. (Same shape Whisper's `EnglishTextNormalizer` /
 * the manifest's `asrWer` use — minus the number-word expansion, which the
 * fixed phrase list avoids needing.)
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9'\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein word-edit distance for WER. */
function wordEditDistance(ref: string[], hyp: string[]): number {
  const n = ref.length;
  const m = hyp.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Array<number>(m + 1);
  let cur = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      cur[j] = Math.min(sub, prev[j] + 1, cur[j - 1] + 1);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

/* ------------------------------ WAV codec ------------------------------- */

function encodeMonoPcm16Wav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (off: number, s: string) => {
    for (let k = 0; k < s.length; k++) out[off + k] = s.charCodeAt(k);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (const s of pcm) {
    const c = Math.max(-1, Math.min(1, s));
    view.setInt16(off, Math.round(c < 0 ? c * 0x8000 : c * 0x7fff), true);
    off += 2;
  }
  return out;
}

function readMonoPcm16Wav(file: string): { pcm: Float32Array; sampleRateHz: number } {
  const buf = readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`not a RIFF/WAVE file: ${file}`);
  }
  let off = 12;
  let fmt = 0;
  let ch = 0;
  let rate = 0;
  let bits = 0;
  let dataOff = -1;
  let dataBytes = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    off += 8;
    if (id === "fmt ") {
      fmt = buf.readUInt16LE(off);
      ch = buf.readUInt16LE(off + 2);
      rate = buf.readUInt32LE(off + 4);
      bits = buf.readUInt16LE(off + 14);
    } else if (id === "data") {
      dataOff = off;
      dataBytes = size;
      break;
    }
    off += size + (size & 1);
  }
  if (fmt !== 1 || ch !== 1 || bits !== 16 || dataOff < 0) {
    throw new Error(`expected mono PCM16 WAV; got fmt=${fmt} ch=${ch} bits=${bits} (${file})`);
  }
  const n = Math.floor(dataBytes / 2);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.max(-1, buf.readInt16LE(dataOff + i * 2) / 32768);
  return { pcm, sampleRateHz: rate };
}

/* -------------------------- labelled audio set -------------------------- */

/** OmniVoice / Qwen3-TTS output rate. The ASR side resamples internally. */
const TTS_SAMPLE_RATE = 24_000;

/**
 * Fixed phrase set — short, punctuation-light, no number words. Chosen so
 * the standard normalization needs no number expansion and so a single TTS
 * forward fits a small fixed PCM buffer.
 */
const PHRASES: ReadonlyArray<string> = [
  "hello world",
  "the quick brown fox jumps over the lazy dog",
  "turn on the kitchen lights",
  "what time is it in tokyo",
  "play some music",
  "set a reminder for tomorrow morning",
  "open the front door",
  "thanks that is all for now",
];

interface Utterance {
  id: string;
  reference: string;
  pcm: Float32Array;
  sampleRateHz: number;
  synthMs: number | null;
  promptSource: string;
}

function loadExternalWavDir(dir: string): Utterance[] {
  const out: Utterance[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.toLowerCase().endsWith(".wav")) continue;
    const base = name.slice(0, -4);
    const txt = path.join(dir, `${base}.txt`);
    if (!existsSync(txt)) {
      if (verbose) process.stderr.write(`[asr-bench] skip ${name}: no ${base}.txt reference\n`);
      continue;
    }
    const { pcm, sampleRateHz } = readMonoPcm16Wav(path.join(dir, name));
    out.push({
      id: base,
      reference: readFileSync(txt, "utf8").trim(),
      pcm,
      sampleRateHz,
      synthMs: null,
      promptSource: "external_wav_txt",
    });
  }
  if (out.length === 0) throw new Error(`[asr-bench] no WAV+.txt pairs found in ${dir}`);
  return out;
}

function loadAcceptedPrompts(): string[] {
  const explicit = args("--prompt").flatMap((v) =>
    v
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const fromFile = promptFile
    ? readFileSync(promptFile, "utf8")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("#"))
    : [];
  return [...explicit, ...fromFile];
}

function firstBundleTextModel(bundleDir: string): string | null {
  const dir = path.join(bundleDir, "text");
  if (!existsSync(dir)) return null;
  const gguf = readdirSync(dir)
    .filter((f) => f.endsWith(".gguf"))
    .sort()[0];
  return gguf ? path.join(dir, gguf) : null;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function waitHealthy(port: number, child: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`[asr-bench] llama-server exited before /health (code ${child.exitCode})`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // server still loading
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("[asr-bench] llama-server did not become healthy within 180s");
}

async function startPromptServer(): Promise<{ port: number; child: ChildProcessWithoutNullStreams; textModel: string }> {
  const server = path.join(binDir, "llama-server");
  if (!existsSync(server)) throw new Error(`[asr-bench] --generate-prompts needs ${server}`);
  const textModel = firstBundleTextModel(bundle);
  if (!textModel) throw new Error(`[asr-bench] --generate-prompts could not find a text/*.gguf in ${bundle}`);
  const port = await getFreePort();
  const threads = String(Math.min(os.cpus().length, 12));
  const ngl = backend === "metal" ? "99" : "0";
  const env = {
    ...process.env,
    DYLD_LIBRARY_PATH:
      process.platform === "darwin"
        ? `${binDir}${path.delimiter}${process.env.DYLD_LIBRARY_PATH ?? ""}`
        : process.env.DYLD_LIBRARY_PATH,
    LD_LIBRARY_PATH: `${binDir}${path.delimiter}${process.env.LD_LIBRARY_PATH ?? ""}`,
  };
  const child = spawn(
    server,
    [
      "-m",
      textModel,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--ctx-size",
      "2048",
      "--threads",
      threads,
      "--n-gpu-layers",
      ngl,
      "--no-webui",
    ],
    { cwd: binDir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (verbose) {
    child.stderr.on("data", (d) => process.stderr.write(`[llama-server] ${d}`));
  }
  await waitHealthy(port, child);
  return { port, child, textModel };
}

function parseGeneratedPrompts(text: string, limit: number): string[] {
  return text
    .split(/\r?\n|[•*-]\s+/)
    .map((s) => s.replace(/^\s*\d+[.)]\s*/, "").replace(/^["']|["']$/g, "").trim())
    .filter((s) => s.length >= 6 && s.length <= 120)
    .filter((s) => !/[{}[\]]/.test(s))
    .slice(0, limit);
}

async function generatePrompts(count: number): Promise<{ prompts: string[]; model: string | null; latencyMs: number | null }> {
  if (count <= 0) return { prompts: [], model: null, latencyMs: null };
  let server: Awaited<ReturnType<typeof startPromptServer>> | null = null;
  const t0 = performance.now();
  try {
    server = await startPromptServer();
    const res = await fetch(`http://127.0.0.1:${server.port}/completion`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt:
          `Write ${count} short speech recognition test utterances, one per line. ` +
          "Use plain everyday spoken English, no numbering, no punctuation-heavy text.",
        n_predict: Math.max(64, count * 18),
        temperature: 0.4,
        stream: false,
        cache_prompt: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`[asr-bench] /completion HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const content = String(json.content ?? json.response ?? "");
    const prompts = parseGeneratedPrompts(content, count);
    if (prompts.length === 0) throw new Error("[asr-bench] local model generated no parseable prompts");
    return { prompts, model: server.textModel, latencyMs: performance.now() - t0 };
  } finally {
    if (server) {
      server.child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      if (server.child.exitCode === null) server.child.kill("SIGKILL");
    }
  }
}

/* --------------------------------- main --------------------------------- */

interface BenchRow {
  id: string;
  text: string;
  reference: string;
  hypothesis: string;
  normalizedRef: string;
  normalizedHyp: string;
  refWords: number;
  errors: number;
  wer: number;
  audioSeconds: number;
  synthMs: number | null;
  synthLatencyMs: number | null;
  synthRtf: number | null;
  transcribeMs: number;
  transcribeLatencyMs: number;
  rtf: number;
  roundtripMs: number;
  promptSource: string;
}

async function main(): Promise<void> {
  if (!existsSync(dylib)) {
    throw new Error(`[asr-bench] libelizainference not found at ${dylib} — pass --dylib`);
  }
  if (!existsSync(bundle)) {
    throw new Error(`[asr-bench] bundle not found at ${bundle} — pass --bundle`);
  }
  const acceptedPrompts = loadAcceptedPrompts();
  const generated = await generatePrompts(generatedPromptCount);
  const promptLabels = [...acceptedPrompts, ...generated.prompts];
  const ffi = loadElizaInferenceFfi(dylib);
  const ctx = ffi.create(bundle);
  let labelledSetSource: "tts_loopback_self_labelled" | "external_wav_txt" = "external_wav_txt";
  try {
    // 1) build the labelled set
    let utterances: Utterance[];
    if (wavDir) {
      utterances = loadExternalWavDir(wavDir);
    } else {
      labelledSetSource = "tts_loopback_self_labelled";
      ffi.mmapAcquire(ctx, "tts");
      utterances = [];
      const phrases = promptLabels.length > 0 ? promptLabels : [...PHRASES];
      // 30s of audio @ 24 kHz is 720k samples; phrases here are << that.
      const outBuf = new Float32Array(TTS_SAMPLE_RATE * 30);
      for (let i = 0; i < phrases.length; i++) {
        const t0 = performance.now();
        const written = ffi.ttsSynthesize({
          ctx,
          text: phrases[i],
          speakerPresetId: null,
          out: outBuf,
        });
        const synthMs = performance.now() - t0;
        if (written <= 0) throw new Error(`[asr-bench] TTS produced ${written} samples for "${phrases[i]}"`);
        const id = `tts-asr-${String(i).padStart(2, "0")}`;
        const pcm = outBuf.slice(0, written);
        if (saveAudioDir) {
          mkdirSync(saveAudioDir, { recursive: true });
          writeFileSync(path.join(saveAudioDir, `${id}.wav`), encodeMonoPcm16Wav(pcm, TTS_SAMPLE_RATE));
          writeFileSync(path.join(saveAudioDir, `${id}.txt`), `${phrases[i]}\n`);
        }
        utterances.push({
          id,
          reference: phrases[i],
          pcm,
          sampleRateHz: TTS_SAMPLE_RATE,
          synthMs,
          promptSource:
            i < acceptedPrompts.length
              ? "accepted_prompt"
              : generated.prompts.length > 0 && i < acceptedPrompts.length + generated.prompts.length
                ? "model_generated_prompt"
                : "built_in_prompt",
        });
        if (verbose) process.stderr.write(`[asr-bench] synthesized "${phrases[i]}" → ${written} samples in ${synthMs.toFixed(1)}ms\n`);
      }
      ffi.mmapEvict(ctx, "tts");
    }

    // 2) transcribe each + accumulate WER / RTF
    ffi.mmapAcquire(ctx, "asr");
    const rows: BenchRow[] = [];
    let totalErrors = 0;
    let totalRefWords = 0;
    let totalAudioSec = 0;
    let totalWallSec = 0;
    for (const u of utterances) {
      const t0 = performance.now();
      const hyp = ffi.asrTranscribe({ ctx, pcm: u.pcm, sampleRateHz: u.sampleRateHz });
      const transcribeMs = performance.now() - t0;
      const nRef = normalize(u.reference);
      const nHyp = normalize(hyp);
      const refW = nRef.length === 0 ? [] : nRef.split(" ");
      const hypW = nHyp.length === 0 ? [] : nHyp.split(" ");
      const errors = wordEditDistance(refW, hypW);
      const audioSeconds = u.pcm.length / u.sampleRateHz;
      const wer = refW.length === 0 ? (hypW.length === 0 ? 0 : 1) : errors / refW.length;
      const rtf = audioSeconds / (transcribeMs / 1000);
      const synthRtf = u.synthMs === null ? null : audioSeconds / (u.synthMs / 1000);
      const roundtripMs = (u.synthMs ?? 0) + transcribeMs;
      rows.push({
        id: u.id,
        text: u.reference,
        reference: u.reference,
        hypothesis: hyp,
        normalizedRef: nRef,
        normalizedHyp: nHyp,
        refWords: refW.length,
        errors,
        wer,
        audioSeconds,
        synthMs: u.synthMs,
        synthLatencyMs: u.synthMs,
        synthRtf,
        transcribeMs,
        transcribeLatencyMs: transcribeMs,
        rtf,
        roundtripMs,
        promptSource: u.promptSource,
      });
      totalErrors += errors;
      totalRefWords += refW.length;
      totalAudioSec += audioSeconds;
      totalWallSec += transcribeMs / 1000;
      if (verbose) {
        process.stderr.write(
          `[asr-bench] ${u.id}: ref="${nRef}" hyp="${nHyp}" wer=${wer.toFixed(3)} asr_rtf=${rtf.toFixed(2)} roundtrip_ms=${roundtripMs.toFixed(1)}\n`,
        );
      }
    }
    ffi.mmapEvict(ctx, "asr");

    const aggregateWer = totalRefWords === 0 ? 1 : totalErrors / totalRefWords;
    const aggregateRtf = totalWallSec === 0 ? 0 : totalAudioSec / totalWallSec;
    const passed = aggregateWer <= gateThreshold;

    const result = {
      schemaVersion: 1,
      tool: "asr_bench.ts",
      generatedAt: new Date().toISOString(),
      dylib,
      bundle,
      abiVersion: ffi.libraryAbiVersion,
      backend,
      engine: {
        binDir,
        capabilitiesPath: existsSync(path.join(binDir, "CAPABILITIES.json")) ? path.join(binDir, "CAPABILITIES.json") : null,
      },
      labelledSet: {
        source: labelledSetSource,
        measurementClass: labelledSetSource === "external_wav_txt" ? "real_recorded_or_external_labelled" : "self_labelled_tts_asr_loopback",
        realRecordedWer: labelledSetSource === "external_wav_txt",
        wavDir: wavDir || null,
        count: rows.length,
        normalization: "lowercase + strip-punctuation + collapse-ws (Whisper-style)",
        acceptedPrompts: acceptedPrompts.length,
        generatedPrompts: generated.prompts.length,
        generatedPromptModel: generated.model,
        generatedPromptLatencyMs: generated.latencyMs,
        saveAudioDir: saveAudioDir || null,
        ...(labelledSetSource === "tts_loopback_self_labelled"
          ? {
              caveat:
                "Audio is synthesized from the same local bundle and labelled with the text that " +
                "created it. This self-labelled TTS→ASR loopback WER measures text preservation " +
                "through the local TTS and ASR stack, not ASR accuracy on real recorded speech. " +
                "Use --wav-dir with recorded WAV+.txt pairs for real WER.",
            }
          : {}),
      },
      aggregate: {
        wer: aggregateWer,
        rtf: aggregateRtf,
        asrRtf: aggregateRtf,
        meanSynthMs:
          rows.some((r) => r.synthMs !== null)
            ? rows.reduce((sum, r) => sum + (r.synthMs ?? 0), 0) / rows.filter((r) => r.synthMs !== null).length
            : null,
        meanTranscribeMs: rows.reduce((sum, r) => sum + r.transcribeMs, 0) / rows.length,
        meanRoundtripMs: rows.reduce((sum, r) => sum + r.roundtripMs, 0) / rows.length,
        utterances: rows.length,
        refWords: totalRefWords,
        errors: totalErrors,
        audioSeconds: totalAudioSec,
        wallSeconds: totalWallSec,
      },
      gate: { metric: "asr_wer", op: "<=", threshold: gateThreshold, passed },
      rows,
    };

    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

    if (evalOut) {
      // A TTS-synthesized labelled set is loopback, not a real recorded WER
      // measurement. Report it as `not-run` for the publish gate. Only an
      // external real-speech --wav-dir set produces a `measured` row.
      const validMeasurement = labelledSetSource === "external_wav_txt";
      const evalBlob = validMeasurement
        ? {
            schemaVersion: 1,
            metric: "asr_wer",
            op: "<=",
            status: "measured",
            wer: aggregateWer,
            passed,
            gateThreshold,
            backend,
            labelledSetSource,
            utterances: rows.length,
            benchArtifact: path.relative(path.resolve(__dirname, "../.."), outPath),
            ...(passed ? {} : { gateReason: `asr_wer ${aggregateWer.toFixed(4)} > ${gateThreshold}` }),
          }
        : {
            schemaVersion: 1,
            metric: "asr_wer",
            op: "<=",
            status: "not-run",
            wer: null,
            passed: false,
            gateThreshold,
            backend,
            labelledSetSource,
            utterances: rows.length,
            reason:
              "labelled set was TTS-synthesized from the bundle itself, so WER is self-labelled " +
              "TTS→ASR loopback rather than real recorded-speech ASR WER; needs a real recorded " +
              "WAV+.txt corpus via --wav-dir for a publish-gate WER.",
            rtf: aggregateRtf,
            benchArtifact: path.relative(path.resolve(__dirname, "../.."), outPath),
          };
      mkdirSync(path.dirname(evalOut), { recursive: true });
      writeFileSync(evalOut, `${JSON.stringify(evalBlob, null, 2)}\n`);
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          wer: aggregateWer,
          rtf: aggregateRtf,
          meanRoundtripMs: result.aggregate.meanRoundtripMs,
          labelledSetSource,
          backend,
          out: outPath,
        },
        null,
        2,
      )}\n`,
    );
    // A bench run is informational on stand-in bundles; never fail CI here —
    // the publish gate is the one that enforces the threshold.
  } finally {
    ffi.destroy(ctx);
    ffi.close();
  }
}

main();
