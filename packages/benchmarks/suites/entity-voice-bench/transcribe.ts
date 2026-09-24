#!/usr/bin/env bun
/**
 * Transcribe the synthesized corpus with the real local ASR (Eliza-1
 * Qwen3-ASR GGUF through the fused libelizainference FFI — the exact
 * TRANSCRIPTION path the agent uses). Writes asr-transcripts.json next to
 * this script: per-utterance hypothesis + WER + proper-name survival.
 *
 * The transcript file is committed as a recorded artifact (with full
 * provenance) so the extraction lanes can run keyless/deterministic in CI
 * with `--input audio` replaying these real ASR outputs; regenerate on any
 * ASR/model/corpus change with `bun run corpus:transcribe`.
 *
 * Env:
 *   ELIZA_INFERENCE_LIBRARY / ELIZA_INFERENCE_LIB_DIR — fused lib
 *   ELIZA_ASR_BUNDLE — dir with asr/eliza-1-asr.gguf + -mmproj.gguf
 *   ENTITY_VOICE_REAL_REQUIRE — truthy: turn every skip into a failure
 *
 * Exit codes: 0 · 1 failure · 2 skip (assets not staged, REQUIRE unset).
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFusedLibraryPath } from "@elizaos/plugin-local-inference/services/desktop-fused-ffi-backend-runtime";
import { loadElizaInferenceFfi } from "@elizaos/plugin-local-inference/services/voice/ffi-bindings";
import { decodeMonoPcm16Wav } from "@elizaos/plugin-local-inference/services/voice/wav-codec";
import { allUtterances, speakerByKey } from "./corpus.ts";
import { nameHitRate, normalize, wordErrorRate } from "./metrics.ts";

const REQUIRE = ["1", "true", "yes"].includes(
  process.env.ENTITY_VOICE_REAL_REQUIRE?.trim().toLowerCase() ?? "",
);
function skip(msg: string): never {
  if (REQUIRE) {
    console.error(`[entity-voice-bench:asr] FAIL (REQUIRE set): ${msg}`);
    process.exit(1);
  }
  console.log(`[entity-voice-bench:asr] SKIP: ${msg}`);
  process.exit(2);
}
function fail(msg: string): never {
  console.error(`[entity-voice-bench:asr] FAIL: ${msg}`);
  process.exit(1);
}

if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  skip("not running under bun (bun:ffi required)");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const audioDir = process.argv.includes("--audio")
  ? path.resolve(process.argv[process.argv.indexOf("--audio") + 1] ?? "")
  : path.join(__dirname, "results", "audio");
const manifestPath = path.join(audioDir, "manifest.json");
if (!existsSync(manifestPath)) {
  skip(`no corpus manifest at ${manifestPath} — run corpus:synth first`);
}

const libPath = resolveFusedLibraryPath(null, process.env);
if (!libPath) {
  skip("fused lib not found (set ELIZA_INFERENCE_LIBRARY / ELIZA_INFERENCE_LIB_DIR)");
}
const bundle = process.env.ELIZA_ASR_BUNDLE?.trim();
if (!bundle || !existsSync(path.join(bundle, "asr"))) {
  skip("no ASR bundle (set ELIZA_ASR_BUNDLE to a dir with asr/eliza-1-asr.gguf)");
}

interface ManifestItem {
  id: string;
  voice: string;
  text: string;
  wav: string;
  sha256: string;
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  items: ManifestItem[];
};
const manifestItems = new Map(manifest.items.map((item) => [item.id, item]));

/** Proper names ground truth expects to survive ASR for this utterance. */
function expectedNames(utteranceId: string): string[] {
  const utterance = allUtterances().find((u) => u.id === utteranceId);
  if (!utterance) return [];
  const candidates = new Set<string>();
  const spoken = speakerByKey(utterance.speaker).spokenName;
  if (spoken && normalize(utterance.text).includes(normalize(spoken))) {
    candidates.add(spoken);
  }
  for (const name of [
    utterance.expectCreates,
    utterance.expectRelationship?.toName,
    utterance.expectFact?.subject,
  ]) {
    if (name && normalize(utterance.text).includes(normalize(name))) {
      candidates.add(name);
    }
  }
  return [...candidates];
}

const ffi = loadElizaInferenceFfi(libPath);
const ctx = ffi.create(bundle);
ffi.mmapAcquire(ctx, "asr");

interface TranscriptItem {
  id: string;
  voice: string;
  reference: string;
  hypothesis: string;
  wer: number;
  nameHitRate: number | null;
  expectedNames: string[];
  asrMs: number;
  wavSha256: string;
}

const items: TranscriptItem[] = [];
try {
  for (const utterance of allUtterances()) {
    const entry = manifestItems.get(utterance.id);
    if (!entry) {
      skip(`utterance ${utterance.id} missing from audio manifest — re-run corpus:synth`);
    }
    if (entry.text !== utterance.text) {
      skip(`utterance ${utterance.id} audio is stale (text changed) — re-run corpus:synth`);
    }
    const wavPath = path.join(audioDir, entry.wav);
    if (!existsSync(wavPath)) skip(`missing WAV ${wavPath}`);
    const { pcm, sampleRate } = decodeMonoPcm16Wav(
      new Uint8Array(readFileSync(wavPath)),
    );
    const started = performance.now();
    const { text } = ffi.asrTranscribeTimed({ ctx, pcm, sampleRateHz: sampleRate });
    const asrMs = Math.round(performance.now() - started);
    const hypothesis = (text ?? "").trim();
    if (hypothesis.length === 0) fail(`${utterance.id}: empty transcript`);
    const names = expectedNames(utterance.id);
    const item: TranscriptItem = {
      id: utterance.id,
      voice: entry.voice,
      reference: utterance.text,
      hypothesis,
      wer: Number(wordErrorRate(utterance.text, hypothesis).toFixed(3)),
      nameHitRate: nameHitRate(names, hypothesis),
      expectedNames: names,
      asrMs,
      wavSha256: entry.sha256,
    };
    items.push(item);
    console.log(
      `[entity-voice-bench:asr] ${utterance.id} wer=${item.wer} names=${item.nameHitRate ?? "n/a"} (${asrMs}ms) "${hypothesis}"`,
    );
  }
} finally {
  ffi.mmapEvict(ctx, "asr");
  ffi.destroy(ctx);
  ffi.close();
}

const meanWer = items.reduce((a, i) => a + i.wer, 0) / Math.max(1, items.length);
const nameRates = items.filter((i) => i.nameHitRate !== null);
const meanNameHit =
  nameRates.reduce((a, i) => a + (i.nameHitRate ?? 0), 0) /
  Math.max(1, nameRates.length);

const outPath = path.join(__dirname, "asr-transcripts.json");
writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      host: { platform: os.platform(), arch: os.arch() },
      libPath,
      asrBundle: {
        dir: bundle,
        model: statSync(path.join(bundle, "asr", "eliza-1-asr.gguf")).size,
        mmproj: statSync(path.join(bundle, "asr", "eliza-1-asr-mmproj.gguf")).size,
      },
      aggregate: {
        utterances: items.length,
        meanWer: Number(meanWer.toFixed(3)),
        meanNameHitRate: Number(meanNameHit.toFixed(3)),
      },
      items,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `[entity-voice-bench:asr] DONE — ${items.length} transcripts, mean WER ${meanWer.toFixed(3)}, name survival ${meanNameHit.toFixed(3)} → ${outPath}`,
);
