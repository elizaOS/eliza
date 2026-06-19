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
 * All lines share one voice: a single reference passage is synthesized from the
 * instruct, then every line is voice-cloned from that reference so the timbre is
 * identical across presets (instruct + seed alone do not pin a stable speaker).
 *
 * Output (default `packages/app-core/assets/onboarding-voice/`):
 *   <id>.wav        one per ONBOARDING_VOICE_LINES entry (24 kHz mono, 16-bit)
 *   manifest.json   { generatedAt, lang, seed, voice, lines: [...] }
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
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
//
// This is intentionally NOT the licensed Eliza "same" voice. That voice is
// research-only (Her-derivative) and is reconstructed at runtime from a
// metadata-only preset in the downloaded eliza-1 bundle — its audio is never
// committed. Onboarding plays before any bundle exists, so its presets use a
// generic, license-clean synthetic voice instead.
const DEFAULT_INSTRUCT = "female, young adult, moderate pitch";
const DEFAULT_LANG = "English";
const DEFAULT_SEED = "0";

// Voice consistency across lines is enforced by cloning, not by instruct alone:
// instruct + seed do not pin a stable speaker identity across different texts,
// so we synthesize ONE reference passage (instruct-only) and then voice-clone
// every onboarding line from it (`--ref-wav`/`--ref-text`). The reference is a
// build-time conditioning input only — it lives in a temp dir, is never served
// to users, and is never committed. The passage is public-domain Harvard
// sentences (IEEE), chosen for broad phoneme coverage and unambiguous licensing.
const REFERENCE_TEXT =
  "The birch canoe slid on the smooth planks. Glue the sheet to the dark blue background. It is easy to tell the depth of a well. These days a chicken leg is a rare dish. Rice is often served in round bowls.";

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

/**
 * Synthesize `text` to `outFile`. With `ref` (a `{ wav, textFile }` pair) the
 * voice is cloned from the reference audio; without it the voice is sampled
 * from `args.instruct`. The two are mutually exclusive — instruct seeds the
 * one reference, the reference then conditions every line.
 */
function synthesize(args, text, outFile, ref) {
  const cli = [
    "--model",
    args.model,
    "--codec",
    args.codec,
    "--lang",
    args.lang,
    "--seed",
    args.seed,
    "--format",
    "wav16",
    "-o",
    outFile,
  ];
  if (ref) {
    cli.push("--ref-wav", ref.wav, "--ref-text", ref.textFile);
  } else {
    cli.push("--instruct", args.instruct);
  }
  const result = spawnSync(args.bin, cli, {
    input: text,
    stdio: ["pipe", "inherit", "inherit"],
  });
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

  // Pin the voice once: synthesize the reference passage from instruct, then
  // clone every line from it. Reference lives in a temp dir — never served,
  // never committed.
  const refDir = mkdtempSync(path.join(os.tmpdir(), "onboarding-voice-ref-"));
  const refWav = path.join(refDir, "reference.wav");
  const refTextFile = path.join(refDir, "reference.txt");
  writeFileSync(refTextFile, `${REFERENCE_TEXT}\n`);
  synthesize(args, REFERENCE_TEXT, refWav);
  const refInspect = inspectWav16(readFileSync(refWav));
  if (refInspect.samples === 0 || refInspect.peak === 0) {
    throw new Error(
      "OmniVoice produced a silent reference passage — cannot clone onboarding presets from silence.",
    );
  }
  const ref = { wav: refWav, textFile: refTextFile };
  process.stdout.write(
    `[onboarding-voice] reference: ${(refInspect.samples / 24000).toFixed(2)}s instruct="${args.instruct}" (temp, not committed)\n`,
  );

  const manifestLines = [];
  for (const line of lines) {
    const file = `${line.id}.wav`;
    const outFile = path.join(args.out, file);
    synthesize(args, line.text, outFile, ref);
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
        lang: args.lang,
        seed: args.seed,
        voice: {
          mode: "cloned-from-reference",
          license:
            "generic synthetic (not the research-only Eliza 'same' voice)",
          instruct: args.instruct,
          referenceText: REFERENCE_TEXT,
        },
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
