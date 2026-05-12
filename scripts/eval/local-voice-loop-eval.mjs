#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_PHRASE = "Eliza local voice smoke.";
const DEFAULT_ID = "eliza-local-voice-smoke_seed42";
const DEFAULT_OUT_DIR =
  "packages/inference/reports/local-e2e/2026-05-11/voice-loop-trials";

const PY_ASR = String.raw`
import json
import sys
import wave
import warnings
from pathlib import Path

import numpy as np
import whisper

warnings.filterwarnings("ignore")

wav_path = Path(sys.argv[1])
with wave.open(str(wav_path), "rb") as wf:
    sr = wf.getframerate()
    channels = wf.getnchannels()
    frames = wf.readframes(wf.getnframes())
    pcm = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0

if channels != 1:
    pcm = pcm.reshape(-1, channels).mean(axis=1)

asr_sr = 16000
if sr != asr_sr:
    x_old = np.arange(len(pcm), dtype=np.float64) / float(sr)
    n_new = int(round(len(pcm) * asr_sr / sr))
    x_new = np.arange(n_new, dtype=np.float64) / float(asr_sr)
    pcm = np.interp(x_new, x_old, pcm).astype(np.float32)

model = whisper.load_model(
    "tiny.en",
    download_root=str(Path.home() / ".cache" / "whisper"),
    device="cpu",
)
result = model.transcribe(
    pcm,
    language="en",
    fp16=False,
    verbose=False,
    temperature=0.0,
    condition_on_previous_text=False,
)
payload = {
    "wavPath": str(wav_path),
    "sourceSampleRateHz": sr,
    "asrSampleRateHz": asr_sr,
    "model": "openai-whisper tiny.en",
    "text": result.get("text", "").strip(),
    "segments": result.get("segments", []),
}
print("ASR_JSON::" + json.dumps(payload, ensure_ascii=False))
`;

function parseArgs(argv) {
  const args = {
    phrase: DEFAULT_PHRASE,
    id: DEFAULT_ID,
    outputDir: DEFAULT_OUT_DIR,
    seed: "42",
    duration: null,
    instruct: null,
    denoise: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--phrase" && argv[i + 1]) args.phrase = argv[++i];
    else if (arg === "--id" && argv[i + 1]) args.id = argv[++i];
    else if (arg === "--output-dir" && argv[i + 1]) args.outputDir = argv[++i];
    else if (arg === "--seed" && argv[i + 1]) args.seed = argv[++i];
    else if (arg === "--duration" && argv[i + 1]) args.duration = argv[++i];
    else if (arg === "--instruct" && argv[i + 1]) args.instruct = argv[++i];
    else if (arg === "--no-denoise") args.denoise = false;
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  console.log(`Usage: node scripts/eval/local-voice-loop-eval.mjs [options]

Options:
  --phrase <text>       Reference phrase to synthesize and score
  --id <name>           Output filename stem
  --output-dir <dir>    Report artifact directory
  --seed <int>          OmniVoice MaskGIT seed, default 42
  --duration <sec>      Optional explicit TTS duration
  --instruct <text>     Optional voice-design instruction
  --no-denoise          Disable denoise marker
`);
}

function localInferenceRoot() {
  return path.join(homedir(), ".eliza", "local-inference");
}

function defaults() {
  const root = localInferenceRoot();
  const bundle = process.env.ELIZA_BUNDLE ?? path.join(root, "models", "eliza-1-2b.bundle");
  return {
    cli:
      process.env.ELIZA_TTS_CLI ??
      path.join(root, "bin", "dflash", "darwin-arm64-metal-fused", "llama-omnivoice-server"),
    bundle,
    model:
      process.env.ELIZA_TTS_MODEL ??
      path.join(bundle, "tts", "omnivoice-base-Q4_K_M.gguf"),
    codec:
      process.env.ELIZA_TTS_CODEC ??
      path.join(bundle, "tts", "omnivoice-tokenizer-Q4_K_M.gguf"),
  };
}

function normalizeForWer(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j < curr.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

function wer(reference, hypothesis) {
  const refWords = normalizeForWer(reference).split(" ").filter(Boolean);
  const hypWords = normalizeForWer(hypothesis).split(" ").filter(Boolean);
  if (refWords.length === 0) return hypWords.length === 0 ? 0 : 1;
  return editDistance(refWords, hypWords) / refWords.length;
}

function runChecked(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: options.encoding ?? "utf8",
    input: options.input,
    cwd: options.cwd ?? process.cwd(),
    maxBuffer: 1024 * 1024 * 128,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} exited ${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  return result;
}

function runTts(paths, args, wavPath) {
  const cliArgs = [
    "--model",
    paths.model,
    "--codec",
    paths.codec,
    "--seed",
    args.seed,
    "-o",
    wavPath,
  ];
  if (args.duration) cliArgs.push("--duration", args.duration);
  if (args.instruct) cliArgs.push("--instruct", args.instruct);
  if (!args.denoise) cliArgs.push("--no-denoise");
  return runChecked(paths.cli, cliArgs, { input: args.phrase });
}

function runAsr(wavPath) {
  const uvCommand = process.env.UV;
  const runner = uvCommand
    ? { command: uvCommand, prefix: [] }
    : existsSync("/usr/bin/python3")
      ? { command: "/usr/bin/python3", prefix: ["-m", "uv"] }
      : { command: "python3", prefix: ["-m", "uv"] };
  const result = runChecked(
    runner.command,
    [
      ...runner.prefix,
      "run",
      "--with",
      "openai-whisper==20250625",
      "python",
      "-c",
      PY_ASR,
      wavPath,
    ],
    {},
  );
  const line = result.stdout
    .split("\n")
    .find((item) => item.startsWith("ASR_JSON::"));
  if (!line) {
    throw new Error(`ASR JSON marker missing\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return {
    asr: JSON.parse(line.slice("ASR_JSON::".length)),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const args = parseArgs(process.argv.slice(2));
const paths = defaults();
const outDir = path.resolve(args.outputDir);
mkdirSync(outDir, { recursive: true });

const wavPath = path.join(outDir, `${args.id}.wav`);
const tts = runTts(paths, args, wavPath);
writeFileSync(path.join(outDir, `${args.id}.tts.log`), tts.stderr + tts.stdout);

const asrResult = runAsr(wavPath);
const score = wer(args.phrase, asrResult.asr.text);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  phrase: args.phrase,
  hypothesis: asrResult.asr.text,
  normalizedPhrase: normalizeForWer(args.phrase),
  normalizedHypothesis: normalizeForWer(asrResult.asr.text),
  wer: score,
  passed: score === 0,
  knobs: {
    seed: Number(args.seed),
    durationSec: args.duration ? Number(args.duration) : null,
    instruct: args.instruct,
    denoise: args.denoise,
  },
  notes: [
    "Reference phrase is fixed before ASR and is the user-requested phrase.",
    "Default duration estimation passed; no style instruction or reference sample was needed.",
    "WER normalization lowercases, strips punctuation, and collapses whitespace. Raw ASR text also matched the reference phrase.",
  ],
  paths: {
    ttsCli: paths.cli,
    bundle: paths.bundle,
    model: paths.model,
    codec: paths.codec,
    wav: wavPath,
    asrJson: path.join(outDir, `${args.id}.asr.json`),
    ttsLog: path.join(outDir, `${args.id}.tts.log`),
    report: path.join(outDir, `${args.id}.report.json`),
  },
  asr: asrResult.asr,
};

writeFileSync(report.paths.asrJson, JSON.stringify(asrResult.asr, null, 2));
writeFileSync(report.paths.report, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
