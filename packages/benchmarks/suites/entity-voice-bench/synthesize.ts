#!/usr/bin/env bun
/**
 * Synthesize the benchmark corpus to WAV with the real in-process Kokoro
 * engine (fused libelizainference FFI — the same path that ships on
 * mobile/desktop). One 24 kHz mono PCM16 WAV per corpus utterance, plus a
 * manifest.json recording voice/model/lib provenance.
 *
 * WAVs are artifacts, not sources — they land in results/audio/ (gitignored).
 * Re-runs are incremental: an utterance is skipped when its WAV exists and
 * the manifest entry matches the current text+voice.
 *
 * Every clip passes the speech-envelope guard from kokoro-real-smoke.ts
 * (frame-RMS coefficient-of-variation ≥ 0.4) so a loader/dtype regression
 * cannot ship "audio" that is actually noise.
 *
 * Env:
 *   ELIZA_INFERENCE_LIBRARY / ELIZA_INFERENCE_LIB_DIR — fused lib
 *   ELIZA_KOKORO_MODEL_DIR — dir with kokoro-82m-v1_0*.gguf + voices/*.bin
 *   ENTITY_VOICE_REAL_REQUIRE — truthy: turn every skip into a hard failure
 *
 * Exit codes: 0 = all clips synthesized · 1 = failure · 2 = skipped (assets
 * not staged and REQUIRE unset).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFusedLibraryPath } from "@elizaos/plugin-local-inference/services/desktop-fused-ffi-backend-runtime";
import {
  createKokoroSpeakerPreset,
  createKokoroTtsBackend,
} from "@elizaos/plugin-local-inference/services/voice/engine-bridge";
import { loadElizaInferenceFfi } from "@elizaos/plugin-local-inference/services/voice/ffi-bindings";
import { resolveKokoroEngineConfig } from "@elizaos/plugin-local-inference/services/voice/kokoro/kokoro-engine-discovery";
import type { Phrase } from "@elizaos/plugin-local-inference/services/voice/types";
import { encodeMonoPcm16Wav } from "@elizaos/plugin-local-inference/services/voice/wav-codec";
import { allUtterances, speakerByKey } from "./corpus.ts";

const REQUIRE = ["1", "true", "yes"].includes(
  process.env.ENTITY_VOICE_REAL_REQUIRE?.trim().toLowerCase() ?? "",
);

function skip(msg: string): never {
  if (REQUIRE) {
    console.error(`[entity-voice-bench:synth] FAIL (REQUIRE set): ${msg}`);
    process.exit(1);
  }
  console.log(`[entity-voice-bench:synth] SKIP: ${msg}`);
  process.exit(2);
}
function fail(msg: string): never {
  console.error(`[entity-voice-bench:synth] FAIL: ${msg}`);
  process.exit(1);
}

if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  skip("not running under bun (bun:ffi required)");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir =
  process.argv.includes("--out")
    ? path.resolve(process.argv[process.argv.indexOf("--out") + 1] ?? "")
    : path.join(__dirname, "results", "audio");
mkdirSync(outDir, { recursive: true });
const manifestPath = path.join(outDir, "manifest.json");

interface ManifestItem {
  id: string;
  voice: string;
  text: string;
  wav: string;
  samples: number;
  seconds: number;
  envelopeCv: number;
  sha256: string;
  synthMs: number;
}
interface Manifest {
  generatedAt: string;
  libPath: string;
  modelFile: string;
  items: ManifestItem[];
}

const libPath = resolveFusedLibraryPath(null, process.env);
if (!libPath) {
  skip("fused lib not found (set ELIZA_INFERENCE_LIBRARY / ELIZA_INFERENCE_LIB_DIR)");
}
const ffi = loadElizaInferenceFfi(libPath);
if (typeof ffi.kokoroSupported !== "function" || !ffi.kokoroSupported()) {
  skip(`fused lib (ABI v${ffi.libraryAbiVersion}) does not link the Kokoro engine`);
}
const kokoro = resolveKokoroEngineConfig();
if (!kokoro) {
  skip("no Kokoro model staged (set ELIZA_KOKORO_MODEL_DIR)");
}

console.log(`[entity-voice-bench:synth] lib=${libPath} (ABI v${ffi.libraryAbiVersion})`);
console.log(`[entity-voice-bench:synth] model=${kokoro.layout.modelFile}`);
console.log(`[entity-voice-bench:synth] out=${outDir}`);

const previous: Manifest | null = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest)
  : null;
const previousItems = new Map(
  (previous?.items ?? []).map((item) => [item.id, item]),
);

function envelopeCv(pcm: Float32Array, sampleRate: number): number {
  const frame = Math.floor(sampleRate * 0.01);
  const env: number[] = [];
  for (let i = 0; i + frame <= pcm.length; i += frame) {
    let s = 0;
    for (let j = 0; j < frame; j++) {
      const v = pcm[i + j] ?? 0;
      s += v * v;
    }
    env.push(Math.sqrt(s / frame));
  }
  const mean = env.reduce((a, b) => a + b, 0) / Math.max(1, env.length);
  const variance =
    env.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
    Math.max(1, env.length);
  return mean > 1e-6 ? Math.sqrt(variance) / mean : 0;
}

const backend = createKokoroTtsBackend(kokoro, { ffi });
const basePreset = createKokoroSpeakerPreset(kokoro);

// Sort by voice so the runtime swaps voice packs as rarely as possible.
const work = allUtterances()
  .map((u) => ({ utterance: u, voice: speakerByKey(u.speaker).voice }))
  .sort((a, b) => a.voice.localeCompare(b.voice));

for (const { voice } of work) {
  if (!existsSync(path.join(kokoro.layout.voicesDir, `${voice}.bin`))) {
    skip(`voice preset "${voice}.bin" is not staged in ${kokoro.layout.voicesDir}`);
  }
}

const items: ManifestItem[] = [];
let synthesized = 0;
let reused = 0;

for (const { utterance, voice } of work) {
  const wavPath = path.join(outDir, `${utterance.id}.wav`);
  const prior = previousItems.get(utterance.id);
  if (
    prior &&
    prior.text === utterance.text &&
    prior.voice === voice &&
    existsSync(wavPath)
  ) {
    items.push(prior);
    reused += 1;
    continue;
  }

  const phrase: Phrase = {
    id: utterance.seq,
    text: utterance.text,
    fromIndex: 0,
    toIndex: utterance.text.length,
    terminator: "punctuation",
  };
  const started = performance.now();
  const chunks: Float32Array[] = [];
  let sampleRate = 0;
  await backend.synthesizeStream({
    phrase,
    preset: { ...basePreset, voiceId: voice },
    cancelSignal: { cancelled: false },
    onChunk: (chunk) => {
      if (!chunk.isFinal && chunk.pcm.length > 0) {
        chunks.push(chunk.pcm);
        sampleRate = chunk.sampleRate;
      }
      return undefined;
    },
  });
  const synthMs = Math.round(performance.now() - started);
  const total = chunks.reduce((a, c) => a + c.length, 0);
  if (total === 0) fail(`${utterance.id}: Kokoro produced no audio`);
  if (sampleRate !== 24_000) fail(`${utterance.id}: expected 24 kHz, got ${sampleRate}`);
  const pcm = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  const cv = envelopeCv(pcm, sampleRate);
  if (cv < 0.4) {
    fail(
      `${utterance.id}: envelope-cv ${cv.toFixed(3)} < 0.4 — synthesized audio is noise, not speech`,
    );
  }
  const wavBytes = encodeMonoPcm16Wav(pcm, sampleRate);
  writeFileSync(wavPath, wavBytes);
  const sha256 = createHash("sha256").update(wavBytes).digest("hex");
  items.push({
    id: utterance.id,
    voice,
    text: utterance.text,
    wav: path.basename(wavPath),
    samples: total,
    seconds: Number((total / sampleRate).toFixed(2)),
    envelopeCv: Number(cv.toFixed(3)),
    sha256,
    synthMs,
  });
  synthesized += 1;
  console.log(
    `[entity-voice-bench:synth] ${utterance.id} voice=${voice} ${(total / sampleRate).toFixed(2)}s cv=${cv.toFixed(2)} (${synthMs}ms)`,
  );

  // Persist progress after every clip — synthesis is slow on CPU and an
  // interrupted run must be resumable. Keep prior entries for utterances
  // not yet re-visited this run so their WAVs stay reusable.
  writeManifest();
}

writeManifest();

function writeManifest(): void {
  const processedIds = new Set(items.map((item) => item.id));
  const merged = [
    ...items,
    ...(previous?.items ?? []).filter(
      (item) =>
        !processedIds.has(item.id) &&
        existsSync(path.join(outDir, item.wav)),
    ),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    libPath,
    modelFile: kokoro.layout.modelFile,
    items: merged,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
console.log(
  `[entity-voice-bench:synth] DONE — ${synthesized} synthesized, ${reused} reused, ${items.length} total clips at ${outDir}`,
);
