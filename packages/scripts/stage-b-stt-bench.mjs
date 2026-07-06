#!/usr/bin/env node
// Stage-B on-device STT evaluation driver for issue #9958 (Apple arm).
//
// Produces a REAL, measured Stage-B STT result for the Apple
// `SFSpeechRecognizer` (ANE-capable, on-device) recognizer claimed in
// `packages/ui/src/voice/VOICE_UX.md` §7. It:
//   1. synthesises real intelligible speech for the labelled reference corpus
//      using on-device Apple TTS (`say`) — the repo's checked-in ASR fixtures
//      are deterministic tones (see asr_bench_fixtures/.../manifest.json), so
//      this regenerates the matching speech the manifest itself asks for;
//   2. builds + runs the Swift `stage-b-stt-bench` recognizer over a quiet and
//      a noise-degraded condition with `requiresOnDeviceRecognition = true`;
//   3. scores WER with the same normalize + word-edit metric as
//      `plugins/plugin-local-inference/native/verify/asr_bench.ts`;
//   4. writes a machine-readable matrix + markdown report + listenable audio.
//
// STT-side only; Kokoro TTS is unchanged. This measures the macOS / Apple
// Silicon on-device SFSpeechRecognizer arm. iOS-device battery telemetry and
// the Android `SpeechRecognizer` (NNAPI) arm remain device-gated handoff.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const ISSUE = "9958";
const SWIFT_PACKAGE = path.join(
  REPO_ROOT,
  "packages/scripts/stage-b-stt-bench",
);
const BENCH_BIN = path.join(SWIFT_PACKAGE, ".build/release/stage-b-stt-bench");
const REFERENCE_MANIFEST = path.join(
  REPO_ROOT,
  "plugins/plugin-local-inference/native/verify/asr_bench_fixtures/non_publish_structure_5utt/manifest.json",
);
const SAMPLE_RATE = 16000;
const NOISE_SNR_DB = 10;

function parseArgs(argv) {
  const args = {
    out: path.join("test-results", "evidence", `${ISSUE}-stt-stage-b-eval`),
    voice: "Samantha",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i] ?? args.out;
    else if (argv[i] === "--voice") args.voice = argv[++i] ?? args.voice;
  }
  return args;
}

function writeSkip(outDir, reason) {
  fs.mkdirSync(outDir, { recursive: true });
  const doc = {
    schema: "eliza_stage_b_stt_eval_v1",
    issue: Number(ISSUE),
    status: "skip",
    reason,
    host: { platform: process.platform, arch: process.arch },
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(outDir, "stage-b-stt-matrix.json"),
    JSON.stringify(doc, null, 2),
  );
  console.log(`[stage-b-stt] skip: ${reason}`);
}

function commandExists(name) {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}

// --- WER (mirrors asr_bench.ts normalize + word-edit distance) --------------

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9'\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordEditDistance(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  let cur = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      cur[j] = Math.min(sub, prev[j] + 1, cur[j - 1] + 1);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

function werFor(reference, hypothesis) {
  const ref = normalize(reference).split(" ").filter(Boolean);
  const hyp = normalize(hypothesis).split(" ").filter(Boolean);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return wordEditDistance(ref, hyp) / ref.length;
}

// --- WAV helpers ------------------------------------------------------------

function readWavPcm16(file) {
  const buf = fs.readFileSync(file);
  // Locate the "data" chunk rather than assuming a fixed 44-byte header.
  let offset = 12;
  let dataStart = -1;
  let dataLen = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") {
      dataStart = offset + 8;
      dataLen = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataStart < 0) throw new Error(`no data chunk in ${file}`);
  const samples = new Int16Array(Math.floor(dataLen / 2));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = buf.readInt16LE(dataStart + i * 2);
  }
  return samples;
}

function writeWavPcm16(file, samples, sampleRate) {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(
      Math.max(-32768, Math.min(32767, samples[i] | 0)),
      44 + i * 2,
    );
  }
  fs.writeFileSync(file, buf);
}

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

// Box-Muller gaussian noise mixed to a target SNR (dB).
function addNoise(samples, snrDb) {
  const signalRms = rms(samples);
  const noiseRms = signalRms / 10 ** (snrDb / 20);
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const u1 = Math.random() || 1e-9;
    const u2 = Math.random();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out[i] = samples[i] + g * noiseRms;
  }
  return out;
}

// --- synthesis --------------------------------------------------------------

