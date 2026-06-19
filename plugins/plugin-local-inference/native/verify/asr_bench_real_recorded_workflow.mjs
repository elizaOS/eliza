#!/usr/bin/env node
/**
 * No-model helper for the 0_8b real-recorded ASR WER gate.
 *
 * This does not run ASR and never treats generated/synthetic audio as publish
 * evidence. It creates a tiny deterministic non-speech fixture corpus for
 * plumbing tests and emits a fail-closed report until a >=5-utterance
 * real-recorded WAV+.txt corpus is supplied to asr_bench.ts with
 * --real-recorded.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = findRepoRoot(__dirname);
const VERIFY_ROOT = __dirname;
const REPORTS_ROOT = path.join(VERIFY_ROOT, "reports");
const DEFAULT_TIER = "0_8b";
const DEFAULT_MIN_UTTERANCES = 5;
const DEFAULT_FIXTURE_DIR = path.join(
  VERIFY_ROOT,
  "asr_bench_fixtures",
  "non_publish_structure_5utt",
);
const DEFAULT_REPORT_DATE = "2026-05-16";
const DEFAULT_REPORT = path.join(
  REPORTS_ROOT,
  DEFAULT_REPORT_DATE,
  "asr-wer-real-recorded-0_8b-needs-corpus-20260516.json",
);

const FIXTURE_UTTERANCES = [
  ["utt-01", "turn on the kitchen lights"],
  ["utt-02", "set a reminder for tomorrow morning"],
  ["utt-03", "what time is it in tokyo"],
  ["utt-04", "open the front door"],
  ["utt-05", "thanks that is all for now"],
];

function findRepoRoot(startDir) {
  let current = startDir;
  while (true) {
    if (
      fs.existsSync(path.join(current, "AGENTS.md")) &&
      fs.existsSync(path.join(current, "plugins", "plugin-local-inference"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`could not locate repo root from ${startDir}`);
    }
    current = parent;
  }
}

function parseArgs(argv) {
  const args = {
    tier: DEFAULT_TIER,
    bundle: "~/.eliza/local-inference/models/eliza-1-0_8b.bundle",
    wavDir: "",
    fixtureDir: DEFAULT_FIXTURE_DIR,
    out: DEFAULT_REPORT,
    evalOut: "",
    minUtterances: DEFAULT_MIN_UTTERANCES,
    realRecorded: false,
    initFixture: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--tier") args.tier = requireValue(argv, ++i, a);
    else if (a === "--bundle") args.bundle = requireValue(argv, ++i, a);
    else if (a === "--wav-dir") args.wavDir = requireValue(argv, ++i, a);
    else if (a === "--fixture-dir") args.fixtureDir = requireValue(argv, ++i, a);
    else if (a === "--out") args.out = requireValue(argv, ++i, a);
    else if (a === "--eval-out") args.evalOut = requireValue(argv, ++i, a);
    else if (a === "--min-utterances") args.minUtterances = Number(requireValue(argv, ++i, a));
    else if (a === "--real-recorded") args.realRecorded = true;
    else if (a === "--init-fixture") args.initFixture = true;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }

  if (!Number.isInteger(args.minUtterances) || args.minUtterances < 1) {
    throw new Error(`--min-utterances must be a positive integer; got ${args.minUtterances}`);
  }

  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage:
  node plugins/plugin-local-inference/native/verify/asr_bench_real_recorded_workflow.mjs \\
    --init-fixture \\
    --out plugins/plugin-local-inference/native/reports/local-e2e/2026-05-16/asr-wer-real-recorded-0_8b-needs-corpus-20260516.json

  # After recording real microphone/field audio:
  bun plugins/plugin-local-inference/native/verify/asr_bench.ts \\
    --bundle ~/.eliza/local-inference/models/eliza-1-0_8b.bundle \\
    --wav-dir <real-recorded-wav-txt-dir> \\
    --real-recorded \\
    --min-real-recorded-utterances 5 \\
    --out <bench-json> \\
    --eval-out <asr-wer-json>`);
}

function rel(file) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(REPO_ROOT, file);
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

function encodeMonoPcm16Wav(samples, sampleRateHz) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRateHz, 24);
  out.writeUInt32LE(sampleRateHz * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return out;
}

function fixtureTone(index) {
  const sampleRateHz = 16_000;
  const seconds = 0.2;
  const count = Math.floor(sampleRateHz * seconds);
  const freq = 220 + index * 45;
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const fade = Math.min(i / 320, (count - i - 1) / 320, 1);
    samples[i] = 0.08 * Math.max(0, fade) * Math.sin((2 * Math.PI * freq * i) / sampleRateHz);
  }
  return { sampleRateHz, wav: encodeMonoPcm16Wav(samples, sampleRateHz) };
}

function writeFixtureCorpus(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const utterances = [];
  for (let i = 0; i < FIXTURE_UTTERANCES.length; i += 1) {
    const [id, text] = FIXTURE_UTTERANCES[i];
    const { sampleRateHz, wav } = fixtureTone(i);
    const wavPath = path.join(dir, `${id}.wav`);
    const txtPath = path.join(dir, `${id}.txt`);
    fs.writeFileSync(wavPath, wav);
    fs.writeFileSync(txtPath, `${text}\n`);
    utterances.push({
      id,
      reference: text,
      wav: path.basename(wavPath),
      txt: path.basename(txtPath),
      sampleRateHz,
      fixture: "deterministic_non_speech_tone",
    });
  }

  const manifest = {
    schemaVersion: 1,
    corpusId: "asr-bench-non-publish-structure-5utt",
    tier: DEFAULT_TIER,
    utterances: utterances.length,
    provenance: "deterministic_non_speech_fixture",
    realRecorded: false,
    publishGateEligible: false,
    purpose:
      "Corpus-shape fixture only. These WAV files are deterministic tones, not speech recordings, and must not be used as ASR WER publish evidence.",
    requiredPublishReplacement:
      "Record at least five microphone or field speech WAV files with matching .txt transcripts, then run asr_bench.ts with --wav-dir <dir> --real-recorded.",
    files: utterances,
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(
    path.join(dir, "README.md"),
    `# ASR Bench Non-Publish Structure Fixture

This directory is a deterministic corpus-shape fixture for the ASR WER workflow.
The WAV files are short generated tones, not speech and not TTS. They only prove
that five WAV+.txt pairs can be carried through scripts without downloading
models.

Do not use this directory as publish evidence. The 0_8b ASR WER publish gate
requires at least five explicit real microphone or field recordings with matching
transcripts, run through:

\`\`\`sh
bun plugins/plugin-local-inference/native/verify/asr_bench.ts \\
  --bundle ~/.eliza/local-inference/models/eliza-1-0_8b.bundle \\
  --wav-dir <real-recorded-wav-txt-dir> \\
  --real-recorded \\
  --min-real-recorded-utterances 5
\`\`\`
`,
  );
  return manifest;
}

function readWavSummary(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`not a RIFF/WAVE file: ${file}`);
  }

  let off = 12;
  let channels = null;
  let sampleRateHz = null;
  let bitsPerSample = null;
  let dataBytes = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    off += 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(off + 2);
      sampleRateHz = buf.readUInt32LE(off + 4);
      bitsPerSample = buf.readUInt16LE(off + 14);
    } else if (id === "data") {
      dataBytes = size;
      break;
    }
    off += size + (size & 1);
  }
  const bytesPerSample = channels && bitsPerSample ? channels * (bitsPerSample / 8) : null;
  const seconds = dataBytes && bytesPerSample && sampleRateHz ? dataBytes / bytesPerSample / sampleRateHz : null;
  return { channels, sampleRateHz, bitsPerSample, seconds };
}

function collectWavTxtPairs(dir) {
  if (!fs.existsSync(dir)) return [];
  const pairs = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.toLowerCase().endsWith(".wav")) continue;
    const id = name.slice(0, -4);
    const txt = path.join(dir, `${id}.txt`);
    if (!fs.existsSync(txt)) {
      pairs.push({ id, wav: path.join(dir, name), txt, missingTranscript: true });
      continue;
    }
    const summary = readWavSummary(path.join(dir, name));
    pairs.push({
      id,
      wav: path.join(dir, name),
      txt,
      reference: fs.readFileSync(txt, "utf8").trim(),
      ...summary,
    });
  }
  return pairs;
}

function readCorpusManifest(dir) {
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  return {
    path: manifestPath,
    data: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
  };
}

function corpusManifestBlocker(corpusManifest) {
  if (!corpusManifest) return null;
  const provenance = String(corpusManifest.data?.provenance ?? "").toLowerCase();
  if (corpusManifest.data?.realRecorded === false) {
    return `${rel(corpusManifest.path)} declares realRecorded=false.`;
  }
  if (corpusManifest.data?.publishGateEligible === false) {
    return `${rel(corpusManifest.path)} declares publishGateEligible=false.`;
  }
  if (/(generated|synthetic|fixture|tts|loopback)/.test(provenance)) {
    return `${rel(corpusManifest.path)} declares non-real-recorded provenance "${provenance}".`;
  }
  return null;
}

function buildReport(args, fixtureManifest) {
  const candidateDir = args.wavDir || args.fixtureDir;
  const usingFixtureDir = !args.wavDir;
  const fixtureManifestPath = path.join(args.fixtureDir, "manifest.json");
  const fixtureManifestForReport =
    usingFixtureDir && (fixtureManifest || fs.existsSync(fixtureManifestPath))
      ? fixtureManifestPath
      : null;
  const candidateManifest = readCorpusManifest(candidateDir);
  const manifestBlocker = corpusManifestBlocker(candidateManifest);
  const effectiveProvenance =
    typeof candidateManifest?.data?.provenance === "string" &&
    candidateManifest.data.provenance
      ? candidateManifest.data.provenance
      : args.realRecorded
        ? "real_recorded"
        : "deterministic_non_speech_fixture";
  const pairs = collectWavTxtPairs(candidateDir);
  const completePairs = pairs.filter((pair) => !pair.missingTranscript);
  const corpusReadyForAsrBench =
    args.realRecorded &&
    completePairs.length >= args.minUtterances &&
    completePairs.every((pair) => pair.channels === 1 && pair.bitsPerSample === 16) &&
    !manifestBlocker;

  const blockers = [];
  if (!args.realRecorded) {
    blockers.push(
      "No explicit real-recorded corpus was supplied. This report remains fail-closed and is not publish evidence.",
    );
  }
  if (completePairs.length < args.minUtterances) {
    blockers.push(
      `Real-recorded ASR WER publish evidence requires >=${args.minUtterances} WAV+.txt utterances; found ${completePairs.length}.`,
    );
  }
  for (const pair of pairs) {
    if (pair.missingTranscript) blockers.push(`${rel(pair.wav)} is missing ${path.basename(pair.txt)}.`);
    if (!pair.missingTranscript && (pair.channels !== 1 || pair.bitsPerSample !== 16)) {
      blockers.push(
        `${rel(pair.wav)} must be mono PCM16 WAV for asr_bench.ts; got channels=${pair.channels}, bits=${pair.bitsPerSample}.`,
      );
    }
  }
  if (manifestBlocker) {
    blockers.push(`${manifestBlocker} This WAV directory cannot be used as publish ASR WER evidence.`);
  }
  if (fixtureManifest || usingFixtureDir) {
    blockers.push(
      "The initialized fixture WAV files are deterministic non-speech tones. They validate corpus plumbing only and must not be used as ASR WER publish evidence.",
    );
  }
  if (corpusReadyForAsrBench) {
    blockers.push(
      "Corpus structure is ready, but WER is still not measured until asr_bench.ts transcribes it and writes the bench/eval artifacts.",
    );
  }

  const runRealRecordedWer = [
    "bun plugins/plugin-local-inference/native/verify/asr_bench.ts",
    "--bundle ~/.eliza/local-inference/models/eliza-1-0_8b.bundle",
    `--wav-dir ${args.realRecorded ? rel(candidateDir) : "<real-recorded-wav-txt-dir>"}`,
    "--real-recorded",
    `--min-real-recorded-utterances ${args.minUtterances}`,
    "--out plugins/plugin-local-inference/native/verify/reports/asr-bench-real-recorded-0_8b-<date>.json",
    "--eval-out plugins/plugin-local-inference/native/verify/reports/asr-wer-real-recorded-0_8b-<date>.json",
  ].join(" ");

  return {
    schemaVersion: 1,
    tool: "asr_bench_real_recorded_workflow.mjs",
    generatedAt: new Date().toISOString(),
    tier: args.tier,
    bundle: args.bundle,
    metric: "asr_wer",
    op: "<=",
    status: "not-run",
    wer: null,
    passed: false,
    gateThreshold: 0.1,
    labelledSet: {
      source: "external_wav_txt",
      measurementClass: corpusReadyForAsrBench
        ? "real_recorded_labelled_speech_pending_asr"
        : "missing_or_non_publish_real_recorded_speech",
      provenance: effectiveProvenance,
      operatorDeclaredRealRecorded: args.realRecorded,
      realRecordedWer: false,
      publishGateEligible: false,
      wavDir: rel(candidateDir),
      count: completePairs.length,
      minRealRecordedUtterances: args.minUtterances,
      corpusReadyForAsrBench,
      fixtureManifest: fixtureManifestForReport
        ? rel(fixtureManifestForReport)
        : null,
      corpusManifest: candidateManifest ? rel(candidateManifest.path) : null,
      corpusManifestBlocker: manifestBlocker,
    },
    corpus: {
      pairs: completePairs.map((pair) => ({
        id: pair.id,
        wav: rel(pair.wav),
        txt: rel(pair.txt),
        reference: pair.reference,
        sampleRateHz: pair.sampleRateHz,
        seconds: pair.seconds,
      })),
    },
    blockers,
    guidance: {
      publishEvidence:
        "Use only explicit real microphone or field recordings with human transcripts. Do not use generated TTS, deterministic tones, or unknown-provenance WAVs as publish ASR WER.",
      runRealRecordedWer,
    },
  };
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let fixtureManifest = null;
  if (args.initFixture) fixtureManifest = writeFixtureCorpus(args.fixtureDir);
  const report = buildReport(args, fixtureManifest);
  writeJson(args.out, report);
  if (args.evalOut) {
    writeJson(args.evalOut, {
      schemaVersion: 1,
      metric: "asr_wer",
      op: "<=",
      status: "not-run",
      wer: null,
      passed: false,
      gateThreshold: report.gateThreshold,
      backend: null,
      labelledSetSource: report.labelledSet.source,
      labelledSetProvenance: report.labelledSet.provenance,
      utterances: report.labelledSet.count,
      minRealRecordedUtterances: report.labelledSet.minRealRecordedUtterances,
      reason: report.blockers.join(" "),
      benchArtifact: rel(args.out),
    });
  }
  const summary = {
    status: report.status,
    wer: report.wer,
    utterances: report.labelledSet.count,
    publishGateEligible: report.labelledSet.publishGateEligible,
    out: rel(args.out),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();
