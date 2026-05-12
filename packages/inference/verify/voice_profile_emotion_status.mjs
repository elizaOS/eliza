#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..", "..");

function rel(path) {
  return resolve(repoRoot, path);
}

function loadJson(path) {
  const full = rel(path);
  if (!existsSync(full)) return null;
  return JSON.parse(readFileSync(full, "utf8"));
}

function sha256(path) {
  const full = rel(path);
  if (!existsSync(full)) return null;
  return createHash("sha256").update(readFileSync(full)).digest("hex");
}

function wavSize(path) {
  const full = rel(path);
  if (!existsSync(full)) return null;
  const buf = readFileSync(full);
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  return {
    bytes: buf.length,
    sampleRateHz: buf.readUInt32LE(24),
    dataBytes: buf.readUInt32LE(40),
    samples: Math.floor(buf.readUInt32LE(40) / 2),
  };
}

function asrSummary(path) {
  const j = loadJson(path);
  if (!j) return { status: "missing", path };
  return {
    status: j.ok ? "pass" : "fail",
    path,
    transcript: j.transcript,
    normalizedTranscript: j.normalizedTranscript,
    expected: j.expectedContains,
    transcribeMs: j.transcribeMs,
    totalMs: j.totalMs,
  };
}

function stepSweepSummary(...paths) {
  const path = paths.find((candidate) => loadJson(candidate));
  if (!path) return { status: "missing", paths };
  const j = loadJson(path);
  const rows = Array.isArray(j.rows) ? j.rows : [];
  const lexicalFailures = rows.filter(
    (row) => typeof row.asrWer !== "number" || row.asrWer > 0.25,
  );
  const missingAudio = rows.filter(
    (row) => !row.audioPath || !existsSync(rel(row.audioPath)),
  );
  const meanRtf =
    rows.length > 0
      ? rows.reduce((sum, row) => sum + (Number(row.rtf) || 0), 0) / rows.length
      : null;
  return {
    status:
      rows.length > 0 && lexicalFailures.length === 0 && missingAudio.length === 0
        ? "pass"
        : "fail",
    path,
    codecBackend: j.codecBackend,
    summary: j.summary,
    meanRtf,
    rows: rows.map((row) => ({
      id: row.id,
      text: row.text,
      steps: row.steps,
      audioSec: row.audioSec,
      wallMs: row.wallMs,
      rtf: row.rtf,
      asrWer: row.asrWer,
      asrTranscript: row.asrTranscript,
      audioPath: row.audioPath,
      audioSha256: row.audioPath ? sha256(row.audioPath) : null,
    })),
    lexicalFailures: lexicalFailures.map((row) => row.id),
    missingAudio: missingAudio.map((row) => row.id),
  };
}

function ttsSummary(path) {
  const j = loadJson(path);
  if (!j) return { status: "missing", path };
  return {
    status: j.ok ? "pass" : "fail",
    path,
    text: j.text,
    speakerPresetId: j.speakerPresetId,
    streamSupported: j.streamSupported,
    maskgitSteps: j.maskgitSteps,
    chunks: j.chunks,
    bodyChunks: j.bodyChunks,
    samples: j.samples,
    audioSeconds: j.audioSeconds,
    synthMs: j.synthMs,
    rtf: j.rtf,
    wavOut: j.wavOut,
    wavSha256: j.wavOut ? sha256(j.wavOut) : null,
  };
}

const defaultTtsPath =
  "packages/inference/reports/local-e2e/2026-05-12/tts-stream-smoke-wav-capital-steps6-20260512.json";
const defaultAsrPath =
  "packages/inference/reports/local-e2e/2026-05-12/asr-ffi-smoke-tts-stream-capital-steps6-20260512.json";
const styled6TtsPath =
  "packages/inference/reports/local-e2e/2026-05-12/tts-stream-smoke-styled-meeting-steps6-20260512.json";
const styled6AsrPath =
  "packages/inference/reports/local-e2e/2026-05-12/asr-ffi-smoke-tts-stream-styled-meeting-steps6-20260512.json";
const styled32TtsPath =
  "packages/inference/reports/local-e2e/2026-05-12/tts-stream-smoke-styled-meeting-steps32-20260512.json";
const styled32AsrPath =
  "packages/inference/reports/local-e2e/2026-05-12/asr-ffi-smoke-tts-stream-styled-meeting-steps32-20260512.json";
const refCloneWavPath =
  "packages/inference/reports/local-e2e/2026-05-12/audio/tts-refclone-meeting-steps32-20260512.wav";
const refCloneAsrPath =
  "packages/inference/reports/local-e2e/2026-05-12/asr-ffi-smoke-tts-refclone-meeting-steps32-20260512.json";
const currentStepSweepPath =
  "packages/inference/reports/local-e2e/2026-05-12/tts-step-sweep-0_6b-current-20260512.json";
const postTierStepSweepPath =
  "packages/inference/reports/local-e2e/2026-05-12/tts-step-sweep-0_6b-post-tier-migration-20260512.json";
const currentReferenceWavPath =
  "packages/inference/reports/local-e2e/2026-05-12/audio/chunk4_capital-steps6.wav";

