#!/usr/bin/env node
/**
 * Generate the bundled onboarding voice presets.
 *
 * Onboarding speaks a few fixed lines before any agent or downloaded model
 * exists, so we pre-render them once with our default local OmniVoice model and
 * commit the resulting WAVs. The first-run TTS route serves these by line id;
 * playback is then instant and offline.
 *
 * Unlike GGUF/ONNX model weights, these are small spoken-line WAVs (a few
 * seconds each) and ARE committed to the repo as product assets, the same way
 * UI icons or sound effects are.
 *
 * Synthesis runs the standalone `omnivoice-tts` CLI directly (model + codec
 * GGUFs), so it needs neither a running agent nor a downloaded Eliza-1 runtime
 * bundle. Prerequisites:
 *
 *   1. Build the CLI (once):
 *        cmake --build plugins/plugin-local-inference/native/omnivoice.cpp/build \
 *          --target omnivoice-tts
 *   2. Fetch the model weights (once, ~900 MB, not committed):
 *        hf download Serveurperso/OmniVoice-GGUF \
 *          omnivoice-base-Q8_0.gguf omnivoice-tokenizer-Q8_0.gguf \
 *          --local-dir plugins/plugin-local-inference/native/omnivoice.cpp/models
 *   3. Generate:
 *        bun packages/app-core/scripts/voice-preset/build-onboarding-voice.mjs
 *
 * Output (default `packages/app-core/assets/onboarding-voice/`):
 *   <id>.wav        one per ONBOARDING_VOICE_LINES entry (24 kHz mono, 16-bit)
 *   manifest.json   { generatedAt, instruct, lang, seed, lines: [...] }
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const OMNIVOICE_ROOT = path.join(
  REPO_ROOT,
  "plugins/plugin-local-inference/native/omnivoice.cpp",
);
const DEFAULT_OUT_DIR = path.resolve(HERE, "../../assets/onboarding-voice");

// Eliza's default onboarding voice. OmniVoice accepts a fixed vocabulary of
// instruct items (gender, age, pitch, accent); we pin a clear young-adult
// female voice and keep it fixed-seed for reproducible presets.
const DEFAULT_INSTRUCT = "female, young adult, moderate pitch";
const DEFAULT_LANG = "English";
const DEFAULT_SEED = "0";

function parseArgs(argv) {
  const args = {
    bin: path.join(OMNIVOICE_ROOT, "build", "omnivoice-tts"),
    model: path.join(OMNIVOICE_ROOT, "models", "omnivoice-base-Q8_0.gguf"),
    codec: path.join(OMNIVOICE_ROOT, "models", "omnivoice-tokenizer-Q8_0.gguf"),
    out: DEFAULT_OUT_DIR,
    instruct: DEFAULT_INSTRUCT,
    lang: DEFAULT_LANG,
    seed: DEFAULT_SEED,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--bin":
        args.bin = path.resolve(argv[++i]);
        break;
      case "--model":
        args.model = path.resolve(argv[++i]);
        break;
      case "--codec":
        args.codec = path.resolve(argv[++i]);
        break;
      case "--out":
        args.out = path.resolve(argv[++i]);
        break;
      case "--instruct":
        args.instruct = argv[++i];
        break;
      case "--lang":
        args.lang = argv[++i];
        break;
      case "--seed":
        args.seed = argv[++i];
        break;
      case "-h":
      case "--help":
        process.stdout.write(
          "Usage: build-onboarding-voice.mjs [--bin <omnivoice-tts>] [--model <gguf>] [--codec <gguf>] [--instruct <str>] [--lang <str>] [--seed <int>] [--out <dir>]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

/** Parse a 16-bit PCM mono WAV: returns sample count + peak amplitude. */
function inspectWav16(buf) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("not a RIFF/WAV file");
  }
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "data") {
      let peak = 0;
      for (let i = body; i + 1 < body + size && i + 1 < buf.length; i += 2) {
        const s = Math.abs(buf.readInt16LE(i));
        if (s > peak) peak = s;
      }
      return { samples: Math.floor(size / 2), peak };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("no data chunk");
}

function synthesize(args, text, outFile) {
  const result = spawnSync(
    args.bin,
    [
      "--model",
      args.model,
      "--codec",
      args.codec,
      "--lang",
      args.lang,
      "--instruct",
      args.instruct,
      "--seed",
      args.seed,
      "--format",
      "wav16",
      "-o",
      outFile,
    ],
    { input: text, stdio: ["pipe", "inherit", "inherit"] },
  );
  if (result.status !== 0) {
    throw new Error(
      `omnivoice-tts exited ${result.status ?? "(signal)"} for "${text}"`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const [label, file] of [
    ["binary", args.bin],
    ["model", args.model],
    ["codec", args.codec],
  ]) {
    if (!existsSync(file)) {
      process.stderr.write(
        `[onboarding-voice] Missing ${label}: ${file}\n  See the header of this script for build/download prerequisites.\n`,
      );
      process.exit(2);
    }
  }

  // ONBOARDING_VOICE_LINES is plain data with no app-core runtime deps; bun
  // resolves the .ts import directly.
  const { ONBOARDING_VOICE_LINES: lines } = await import(
    path.resolve(HERE, "../../src/api/onboarding-voice-lines.ts")
  );

  mkdirSync(args.out, { recursive: true });
  const manifestLines = [];
  for (const line of lines) {
    const file = `${line.id}.wav`;
    const outFile = path.join(args.out, file);
    synthesize(args, line.text, outFile);
    const wav = readFileSync(outFile);
    const { samples, peak } = inspectWav16(wav);
    if (samples === 0 || peak === 0) {
      throw new Error(
        `OmniVoice produced silence for "${line.text}" — refusing to commit an empty onboarding preset.`,
      );
    }
    manifestLines.push({
      id: line.id,
      text: line.text,
      file,
      bytes: wav.length,
    });
    process.stdout.write(
      `[onboarding-voice] ${line.id}: ${wav.length} bytes, ${(samples / 24000).toFixed(2)}s, peak ${peak} -> ${file}\n`,
    );
  }

  writeFileSync(
    path.join(args.out, "manifest.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        instruct: args.instruct,
        lang: args.lang,
        seed: args.seed,
        lines: manifestLines,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `[onboarding-voice] Wrote ${manifestLines.length} presets -> ${args.out}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[onboarding-voice] ${err?.stack ?? err}\n`);
  process.exit(1);
});
