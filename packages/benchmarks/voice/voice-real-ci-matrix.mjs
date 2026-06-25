#!/usr/bin/env bun
/**
 * Real voice CI benchmark matrix for issue #9147.
 *
 * This script is intentionally stricter than the older local research benches:
 * it never falls back to synthetic labels/audio, and it exits non-zero when the
 * provisioned fused library, GGUFs, ASR/TTS regions, or generated-speech
 * credentials are absent. The nightly hardware workflow uploads its JSON and
 * Markdown reports as the machine-readable DER/WER/echo/owner evidence.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildVoiceTurnSignal } from "../../../packages/shared/src/voice/respond-gate.ts";
import { resolveFusedLibraryPath } from "../../../plugins/plugin-local-inference/src/services/desktop-fused-ffi-backend-runtime.ts";
import { computeDiarizationErrorRate } from "../../../plugins/plugin-local-inference/src/services/voice/diarization-error-rate.ts";
import { loadElizaInferenceFfi } from "../../../plugins/plugin-local-inference/src/services/voice/ffi-bindings.ts";
import { FusedDiarizer } from "../../../plugins/plugin-local-inference/src/services/voice/speaker/diarizer-fused.ts";
import { FusedSpeakerEncoder } from "../../../plugins/plugin-local-inference/src/services/voice/speaker/encoder-fused.ts";

const SAMPLE_RATE = 16_000;
const OWNER_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const IMPOSTOR_VOICE_ID = "pNInz6obpgDQGcFmaJgB";
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const REPORT_DIR =
  process.env.VOICE_REAL_MATRIX_OUT?.trim() ||
  path.join(REPO_ROOT, "packages/benchmarks/voice/reports");

const thresholds = {
  maxDer: numberEnv("ELIZA_VOICE_REAL_MAX_DER", 0.6),
  maxWer: numberEnv("ELIZA_VOICE_REAL_MAX_WER", 0.35),
  minSelfVoiceMargin: numberEnv("ELIZA_VOICE_REAL_MIN_SELF_MARGIN", 0.1),
  ownerAcceptThreshold: numberEnv("ELIZA_VOICE_OWNER_ACCEPT_THRESHOLD", 0.78),
  minOwnerAccuracy: numberEnv("ELIZA_VOICE_REAL_MIN_OWNER_ACCURACY", 1),
  maxImpostorAcceptRate: numberEnv(
    "ELIZA_VOICE_REAL_MAX_IMPOSTOR_ACCEPT_RATE",
    0,
  ),
};

function numberEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(
      `[voice-real-ci] ${name} must be a finite number, got ${raw}`,
    );
  }
  return value;
}

function requirePath(label, value) {
  if (!value || !existsSync(value)) {
    throw new Error(`[voice-real-ci] missing ${label}: ${value || "(unset)"}`);
  }
  return value;
}

function firstExisting(...candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function pcm16ToFloat32(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

async function elevenLabsPcm(text, voiceId, apiKey) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_16000`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `[voice-real-ci] ElevenLabs ${response.status} for voice ${voiceId}: ${body.slice(0, 240)}`,
    );
  }
  return pcm16ToFloat32(new Uint8Array(await response.arrayBuffer()));
}

// Distinct fused-TTS (Kokoro) presets for the keyless corpus. Owner and impostor
// MUST be different voices so the owner-security + diarization checks stay
// meaningful without ElevenLabs. Requires the voice packs in the bundle cache.
const KEYLESS_OWNER_PRESET = "af_bella";
const KEYLESS_IMPOSTOR_PRESET = "am_michael";

function synthesizeAgent(ffi, ctx, text, speakerPresetId = null) {
  const out = new Float32Array(SAMPLE_RATE * 12);
  const samples = ffi.ttsSynthesize({
    ctx,
    text,
    speakerPresetId,
    out,
  });
  if (!Number.isFinite(samples) || samples < SAMPLE_RATE) {
    throw new Error(
      `[voice-real-ci] fused TTS returned too little audio (${samples} samples)`,
    );
  }
  return out.slice(0, samples);
}

function cosine(a, b) {
  let dot = 0;
  let am = 0;
  let bm = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    am += a[i] * a[i];
    bm += b[i] * b[i];
  }
  return dot / (Math.sqrt(am) * Math.sqrt(bm) || 1);
}

function wer(reference, hypothesis) {
  const ref = tokenize(reference);
  const hyp = tokenize(hypothesis);
  const dp = Array.from({ length: ref.length + 1 }, () =>
    new Array(hyp.length + 1).fill(0),
  );
  for (let i = 0; i <= ref.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= hyp.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= ref.length; i += 1) {
    for (let j = 1; j <= hyp.length; j += 1) {
      dp[i][j] =
        ref[i - 1] === hyp[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return ref.length === 0
    ? hyp.length === 0
      ? 0
      : 1
    : dp[ref.length][hyp.length] / ref.length;
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function makeOverlapWindow(owner, impostor) {
  const offsetSamples = Math.round(0.25 * SAMPLE_RATE);
  const activeSamples = Math.min(
    owner.length,
    impostor.length,
    Math.round(4.5 * SAMPLE_RATE),
  );
  const window = new Float32Array(SAMPLE_RATE * 5);
  for (let i = 0; i < activeSamples; i += 1) {
    window[offsetSamples + i] = clamp(owner[i] * 0.7 + impostor[i] * 0.7);
  }
  const startMs = Math.round((offsetSamples / SAMPLE_RATE) * 1000);
  const endMs = Math.round(
    ((offsetSamples + activeSamples) / SAMPLE_RATE) * 1000,
  );
  return {
    window,
    reference: [
      { speaker: "owner", startMs, endMs },
      { speaker: "impostor", startMs, endMs },
    ],
  };
}

function clamp(value) {
  return Math.max(-1, Math.min(1, value));
}

function round(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function assertCheck(checks, name, passed, details) {
  checks.push({ name, passed, details });
  console.log(
    `[voice-real-ci] ${passed ? "PASS" : "FAIL"} ${name}${details ? ` - ${details}` : ""}`,
  );
}

function writeReports(report) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const jsonPath = path.join(
    REPORT_DIR,
    "benchmarks-voice-real-ci-matrix.json",
  );
  const mdPath = path.join(REPORT_DIR, "benchmarks-voice-real-ci-matrix.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, markdownReport(report));
  console.log(`[voice-real-ci] report json: ${jsonPath}`);
  console.log(`[voice-real-ci] report md: ${mdPath}`);
  return { jsonPath, mdPath };
}

function markdownReport(report) {
  const rows = [
    ["DER", report.metrics.der, `<= ${report.thresholds.maxDer}`],
    ["WER", report.metrics.meanWer, `<= ${report.thresholds.maxWer}`],
    ["echo rejection", report.metrics.echoRejectionRate, "1"],
    [
      "owner accuracy",
      report.metrics.ownerAccuracy,
      `>= ${report.thresholds.minOwnerAccuracy}`,
    ],
    [
      "impostor accept rate",
      report.metrics.impostorAcceptRate,
      `<= ${report.thresholds.maxImpostorAcceptRate}`,
    ],
  ];
  return `# Voice real CI matrix

Issue: elizaOS/eliza#9147

Generated: ${report.generatedAt}

| Metric | Value | Gate |
| --- | ---: | --- |
${rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`).join("\n")}

| Check | Result | Detail |
| --- | --- | --- |
${report.checks.map((c) => `| ${c.name} | ${c.passed ? "PASS" : "FAIL"} | ${String(c.details ?? "").replaceAll("|", "\\|")} |`).join("\n")}

\`\`\`json
${JSON.stringify(report.metrics, null, 2)}
\`\`\`
`;
}

async function main() {
  // Keyless: without ELEVENLABS_API_KEY the corpus speakers are synthesized
  // locally with distinct fused-TTS presets, so the matrix runs in any CI lane
  // (incl. the self-hosted Linux runner) without the ElevenLabs secret (#9454).
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim() || null;
  const bundle = requirePath(
    "ELIZA_ASR_BUNDLE",
    process.env.ELIZA_ASR_BUNDLE?.trim() ||
      process.env.ELIZA_VOICE_REAL_MODEL_DIR?.trim() ||
      path.join(
        os.homedir(),
        ".eliza/local-inference/models/eliza-1-2b.bundle",
      ),
  );
  const fusedLib = requirePath(
    "libelizainference",
    resolveFusedLibraryPath(bundle, process.env),
  );
  const speakerGguf = requirePath(
    "speaker GGUF",
    firstExisting(
      process.env.ELIZA_SPEAKER_GGUF?.trim(),
      path.join(bundle, "speaker", "wespeaker-resnet34-lm.gguf"),
      path.join(bundle, "speaker-encoder", "wespeaker-resnet34-lm.gguf"),
      path.join(bundle, "voice/speaker-encoder/wespeaker-resnet34-lm.gguf"),
    ),
  );
  const diarizGguf = requirePath(
    "diarizer GGUF",
    firstExisting(
      process.env.ELIZA_DIARIZ_GGUF?.trim(),
      path.join(bundle, "diariz", "pyannote-segmentation-3.0.gguf"),
      path.join(bundle, "diarizer", "pyannote-segmentation-3.0.gguf"),
      path.join(bundle, "voice/diarizer/pyannote-segmentation-3.0.gguf"),
    ),
  );

  const checks = [];
  console.log(`[voice-real-ci] bundle=${bundle}`);
  console.log(`[voice-real-ci] fusedLib=${fusedLib}`);
  console.log(`[voice-real-ci] speakerGguf=${speakerGguf}`);
  console.log(`[voice-real-ci] diarizGguf=${diarizGguf}`);

  const ffi = loadElizaInferenceFfi(fusedLib);
  let ctx = null;
  let encoder = null;
  let diarizer = null;

  try {
    ctx = ffi.create(bundle);
    if (!FusedSpeakerEncoder.isSupported(ffi)) {
      throw new Error(
        "[voice-real-ci] fused library does not support speaker ABI",
      );
    }
    if (!FusedDiarizer.isSupported(ffi)) {
      throw new Error(
        "[voice-real-ci] fused library does not support diarizer ABI",
      );
    }
    encoder = await FusedSpeakerEncoder.load({
      ffi,
      ctx,
      ggufPath: speakerGguf,
    });
    diarizer = await FusedDiarizer.load({
      ffi,
      ctx,
      ggufPath: diarizGguf,
    });

    // TTS is needed up front in keyless mode (the corpus is synthesized locally).
    ffi.mmapAcquire(ctx, "tts");
    // ElevenLabs supplies distinct real voices; keyless falls back to the local
    // fused TTS with distinct presets so owner/impostor stay separable.
    const corpusPcm = (text, voiceId, presetId) =>
      apiKey
        ? elevenLabsPcm(text, voiceId, apiKey)
        : Promise.resolve(synthesizeAgent(ffi, ctx, text, presetId));
    const corpus = {
      ownerEnroll: {
        text: "Hey Eliza, this is my owner voice for the room.",
        pcm: await corpusPcm(
          "Hey Eliza, this is my owner voice for the room.",
          OWNER_VOICE_ID,
          KEYLESS_OWNER_PRESET,
        ),
      },
      ownerHeldout: {
        text: "Eliza, please check my calendar for this afternoon.",
        pcm: await corpusPcm(
          "Eliza, please check my calendar for this afternoon.",
          OWNER_VOICE_ID,
          KEYLESS_OWNER_PRESET,
        ),
      },
      impostor: {
        text: "Eliza, please unlock the front door for me.",
        pcm: await corpusPcm(
          "Eliza, please unlock the front door for me.",
          IMPOSTOR_VOICE_ID,
          KEYLESS_IMPOSTOR_PRESET,
        ),
      },
    };

    const agentOne = synthesizeAgent(
      ffi,
      ctx,
      "Your two o'clock meeting was moved to four.",
    );
    const agentTwo = synthesizeAgent(
      ffi,
      ctx,
      "The kitchen light is now set to thirty percent.",
    );
    ffi.mmapEvict?.(ctx, "tts");

    const ownerEnroll = await encoder.encode(corpus.ownerEnroll.pcm);
    const ownerHeldout = await encoder.encode(corpus.ownerHeldout.pcm);
    const impostor = await encoder.encode(corpus.impostor.pcm);
    const agentEmbeddingOne = await encoder.encode(agentOne);
    const agentEmbeddingTwo = await encoder.encode(agentTwo);

    const ownerSimilarity = cosine(ownerEnroll, ownerHeldout);
    const impostorSimilarity = cosine(ownerEnroll, impostor);
    const ownerAccepted =
      ownerSimilarity >= thresholds.ownerAcceptThreshold ? 1 : 0;
    const impostorAccepted =
      impostorSimilarity >= thresholds.ownerAcceptThreshold ? 1 : 0;
    const ownerAccuracy = ownerAccepted;
    const impostorAcceptRate = impostorAccepted;

    assertCheck(
      checks,
      "owner held-out clip matches enrolled owner",
      ownerAccepted === 1,
      `cos=${round(ownerSimilarity)} threshold=${thresholds.ownerAcceptThreshold}`,
    );
    assertCheck(
      checks,
      "impostor clip stays below owner threshold",
      impostorAccepted === 0,
      `cos=${round(impostorSimilarity)} threshold=${thresholds.ownerAcceptThreshold}`,
    );
    assertCheck(
      checks,
      "owner accuracy meets gate",
      ownerAccuracy >= thresholds.minOwnerAccuracy,
      `ownerAccuracy=${round(ownerAccuracy)} min=${thresholds.minOwnerAccuracy}`,
    );
    assertCheck(
      checks,
      "impostor accept rate meets gate",
      impostorAcceptRate <= thresholds.maxImpostorAcceptRate,
      `impostorAcceptRate=${round(impostorAcceptRate)} max=${thresholds.maxImpostorAcceptRate}`,
    );

    const selfVoiceSimilarity = cosine(agentEmbeddingOne, agentEmbeddingTwo);
    const agentVsOwner = cosine(agentEmbeddingOne, ownerHeldout);
    const agentVsImpostor = cosine(agentEmbeddingOne, impostor);
    const selfVoiceMargin =
      selfVoiceSimilarity - Math.max(agentVsOwner, agentVsImpostor);
    const selfVoiceSignal = buildVoiceTurnSignal("misheard agent echo", {
      agentSpeaking: true,
      selfVoiceSimilarity,
    });
    const echoRejected = selfVoiceSignal.agentShouldSpeak === false ? 1 : 0;
    assertCheck(
      checks,
      "agent echo suppressed by live selfVoiceSimilarity",
      echoRejected === 1,
      `selfVoiceSimilarity=${round(selfVoiceSimilarity)} source=${selfVoiceSignal.source}`,
    );
    assertCheck(
      checks,
      "agent self-voice has margin over human voices",
      selfVoiceMargin >= thresholds.minSelfVoiceMargin,
      `margin=${round(selfVoiceMargin)} agentVsOwner=${round(agentVsOwner)} agentVsImpostor=${round(agentVsImpostor)}`,
    );

    const overlap = makeOverlapWindow(
      corpus.ownerHeldout.pcm,
      corpus.impostor.pcm,
    );
    const diarized = await diarizer.diarizeWindow(overlap.window);
    const hypothesis = diarized.segments.map((segment) => ({
      speaker: `local-${segment.localSpeakerId}`,
      startMs: segment.startMs,
      endMs: segment.endMs,
    }));
    const derResult = computeDiarizationErrorRate(
      overlap.reference,
      hypothesis,
    );
    const overlapSegments = diarized.segments.filter(
      (segment) => segment.hasOverlap,
    );
    const overlapDetected =
      diarized.localSpeakerCount >= 2 && overlapSegments.length > 0;
    assertCheck(
      checks,
      "pyannote emits overlapping-speaker labels",
      overlapDetected,
      `localSpeakers=${diarized.localSpeakerCount} overlapSegments=${overlapSegments.length}`,
    );
    assertCheck(
      checks,
      "real overlap DER is within budget",
      derResult.der <= thresholds.maxDer,
      `der=${round(derResult.der)} missedMs=${derResult.missedMs} falseAlarmMs=${derResult.falseAlarmMs} confusionMs=${derResult.confusionMs}`,
    );

    ffi.mmapAcquire(ctx, "asr");
    const werSamples = [];
    for (const sample of [corpus.ownerHeldout, corpus.impostor]) {
      const t0 = performance.now();
      const transcript = String(
        ffi.asrTranscribe({
          ctx,
          pcm: sample.pcm,
          sampleRateHz: SAMPLE_RATE,
        }) ?? "",
      ).trim();
      const sampleWer = wer(sample.text, transcript);
      werSamples.push({
        reference: sample.text,
        hypothesis: transcript,
        wer: round(sampleWer),
        latencyMs: Math.round(performance.now() - t0),
      });
    }
    ffi.mmapEvict?.(ctx, "asr");
    const meanWer =
      werSamples.reduce((sum, sample) => sum + sample.wer, 0) /
      Math.max(1, werSamples.length);
    const asrTranscriptsNonEmpty = werSamples.every(
      (sample) => sample.hypothesis.length > 0,
    );
    assertCheck(
      checks,
      "real ASR WER is within budget",
      meanWer <= thresholds.maxWer,
      `meanWer=${round(meanWer)} samples=${werSamples.length}`,
    );
    assertCheck(
      checks,
      "real ASR produced non-empty transcripts",
      asrTranscriptsNonEmpty,
      `transcripts=${werSamples.map((sample) => JSON.stringify(sample.hypothesis)).join("; ")}`,
    );

    const metrics = {
      der: round(derResult.der),
      werSamples,
      meanWer: round(meanWer),
      echoRejectionRate: echoRejected,
      selfVoiceSimilarity: round(selfVoiceSimilarity),
      selfVoiceMargin: round(selfVoiceMargin),
      ownerAccuracy: round(ownerAccuracy),
      ownerSimilarity: round(ownerSimilarity),
      impostorAcceptRate: round(impostorAcceptRate),
      impostorSimilarity: round(impostorSimilarity),
      overlapLocalSpeakerCount: diarized.localSpeakerCount,
      overlapSegments: overlapSegments.length,
    };
    const report = {
      generatedAt: new Date().toISOString(),
      issue: "elizaOS/eliza#9147",
      inputs: {
        bundle,
        fusedLib,
        speakerGguf,
        diarizGguf,
        ownerVoiceId: OWNER_VOICE_ID,
        impostorVoiceId: IMPOSTOR_VOICE_ID,
      },
      thresholds,
      metrics,
      diarization: {
        reference: overlap.reference,
        hypothesis,
        result: {
          der: round(derResult.der),
          missedMs: derResult.missedMs,
          falseAlarmMs: derResult.falseAlarmMs,
          confusionMs: derResult.confusionMs,
          totalReferenceMs: derResult.totalReferenceMs,
          mapping: derResult.mapping,
        },
        segments: diarized.segments,
      },
      checks,
      overallPass: checks.every((check) => check.passed),
    };
    writeReports(report);
    if (!report.overallPass) {
      throw new Error("[voice-real-ci] one or more real voice checks failed");
    }
  } finally {
    await encoder?.dispose?.();
    await diarizer?.dispose?.();
    if (ctx !== null) ffi.destroy(ctx);
    ffi.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