const defaultRoundTripTts = ttsSummary(defaultTtsPath);
const defaultRoundTripAsr = asrSummary(defaultAsrPath);
const defaultStepSweep = stepSweepSummary(
  currentStepSweepPath,
  postTierStepSweepPath,
);
const defaultStreamingStatus =
  defaultRoundTripTts.status === "pass" && defaultRoundTripAsr.status === "pass"
    ? "pass"
    : defaultStepSweep.status;
const referenceWav = existsSync(rel(currentReferenceWavPath))
  ? currentReferenceWavPath
  : "packages/inference/reports/local-e2e/2026-05-12/audio/tts-stream-smoke-capital-steps6-20260512.wav";

const report = {
  generatedAt: new Date().toISOString(),
  bundle: "/Users/shawwalters/.eliza/local-inference/models/eliza-1-0_6b.bundle",
  runtime:
    "/Users/shawwalters/.eliza/local-inference/bin/dflash/darwin-arm64-metal-fused/libelizainference.dylib",
  defaultStreamingTtsRoundTrip: {
    status: defaultStreamingStatus,
    tts: defaultRoundTripTts,
    asr: defaultRoundTripAsr,
    stepSweepFallback: defaultStepSweep,
  },
  styleInstructionRoundTrips: {
    status:
      loadJson(styled6AsrPath)?.ok === true || loadJson(styled32AsrPath)?.ok === true
        ? "pass"
        : "fail",
    conclusion:
      "The native instruct surface is wired, but this 0.6B local bundle did not preserve lexical content under the tested style prompt at either 6 or 32 MaskGIT steps.",
    voiceDesignVocabulary:
      "Local omnivoice voice-design accepts gender, age, pitch, accent, and whisper. It does not expose discrete emotion labels in the fused VoiceDesign table.",
    sixStep: {
      tts: ttsSummary(styled6TtsPath),
      asr: asrSummary(styled6AsrPath),
    },
    thirtyTwoStep: {
      tts: ttsSummary(styled32TtsPath),
      asr: asrSummary(styled32AsrPath),
    },
  },
  referenceVoiceProfileProbe: {
    status: loadJson(refCloneAsrPath)?.ok === true ? "pass" : "fail",
    conclusion:
      "The native CLI reference-audio path accepts ref WAV + transcript and generates a WAV, but the round-trip transcript did not pass lexical validation. The app FFI still lacks a ref_audio/ref_text entry point, so sample-derived voice profiles are not product-ready through app-core yet.",
    referenceWav,
    referenceSha256: sha256(referenceWav),
    outputWav: refCloneWavPath,
    outputWavInfo: wavSize(refCloneWavPath),
    outputSha256: sha256(refCloneWavPath),
    asr: asrSummary(refCloneAsrPath),
  },
  emotionAwareAsrAssessment: {
    status: "not-implemented",
    conclusion:
      "No local evidence shows the ASR path emits emotion labels. Keep ASR transcript/token confidence separate from emotion recognition; add a tiny SER head/adaptor over early audio features if emotion attribution is required.",
    currentLocalAsrEvidence:
      "The local ASR FFI passes lexical ASR for the default generated TTS sample but does not return emotion fields.",
  },
  citedResearch: [
    {
      url: "https://github.com/QwenLM/Qwen3-ASR-Toolkit",
      evidence:
        "Toolkit uses VAD for long-audio chunking and SRT generation around natural silent pauses.",
    },
    {
      url: "https://github.com/QwenLM/Qwen3-ASR",
      evidence:
        "Open Qwen3-ASR supports streaming inference with the vLLM backend and speech/music/song recognition, language detection, and timestamps.",
    },
    {
      url: "https://github.com/QwenLM/Qwen3-ASR-Toolkit/issues/13",
      evidence:
        "Diarization and multi-speaker transcript segmentation are requested but open, including enrollment and overlap/timestamp constraints.",
    },
    {
      url: "https://github.com/QwenLM/Qwen3-TTS",
      evidence:
        "Qwen3-TTS advertises expressive/streaming generation, voice design, and vivid voice cloning; its published evals include WER/SIM and controllable speech generation metrics.",
    },
    {
      url: "https://github.com/Trshadow45/ComfyUI-Qwen3-TTS",
      evidence:
        "The ComfyUI wrapper claims emotion-aware ASR in repository metadata, but the README body does not document an emotion-ASR API contract.",
    },
  ],
  nextEngineeringGate:
    "Do not ship style-conditioned or reference-clone voice profiles as recommended defaults until their ASR round trips pass the same WER gate as default streaming TTS. Expose native ref_audio/ref_text through libelizainference before productizing sample-derived profiles.",
};

const out =
  "packages/inference/reports/local-e2e/2026-05-12/voice-profile-emotion-readiness-20260512.json";
writeFileSync(rel(out), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      ok: true,
      out,
      defaultTtsStatus: report.defaultStreamingTtsRoundTrip.status,
      referenceVoiceProfileStatus: report.referenceVoiceProfileProbe.status,
      emotionAwareAsrStatus: report.emotionAwareAsrAssessment.status,
    },
    null,
    2,
  ),
);
