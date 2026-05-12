/**
 * Synthetic fixture generator.
 *
 * Real speech audio is not committed to the repo — the harness generates
 * deterministic synthetic test audio at run time. The shapes:
 *
 *   - silence: 16-bit zeros (VAD must NOT fire)
 *   - white-noise speech proxy: shaped noise that triggers VAD energy gates
 *   - short utterance: 1.5 s of band-limited noise + envelope
 *   - long utterance: 8 s of band-limited noise + envelope
 *   - false-EOS utterance: long shape with a 400 ms mid-clause dip
 *   - barge-in overlay: 1 s of higher-energy noise to mix at t=3 s
 *
 * Per the ELIZA_1_GGUF_READINESS audit, synthetic fixtures cover *plumbing*
 * correctness only. Latency gates against real speech still require
 * real-recorded WAVs in a follow-up.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { encodeWav } from "./audio-source.ts";

const SAMPLE_RATE = 16000;

/**
 * A small deterministic PRNG (mulberry32) so generated fixtures are
 * stable across runs / OSes.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Band-limited noise envelope shaped to look like speech to a VAD energy
 * gate. Centered around 200–800 Hz, with a slow amplitude envelope so the
 * VAD onset+hangover machinery has something to bite on.
 */
function speechProxy(
  durationMs: number,
  seed: number,
  amplitude = 0.18,
): Float32Array {
  const samples = Math.floor((durationMs / 1000) * SAMPLE_RATE);
  const out = new Float32Array(samples);
  const rng = mulberry32(seed);
  // Two pseudo-formant tones with noise modulation.
  const f1 = 220;
  const f2 = 660;
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    // Envelope: 25 ms attack, 50 ms decay around 50 ms syllables.
    const syllable = (Math.sin(2 * Math.PI * 5 * t) + 1) * 0.5; // 5 Hz syllable
    const env = Math.min(1, syllable * 1.4) * Math.exp(-((t % 0.2) - 0.1) ** 2 * 60);
    const noise = (rng() - 0.5) * 2;
    const tone = 0.6 * Math.sin(2 * Math.PI * f1 * t) +
      0.4 * Math.sin(2 * Math.PI * f2 * t);
    out[i] = amplitude * env * (0.5 * tone + 0.5 * noise);
  }
  return out;
}

/** Pure silence at the given duration. */
export function generateSilence(durationMs: number): Float32Array {
  return new Float32Array(Math.floor((durationMs / 1000) * SAMPLE_RATE));
}

/** Short utterance — 1.5 s of speech proxy. */
export function generateShortUtterance(seed = 42): Float32Array {
  return speechProxy(1500, seed);
}

/** Long utterance — 8 s of speech proxy. */
export function generateLongUtterance(seed = 43): Float32Array {
  return speechProxy(8000, seed);
}

/**
 * Long utterance with a 400 ms mid-clause silence dip — used to test that
 * the pipeline's optimistic decoder fires on the pause but rolls back
 * cleanly when speech resumes.
 */
export function generateFalseEosUtterance(seed = 44): Float32Array {
  const first = speechProxy(3000, seed);
  const dip = generateSilence(400);
  const rest = speechProxy(4000, seed + 1);
  const out = new Float32Array(first.length + dip.length + rest.length);
  out.set(first, 0);
  out.set(dip, first.length);
  out.set(rest, first.length + dip.length);
  return out;
}

/**
 * 1 s of higher-energy noise suitable for overlaying as a barge-in
 * trigger (loud enough that VAD onset fires, not so loud the original
 * audio gets clipped after additive mixing).
 */
export function generateBargeInOverlay(seed = 45): Float32Array {
  return speechProxy(1000, seed, 0.25);
}

/** Sample-rate convenience export. */
export const FIXTURE_SAMPLE_RATE = SAMPLE_RATE;

/** Write a Float32 PCM buffer to disk as a 16 kHz mono 16-bit WAV. */
export function writeFixtureWav(path: string, pcm: Float32Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = encodeWav(pcm, SAMPLE_RATE);
  writeFileSync(path, bytes);
}

export interface FixtureSet {
  silence: Float32Array;
  short: Float32Array;
  long: Float32Array;
  falseEos: Float32Array;
  bargeInOverlay: Float32Array;
}

/** All fixtures in memory, deterministically seeded. */
export function generateAllFixtures(): FixtureSet {
  return {
    silence: generateSilence(1500),
    short: generateShortUtterance(),
    long: generateLongUtterance(),
    falseEos: generateFalseEosUtterance(),
    bargeInOverlay: generateBargeInOverlay(),
  };
}
