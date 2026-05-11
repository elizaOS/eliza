#!/usr/bin/env bun
/**
 * ASR WER + RTF bench for the Eliza-1 fused inference library.
 *
 * Drives the batch ASR ABI (`eliza_inference_asr_transcribe` in
 * `libelizainference`) over a small labelled audio set, computes
 * word-error-rate with the standard ASR text normalization, and reports
 * the real-time factor (audio-seconds / wall-seconds — higher is faster
 * than realtime). It writes two artifacts:
 *
 *   - `packages/inference/verify/bench_results/asr_<date>.json` — the raw
 *     per-utterance bench rows + aggregate WER/RTF/backend.
 *   - the eval-suite `evals/asr-wer.json` shape (schemaVersion 1, metric
 *     "asr_wer", op "<=", wer/passed/gateThreshold) at `--eval-out` when
 *     given — the same blob `packages/training/scripts/eval/eliza1_eval_suite.py`
 *     would emit, so the publish gate can consume it.
 *
 * Labelled set: synthesized on the fly via the same library's TTS path
 * (`eliza_inference_tts_synthesize` against the bundle's `tts/` GGUF) from
 * a fixed phrase list — there is no public labelled speech corpus checked
 * into the repo. The synthesized audio is real model output (not a fixture),
 * so this is an end-to-end TTS→ASR loop measurement; on a stand-in bundle
 * with off-the-shelf (not fine-tuned) Qwen3-TTS/Qwen3-ASR weights the WER is
 * a lower bound on the final fine-tuned bundle's quality, not a publish gate.
 * Pass `--wav-dir <dir>` to bench against external WAV+`.txt` pairs instead.
 *
 * Usage:
 *   bun packages/inference/verify/asr_bench.ts \
 *     --dylib ~/.eliza/local-inference/bin/dflash/linux-x64-cpu-fused/libelizainference.so \
 *     --bundle ~/.eliza/local-inference/models/eliza-1-0_6b.bundle \
 *     --backend cpu --out packages/inference/verify/bench_results/asr_2026-05-11.json
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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
function flag(name: string): boolean {
  return process.argv.includes(name);
}

const HOME = process.env.HOME ?? "";
const dylib = arg(
  "--dylib",
  `${HOME}/.eliza/local-inference/bin/dflash/linux-x64-cpu-fused/libelizainference.so`,
);
const bundle = arg("--bundle", `${HOME}/.eliza/local-inference/models/eliza-1-0_6b.bundle`);
const backend = arg("--backend", "cpu");
const outPath = arg(
  "--out",
  path.resolve(__dirname, "bench_results", `asr_${new Date().toISOString().slice(0, 10)}.json`),
);
const evalOut = arg("--eval-out", "");
const wavDir = arg("--wav-dir", "");
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
    out.push({ id: base, reference: readFileSync(txt, "utf8").trim(), pcm, sampleRateHz });
  }
  if (out.length === 0) throw new Error(`[asr-bench] no WAV+.txt pairs found in ${dir}`);
  return out;
}

/* --------------------------------- main --------------------------------- */

interface BenchRow {
  id: string;
  reference: string;
  hypothesis: string;
  normalizedRef: string;
  normalizedHyp: string;
  refWords: number;
  errors: number;
  wer: number;
  audioSeconds: number;
  transcribeMs: number;
  rtf: number;
}

