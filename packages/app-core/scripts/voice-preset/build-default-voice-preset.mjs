#!/usr/bin/env node
/**
 * Build `cache/voice-preset-default.bin` — the precomputed default-voice
 * speaker preset (embedding + seed-phrase PCM) that ships *inside* an
 * installed Eliza-1 bundle (it is NOT committed to the repo; the repo
 * commits no GGUF/ONNX/large binaries — same handling as
 * `vad/silero-vad-int8.onnx`, which the bundle downloader fetches per the
 * `eliza-1.manifest.json` `files.vad` / `files.cache` lists).
 *
 * Two modes:
 *
 *   --placeholder
 *       Write a *format-valid* `.bin` with a zero/default speaker embedding
 *       and N=0 phrases. This is an explicit DEV placeholder so the format
 *       round-trips and `SpeakerPresetCache.loadFromBundle()` works without
 *       a real fused build. It is NOT a default voice — it produces silence.
 *       `--dim <N>` sets the embedding dimension (default 256).
 *
 *   --embedding <path> [--bundle <bundleRoot>]
 *       Build the *real* preset. `<path>` is the raw little-endian Float32
 *       speaker-embedding vector for the Eliza-1 default voice, produced by
 *       the fused OmniVoice build pipeline (W7). When `--bundle` is given,
 *       the seed phrases (`DEFAULT_PHRASE_CACHE_SEED`) are synthesized via
 *       the bundle's fused TTS (`EngineVoiceBridge` + `FfiOmniVoiceBackend`)
 *       and their PCM is written into the preset; omit `--bundle` (or pass
 *       `--no-phrases`) to write the embedding only (N=0 phrases — the
 *       runtime will re-prewarm at idle time).
 *
 * The preset file does NOT store a voice id — the runtime assigns one at load
 * time (`"default"` for `cache/voice-preset-default.bin`).
 *
 * Common flags:
 *   --out <path>     Output file. Default: `<bundle>/cache/voice-preset-default.bin`
 *                    if `--bundle` is given, else `./voice-preset-default.bin`.
 *   --concurrency N  Parallel TTS dispatches when synthesizing phrases. Default 2.
 *
 * Run with `bun` (it resolves the `.ts` imports):
 *   bun packages/app-core/scripts/voice-preset/build-default-voice-preset.mjs --placeholder
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_PHRASE_CACHE_SEED } from "../../src/services/local-inference/voice/phrase-cache.ts";
import { writeVoicePresetFile } from "../../src/services/local-inference/voice/voice-preset-format.ts";

const PLACEHOLDER_DEFAULT_DIM = 256;

function parseArgs(argv) {
  const args = {
    placeholder: false,
    embeddingPath: null,
    bundleRoot: null,
    out: null,
    dim: PLACEHOLDER_DEFAULT_DIM,
    concurrency: 2,
    noPhrases: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--placeholder":
        args.placeholder = true;
        break;
      case "--no-phrases":
        args.noPhrases = true;
        break;
      case "--embedding":
        args.embeddingPath = argv[++i];
        break;
      case "--bundle":
        args.bundleRoot = argv[++i];
        break;
      case "--out":
        args.out = argv[++i];
        break;
      case "--dim":
        args.dim = Number.parseInt(argv[++i], 10);
        break;
      case "--concurrency":
        args.concurrency = Number.parseInt(argv[++i], 10);
        break;
      case "-h":
      case "--help":
        printUsageAndExit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function printUsageAndExit(code) {
  process.stdout.write(
    [
      "Usage:",
      "  build-default-voice-preset.mjs --placeholder [--dim N] [--out PATH]",
      "  build-default-voice-preset.mjs --embedding PATH [--bundle ROOT] [--no-phrases]",
      "                                 [--out PATH] [--concurrency N]",
      "",
    ].join("\n"),
  );
  process.exit(code);
}

/** Read a raw little-endian Float32 vector file into a `Float32Array`. */
function readFloat32Vector(file) {
  const bytes = new Uint8Array(readFileSync(file));
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
    throw new Error(
      `Embedding file ${file} has byte length ${bytes.byteLength}, which is not a positive multiple of 4 (raw Float32 LE expected).`,
    );
  }
  // Copy into a fresh, aligned buffer — the file buffer is not guaranteed
  // 4-aligned.
  const aligned = new Uint8Array(bytes.byteLength);
  aligned.set(bytes);
  return new Float32Array(aligned.buffer);
}

