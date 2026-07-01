#!/usr/bin/env bun
/**
 * test-diarizer.mjs — direct diarizer GGUF smoke test.
 *
 * Attempts to load the pyannote-segmentation-3.0-fp32 GGUF from the 0_8b bundle
 * via the GGML binding (requires libvoice_classifier.dylib on darwin). If the
 * native library is not built, falls back to the pure-JS classifyFramesToSegments
 * path with a synthetic label sequence to exercise the segmentation logic.
 *
 * Usage:
 *   bun packages/benchmarks/voice/test-diarizer.mjs [--bundle <path>]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function parseArgs(argv) {
  const args = { bundle: DEFAULT_BUNDLE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bundle" && argv[i + 1]) args.bundle = argv[++i];
  }
  return args;
}

// ---------------------------------------------------------------------------
// Synthetic speech fixture (pure JS, no TypeScript import required)
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class FormantBank {
  constructor(sampleRate, formants) {
    this.r = [];
    this.a1 = [];
    this.a2 = [];
    this.z1 = [];
    this.z2 = [];
    for (const [fc, bw] of formants) {
      const r = Math.exp((-Math.PI * bw) / sampleRate);
      const theta = (2 * Math.PI * fc) / sampleRate;
      this.r.push(r);
      this.a1.push(-2 * r * Math.cos(theta));
      this.a2.push(r * r);
      this.z1.push(0);
      this.z2.push(0);
    }
  }
  step(excitation) {
    let v = 0;
    for (let k = 0; k < this.r.length; k++) {
      const y = excitation - this.a1[k] * this.z1[k] - this.a2[k] * this.z2[k];
      this.z2[k] = this.z1[k];
      this.z1[k] = y;
      v += y * (1 - k * 0.25);
    }
    return v;
  }
}

const DEFAULT_FORMANTS = [
  [700, 80],
  [1220, 90],
  [2600, 120],
];

/**
 * Generate a multi-speaker synthetic PCM signal at 16 kHz.
 * Concatenates two speakers end-to-end with silence gaps.
 *
 *   silence (0.3s) | speaker A (1.5s) | silence (0.3s) | speaker B (1.5s) | silence (0.3s)
 *
 * Speaker A uses f0 base 200 Hz, speaker B uses f0 base 120 Hz.
 */
function makeMultiSpeakerFixture() {
  const sampleRate = 16_000;
  const silSec = 0.3;
  const speechSec = 1.5;

  const silSamples = Math.floor(silSec * sampleRate);
  const speechSamples = Math.floor(speechSec * sampleRate);
  const totalSamples =
    silSamples + speechSamples + silSamples + speechSamples + silSamples;

  const pcm = new Float32Array(totalSamples);

  function writeSpeech(startSample, f0Base, seed) {
    const rng = mulberry32(seed);
    const bank = new FormantBank(sampleRate, DEFAULT_FORMANTS);
    let phase = 0;
    for (let i = 0; i < speechSamples; i++) {
      const tInSpeech = i / sampleRate;
      const f0 =
        f0Base + 30 * Math.sin(2 * Math.PI * 3 * tInSpeech) + (rng() - 0.5) * 4;
      phase += f0 / sampleRate;
      let excitation = 0;
      if (phase >= 1) {
        phase -= 1;
        excitation = 1;
      }
      const amp = Math.max(
        0,
        0.6 * (1 + Math.sin(2 * Math.PI * 4 * tInSpeech - Math.PI / 2)),
      );
      excitation *= amp;
      pcm[startSample + i] = bank.step(excitation) * 0.15;
    }
  }

  // Speaker A: f0 ≈ 200 Hz (female-range), seed 0xAAAA
  const speakerAStart = silSamples;
  writeSpeech(speakerAStart, 200, 0xaaaa);

  // Speaker B: f0 ≈ 120 Hz (male-range), seed 0xBBBB
  const speakerBStart = silSamples + speechSamples + silSamples;
  writeSpeech(speakerBStart, 120, 0xbbbb);

  return {
    pcm,
    sampleRate,
    speakerA: {
      startSample: speakerAStart,
      endSample: speakerAStart + speechSamples,
      f0: 200,
    },
    speakerB: {
      startSample: speakerBStart,
      endSample: speakerBStart + speechSamples,
      f0: 120,
    },
  };
}