function main(): void {
  if (!existsSync(dylib)) {
    throw new Error(`[asr-bench] libelizainference not found at ${dylib} — pass --dylib`);
  }
  const ffi = loadElizaInferenceFfi(dylib);
  const ctx = ffi.create(bundle);
  let synthesizedVia: "tts" | "external" = "external";
  try {
    // 1) build the labelled set
    let utterances: Utterance[];
    if (wavDir) {
      utterances = loadExternalWavDir(wavDir);
    } else {
      synthesizedVia = "tts";
      ffi.mmapAcquire(ctx, "tts");
      utterances = [];
      // 30s of audio @ 24 kHz is 720k samples; phrases here are << that.
      const outBuf = new Float32Array(TTS_SAMPLE_RATE * 30);
      for (let i = 0; i < PHRASES.length; i++) {
        const written = ffi.ttsSynthesize({
          ctx,
          text: PHRASES[i],
          speakerPresetId: null,
          out: outBuf,
        });
        if (written <= 0) throw new Error(`[asr-bench] TTS produced ${written} samples for "${PHRASES[i]}"`);
        utterances.push({
          id: `tts-${String(i).padStart(2, "0")}`,
          reference: PHRASES[i],
          pcm: outBuf.slice(0, written),
          sampleRateHz: TTS_SAMPLE_RATE,
        });
        if (verbose) process.stderr.write(`[asr-bench] synthesized "${PHRASES[i]}" → ${written} samples\n`);
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
      rows.push({
        id: u.id,
        reference: u.reference,
        hypothesis: hyp,
        normalizedRef: nRef,
        normalizedHyp: nHyp,
        refWords: refW.length,
        errors,
        wer,
        audioSeconds,
        transcribeMs,
        rtf,
      });
      totalErrors += errors;
      totalRefWords += refW.length;
      totalAudioSec += audioSeconds;
      totalWallSec += transcribeMs / 1000;
      if (verbose) {
        process.stderr.write(
          `[asr-bench] ${u.id}: ref="${nRef}" hyp="${nHyp}" wer=${wer.toFixed(3)} rtf=${rtf.toFixed(2)}\n`,
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
      labelledSet: {
        source: synthesizedVia,
        wavDir: wavDir || null,
        count: rows.length,
        normalization: "lowercase + strip-punctuation + collapse-ws (Whisper-style)",
        ...(synthesizedVia === "tts"
          ? {
              caveat:
                "Audio synthesized via the bundle's own TTS GGUF. On a stand-in bundle " +
                "(off-the-shelf, not fine-tuned Qwen3-TTS/Qwen3-ASR weights) the synthesized " +
                "speech is low-quality, so the WER reflects TTS quality, not ASR accuracy — " +
                "it is NOT a valid ASR-WER measurement on a stand-in bundle. RTF (audio-sec / " +
                "wall-sec) is content-independent and IS meaningful. Pass --wav-dir with real " +
                "recorded WAV+.txt pairs for a real WER number.",
            }
          : {}),
      },
      aggregate: {
        wer: aggregateWer,
        rtf: aggregateRtf,
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
      // A TTS-synthesized labelled set on a stand-in bundle is not a valid
      // WER measurement (it measures TTS quality). Report it as `not-run`
      // with the real reason — matching what eliza1_eval_suite.py emits —
      // rather than a false `measured` row that would gate on noise. Only
      // an external real-speech --wav-dir set produces a `measured` row.
      const validMeasurement = synthesizedVia === "external";
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
            labelledSetSource: synthesizedVia,
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
            labelledSetSource: synthesizedVia,
            utterances: rows.length,
            reason:
              "labelled set was TTS-synthesized from the bundle's own (stand-in) TTS GGUF — " +
              "WER would measure TTS quality, not ASR accuracy; needs a real recorded-speech " +
              "corpus (--wav-dir WAV+.txt pairs). RTF measurement in the bench artifact is valid.",
            rtf: aggregateRtf,
            benchArtifact: path.relative(path.resolve(__dirname, "../.."), outPath),
          };
      mkdirSync(path.dirname(evalOut), { recursive: true });
      writeFileSync(evalOut, `${JSON.stringify(evalBlob, null, 2)}\n`);
    }

    process.stdout.write(`${JSON.stringify({ wer: aggregateWer, rtf: aggregateRtf, backend, out: outPath }, null, 2)}\n`);
    // A bench run is informational on stand-in bundles; never fail CI here —
    // the publish gate is the one that enforces the threshold.
  } finally {
    ffi.destroy(ctx);
    ffi.close();
  }
}

main();
