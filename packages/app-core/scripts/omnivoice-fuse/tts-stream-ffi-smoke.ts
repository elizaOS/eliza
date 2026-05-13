#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadElizaInferenceFfi } from "../../src/services/local-inference/voice/ffi-bindings";

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  if (idx >= 0) {
    const value = process.argv[idx + 1];
    if (!value) throw new Error(`${name} requires a value`);
    return value;
  }
  return fallback;
}

function intArg(name: string, fallback: number): number {
  const value = arg(name, String(fallback));
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return n;
}

function positiveNumberArg(name: string, fallback: number): number {
  const value = arg(name, String(fallback));
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return n;
}

const dylib = arg(
  "--dylib",
  `${process.env.HOME}/.eliza/local-inference/bin/dflash/darwin-arm64-metal-fused/libelizainference.dylib`,
);
const bundle = arg(
  "--bundle",
  `${process.env.HOME}/.eliza/local-inference/models/eliza-1-0_6b.bundle`,
);
const text = arg(
  "--text",
  "This is a direct streaming text to speech cancellation smoke.",
);
const speakerPresetId = arg("--speaker-preset-id", "");
const cancelMode = arg("--cancel-mode", "native-in-callback");
const cancelAfterChunks = intArg("--cancel-after-chunks", 1);
const maskgitSteps = intArg("--maskgit-steps", 0);
const chunkDurationSec = positiveNumberArg("--chunk-duration-sec", 0);
const chunkThresholdSec = positiveNumberArg("--chunk-threshold-sec", 0);
const warmupRuns = intArg("--warmup-runs", 0);
const outPath = arg("--out", "");
const wavOutPath = arg("--wav-out", "");

if (!["none", "callback-return", "native-in-callback"].includes(cancelMode)) {
  throw new Error(
    "--cancel-mode must be one of: none, callback-return, native-in-callback",
  );
}

const requestedNativeEnv: Record<string, string> = {};
if (maskgitSteps > 0) {
  requestedNativeEnv.ELIZA_TTS_MASKGIT_STEPS = String(maskgitSteps);
}
if (chunkDurationSec > 0) {
  requestedNativeEnv.ELIZA_TTS_CHUNK_DURATION_SEC = String(chunkDurationSec);
}
if (chunkThresholdSec > 0) {
  requestedNativeEnv.ELIZA_TTS_CHUNK_THRESHOLD_SEC = String(chunkThresholdSec);
}

const needsNativeEnvReexec = Object.entries(requestedNativeEnv).some(
  ([key, value]) => process.env[key] !== value,
);

if (needsNativeEnvReexec && process.env.ELIZA_TTS_NATIVE_ENV_REEXEC !== "1") {
  const rerun = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: {
      ...process.env,
      ...requestedNativeEnv,
      ELIZA_TTS_NATIVE_ENV_REEXEC: "1",
    },
  });
  process.exit(rerun.status ?? (rerun.signal ? 1 : 0));
}