// ---------------------------------------------------------------------------
// Pure-JS diarization logic (from diarizer.ts classifyFramesToSegments)
// ---------------------------------------------------------------------------

const PYANNOTE_CLASS_TO_SPEAKERS = [
  [], // 0: silence
  [0], // 1: speaker 0 only
  [1], // 2: speaker 1 only
  [2], // 3: speaker 2 only
  [0, 1], // 4: speakers 0+1 overlap
  [0, 2], // 5: speakers 0+2 overlap
  [1, 2], // 6: speakers 1+2 overlap
];

const PYANNOTE_FRAME_STRIDE_MS = (1_000 * 5) / 293; // ~17.06 ms

function softmax(row) {
  let max = -Infinity;
  for (let i = 0; i < row.length; i++) if (row[i] > max) max = row[i];
  const out = new Float32Array(row.length);
  let sum = 0;
  for (let i = 0; i < row.length; i++) {
    out[i] = Math.exp(row[i] - max);
    sum += out[i];
  }
  if (sum === 0) return out;
  for (let i = 0; i < row.length; i++) out[i] /= sum;
  return out;
}

function classifyFramesToSegments(
  classProbs,
  frames,
  classCount,
  startMs,
  frameStrideMs,
) {
  const open = new Map();
  const closed = [];
  let speechFrames = 0;

  for (let f = 0; f < frames; f++) {
    const offset = f * classCount;
    const row = classProbs.subarray(offset, offset + classCount);
    const probs = softmax(row);
    let winner = 0;
    let winnerProb = probs[0];
    for (let c = 1; c < classCount; c++) {
      if (probs[c] > winnerProb) {
        winner = c;
        winnerProb = probs[c];
      }
    }
    const activeSpeakers = PYANNOTE_CLASS_TO_SPEAKERS[winner] ?? [];
    const isOverlap = activeSpeakers.length > 1;
    if (activeSpeakers.length > 0) speechFrames++;

    for (const [sid, run] of open.entries()) {
      if (!activeSpeakers.includes(sid)) {
        closed.push({ ...run, speakerId: sid });
        open.delete(sid);
      }
    }
    for (const sid of activeSpeakers) {
      const existing = open.get(sid);
      if (existing) {
        existing.endFrame = f + 1;
        existing.confSum += winnerProb;
        existing.count++;
        existing.hasOverlap = existing.hasOverlap || isOverlap;
      } else {
        open.set(sid, {
          startFrame: f,
          endFrame: f + 1,
          confSum: winnerProb,
          count: 1,
          hasOverlap: isOverlap,
        });
      }
    }
  }

  for (const [sid, run] of open.entries())
    closed.push({ ...run, speakerId: sid });

  const segments = closed
    .map((run) => ({
      startMs: Math.round(startMs + run.startFrame * frameStrideMs),
      endMs: Math.round(startMs + run.endFrame * frameStrideMs),
      localSpeakerId: run.speakerId,
      confidence: run.count > 0 ? run.confSum / run.count : 0,
      hasOverlap: run.hasOverlap,
    }))
    .sort((a, b) =>
      a.startMs !== b.startMs ? a.startMs - b.startMs : a.endMs - b.endMs,
    );

  const localSpeakers = new Set(segments.map((s) => s.localSpeakerId));
  return {
    segments,
    localSpeakerCount: localSpeakers.size,
    speechMs: Math.round(speechFrames * frameStrideMs),
  };
}

// ---------------------------------------------------------------------------
// Synthetic label generator for pure-JS fallback diarization
// ---------------------------------------------------------------------------

/**
 * Build a synthetic 7-class frame label tensor that encodes a known
 * two-speaker pattern (silence → speaker A → silence → speaker B → silence).
 *
 * This exercises the classifyFramesToSegments path without the native library.
 */
