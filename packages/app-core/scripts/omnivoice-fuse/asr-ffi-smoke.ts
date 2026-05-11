#!/usr/bin/env bun
import { readFileSync } from "node:fs";
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

function readWavPcm16Mono(path: string): {
  pcm: Float32Array;
  sampleRateHz: number;
} {
  const buf = readFileSync(path);
  if (
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error(`unsupported WAV container: ${path}`);
  }

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRateHz = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    offset += 8;
    if (id === "fmt ") {
      audioFormat = buf.readUInt16LE(offset);
      channels = buf.readUInt16LE(offset + 2);
      sampleRateHz = buf.readUInt32LE(offset + 4);
      bitsPerSample = buf.readUInt16LE(offset + 14);
    } else if (id === "data") {
      dataOffset = offset;
      dataBytes = size;
      break;
    }
    offset += size + (size & 1);
  }

  if (
    audioFormat !== 1 ||
    channels !== 1 ||
    bitsPerSample !== 16 ||
    dataOffset < 0
  ) {
    throw new Error(
      `expected mono PCM16 WAV; got format=${audioFormat} channels=${channels} bits=${bitsPerSample}`,
    );
  }
  const samples = Math.floor(dataBytes / 2);
  const pcm = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.max(-1, buf.readInt16LE(dataOffset + i * 2) / 32768);
  }
  return { pcm, sampleRateHz };
}

const dylib = arg(
  "--dylib",
  `${process.env.HOME}/.eliza/local-inference/bin/dflash/darwin-arm64-metal-fused/libelizainference.dylib`,
);
const bundle = arg(
  "--bundle",
  `${process.env.HOME}/.eliza/local-inference/models/eliza-1-1_7b.bundle`,
);
const wav = arg("--wav", "/tmp/eliza-asr-hello.wav");
const expected = arg("--expected", "hello world").toLowerCase();

function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const ffi = loadElizaInferenceFfi(dylib);
const ctx = ffi.create(bundle);
const started = performance.now();
try {
  const acquireStarted = performance.now();
  ffi.mmapAcquire(ctx, "asr");
  const acquireMs = performance.now() - acquireStarted;

  const { pcm, sampleRateHz } = readWavPcm16Mono(wav);
  const transcribeStarted = performance.now();
  const transcript = ffi.asrTranscribe({ ctx, pcm, sampleRateHz });
  const transcribeMs = performance.now() - transcribeStarted;
  const normalizedTranscript = normalizeTranscript(transcript);
  const normalizedExpected = normalizeTranscript(expected);
  const ok = normalizedTranscript.includes(normalizedExpected);

  ffi.mmapEvict(ctx, "asr");
  const result = {
    ok,
    abi: ffi.libraryAbiVersion,
    dylib,
    bundle,
    wav,
    transcript,
    normalizedTranscript,
    expectedContains: expected,
    normalizedExpected,
    sampleRateHz,
    samples: pcm.length,
    acquireMs,
    transcribeMs,
    totalMs: performance.now() - started,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!ok) process.exit(2);
} finally {
  ffi.destroy(ctx);
  ffi.close();
}