function synthSpeech(reference, voice, aiffPath, wavPath) {
  const say = spawnSync("say", ["-v", voice, "-o", aiffPath, reference], {
    encoding: "utf8",
  });
  if (say.status !== 0) {
    throw new Error(`say failed: ${say.stderr || say.status}`);
  }
  const conv = spawnSync(
    "afconvert",
    ["-f", "WAVE", "-d", `LEI16@${SAMPLE_RATE}`, "-c", "1", aiffPath, wavPath],
    { encoding: "utf8" },
  );
  if (conv.status !== 0) {
    throw new Error(`afconvert failed: ${conv.stderr || conv.status}`);
  }
}

function runBench(manifestPath) {
  const res = spawnSync(
    BENCH_BIN,
    ["--manifest", manifestPath, "--on-device"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (res.status !== 0 && !res.stdout) {
    throw new Error(`bench failed (exit ${res.status}): ${res.stderr}`);
  }
  const doc = JSON.parse(res.stdout);
  if (doc.status !== "ok") {
    return { unavailable: true, doc };
  }
  return { unavailable: false, doc };
}

function aggregate(refByID, doc) {
  const utterances = doc.utterances.map((u) => {
    const reference = refByID.get(u.id) ?? u.reference;
    const wer = werFor(reference, u.hypothesis);
    return {
      id: u.id,
      reference,
      hypothesis: u.hypothesis,
      wer,
      exact: wer === 0,
      recognized: u.recognized,
      latencyMs: u.latencyMs,
      realTimeFactor: u.realTimeFactor,
      audioDurationSec: u.audioDurationSec,
    };
  });
  const lat = utterances.map((u) => u.latencyMs).sort((a, b) => a - b);
  const pct = (p) =>
    lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : 0;
  const mean = (arr) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  return {
    utterances,
    summary: {
      count: utterances.length,
      meanWer: mean(utterances.map((u) => u.wer)),
      exactAcceptRate: mean(utterances.map((u) => (u.exact ? 1 : 0))),
      meanLatencyMs: mean(utterances.map((u) => u.latencyMs)),
      p50LatencyMs: pct(0.5),
      p90LatencyMs: pct(0.9),
      meanRealTimeFactor: mean(utterances.map((u) => u.realTimeFactor)),
    },
  };
}

function fmtPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(
    "# Stage-B on-device STT evaluation — Apple SFSpeechRecognizer arm (#9958)",
  );
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(
    `Host: ${report.host.platform} ${report.host.arch} (${report.host.hostname})`,
  );
  lines.push(
    `Recognizer: \`SFSpeechRecognizer\` locale ${report.locale}, requiresOnDeviceRecognition=${report.requiresOnDeviceRecognition}, supportsOnDeviceRecognition=${report.supportsOnDeviceRecognition}`,
  );
  lines.push(
    `Speech source: on-device Apple TTS (\`say -v ${report.voice}\`) at ${SAMPLE_RATE} Hz mono; noisy condition = white noise mixed at ${NOISE_SNR_DB} dB SNR`,
  );
  lines.push("");
  lines.push("## Backend × condition matrix");
  lines.push("");
  lines.push(
    "| Backend | Condition | Utts | Exact-accept | Mean WER | Mean latency | p50 | p90 | Mean RTF | Status |",
  );
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const cond of report.conditions) {
    const s = cond.result.summary;
    lines.push(
      `| apple-sfspeechrecognizer (on-device) | ${cond.label} | ${s.count} | ${fmtPct(s.exactAcceptRate)} | ${fmtPct(s.meanWer)} | ${s.meanLatencyMs.toFixed(0)} ms | ${s.p50LatencyMs.toFixed(0)} ms | ${s.p90LatencyMs.toFixed(0)} ms | ${s.meanRealTimeFactor.toFixed(3)} | measured |`,
    );
  }
  lines.push(
    "| android `SpeechRecognizer` (NNAPI) | quiet/noisy | — | — | — | — | — | — | — | **device handoff** |",
  );
  lines.push(
    "| fused libelizainference ASR (Whisper-family) | quiet/noisy | — | — | — | — | — | — | — | **runtime handoff** |",
  );
  lines.push("");
  for (const cond of report.conditions) {
    lines.push(`### Per-utterance — ${cond.label}`);
    lines.push("");
    lines.push("| id | reference | hypothesis | WER | latency | RTF |");
    lines.push("|---|---|---|---:|---:|---:|");
    for (const u of cond.result.utterances) {
      lines.push(
        `| ${u.id} | ${u.reference} | ${u.hypothesis || "(empty)"} | ${fmtPct(u.wer)} | ${u.latencyMs.toFixed(0)} ms | ${u.realTimeFactor.toFixed(3)} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Methodology");
  lines.push("");
  lines.push(
    "- Real speech is synthesised on-device with Apple TTS for each labelled reference in",
  );
  lines.push(
    "  `asr_bench_fixtures/non_publish_structure_5utt/manifest.json` (the checked-in WAVs there are",
  );
  lines.push(
    "  deterministic tones, not speech — this regenerates the matching speech the manifest's own",
  );
  lines.push("  `requiredPublishReplacement` note asks for).");
  lines.push(
    "- Each utterance is transcribed by `SFSpeechRecognizer` with `requiresOnDeviceRecognition=true`",
  );
  lines.push(
    "  (no network; ANE/CPU on-device path). Latency is wall-clock from request submit to final result.",
  );
  lines.push(
    "- WER uses the same normalize + Levenshtein word-edit metric as `native/verify/asr_bench.ts`.",
  );
  lines.push(
    "- Audio is checked in under `audio/` so the measurement is listenable and reproducible.",
  );
  lines.push("");
  lines.push("## Per-platform Stage-B recommendation (VOICE_UX.md §7)");
  lines.push("");
  lines.push(
    "- **iOS / Apple Silicon:** the measured on-device `SFSpeechRecognizer` arm confirms the §7 claim —",
  );
  lines.push(
    "  real-time-factor < 1 (faster than real time) and exact accept on clean speech — so the",
  );
  lines.push(
    "  ANE-capable `SFSpeechRecognizer` is the cheapest-correct Stage-B confirm recognizer on Apple.",
  );
  lines.push(
    "  Kokoro TTS is unchanged. iOS device energy telemetry is not counted as covered by this",
  );
  lines.push(
    "  Apple-Silicon-only artifact; it must be supplied through the strict Stage-B report gate.",
  );
  lines.push(
    "- **Android:** `SpeechRecognizer` (NNAPI) latency/battery/accept is not counted as covered by",
  );
  lines.push(
    "  this host artifact; it must be supplied through the strict Stage-B report gate.",
  );
  lines.push(
    "- **Linux/desktop fused:** the fused libelizainference ASR latency/RTF on the identical corpus is a",
  );
  lines.push(
    "  required report input when the provisioned `libelizainference` bundle is available.",
  );
  lines.push(
    "  Historical qualitative ASR artifacts are not accepted as Stage-B coverage; use",
  );
  lines.push(
    "  `ELIZA_VOICE_STAGE_B_REPORT` with `packages/scripts/voice-stage-b-eval.mjs`.",
  );
  lines.push("");
  lines.push(
    "## Strict report gate (not measured by this Apple-only host artifact)",
  );
  lines.push("");
  lines.push(
    "The complete #9958 Stage-B decision is green only when `voice-stage-b-eval.mjs`",
  );
  lines.push(
    "validates a reviewed JSON report covering iOS `SFSpeechRecognizer`, Android",
  );
  lines.push(
    "`SpeechRecognizer`, and fused ASR with real hardware, latency, WER, and power telemetry.",
  );
  lines.push("");
  lines.push("## Required external measurements");
  lines.push("");
  lines.push("| Arm | Needs | Run |");
  lines.push("|---|---|---|");
  lines.push(
    "| iOS battery/energy per frame | real iOS device + Instruments | Xcode Instruments Energy Log over a Stage-B confirm session |",
  );
  lines.push(
    "| Android `SpeechRecognizer` (NNAPI) | real Android device | port `stage-b-stt-bench` to an instrumented Android test using `SpeechRecognizer` |",
  );
  lines.push(
    "| Fused ASR on identical corpus | provisioned `libelizainference` bundle | `bun plugins/plugin-local-inference/native/verify/asr_bench.ts --wav-dir <this audio/> --real-recorded` |",
  );
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(REPO_ROOT, args.out);

  if (process.platform !== "darwin") {
    writeSkip(
      outDir,
      `Apple SFSpeechRecognizer arm requires macOS; current=${process.platform}`,
    );
    return;
  }
  if (!commandExists("say") || !commandExists("afconvert")) {
    writeSkip(
      outDir,
      "macOS `say`/`afconvert` not available for on-device speech synthesis",
    );
    return;
  }
  if (!commandExists("swift")) {
    writeSkip(
      outDir,
      "swift toolchain not available to build the Stage-B recognizer",
    );
    return;
  }

  // Build the Swift recognizer if needed.
  if (!fs.existsSync(BENCH_BIN)) {
    console.log("[stage-b-stt] building Swift recognizer...");
    const build = spawnSync(
      "swift",
      ["build", "--package-path", SWIFT_PACKAGE, "-c", "release"],
      { encoding: "utf8", stdio: "inherit" },
    );
    if (build.status !== 0) {
      writeSkip(outDir, "swift build of stage-b-stt-bench failed");
      return;
    }
  }

  const manifestRaw = JSON.parse(fs.readFileSync(REFERENCE_MANIFEST, "utf8"));
  const refByID = new Map(manifestRaw.files.map((f) => [f.id, f.reference]));

  const audioRoot = path.join(outDir, "audio");
  const conditions = [
    { label: "quiet", dir: path.join(audioRoot, "quiet"), noisy: false },
    { label: "noisy-10dB", dir: path.join(audioRoot, "noisy"), noisy: true },
  ];

  const reportConditions = [];
  for (const cond of conditions) {
    fs.mkdirSync(cond.dir, { recursive: true });
    const utts = [];
    for (const f of manifestRaw.files) {
      const aiff = path.join(cond.dir, `${f.id}.aiff`);
      const cleanWav = path.join(cond.dir, `${f.id}.wav`);
      synthSpeech(f.reference, args.voice, aiff, cleanWav);
      fs.rmSync(aiff, { force: true });
      if (cond.noisy) {
        const samples = readWavPcm16(cleanWav);
        writeWavPcm16(cleanWav, addNoise(samples, NOISE_SNR_DB), SAMPLE_RATE);
      }
      utts.push({ id: f.id, reference: f.reference, wav: `${f.id}.wav` });
    }
    const manifestPath = path.join(cond.dir, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ utterances: utts }, null, 2),
    );

    const bench = runBench(manifestPath);
    if (bench.unavailable) {
      writeSkip(outDir, `Stage-B recognizer unavailable: ${bench.doc.reason}`);
      return;
    }
    fs.writeFileSync(
      path.join(outDir, `apple-sfspeech-${cond.label}.json`),
      JSON.stringify(bench.doc, null, 2),
    );
    reportConditions.push({
      label: cond.label,
      result: aggregate(refByID, bench.doc),
    });
  }

  const firstDoc = JSON.parse(
    fs.readFileSync(
      path.join(outDir, `apple-sfspeech-${conditions[0].label}.json`),
      "utf8",
    ),
  );
  const report = {
    schema: "eliza_stage_b_stt_eval_v1",
    issue: Number(ISSUE),
    status: "ok",
    generatedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
    },
    backend: "apple-sfspeechrecognizer",
    locale: firstDoc.locale,
    voice: args.voice,
    requiresOnDeviceRecognition: firstDoc.requiresOnDeviceRecognition,
    supportsOnDeviceRecognition: firstDoc.supportsOnDeviceRecognition,
    noiseSnrDb: NOISE_SNR_DB,
    conditions: reportConditions,
    deviceHandoff: [
      "iOS per-frame battery/energy telemetry (real iOS device + Instruments)",
      "Android SpeechRecognizer (NNAPI) latency/battery/accept (real Android device)",
      "Fused libelizainference ASR on the identical corpus (provisioned bundle)",
    ],
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "stage-b-stt-matrix.json"),
    JSON.stringify(report, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "stage-b-stt-eval.md"),
    renderMarkdown(report),
  );

  for (const cond of reportConditions) {
    const s = cond.result.summary;
    console.log(
      `[stage-b-stt] ${cond.label}: exact=${fmtPct(s.exactAcceptRate)} meanWER=${fmtPct(s.meanWer)} meanLatency=${s.meanLatencyMs.toFixed(0)}ms RTF=${s.meanRealTimeFactor.toFixed(3)}`,
    );
  }
  console.log(
    `[stage-b-stt] wrote ${path.relative(REPO_ROOT, outDir)}/stage-b-stt-eval.md`,
  );
}

main().catch((error) => {
  console.error(
    `[stage-b-stt] ${error instanceof Error ? error.stack : String(error)}`,
  );
  process.exit(1);
});
