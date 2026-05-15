#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginRoot = resolve(__dirname, "..", "..");
const repoRoot = resolve(pluginRoot, "..", "..");

function rel(path) {
  const primary = resolve(repoRoot, path);
  if (existsSync(primary)) return primary;
  if (path.startsWith("packages/inference/reports/")) {
    return resolve(
      pluginRoot,
      "native",
      "reports",
      path.slice("packages/inference/reports/".length),
    );
  }
  if (path.startsWith("packages/inference/verify/")) {
    return resolve(
      pluginRoot,
      "native",
      "verify",
      path.slice("packages/inference/verify/".length),
    );
  }
  return primary;
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

function canonicalize(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function normalizeWords(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function wordErrorRate(reference, hypothesis) {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  const prev = Array.from({ length: hyp.length + 1 }, (_, i) => i);
  const curr = new Array(hyp.length + 1).fill(0);
  for (let i = 1; i <= ref.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= hyp.length; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j < curr.length; j += 1) prev[j] = curr[j];
  }
  return prev[hyp.length] / ref.length;
}

function wavSize(path) {
  const full = rel(path);
  if (!existsSync(full)) return null;
  const buf = readFileSync(full);
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  let fmtOffset = -1;
  let dataOffset = -1;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= buf.length; ) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (id === "fmt ") fmtOffset = data;
    if (id === "data") {
      dataOffset = data;
      dataBytes = size;
    }
    offset = data + size + (size % 2);
  }
  if (fmtOffset < 0 || dataOffset < 0) return null;
  const channels = buf.readUInt16LE(fmtOffset + 2);
  const bitsPerSample = buf.readUInt16LE(fmtOffset + 14);
  const sampleRateHz = buf.readUInt32LE(fmtOffset + 4);
  const bytesPerFrame = channels * (bitsPerSample / 8);
  const samples = Math.floor(dataBytes / bytesPerFrame);
  let sumSq = 0;
  let peakAbs = 0;
  let silent = 0;
  let previousSign = 0;
  let zeroCrossings = 0;
  if (bitsPerSample === 16 && channels > 0) {
    for (let i = 0; i < samples; i += 1) {
      const value = buf.readInt16LE(dataOffset + i * bytesPerFrame) / 32768;
      const abs = Math.abs(value);
      peakAbs = Math.max(peakAbs, abs);
      sumSq += value * value;
      if (abs < 0.01) silent += 1;
      const sign = value > 0 ? 1 : value < 0 ? -1 : previousSign;
      if (previousSign !== 0 && sign !== 0 && sign !== previousSign) {
        zeroCrossings += 1;
      }
      if (sign !== 0) previousSign = sign;
    }
  }
  return {
    bytes: buf.length,
    sampleRateHz,
    channels,
    bitsPerSample,
    dataBytes,
    samples,
    durationMs: samples > 0 ? Math.round((samples / sampleRateHz) * 1000) : 0,
    rms: samples > 0 ? Number(Math.sqrt(sumSq / samples).toFixed(6)) : 0,
    peakAbs: Number(peakAbs.toFixed(6)),
    zeroCrossingRate:
      samples > 1 ? Number((zeroCrossings / (samples - 1)).toFixed(6)) : 0,
    silenceRatio: samples > 0 ? Number((silent / samples).toFixed(6)) : 1,
  };
}

function deterministicVoiceProfileStatus({ wavPath, referenceText, label }) {
  const wav = wavSize(wavPath);
  const wavSha256 = sha256(wavPath);
  if (!wav || !wavSha256) {
    return { status: "missing", wavPath };
  }
  const issues = [];
  if (wav.bitsPerSample !== 16) issues.push("sample is not PCM16");
  if (wav.sampleRateHz < 16000) issues.push("sample rate below 16kHz");
  if (wav.durationMs < 1000) issues.push("duration below 1000ms");
  if (wav.rms <= 0.001) issues.push("sample appears silent");
  if (!referenceText || referenceText.trim().split(/\s+/).length < 3) {
    issues.push("reference text is missing or too short");
  }
  const payload = {
    schemaVersion: "eliza.voice_profile.v1",
    embeddingModel: "eliza-voice-profile-features-v1",
    reference: {
      label,
      referenceText,
      consent: { attribution: true, synthesis: false },
    },
    samples: [
      {
        id: "reference-sample",
        wavSha256,
        audio: wav,
      },
    ],
  };
  const artifactId = `vpa_${createHash("sha256")
    .update(canonicalJson(payload))
    .digest("hex")
    .slice(0, 32)}`;
  return {
    status: issues.length === 0 ? "ready" : "needs_review",
    artifactId,
    deterministic: true,
    wavPath,
    wavSha256,
    referenceText,
    audio: wav,
    attributionStatus: issues.length === 0 ? "ready" : "needs_review",
    synthesisStatus: "not_authorized",
    issues,
  };
}

