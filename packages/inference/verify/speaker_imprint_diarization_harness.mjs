#!/usr/bin/env node
/**
 * Generated-voice VAD + attribution-only speaker imprint harness.
 *
 * This records the current local state honestly:
 *   - real app-core VAD is run on a generated voice WAV when one is present,
 *     or on a deterministic generated-speech fixture unless --require-wav is set;
 *   - speaker attribution is exercised on supplied segment embeddings;
 *   - full local multi-speaker diarization DER is reported as unavailable
 *     until a local segmentation + speaker-embedding model is wired.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_BUNDLE = path.join(
  os.homedir(),
  ".eliza",
  "local-inference",
  "models",
  "eliza-1-0_8b.bundle",
);
const DEFAULT_WAV = "/tmp/omnivoice-metal-fused-codec-cpu-fallback.wav";
const DEFAULT_REPORT = path.join(
  REPO_ROOT,
  "packages",
  "inference",
  "verify",
  "reports",
  `generated-voice-diarization-${timestamp()}.json`,
);

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function parseArgs(argv) {
  const args = {
    bundle: DEFAULT_BUNDLE,
    wav: DEFAULT_WAV,
    report: DEFAULT_REPORT,
    json: false,
    requireWav: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--bundle") args.bundle = argv[++i] ?? args.bundle;
    else if (arg === "--wav") args.wav = argv[++i] ?? args.wav;
    else if (arg === "--report") args.report = argv[++i] ?? args.report;
    else if (arg === "--json") args.json = true;
    else if (arg === "--require-wav") args.requireWav = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node speaker_imprint_diarization_harness.mjs [--bundle PATH] [--wav PATH] [--report PATH] [--json] [--require-wav]",
      );
      process.exit(0);
    }
  }
  args.bundle = path.resolve(args.bundle);
  args.wav = path.resolve(args.wav);
  args.report = path.resolve(args.report);
  return args;
}

function typescriptRunner() {
  if (fs.existsSync(path.join(REPO_ROOT, "node_modules", ".bin", "tsx"))) {
    for (const cmd of [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      process.execPath,
    ]) {
      if (cmd && fs.existsSync(cmd)) {
        return { cmd, args: ["--import", "tsx"] };
      }
    }
  }
  for (const cmd of [
    "bun",
    path.join(os.homedir(), ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ]) {
    const probe = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return { cmd, args: [] };
  }
  return null;
}

function makeRunnerSource(args) {
  const vadUrl = pathToFileURL(
    path.join(
      REPO_ROOT,
      "packages",
      "app-core",
      "src",
      "services",
      "local-inference",
      "voice",
      "vad.ts",
    ),
  ).href;
  const imprintUrl = pathToFileURL(
    path.join(
      REPO_ROOT,
      "packages",
      "app-core",
      "src",
      "services",
      "local-inference",
      "voice",
      "speaker-imprint.ts",
    ),
  ).href;
  const fixtureUrl = pathToFileURL(
    path.join(
      REPO_ROOT,
      "packages",
      "app-core",
      "src",
      "services",
      "local-inference",
      "voice",
      "__test-helpers__",
      "synthetic-speech.ts",
    ),
  ).href;

  return `
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { resolveSileroVadPath, resolveVadProvider, VadDetector } from ${JSON.stringify(vadUrl)};
import { attributeVoiceImprintObservations } from ${JSON.stringify(imprintUrl)};
import { makeSpeechWithSilenceFixture } from ${JSON.stringify(fixtureUrl)};

const bundleRoot = ${JSON.stringify(args.bundle)};
const wavPath = ${JSON.stringify(args.wav)};
const requireWav = ${JSON.stringify(args.requireWav)};
const SR = 16000;
const FRAME = 512;

function writeWavPcm16Mono(file, pcm, sampleRateHz) {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRateHz, 24);
  buf.writeUInt32LE(sampleRateHz * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  let off = 44;
  for (const sample of pcm) {
    const clamped = Math.max(-1, Math.min(1, sample));
    buf.writeInt16LE(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), off);
    off += 2;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

function ensureGeneratedVoiceWav() {
  if (fs.existsSync(wavPath)) {
    return { path: wavPath, fixtureKind: "provided_generated_voice_wav" };
  }
  if (requireWav) {
    return null;
  }
  const fixture = makeSpeechWithSilenceFixture({
    sampleRate: 24000,
    leadSilenceSec: 0.35,
    speechSec: 1.6,
    tailSilenceSec: 0.45,
    seed: 0x0e11a,
  });
  writeWavPcm16Mono(wavPath, fixture.pcm, fixture.sampleRate);
  return {
    path: wavPath,
    fixtureKind: "deterministic_generated_voice_fixture",
    speechStartMs: (fixture.speechStartSample / fixture.sampleRate) * 1000,
    speechEndMs: (fixture.speechEndSample / fixture.sampleRate) * 1000,
  };
}

function readWavPcm16Mono(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("unsupported WAV container");
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
  if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16 || dataOffset < 0) {
    throw new Error(\`expected mono PCM16 WAV; got format=\${audioFormat} channels=\${channels} bits=\${bitsPerSample}\`);
  }
  const samples = Math.floor(dataBytes / 2);
  const pcm = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    pcm[i] = Math.max(-1, buf.readInt16LE(dataOffset + i * 2) / 32768);
  }
  return {
    pcm,
    sampleRateHz,
    samples,
    dataBytes,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

function resampleLinear(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(pcm.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const frac = pos - i0;
    out[i] = pcm[i0] * (1 - frac) + pcm[i1] * frac;
  }
  return out;
}

function median(xs) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function p95(xs) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

async function runVad() {
  const input = ensureGeneratedVoiceWav();
  if (!input) {
    return {
      available: false,
      reason: "generated voice WAV not found",
      wavPath,
    };
  }
  const modelPath = resolveSileroVadPath({ bundleRoot });
  if (!modelPath) {
    return {
      available: false,
      reason: "no VAD model found",
      bundleRoot,
      wavPath,
    };
  }
  const wav = readWavPcm16Mono(input.path);
  const pcm16k = resampleLinear(wav.pcm, wav.sampleRateHz, SR);
  const provider = await resolveVadProvider({
    modelPath,
    bundleRoot,
    config: {
      sampleRate: SR,
      onsetThreshold: 0.5,
      pauseHangoverMs: 220,
      endHangoverMs: 500,
      minSpeechMs: 150,
    },
  });
  const detector = new VadDetector(provider.vad, {
    sampleRate: SR,
    onsetThreshold: 0.5,
    pauseHangoverMs: 220,
    endHangoverMs: 500,
    minSpeechMs: 150,
  });
  const events = [];
  const computeMs = [];
  detector.onVadEvent((event) => events.push(event));
  let ts = 0;
  for (let i = 0; i < pcm16k.length; i += FRAME) {
    const frame = new Float32Array(FRAME);
    frame.set(pcm16k.subarray(i, Math.min(i + FRAME, pcm16k.length)));
    const t0 = performance.now();
    await detector.pushFrame({ pcm: frame, sampleRate: SR, timestampMs: ts });
    computeMs.push(performance.now() - t0);
    ts += (FRAME * 1000) / SR;
  }
  await detector.flush();
  const starts = events.filter((event) => event.type === "speech-start");
  const ends = events.filter((event) => event.type === "speech-end");
  return {
    available: true,
    provider: provider.id,
    vadModelPath: modelPath,
    wavPath: input.path,
    fixtureKind: input.fixtureKind,
    expectedSpeechStartMs: input.speechStartMs ?? null,
    expectedSpeechEndMs: input.speechEndMs ?? null,
    wav: {
      sampleRateHz: wav.sampleRateHz,
      samples: wav.samples,
      audioSeconds: wav.samples / wav.sampleRateHz,
      sha256: wav.sha256,
    },
    resampled: {
      sampleRateHz: SR,
      samples: pcm16k.length,
      audioSeconds: pcm16k.length / SR,
    },
    summary: {
      speechDetected: starts.length > 0,
      speechStarts: starts.length,
      speechEnds: ends.length,
      firstSpeechStartMs: starts[0]?.timestampMs ?? null,
      firstSpeechEndMs: ends[0]?.timestampMs ?? null,
      speechDurationMs: ends[0]?.speechDurationMs ?? null,
      computeMsMedian: median(computeMs),
      computeMsP95: p95(computeMs),
    },
    events,
  };
}

const vad = await runVad();
const source = {
  kind: "file",
  sourceId: wavPath,
  metadata: {
    generatedVoice: true,
    wavSha256: vad.wav?.sha256,
  },
};
const attribution = attributeVoiceImprintObservations({
  defaultSource: source,
  threshold: 0.8,
  profiles: [
    {
      id: "cluster-generated-owner",
      label: "Generated owner voice",
      displayName: "Generated owner voice",
      entityId: "entity-owner",
      centroidEmbedding: [1, 0, 0],
      embeddingModel: "eliza-voice-embed-v1",
      confidence: 0.92,
      metadata: { attributionOnly: true },
    },
    {
      id: "cluster-generated-guest",
      label: "Generated guest voice",
      displayName: "Generated guest voice",
      entityId: "entity-guest",
      centroidEmbedding: [0, 1, 0],
      embeddingModel: "eliza-voice-embed-v1",
      confidence: 0.88,
      metadata: { attributionOnly: true },
    },
  ],
  observations: [
    {
      id: "obs-generated-owner-1",
      segmentId: "seg-generated-owner-1",
      text: "generated voice sample",
      startMs: vad.summary?.firstSpeechStartMs ?? 0,
      endMs: vad.summary?.firstSpeechEndMs ?? 1000,
      embedding: [0.99, 0.02, 0],
      embeddingModel: "eliza-voice-embed-v1",
      confidence: 0.9,
    },
    {
      id: "obs-generated-guest-1",
      segmentId: "seg-generated-guest-1",
      text: "second supplied segment embedding",
      startMs: 0,
      endMs: 1000,
      embedding: [0.01, 0.99, 0],
      embeddingModel: "eliza-voice-embed-v1",
      confidence: 0.88,
      source: {
        kind: "unknown",
        metadata: {
          suppliedEmbeddingFixture: true,
        },
      },
    },
  ],
});
const expectedEntityIds = ["entity-owner", "entity-guest"];
const predictedEntityIds = attribution.segments.map((segment) => segment.speaker?.entityId ?? null);
const correct = predictedEntityIds.filter((value, i) => value === expectedEntityIds[i]).length;

console.log(JSON.stringify({
  available: true,
  generatedAt: new Date().toISOString(),
  bundleRoot,
  vad,
  speakerAttribution: {
    mode: "attribution_only_supplied_embeddings",
    expectedEntityIds,
    predictedEntityIds,
    accuracy: correct / expectedEntityIds.length,
    summary: attribution.summary,
    primarySpeakerEntityId: attribution.primarySpeaker?.entityId ?? null,
    segments: attribution.segments,
  },
  diarization: {
    localMultiSpeakerImplemented: false,
    der: null,
    reason: "No local multi-speaker segmentation and speaker-embedding extractor is wired yet; this harness validates VAD on generated voice and attribution-only imprint matching on supplied segment embeddings.",
    requiredForDer: [
      "local speaker segmentation or clustering over overlapping speech",
      "speaker embedding extractor calibrated on generated and real microphone speech",
      "labelled multi-speaker local fixtures with RTTM-style reference spans",
    ],
  },
}));
`;
}

function writeReport(args, report) {
  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`wrote ${args.report}`);
    console.log(
      `speaker-imprint-diarization: vad=${report.vad?.available ?? false} attributionAccuracy=${report.speakerAttribution?.accuracy ?? "n/a"} der=${report.diarization?.der ?? "n/a"}`,
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runnerRuntime = typescriptRunner();
  if (!runnerRuntime) {
    writeReport(args, {
      available: false,
      generatedAt: new Date().toISOString(),
      reason:
        "bun or node --import tsx is required to import app-core voice modules",
    });
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-speaker-vad-"));
  const runner = path.join(tmp, "run.mjs");
  fs.writeFileSync(runner, makeRunnerSource(args), "utf8");
  const child = spawnSync(runnerRuntime.cmd, [...runnerRuntime.args, runner], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (child.status !== 0) {
    writeReport(args, {
      available: false,
      generatedAt: new Date().toISOString(),
      reason: "speaker imprint diarization runner failed",
      exitCode: child.status,
      stdout: child.stdout,
      stderr: child.stderr,
    });
    return;
  }

  let report;
  try {
    const lines = child.stdout.trim().split(/\r?\n/).filter(Boolean);
    report = JSON.parse(lines[lines.length - 1] ?? "{}");
  } catch (err) {
    report = {
      available: false,
      generatedAt: new Date().toISOString(),
      reason: "speaker imprint diarization runner did not emit JSON",
      stdout: child.stdout,
      stderr: child.stderr,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
  report.harness = path.relative(process.cwd(), __filename);
  writeReport(args, report);
}

main();