/**
 * Synthesize the seed phrases against a bundle's fused OmniVoice TTS and
 * return `VoicePresetSeedPhrase[]`. Dynamically imports the engine layer so
 * the placeholder path stays dependency-light.
 */
async function synthesizeSeedPhrases({ bundleRoot, concurrency }) {
  const { LocalInferenceEngine } = await import(
    "../../src/services/local-inference/engine.ts"
  );
  const { decodeMonoPcm16Wav } = await import(
    "../../src/services/local-inference/voice/engine-bridge.ts"
  );
  const engine = new LocalInferenceEngine();
  engine.startVoice({ bundleRoot, useFfiBackend: true });
  await engine.armVoice();
  try {
    const out = [];
    const texts = [...DEFAULT_PHRASE_CACHE_SEED];
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= texts.length) return;
        const text = texts[idx];
        const wav = await engine.synthesizeSpeech(text);
        const { pcm, sampleRate } = decodeMonoPcm16Wav(wav);
        if (pcm.length === 0) {
          throw new Error(
            `Fused TTS returned empty PCM for "${text}" — this build is not a real TTS backend; do not bake silence into the preset.`,
          );
        }
        out.push({ text, sampleRate, pcm });
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(concurrency, texts.length)) },
        () => worker(),
      ),
    );
    return out;
  } finally {
    await engine.stopVoice();
  }
}

function defaultOutPath(args) {
  if (args.out) return path.resolve(args.out);
  if (args.bundleRoot) {
    return path.join(
      path.resolve(args.bundleRoot),
      "cache",
      "voice-preset-default.bin",
    );
  }
  return path.resolve("voice-preset-default.bin");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.placeholder && !args.embeddingPath) {
    process.stderr.write(
      [
        "[voice-preset] Refusing to build a real preset without a speaker embedding.",
        "",
        "  The Eliza-1 default-voice speaker embedding is produced by the fused",
        "  OmniVoice build (W7). Pass `--embedding <path>` (raw Float32 LE bytes),",
        "  optionally with `--bundle <root>` to synthesize the seed-phrase PCM via",
        "  the bundle's fused TTS.",
        "",
        "  For a format-valid DEV placeholder (zero embedding, no phrases) run with",
        "  `--placeholder`.",
        "",
      ].join("\n"),
    );
    process.exit(2);
  }

  let embedding;
  let phrases = [];

  if (args.placeholder) {
    const dim =
      Number.isFinite(args.dim) && args.dim > 0
        ? args.dim
        : PLACEHOLDER_DEFAULT_DIM;
    embedding = new Float32Array(dim); // all zeros
    phrases = []; // N=0 — a placeholder preset carries no audio
    process.stdout.write(
      `[voice-preset] PLACEHOLDER mode: zero embedding dim=${dim}, 0 phrases. This is a dev placeholder, NOT the default voice.\n`,
    );
  } else {
    embedding = readFloat32Vector(args.embeddingPath);
    if (args.bundleRoot && !args.noPhrases) {
      phrases = await synthesizeSeedPhrases({
        bundleRoot: args.bundleRoot,
        concurrency: args.concurrency,
      });
      process.stdout.write(
        `[voice-preset] Synthesized ${phrases.length} seed phrases via ${args.bundleRoot}.\n`,
      );
    } else {
      process.stdout.write(
        "[voice-preset] No --bundle (or --no-phrases): writing embedding only; the runtime will re-prewarm phrases at idle.\n",
      );
    }
    process.stdout.write(
      `[voice-preset] Embedding: ${embedding.length} f32 dims from ${args.embeddingPath}\n`,
    );
  }

  const blob = writeVoicePresetFile({ embedding, phrases });
  const outPath = defaultOutPath(args);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, blob);
  process.stdout.write(
    `[voice-preset] Wrote ${blob.byteLength} bytes -> ${outPath}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[voice-preset] ${err?.stack ?? err}\n`);
  process.exit(1);
});