function writeWavPcm16Mono(
  path: string,
  pcm: Float32Array,
  sampleRate: number,
) {
  mkdirSync(dirname(path), { recursive: true });
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
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
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) {
    const sample = Math.max(-1, Math.min(1, pcm[i]));
    buf.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

if (maskgitSteps > 0) {
  process.env.ELIZA_TTS_MASKGIT_STEPS = String(maskgitSteps);
}
if (chunkDurationSec > 0) {
  process.env.ELIZA_TTS_CHUNK_DURATION_SEC = String(chunkDurationSec);
}
if (chunkThresholdSec > 0) {
  process.env.ELIZA_TTS_CHUNK_THRESHOLD_SEC = String(chunkThresholdSec);
}
const effectiveMaskgitSteps =
  maskgitSteps > 0
    ? maskgitSteps
    : Number.parseInt(process.env.ELIZA_TTS_MASKGIT_STEPS || "0", 10) || null;
const effectiveChunkDurationSec =
  chunkDurationSec > 0
    ? chunkDurationSec
    : Number.parseFloat(process.env.ELIZA_TTS_CHUNK_DURATION_SEC || "0") ||
      null;
const effectiveChunkThresholdSec =
  chunkThresholdSec > 0
    ? chunkThresholdSec
    : Number.parseFloat(process.env.ELIZA_TTS_CHUNK_THRESHOLD_SEC || "0") ||
      null;
const ffi = loadElizaInferenceFfi(dylib);
const ctx = ffi.create(bundle);
const started = performance.now();

function codecBackendPolicy(path: string): {
  status: "default" | "intentional-cpu-fallback";
  requested: "default" | "Metal";
  selected: "default" | "CPU";
  reason: string | null;
} {
  const metalTarget =
    process.platform === "darwin" &&
    process.arch === "arm64" &&
    /metal/i.test(path);
  if (!metalTarget) {
    return {
      status: "default",
      requested: "default",
      selected: "default",
      reason: null,
    };
  }
  return {
    status: "intentional-cpu-fallback",
    requested: "Metal",
    selected: "CPU",
    reason: "merged-ggml-dac-decode-stall",
  };
}

try {
  const acquireStarted = performance.now();
  ffi.mmapAcquire(ctx, "tts");
  const acquireMs = performance.now() - acquireStarted;
  const streamSupported = ffi.ttsStreamSupported();
  const warmups: Array<{
    firstAudioMs: number | null;
    synthMs: number;
    bodyChunks: number;
    samples: number;
    audioSeconds: number;
    rtf: number | null;
    cancelled: boolean;
  }> = [];

  for (let i = 0; streamSupported && i < warmupRuns; i++) {
    let warmupFirstAudioMs: number | null = null;
    let warmupBodyChunks = 0;
    let warmupSamples = 0;
    const warmupStarted = performance.now();
    const result = ffi.ttsSynthesizeStream({
      ctx,
      text,
      speakerPresetId: speakerPresetId || null,
      onChunk: ({ pcm, isFinal }) => {
        if (isFinal || pcm.length === 0) return false;
        if (warmupBodyChunks === 0) {
          warmupFirstAudioMs = performance.now() - warmupStarted;
        }
        warmupBodyChunks++;
        warmupSamples += pcm.length;
        return false;
      },
    });
    const warmupSynthMs = performance.now() - warmupStarted;
    const warmupAudioSeconds = warmupSamples / 24000;
    warmups.push({
      firstAudioMs: warmupFirstAudioMs,
      synthMs: warmupSynthMs,
      bodyChunks: warmupBodyChunks,
      samples: warmupSamples,
      audioSeconds: warmupAudioSeconds,
      rtf:
        warmupAudioSeconds > 0 ? warmupSynthMs / 1000 / warmupAudioSeconds : null,
      cancelled: result.cancelled,
    });
  }

  let chunks = 0;
  let bodyChunks = 0;
  let finalChunks = 0;
  let samples = 0;
  let firstAudioMs: number | null = null;
  let firstChunkSamples = 0;
  let largestChunkSamples = 0;
  let nativeCancelCalled = false;
  let cancelRequested = false;
  let cancelled = false;
  let synthMs = 0;
  const pcmChunks: Float32Array[] = [];

  if (streamSupported) {
    const synthStarted = performance.now();
    const result = ffi.ttsSynthesizeStream({
      ctx,
      text,
      speakerPresetId: speakerPresetId || null,
      onChunk: ({ pcm, isFinal }) => {
        chunks++;
        if (isFinal) {
          finalChunks++;
          return false;
        }
        bodyChunks++;
        if (firstAudioMs === null) {
          firstAudioMs = performance.now() - synthStarted;
          firstChunkSamples = pcm.length;
        }
        largestChunkSamples = Math.max(largestChunkSamples, pcm.length);
        samples += pcm.length;
        if (wavOutPath && pcm.length > 0) {
          pcmChunks.push(new Float32Array(pcm));
        }
        if (
          cancelMode !== "none" &&
          !cancelRequested &&
          bodyChunks >= cancelAfterChunks
        ) {
          cancelRequested = true;
          if (cancelMode === "native-in-callback") {
            ffi.cancelTts(ctx);
            nativeCancelCalled = true;
            return false;
          }
          return true;
        }
        return false;
      },
    });
    synthMs = performance.now() - synthStarted;
    cancelled = result.cancelled;
  }

  const expectsCancel = cancelMode !== "none";
  const ok =
    streamSupported &&
    bodyChunks > 0 &&
    finalChunks > 0 &&
    samples > 0 &&
    (expectsCancel ? cancelled : !cancelled) &&
    (cancelMode === "native-in-callback" ? nativeCancelCalled : true);

  let wavBytes = 0;
  if (wavOutPath && samples > 0) {
    const merged = new Float32Array(samples);
    let offset = 0;
    for (const chunk of pcmChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    writeWavPcm16Mono(wavOutPath, merged, 24000);
    wavBytes = 44 + samples * 2;
  }

  ffi.mmapEvict(ctx, "tts");
  const report = {
    ok,
    abi: ffi.libraryAbiVersion,
    dylib,
    bundle,
    text,
    speakerPresetId: speakerPresetId || null,
    streamSupported,
    cancelMode,
    cancelAfterChunks,
    maskgitSteps: effectiveMaskgitSteps,
    chunkDurationSec: effectiveChunkDurationSec,
    chunkThresholdSec: effectiveChunkThresholdSec,
    cancelRequested,
    cancelled,
    nativeCancelCalled,
    chunks,
    bodyChunks,
    finalChunks,
    samples,
    audioSeconds: samples / 24000,
    firstAudioMs,
    firstChunkSamples,
    firstChunkAudioSeconds: firstChunkSamples / 24000,
    largestChunkSamples,
    largestChunkAudioSeconds: largestChunkSamples / 24000,
    wavOut: wavOutPath || null,
    wavBytes,
    acquireMs,
    synthMs,
    rtf: samples > 0 ? synthMs / 1000 / (samples / 24000) : null,
    totalMs: performance.now() - started,
    warmupRuns,
    warmups,
    codecBackendPolicy: codecBackendPolicy(dylib),
    reason: ok
      ? null
      : streamSupported
        ? "stream ran but did not satisfy chunk/final/cancel expectations"
        : "eliza_inference_tts_stream_supported() returned 0",
  };
  const json = JSON.stringify(report, null, 2);
  if (outPath) writeFileSync(outPath, `${json}\n`);
  console.log(json);
  if (!ok) process.exit(2);
} finally {
  ffi.destroy(ctx);
  ffi.close();
}