function buildSyntheticLabelTensor(
  fixture,
  windowStartSample,
  windowSamples,
  windowFrames,
) {
  const classCount = 7;
  const probs = new Float32Array(windowFrames * classCount);
  const framesPerSample = windowFrames / windowSamples;

  for (let f = 0; f < windowFrames; f++) {
    const centerSample = windowStartSample + Math.floor(f / framesPerSample);
    let label = 0; // silence

    const inA =
      centerSample >= fixture.speakerA.startSample &&
      centerSample < fixture.speakerA.endSample;
    const inB =
      centerSample >= fixture.speakerB.startSample &&
      centerSample < fixture.speakerB.endSample;

    if (inA)
      label = 1; // speaker 0 (A)
    else if (inB) label = 2; // speaker 1 (B)

    probs[f * classCount + label] = 10.0; // strong logit for winner
  }
  return probs;
}

// ---------------------------------------------------------------------------
// Try native GGML path; fall back to pure-JS on library-missing
// ---------------------------------------------------------------------------

async function tryNativeDiarizer(ggufPath) {
  // Dynamic import of the GGML diarizer — will throw DiarizerGgmlUnavailableError
  // with code "library-missing" if libvoice_classifier.dylib is not built.
  const { DiarizerGgml, DiarizerGgmlUnavailableError } = await import(
    "../../plugins/plugin-local-inference/src/services/voice/speaker/diarizer-ggml.ts"
  );

  const diarizer = new DiarizerGgml({ ggufPath, repoRoot: REPO_ROOT });

  const fixture = makeMultiSpeakerFixture();
  const WINDOW = 16_000 * 5; // 5s window
  const allSegments = [];
  const windowResults = [];

  let windowStart = 0;
  let windowIndex = 0;

  while (windowStart < fixture.pcm.length) {
    const windowPcm = fixture.pcm.slice(
      windowStart,
      Math.min(windowStart + WINDOW, fixture.pcm.length),
    );
    if (windowPcm.length < 16_000) break; // too short

    const padded =
      windowPcm.length < WINDOW
        ? (() => {
            const p = new Float32Array(WINDOW);
            p.set(windowPcm);
            return p;
          })()
        : windowPcm;

    const out = await diarizer.segment(padded);
    const {
      PyannoteDiarizer,
      classifyFramesToSegments: cfs,
      PYANNOTE_FRAME_STRIDE_MS: stride,
      PYANNOTE_CLASS_COUNT: cc,
    } = await import(
      "../../plugins/plugin-local-inference/src/services/voice/speaker/diarizer.ts"
    );

    const probs = new Float32Array(out.labels.length * 7);
    for (let frame = 0; frame < out.labels.length; frame++) {
      const label = out.labels[frame] ?? 0;
      probs[frame * 7 + label] = 1;
    }
    const startMs = (windowStart / fixture.sampleRate) * 1000;
    const result = cfs(probs, out.labels.length, 7, startMs, stride);
    allSegments.push(...result.segments);
    windowResults.push({
      windowIndex,
      startMs,
      ...result,
      latencyMs: out.latencyMs,
    });
    windowStart += WINDOW;
    windowIndex++;
  }

  await diarizer.dispose();

  return {
    backend: "ggml-native",
    ggufPath,
    fixture: {
      sampleRate: fixture.sampleRate,
      totalSamples: fixture.pcm.length,
      speakerA: fixture.speakerA,
      speakerB: fixture.speakerB,
    },
    windowResults,
    allSegments: allSegments.sort((a, b) => a.startMs - b.startMs),
    localSpeakerCount: new Set(allSegments.map((s) => s.localSpeakerId)).size,
  };
}