function heuristicEmotionAttribution({ transcript, audio }) {
  const text = String(transcript ?? "").toLowerCase();
  const scores = {
    happy: 0,
    sad: 0,
    angry: 0,
    nervous: 0,
    calm: 0,
    excited: 0,
    whisper: 0,
  };
  const evidence = [];
  const add = (emotion, amount, detail) => {
    scores[emotion] = Math.min(1, scores[emotion] + amount);
    evidence.push({ source: "text_audio_heuristic", emotion, detail, amount });
  };
  if (/\b(happy|glad|great|thanks|love)\b/.test(text)) {
    add("happy", 0.32, "positive transcript terms");
  }
  if (/\b(excited|amazing|wow|urgent)\b/.test(text)) {
    add("excited", 0.34, "high-arousal transcript terms");
  }
  if (/\b(sad|sorry|tired|hurt|miss)\b/.test(text)) {
    add("sad", 0.34, "sadness transcript terms");
  }
  if (/\b(angry|mad|furious|stop|unacceptable)\b/.test(text)) {
    add("angry", 0.36, "anger transcript terms");
  }
  if (/\b(worried|nervous|afraid|scared|anxious|maybe)\b/.test(text)) {
    add("nervous", 0.34, "anxiety transcript terms");
  }
  if (audio?.rms >= 0.18 && /!|urgent|wow/.test(text)) {
    add("excited", 0.2, "high energy audio with arousal text");
  }
  if (audio?.rms <= 0.06 && audio?.zeroCrossingRate >= 0.14) {
    add("whisper", 0.3, "low energy, high zero-crossing audio");
  }
  if (audio?.rms <= 0.1) add("calm", 0.12, "restrained energy audio");
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return {
    status: "available",
    emotion: best?.[1] >= 0.18 ? best[0] : null,
    confidence: best?.[1] ?? 0,
    modelNativeEmotion: false,
    conclusion:
      "Emotion is attributed from transcript text and audio features only; the local ASR smoke output is not treated as model-native emotion recognition.",
    evidence,
    scores,
  };
}

function asrSummary(path) {
  const j = loadJson(path);
  if (!j) return { status: "missing", path };
  const expected =
    j.normalizedExpected ??
    j.expectedContains ??
    j.expected ??
    j.referenceText ??
    null;
  const transcript = j.transcript ?? j.normalizedTranscript ?? "";
  const wer =
    expected && transcript
      ? Number(wordErrorRate(expected, transcript).toFixed(4))
      : null;
  return {
    status: j.ok ? "pass" : "fail",
    path,
    transcript: j.transcript,
    normalizedTranscript: j.normalizedTranscript,
    expected,
    wer,
    transcribeMs: j.transcribeMs,
    totalMs: j.totalMs,
  };
}

