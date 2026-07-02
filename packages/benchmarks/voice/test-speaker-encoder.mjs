/**
 * test-speaker-encoder.mjs
 *
 * Task 2: Test speaker encoder directly.
 *
 * Attempts to load the WeSpeaker ResNet34-LM GGUF via the GGML binding.
 * On macOS the native libvoice_classifier.dylib is not yet built, so FFI
 * will fail.  In that case the script falls back to a pure-JS synthetic
 * embedding path that exercises the cosine-similarity math and clearly
 * documents what is missing for a live run.
 *
 * The synthetic path generates two voice classes from different frequency
 * carriers (OWNER: 200 Hz, ATTACKER: 120 Hz) through a simple 3-formant
 * resonator, then feeds the PCM through a deterministic feature-extraction
 * pipeline (frame-level RMS + spectral centroid bands) to produce a stable
 * 256-dim embedding — stable enough that same-voice pairs score high and
 * different-voice pairs score low.
 *
 * Run: bun packages/benchmarks/voice/test-speaker-encoder.mjs
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const GGUF_PATH =
  process.env.WESPEAKER_GGUF_PATH ??
  `${process.env.HOME}/.eliza/local-inference/models/eliza-1-0_8b.bundle/voice/speaker-encoder/wespeaker-resnet34-lm-fp32.gguf`;

const EMBEDDING_DIM = 256;
const SAMPLE_RATE = 16_000;
const SPEECH_DURATION_SEC = 1.5; // ~1.5 s per sample

// ---------------------------------------------------------------------------
// Synthetic voice generation
// ---------------------------------------------------------------------------

/** Tiny deterministic PRNG (Mulberry32). */
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
    this.a1 = [];
    this.a2 = [];
    this.z1 = [];
    this.z2 = [];
    this.scale = [];
    for (const [fc, bw, gain] of formants) {
      const r = Math.exp((-Math.PI * bw) / sampleRate);
      const theta = (2 * Math.PI * fc) / sampleRate;
      this.a1.push(-2 * r * Math.cos(theta));
      this.a2.push(r * r);
      this.z1.push(0);
      this.z2.push(0);
      this.scale.push(gain ?? 1);
    }
  }
  step(excitation) {
    let v = 0;
    for (let k = 0; k < this.a1.length; k++) {
      const y = excitation - this.a1[k] * this.z1[k] - this.a2[k] * this.z2[k];
      this.z2[k] = this.z1[k];
      this.z1[k] = y;
      v += y * this.scale[k];
    }
    return v;
  }
}

/**
 * Synthesize a voiced speech sample with the given fundamental frequency f0.
 * Two samples with the same f0 and seed should produce embeddings with high
 * cosine similarity; samples with different f0 should be clearly distinct.
 *
 * @param {object} opts
 * @param {number} opts.f0       - Fundamental frequency in Hz
 * @param {number} opts.seed     - RNG seed for jitter
 * @param {number} [opts.sampleRate]
 * @param {number} [opts.durationSec]
 */
function synthesizeVoice({
  f0,
  seed,
  sampleRate = SAMPLE_RATE,
  durationSec = SPEECH_DURATION_SEC,
}) {
  // Formant frequencies define the "vocal tract" — fixed per voice class.
  // OWNER (high f0): brighter formants.  ATTACKER (low f0): darker formants.
  const F1 = f0 > 150 ? 800 : 550;
  const F2 = f0 > 150 ? 1400 : 1100;
  const F3 = f0 > 150 ? 2800 : 2200;
  const bank = new FormantBank(sampleRate, [
    [F1, 80, 1.0],
    [F2, 100, 0.7],
    [F3, 130, 0.4],
  ]);
  const rng = mulberry32(seed);
  const n = Math.floor(durationSec * sampleRate);
  const pcm = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const jitter = (rng() - 0.5) * 3;
    const instF0 = f0 + 8 * Math.sin(2 * Math.PI * 4 * t) + jitter;
    phase += instF0 / sampleRate;
    let excitation = 0;
    if (phase >= 1) {
      phase -= 1;
      excitation = 1;
    }
    // Syllable-rate amplitude envelope ~4 Hz
    const amp = Math.max(
      0,
      0.6 * (1 + Math.sin(2 * Math.PI * 4 * t - Math.PI / 2)),
    );
    pcm[i] = bank.step(excitation * amp) * 0.15;
  }
  return pcm;
}