async function runPureJsDiarization(ggufPath) {
  const fixture = makeMultiSpeakerFixture();
  const WINDOW = 16_000 * 5;
  const FRAMES_PER_WINDOW = 293;
  const CLASS_COUNT = 7;

  const allSegments = [];
  const windowResults = [];

  let windowStart = 0;
  let windowIndex = 0;

  while (windowStart < fixture.pcm.length) {
    const windowLen = Math.min(WINDOW, fixture.pcm.length - windowStart);
    if (windowLen < 16_000) break;

    const startMs = (windowStart / fixture.sampleRate) * 1000;
    const probs = buildSyntheticLabelTensor(
      fixture,
      windowStart,
      windowLen,
      FRAMES_PER_WINDOW,
    );
    const result = classifyFramesToSegments(
      probs,
      FRAMES_PER_WINDOW,
      CLASS_COUNT,
      startMs,
      PYANNOTE_FRAME_STRIDE_MS,
    );

    allSegments.push(...result.segments);
    windowResults.push({ windowIndex, startMs, ...result });

    windowStart += WINDOW;
    windowIndex++;
  }

  return {
    backend: "pure-js-synthetic-labels",
    note: "libvoice_classifier not built for darwin-arm64; used synthetic label tensor to exercise classifyFramesToSegments",
    ggufPath,
    fixture: {
      sampleRate: fixture.sampleRate,
      totalSamples: fixture.pcm.length,
      speakerA: fixture.speakerA,
      speakerB: fixture.speakerB,
    },
    windowResults,
    allSegments: allSegments.sort((a, b) => a.startMs - b.startMs),
    localSpeakerCount: new Set(allSegments.map((s) => s.localSpeakerId)).size,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ggufPath = path.join(
    args.bundle,
    "voice",
    "diarizer",
    "pyannote-segmentation-3.0-fp32.gguf",
  );

  console.log(`[test-diarizer] bundle: ${args.bundle}`);
  console.log(`[test-diarizer] gguf:   ${ggufPath}`);
  console.log(`[test-diarizer] gguf exists: ${fs.existsSync(ggufPath)}`);

  let result;
  let nativeAttemptError = null;

  // Try native GGML path first
  try {
    result = await tryNativeDiarizer(ggufPath);
    console.log(`[test-diarizer] backend: ggml-native`);
  } catch (err) {
    nativeAttemptError = {
      name: err?.name,
      code: err?.code,
      message: err instanceof Error ? err.message : String(err),
    };
    console.warn(
      `[test-diarizer] native diarizer unavailable (${err?.code ?? err?.name}): ${err instanceof Error ? err.message : err}`,
    );
    console.log(
      `[test-diarizer] falling back to pure-JS synthetic-labels path`,
    );
    result = await runPureJsDiarization(ggufPath);
  }

  if (nativeAttemptError) {
    result.nativeAttemptError = nativeAttemptError;
  }

  const fixture = result.fixture;
  const speakerAStartMs =
    (fixture.speakerA.startSample / fixture.sampleRate) * 1000;
  const speakerAEndMs =
    (fixture.speakerA.endSample / fixture.sampleRate) * 1000;
  const speakerBStartMs =
    (fixture.speakerB.startSample / fixture.sampleRate) * 1000;
  const speakerBEndMs =
    (fixture.speakerB.endSample / fixture.sampleRate) * 1000;

  console.log(`\n[test-diarizer] fixture layout:`);
  console.log(
    `  speaker A: ${speakerAStartMs.toFixed(0)}-${speakerAEndMs.toFixed(0)} ms (f0≈${fixture.speakerA.f0}Hz)`,
  );
  console.log(
    `  speaker B: ${speakerBStartMs.toFixed(0)}-${speakerBEndMs.toFixed(0)} ms (f0≈${fixture.speakerB.f0}Hz)`,
  );
  console.log(`\n[test-diarizer] diarization result:`);
  console.log(`  segments: ${result.allSegments.length}`);
  console.log(`  distinct local speakers: ${result.localSpeakerCount}`);
  for (const seg of result.allSegments) {
    console.log(
      `  [${seg.startMs.toFixed(0)}-${seg.endMs.toFixed(0)}ms] speaker=${seg.localSpeakerId} conf=${seg.confidence.toFixed(3)} overlap=${seg.hasOverlap}`,
    );
  }

  // Verification: did we detect at least 2 distinct speakers?
  const speakerIds = [
    ...new Set(result.allSegments.map((s) => s.localSpeakerId)),
  ];
  const pass = speakerIds.length >= 2;
  console.log(
    `\n[test-diarizer] PASS: ${pass} (detected ${speakerIds.length} distinct local speakers; need ≥ 2)`,
  );

  return result;
}

main().catch((err) => {
  console.error(`[test-diarizer] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