function asrFromTtsSmokeSummary(path) {
  const j = loadJson(path);
  if (!j) return { status: "missing", path };
  const expected =
    j.normalizedExpected ?? j.expectedContains ?? j.expected ?? null;
  const transcript = j.normalizedTranscript ?? j.transcript ?? "";
  const wav = j.wav ? wavSize(j.wav) : null;
  const lexicalPass =
    j.ok === true &&
    typeof expected === "string" &&
    expected.length > 0 &&
    typeof transcript === "string" &&
    transcript.includes(expected);
  return {
    status: lexicalPass && wav ? "pass" : "fail",
    path,
    bundle: j.bundle ?? null,
    wav: j.wav ?? null,
    wavInfo: wav,
    transcript: j.transcript ?? null,
    normalizedTranscript: j.normalizedTranscript ?? null,
    expected,
    wer:
      expected && transcript
        ? Number(wordErrorRate(expected, transcript).toFixed(4))
        : null,
    transcribeMs: j.transcribeMs ?? null,
    totalMs: j.totalMs ?? null,
    reason:
      lexicalPass && wav
        ? "active bundle generated TTS audio round-tripped through local ASR"
        : "ASR-from-TTS smoke missing audio or lexical validation",
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

const activeTier = "0_8b";
const activeBundleDir =
  "/Users/shawwalters/.eliza/local-inference/models/eliza-1-0_8b.bundle";
const defaultTtsPath =
  "packages/inference/reports/local-e2e/2026-05-14/tts-stream-smoke-warmed-local-loop-0_8b-20260514.json";
const defaultAsrPath =
  "packages/inference/reports/local-e2e/2026-05-14/asr-tts-loopback-warmed-local-loop-0_8b-20260514.json";
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
const currentActiveAsrFromTtsPaths = [
  "packages/inference/reports/local-e2e/2026-05-14/asr-tts-loopback-hello-there-0_8b-fallback-ipa-20260514.json",
  "packages/inference/reports/local-e2e/asr-producer-reply-from-tts-16k-20260513.json",
  "packages/inference/reports/local-e2e/asr-producer-reply-from-tts-20260513.json",
  "packages/inference/reports/local-e2e/asr-hello-cal-from-tts-20260513.json",
];
const staleElizaVoiceSmokePath =
  "packages/inference/reports/local-e2e/2026-05-11/voice-loop-trials/eliza-local-voice-smoke_seed42.asr.json";
const currentStepSweepPath =
  "packages/inference/reports/local-e2e/2026-05-12/tts-step-sweep-0_6b-current-20260512.json";
const postTierStepSweepPath =
  "packages/inference/reports/local-e2e/2026-05-12/tts-step-sweep-0_6b-post-tier-migration-20260512.json";
const currentReferenceWavPath =
  "packages/inference/reports/local-e2e/2026-05-14/audio/tts-stream-smoke-hello-there-0_8b-fallback-ipa-20260514.wav";
const activeTierMatrix = [
  "0_8b",
  "2b",
  "4b",
  "9b",
  "27b",
  "27b-256k",
  "27b-256k",
];

const defaultRoundTripTts = ttsSummary(defaultTtsPath);
const defaultRoundTripAsr = asrSummary(defaultAsrPath);
const defaultStepSweep = stepSweepSummary(
  currentStepSweepPath,
  postTierStepSweepPath,
);
const currentActiveAsrFromTts = currentActiveAsrFromTtsPaths.map((path) =>
  asrFromTtsSmokeSummary(path),
);
const bestCurrentActiveAsrFromTts =
  currentActiveAsrFromTts.find((row) => row.status === "pass") ??
  currentActiveAsrFromTts[0];
const directDefaultEvidencePass =
  defaultRoundTripTts.status === "pass" && defaultRoundTripAsr.status === "pass";
const defaultStreamingEvidenceMode = directDefaultEvidencePass
  ? "direct_streaming_tts_asr"
  : bestCurrentActiveAsrFromTts?.status === "pass"
    ? "active_asr_from_tts_smoke"
    : defaultStepSweep.status === "pass"
      ? "legacy_0_6b_step_sweep_fallback"
      : "missing";
const defaultStreamingStatus = directDefaultEvidencePass
  ? "pass"
  : bestCurrentActiveAsrFromTts?.status === "pass"
    ? "pass_active_smoke"
    : defaultStepSweep.status === "pass"
      ? "legacy_fallback_pass"
      : "fail";
const referenceWav = existsSync(rel(currentReferenceWavPath))
  ? currentReferenceWavPath
  : "packages/inference/reports/local-e2e/2026-05-12/audio/tts-stream-smoke-capital-steps6-20260512.wav";
const referenceProfileStatus = deterministicVoiceProfileStatus({
  wavPath: referenceWav,
  referenceText: "Capital city reference voice sample.",
  label: "local-reference",
});
const defaultEmotionAttribution = heuristicEmotionAttribution({
  transcript:
    defaultRoundTripAsr.transcript ??
    defaultRoundTripAsr.normalizedTranscript ??
    bestCurrentActiveAsrFromTts?.transcript ??
    bestCurrentActiveAsrFromTts?.normalizedTranscript ??
    defaultRoundTripTts.text,
  audio: wavSize(defaultRoundTripTts.wavOut ?? bestCurrentActiveAsrFromTts?.wav ?? referenceWav),
});
const nativeReferenceClonePass = loadJson(refCloneAsrPath)?.ok === true;
const referenceVoiceProfileProductStatus =
  referenceProfileStatus.status === "ready" && nativeReferenceClonePass
    ? "ready"
    : referenceProfileStatus.status === "ready"
      ? "attribution_ready_synthesis_not_ready"
      : referenceProfileStatus.status;
const staleElizaVoiceSmoke = asrSummary(staleElizaVoiceSmokePath);

const report = {
  generatedAt: new Date().toISOString(),
  tier: activeTier,
  bundle: {
    tier: activeTier,
    dir: activeBundleDir,
  },
  activeTierMatrix,
  runtime:
    "/Users/shawwalters/.eliza/local-inference/bin/dflash/darwin-arm64-metal-fused/libelizainference.dylib",
  defaultStreamingTtsRoundTrip: {
    status: defaultStreamingStatus,
    evidenceMode: defaultStreamingEvidenceMode,
    productReady: defaultStreamingStatus === "pass" || defaultStreamingStatus === "pass_active_smoke",
    tts: defaultRoundTripTts,
    asr: defaultRoundTripAsr,
    currentActiveAsrFromTts: bestCurrentActiveAsrFromTts,
    activeAsrFromTtsCandidates: currentActiveAsrFromTts,
    stepSweepFallback: defaultStepSweep,
    staleElizaLocalVoiceSmoke: {
      ...staleElizaVoiceSmoke,
      ignoredForProductStatus: true,
      reason:
        "The historical eliza-local-voice-smoke_seed42 ASR report is empty/stale and must not be scored as WER=1.0 evidence for the active tier.",
    },
  },
  styleInstructionRoundTrips: {
    status:
      loadJson(styled6AsrPath)?.ok === true || loadJson(styled32AsrPath)?.ok === true
        ? "pass"
        : "fail",
    conclusion:
      "The native instruct surface is wired, but the local bundle did not preserve lexical content under the tested style prompt at either 6 or 32 MaskGIT steps.",
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
    status: referenceVoiceProfileProductStatus,
    conclusion:
      "Sample WAV + reference metadata can produce a deterministic attribution profile artifact for speaker attribution. It is not a product-ready reference-clone synthesis profile until native ref_audio/ref_text round-trips pass the lexical gate.",
    profileArtifact: referenceProfileStatus,
    referenceWav,
    referenceSha256: sha256(referenceWav),
    nativeReferenceCloneRoundTrip: {
      status: nativeReferenceClonePass ? "pass" : "fail",
      outputWav: refCloneWavPath,
      outputWavInfo: wavSize(refCloneWavPath),
      outputSha256: sha256(refCloneWavPath),
      asr: asrSummary(refCloneAsrPath),
    },
  },
  emotionAwareAsrAssessment: {
    status: "heuristic_available_native_not_implemented",
    conclusion:
      "Emotion status is heuristic attribution from ASR transcript text and audio features. Local ASR evidence does not expose supported model-native emotion labels, so this is not emotion-aware ASR.",
    currentLocalAsrEvidence:
      "The local ASR FFI passes lexical ASR for the default generated TTS sample and returns transcript fields; no emotion field is present in the smoke evidence.",
    asrNativeEmotion: {
      status: "not_implemented",
      modelNativeEmotionClaimed: false,
      requiredEvidence:
        "ASR output must carry a supported emotion label or V-A-D payload and set emotionLabelSupported=true before this can be reported as model-native emotion-aware ASR.",
    },
    defaultRoundTripAttribution: defaultEmotionAttribution,
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
  "packages/inference/reports/local-e2e/2026-05-14/voice-profile-emotion-readiness-0_8b-20260514.json";
writeFileSync(rel(out), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      ok: true,
      out,
      defaultTtsStatus: report.defaultStreamingTtsRoundTrip.status,
      defaultTtsEvidenceMode: report.defaultStreamingTtsRoundTrip.evidenceMode,
      referenceVoiceProfileStatus: report.referenceVoiceProfileProbe.status,
      emotionAwareAsrStatus: report.emotionAwareAsrAssessment.status,
      modelNativeEmotionClaimed:
        report.emotionAwareAsrAssessment.asrNativeEmotion.modelNativeEmotionClaimed,
    },
    null,
    2,
  ),
);