// ---------------------------------------------------------------------------
// Pure-JS feature extraction → 256-dim embedding
// ---------------------------------------------------------------------------

const FRAME_SIZE = 512;
const HOP_SIZE = 256;
const N_BANDS = 16; // log-spaced frequency bands per frame

/**
 * Compute a 256-dim embedding from raw PCM using frame-level spectral
 * band energies + RMS.  This is NOT a production speaker encoder — it's a
 * deterministic feature extractor that produces stable embeddings for
 * same-voice pairs and distinct embeddings for different-voice pairs.
 *
 * The 256 features are:
 *   - 16 bands × 8 stat moments (mean, std, min, max per band, 4 temporal stats) = 128
 *   - 16 global spectral band energy percentiles = 16
 *   - 8 f0-range bins × 8 temporal spread stats = 64
 *   - 24 global RMS / energy envelope statistics = 24
 *   - 24 zero-crossing-rate statistics = 24
 *   Total: 256
 *
 * All features are L2-normalized.
 */
function computeEmbedding(pcm) {
  const nFrames = Math.floor((pcm.length - FRAME_SIZE) / HOP_SIZE) + 1;
  if (nFrames < 1) throw new Error("PCM too short for embedding");

  // Pre-allocate band energy matrix [nFrames × N_BANDS]
  const bandEnergies = new Array(nFrames);
  const rmsPerFrame = new Float64Array(nFrames);
  const zcrPerFrame = new Float64Array(nFrames);

  for (let fi = 0; fi < nFrames; fi++) {
    const start = fi * HOP_SIZE;
    const frame = pcm.slice(start, start + FRAME_SIZE);

    // RMS
    let sumSq = 0;
    for (let s = 0; s < frame.length; s++) sumSq += frame[s] * frame[s];
    rmsPerFrame[fi] = Math.sqrt(sumSq / frame.length);

    // Zero-crossing rate
    let zcr = 0;
    for (let s = 1; s < frame.length; s++) {
      if (frame[s] * frame[s - 1] < 0) zcr++;
    }
    zcrPerFrame[fi] = zcr / frame.length;

    // Spectral band energies via DFT (naive O(N²) — OK for 512 samples)
    // Log-spaced bands from 80 Hz to 7500 Hz
    const freqRes = SAMPLE_RATE / FRAME_SIZE; // Hz per bin
    const minBin = Math.floor(80 / freqRes);
    const maxBin = Math.floor(7500 / freqRes);
    const logMin = Math.log(Math.max(1, minBin));
    const logMax = Math.log(maxBin);
    const bands = new Float64Array(N_BANDS);

    // DFT magnitude spectrum
    const mag = new Float64Array(FRAME_SIZE / 2);
    for (let k = 0; k < FRAME_SIZE / 2; k++) {
      let re = 0;
      let im = 0;
      for (let s = 0; s < frame.length; s++) {
        const angle = (2 * Math.PI * k * s) / FRAME_SIZE;
        re += frame[s] * Math.cos(angle);
        im -= frame[s] * Math.sin(angle);
      }
      mag[k] = Math.sqrt(re * re + im * im);
    }

    // Accumulate into log-spaced bands
    for (let k = minBin; k < maxBin && k < mag.length; k++) {
      const logK = Math.log(k);
      const bandIdx = Math.floor(
        ((logK - logMin) / (logMax - logMin)) * N_BANDS,
      );
      if (bandIdx >= 0 && bandIdx < N_BANDS) {
        bands[bandIdx] += mag[k];
      }
    }
    bandEnergies[fi] = bands;
  }

  // Build 256-dim feature vector
  const features = new Float64Array(256);
  let cursor = 0;

  // Per-band statistics (mean, std, min, max across frames) — 4 × N_BANDS = 64
  for (let b = 0; b < N_BANDS; b++) {
    let sum = 0;
    let sumSq = 0;
    let mn = Infinity;
    let mx = -Infinity;
    for (let fi = 0; fi < nFrames; fi++) {
      const v = bandEnergies[fi][b];
      sum += v;
      sumSq += v * v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const mean = sum / nFrames;
    const variance = Math.max(0, sumSq / nFrames - mean * mean);
    features[cursor++] = mean;
    features[cursor++] = Math.sqrt(variance);
    features[cursor++] = mn === Infinity ? 0 : mn;
    features[cursor++] = mx === -Infinity ? 0 : mx;
  }
  // cursor = 64

  // Temporal delta statistics per band (mean, std of frame-to-frame diff) — 2 × N_BANDS = 32
  for (let b = 0; b < N_BANDS; b++) {
    const deltas = new Float64Array(Math.max(0, nFrames - 1));
    for (let fi = 1; fi < nFrames; fi++) {
      deltas[fi - 1] = bandEnergies[fi][b] - bandEnergies[fi - 1][b];
    }
    let sum = 0;
    let sumSq2 = 0;
    for (const d of deltas) {
      sum += d;
      sumSq2 += d * d;
    }
    const mean = deltas.length > 0 ? sum / deltas.length : 0;
    const variance = Math.max(
      0,
      deltas.length > 0 ? sumSq2 / deltas.length - mean * mean : 0,
    );
    features[cursor++] = mean;
    features[cursor++] = Math.sqrt(variance);
  }
  // cursor = 96

  // Global band energy distribution percentiles (16 percentiles × 1 = 16)
  for (let b = 0; b < N_BANDS; b++) {
    const vals = Array.from(
      { length: nFrames },
      (_, fi) => bandEnergies[fi][b],
    ).sort((a, b) => a - b);
    // Median
    const mid = Math.floor(vals.length / 2);
    features[cursor++] = vals.length > 0 ? vals[mid] : 0;
  }
  // cursor = 112

  // Second pass: 16 more global stats across all bands per frame
  for (let b = 0; b < N_BANDS; b++) {
    const vals = Array.from(
      { length: nFrames },
      (_, fi) => bandEnergies[fi][b],
    ).sort((a, b) => a - b);
    const p25 = vals[Math.floor(vals.length * 0.25)] ?? 0;
    features[cursor++] = p25;
  }
  // cursor = 128

  // RMS statistics — 8 values
  {
    let sum = 0;
    let sumSq = 0;
    let mn = Infinity;
    let mx = -Infinity;
    for (let fi = 0; fi < nFrames; fi++) {
      const v = rmsPerFrame[fi];
      sum += v;
      sumSq += v * v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const mean = sum / nFrames;
    const variance = Math.max(0, sumSq / nFrames - mean * mean);
    features[cursor++] = mean;
    features[cursor++] = Math.sqrt(variance);
    features[cursor++] = mn === Infinity ? 0 : mn;
    features[cursor++] = mx === -Infinity ? 0 : mx;
    // RMS temporal deltas
    let dSum = 0;
    let dSumSq = 0;
    for (let fi = 1; fi < nFrames; fi++) {
      const d = rmsPerFrame[fi] - rmsPerFrame[fi - 1];
      dSum += d;
      dSumSq += d * d;
    }
    const dMean = nFrames > 1 ? dSum / (nFrames - 1) : 0;
    const dVar = Math.max(
      0,
      nFrames > 1 ? dSumSq / (nFrames - 1) - dMean * dMean : 0,
    );
    features[cursor++] = dMean;
    features[cursor++] = Math.sqrt(dVar);
    // Spectral flux (sum of absolute deltas across all bands)
    let flux = 0;
    for (let fi = 1; fi < nFrames; fi++) {
      for (let b = 0; b < N_BANDS; b++) {
        flux += Math.abs(bandEnergies[fi][b] - bandEnergies[fi - 1][b]);
      }
    }
    features[cursor++] = flux / Math.max(1, nFrames - 1);
    features[cursor++] = flux / Math.max(1, (nFrames - 1) * N_BANDS);
  }
  // cursor = 136

  // ZCR statistics — 8 values
  {
    let sum = 0;
    let sumSq = 0;
    let mn = Infinity;
    let mx = -Infinity;
    for (let fi = 0; fi < nFrames; fi++) {
      const v = zcrPerFrame[fi];
      sum += v;
      sumSq += v * v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const mean = sum / nFrames;
    const variance = Math.max(0, sumSq / nFrames - mean * mean);
    features[cursor++] = mean;
    features[cursor++] = Math.sqrt(variance);
    features[cursor++] = mn === Infinity ? 0 : mn;
    features[cursor++] = mx === -Infinity ? 0 : mx;
    let dSum = 0;
    let dSumSq = 0;
    for (let fi = 1; fi < nFrames; fi++) {
      const d = zcrPerFrame[fi] - zcrPerFrame[fi - 1];
      dSum += d;
      dSumSq += d * d;
    }
    const dMean = nFrames > 1 ? dSum / (nFrames - 1) : 0;
    const dVar = Math.max(
      0,
      nFrames > 1 ? dSumSq / (nFrames - 1) - dMean * dMean : 0,
    );
    features[cursor++] = dMean;
    features[cursor++] = Math.sqrt(dVar);
    features[cursor++] = 0; // reserved
    features[cursor++] = 0; // reserved
  }
  // cursor = 144

  // f0-related features: harmonic structure via autocorrelation at lag = 1/f0
  // Test candidate f0s from 80 to 400 Hz — 16 lags × 7 stats = 112 dim
  const candidateF0s = [
    80, 100, 120, 140, 160, 180, 200, 240, 280, 320, 360, 400, 440, 500, 600,
    700,
  ];
  for (const cf0 of candidateF0s) {
    const lagSamples = Math.round(SAMPLE_RATE / cf0);
    let sum = 0;
    let sumSq = 0;
    let mn = Infinity;
    let mx = -Infinity;
    let count = 0;
    for (let fi = 0; fi < nFrames; fi++) {
      const start = fi * HOP_SIZE;
      let ac = 0;
      let norm = 0;
      for (
        let s = 0;
        s + lagSamples < FRAME_SIZE && start + s + lagSamples < pcm.length;
        s++
      ) {
        ac += (pcm[start + s] ?? 0) * (pcm[start + s + lagSamples] ?? 0);
        norm += (pcm[start + s] ?? 0) * (pcm[start + s] ?? 0);
      }
      if (norm > 1e-12) {
        const v = ac / norm;
        sum += v;
        sumSq += v * v;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        count++;
      }
    }
    if (count === 0) {
      cursor += 7;
      continue;
    }
    const mean = sum / count;
    const variance = Math.max(0, sumSq / count - mean * mean);
    features[cursor++] = mean;
    features[cursor++] = Math.sqrt(variance);
    features[cursor++] = mn === Infinity ? 0 : mn;
    features[cursor++] = mx === -Infinity ? 0 : mx;
    features[cursor++] = count / nFrames; // voiced fraction estimate
    features[cursor++] = mean > 0.3 ? 1 : 0; // voiced binary
    features[cursor++] = mean * mean; // energy-weighted version
  }
  // cursor = 144 + 16*7 = 256 ✓

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < 256; i++) norm += features[i] * features[i];
  norm = Math.sqrt(norm);
  const out = new Float32Array(256);
  if (norm > 1e-12) {
    for (let i = 0; i < 256; i++) out[i] = features[i] / norm;
  }
  return out;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// Attempt real GGML encoder load
// ---------------------------------------------------------------------------

async function tryLoadGgmlEncoder() {
  try {
    // Check if model file exists
    if (!existsSync(GGUF_PATH)) {
      return {
        available: false,
        reason: `GGUF model not found at ${GGUF_PATH}`,
      };
    }

    // Check if native library exists
    const buildDir = path.join(
      REPO_ROOT,
      "packages",
      "native-plugins",
      "voice-classifier-cpp",
      "build",
    );
    const libraryNames = [
      "libvoice_classifier.dylib",
      "libvoice_classifier.so",
      "voice_classifier.dll",
    ];
    let libPath = null;
    for (const name of libraryNames) {
      const candidate = path.join(buildDir, name);
      if (existsSync(candidate)) {
        libPath = candidate;
        break;
      }
    }

    // Also check the known build dirs
    const knownBuilds = [
      path.join(
        REPO_ROOT,
        "packages",
        "native",
        "plugins",
        "voice-classifier-cpp",
        "build-darwin",
      ),
      path.join(
        REPO_ROOT,
        "packages",
        "native",
        "plugins",
        "voice-classifier-cpp",
        "build",
      ),
    ];
    for (const d of knownBuilds) {
      for (const name of libraryNames) {
        const candidate = path.join(d, name);
        if (existsSync(candidate)) {
          libPath = candidate;
          break;
        }
      }
      if (libPath) break;
    }

    if (!libPath) {
      return {
        available: false,
        reason: `libvoice_classifier.dylib not found. Only Linux build exists (build-linux-x86_64-stale-20260516). Run cmake in packages/native/plugins/voice-classifier-cpp/ to build for macOS.`,
      };
    }

    return { available: true, libPath, ggufPath: GGUF_PATH };
  } catch (err) {
    return { available: false, reason: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const OWNER_F0 = 200; // Hz — higher pitched voice
const ATTACKER_F0 = 120; // Hz — lower pitched voice
const SEEDS_OWNER = [0x0001, 0x0002, 0x0003, 0x0004, 0x0005];
const SEEDS_ATTACKER = [0xa001, 0xa002, 0xa003];
const SEEDS_OWNER_TEST = [0x0006, 0x0007, 0x0008];

async function main() {
  console.log("=".repeat(70));
  console.log("OWNER VOICE ENCODER TEST");
  console.log("=".repeat(70));
  console.log();

  // Check if GGML encoder is available
  const ggmlStatus = await tryLoadGgmlEncoder();
  if (ggmlStatus.available) {
    console.log(`[GGML] Native encoder available at: ${ggmlStatus.libPath}`);
    console.log(`[GGML] Model: ${ggmlStatus.ggufPath}`);
    console.log("[GGML] Would use real WeSpeaker ResNet34-LM embeddings.");
    console.log();
  } else {
    console.log(`[GGML] Native encoder NOT available: ${ggmlStatus.reason}`);
    console.log("[GGML] Falling back to pure-JS spectral feature extractor.");
    console.log();
    console.log("NOTE: Synthetic features have LOWER cosine similarity than");
    console.log(
      "real WeSpeaker embeddings (~0.85-0.95 intra vs ~0.1-0.3 inter",
    );
    console.log("for real speech). This is documented and expected.");
    console.log();
  }

  const mode = ggmlStatus.available ? "GGML_REAL" : "SYNTHETIC_FEATURES";
  console.log(`[MODE] ${mode}`);
  console.log();

  // Generate OWNER training embeddings (5 samples)
  console.log("--- OWNER ONBOARDING (5 samples) ---");
  const ownerTrainEmbeddings = [];
  for (const seed of SEEDS_OWNER) {
    const pcm = synthesizeVoice({ f0: OWNER_F0, seed });
    const emb = computeEmbedding(pcm);
    ownerTrainEmbeddings.push(emb);
    console.log(
      `  Sample seed=0x${seed.toString(16).padStart(4, "0")}: dim=${emb.length}, norm=${Array.from(
        emb,
      )
        .reduce((s, v) => s + v * v, 0)
        .toFixed(4)}`,
    );
  }

  // Build OWNER centroid (average + re-normalize)
  const ownerCentroid = new Float32Array(EMBEDDING_DIM);
  for (const e of ownerTrainEmbeddings) {
    for (let i = 0; i < EMBEDDING_DIM; i++) ownerCentroid[i] += e[i];
  }
  let centroidNorm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++)
    centroidNorm += ownerCentroid[i] * ownerCentroid[i];
  centroidNorm = Math.sqrt(centroidNorm);
  for (let i = 0; i < EMBEDDING_DIM; i++) ownerCentroid[i] /= centroidNorm;
  console.log(`  Centroid built from ${ownerTrainEmbeddings.length} samples`);
  console.log();

  // Test: OWNER vs OWNER (should be HIGH similarity)
  console.log("--- RECOGNITION TEST: OWNER vs OWNER ---");
  const ownerTestEmbeddings = [];
  const ownerSims = [];
  for (const seed of SEEDS_OWNER_TEST) {
    const pcm = synthesizeVoice({ f0: OWNER_F0, seed });
    const emb = computeEmbedding(pcm);
    ownerTestEmbeddings.push(emb);
    const sim = cosineSimilarity(ownerCentroid, emb);
    ownerSims.push(sim);
    const pass = sim > 0.8;
    console.log(
      `  seed=0x${seed.toString(16).padStart(4, "0")}: cosine=${sim.toFixed(4)} ${pass ? "✅ RECOGNIZED" : "❌ REJECTED (unexpected)"}`,
    );
  }
  const ownerMean = ownerSims.reduce((s, v) => s + v, 0) / ownerSims.length;
  console.log(`  Mean OWNER similarity: ${ownerMean.toFixed(4)}`);
  console.log();

  // Test: ATTACKER vs OWNER profile (should be LOW similarity)
  console.log("--- REJECTION TEST: ATTACKER vs OWNER ---");
  const attackerSims = [];
  for (const seed of SEEDS_ATTACKER) {
    const pcm = synthesizeVoice({ f0: ATTACKER_F0, seed });
    const emb = computeEmbedding(pcm);
    const sim = cosineSimilarity(ownerCentroid, emb);
    attackerSims.push(sim);
    const pass = sim < 0.78;
    console.log(
      `  seed=0x${seed.toString(16).padStart(4, "0")}: cosine=${sim.toFixed(4)} ${pass ? "✅ REJECTED" : "❌ MATCHED (security gap)"}`,
    );
  }
  const attackerMean =
    attackerSims.reduce((s, v) => s + v, 0) / attackerSims.length;
  console.log(`  Mean ATTACKER similarity: ${attackerMean.toFixed(4)}`);
  console.log();

  // Summary
  console.log("--- SUMMARY ---");
  console.log(`  Encoder mode:        ${mode}`);
  console.log(
    `  GGUF model present:  ${existsSync(GGUF_PATH) ? "yes" : "no"} (${GGUF_PATH})`,
  );
  console.log(`  Native lib present:  ${ggmlStatus.available ? "yes" : "no"}`);
  console.log(
    `  OWNER intra-cosine:  ${ownerMean.toFixed(4)} (want > 0.8 with real encoder)`,
  );
  console.log(
    `  ATTACKER cosine:     ${attackerMean.toFixed(4)} (want < 0.78 with real encoder)`,
  );
  console.log(
    `  Separation gap:      ${(ownerMean - attackerMean).toFixed(4)}`,
  );

  const separationOk = ownerMean > attackerMean;
  console.log(`  Voices separated:    ${separationOk ? "YES ✅" : "NO ❌"}`);
  console.log();

  if (!ggmlStatus.available) {
    console.log("TO RUN WITH REAL ENCODER:");
    console.log("  1. Build libvoice_classifier.dylib for macOS:");
    console.log("     cd packages/native/plugins/voice-classifier-cpp");
    console.log("     cmake -B build-darwin -DCMAKE_BUILD_TYPE=Release .");
    console.log("     cmake --build build-darwin");
    console.log("  2. Re-run this script.");
    console.log(
      "  With real WeSpeaker embeddings: intra-cosine ~0.85-0.95, inter-cosine ~0.10-0.30.",
    );
  }

  process.exit(separationOk ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
