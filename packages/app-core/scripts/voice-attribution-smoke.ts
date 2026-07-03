#!/usr/bin/env bun
/**
 * Speaker-attribution / diarization smoke harness (real GGUF models).
 *
 * Runs the full native voice-attribution stack against a real-speech WAV and
 * asserts each stage produces correct output:
 *   - WeSpeaker encoder (`FusedSpeakerEncoder`) → 256-d unit-norm, deterministic
 *   - pyannote diarizer (`FusedDiarizer`)       → segments real speech
 *   - `VoiceAttributionPipeline`                → enroll → bind entity → re-match
 *
 * Single fused engine: the speaker encoder + diarizer run EXCLUSIVELY through
 * the one fused `libelizainference` handle (`eliza_inference_speaker_*` /
 * `_diariz_*`). There is no standalone `libvoice_classifier` runtime.
 *
 * The GGUFs are NOT in the repo (they are produced by the in-tree onnx→gguf
 * converters under packages/native/plugins/<lib>/scripts/). Point this at a
 * directory holding them; the fused lib resolves from $ELIZA_INFERENCE_LIBRARY
 * (exact) or $ELIZA_INFERENCE_LIB_DIR.
 *
 * Usage:
 *   bun packages/app-core/scripts/voice-attribution-smoke.ts \
 *     --models /path/to/dir/with/{silero-vad-v5,wespeaker-resnet34-lm,pyannote-segmentation-3.0}.gguf
 *   ELIZA_VOICE_REAL_MODEL_DIR=/path/to/models bun packages/app-core/scripts/voice-attribution-smoke.ts
 *
 * Exit 0 on pass OR when models / the fused lib are absent (skipped). Pass
 * `--require-real` (or set `ELIZA_VOICE_REAL_REQUIRE=1`) in provisioned CI to
 * convert any skip into a hard failure; the real matrix must produce evidence,
 * not a green skip.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { buildVoiceTurnSignal } from "../../../packages/shared/src/voice/respond-gate.ts";
import { handleLiveVoiceAttribution } from "../../../plugins/plugin-local-inference/src/runtime/voice-entity-binding.ts";
import { resolveFusedLibraryPath } from "../../../plugins/plugin-local-inference/src/services/desktop-fused-ffi-backend-runtime.ts";
import {
  AudioFrameConsumer,
  type AudioFrameEvent,
} from "../../../plugins/plugin-local-inference/src/services/voice/audio-frame-consumer.ts";
import { loadElizaInferenceFfi } from "../../../plugins/plugin-local-inference/src/services/voice/ffi-bindings.ts";
import { VoiceProfileStore } from "../../../plugins/plugin-local-inference/src/services/voice/profile-store.ts";
import { VoiceAttributionPipeline } from "../../../plugins/plugin-local-inference/src/services/voice/speaker/attribution-pipeline.ts";
import { FusedDiarizer } from "../../../plugins/plugin-local-inference/src/services/voice/speaker/diarizer-fused.ts";
import { FusedSpeakerEncoder } from "../../../plugins/plugin-local-inference/src/services/voice/speaker/encoder-fused.ts";
import {
  GgmlSileroVad,
  VadDetector,
} from "../../../plugins/plugin-local-inference/src/services/voice/vad.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const WAV = path.join(
  REPO_ROOT,
  "plugins/plugin-local-inference/native/audio-fixtures/freeman.wav",
);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const REQUIRE_REAL =
  process.argv.includes("--require-real") ||
  process.env.ELIZA_VOICE_REAL_REQUIRE?.trim() === "1";

function skip(message: string): never {
  const prefix = REQUIRE_REAL ? "FAIL" : "SKIP";
  console.log(`[voice-attribution-smoke] ${prefix} — ${message}`);
  process.exit(REQUIRE_REAL ? 1 : 0);
}

const modelsDir =
  arg("--models") ??
  process.env.ELIZA_VOICE_REAL_MODEL_DIR?.trim() ??
  "/tmp/voice-models";
function firstExisting(...parts: string[]): string | null {
  for (const part of parts) {
    const p = path.isAbsolute(part) ? part : path.join(modelsDir, part);
    if (existsSync(p)) return p;
  }
  return null;
}
const M = {
  vad: firstExisting(
    "silero-vad-v5.1.2.ggml.bin",
    "silero-vad-v5.gguf",
    "vad/silero-vad-v5.1.2.ggml.bin",
    "vad/silero-vad-v5.gguf",
    "voice/vad/silero-vad-v5.1.2.ggml.bin",
    "bundles/2b/vad/silero-vad-v5.gguf",
  ),
  enc: firstExisting(
    "wespeaker-resnet34-lm.gguf",
    "speaker/wespeaker-resnet34-lm.gguf",
    "speaker-encoder/wespeaker-resnet34-lm.gguf",
    "voice/speaker-encoder/wespeaker-resnet34-lm.gguf",
  ),
  dia: firstExisting(
    // epoch-2 IFGO bake first (#11377) — the IFGO fused reader rejects the
    // legacy epoch-less IOFC artifact below.
    "pyannote-segmentation-3.0-ifgo-epoch2.gguf",
    "diariz/pyannote-segmentation-3.0-ifgo-epoch2.gguf",
    "diarizer/pyannote-segmentation-3.0-ifgo-epoch2.gguf",
    "voice/diarizer/pyannote-segmentation-3.0-ifgo-epoch2.gguf",
    "pyannote-segmentation-3.0.gguf",
    "diariz/pyannote-segmentation-3.0.gguf",
    "diarizer/pyannote-segmentation-3.0.gguf",
    "voice/diarizer/pyannote-segmentation-3.0.gguf",
  ),
};

if (!M.vad || !M.enc || !M.dia) {
  skip(
    `GGUF models not found under ${modelsDir}.\n` +
      "  Expected Silero VAD, WeSpeaker, and pyannote assets; pass --models <dir> or set ELIZA_VOICE_REAL_MODEL_DIR.",
  );
}

function stageVoiceBundle(models: { vad: string; enc: string; dia: string }): {
  root: string;
  vad: string;
  enc: string;
  dia: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "voice-model-bundle-"));
  const out = {
    root,
    vad: path.join(root, "vad", path.basename(models.vad)),
    enc: path.join(root, "speaker", "wespeaker-resnet34-lm.gguf"),
    dia: path.join(root, "diariz", "pyannote-segmentation-3.0.gguf"),
  };
  mkdirSync(path.dirname(out.vad), { recursive: true });
  mkdirSync(path.dirname(out.enc), { recursive: true });
  mkdirSync(path.dirname(out.dia), { recursive: true });
  copyFileSync(models.vad, out.vad);
  copyFileSync(models.enc, out.enc);
  copyFileSync(models.dia, out.dia);
  return out;
}

const BUNDLE = stageVoiceBundle(M as { vad: string; enc: string; dia: string });

// Resolve the fused libelizainference. The speaker encoder + diarizer run
// EXCLUSIVELY through it (the `eliza_inference_speaker_*` / `_diariz_*` ABI off
// one handle); there is no standalone runtime to fall back to.
const FUSED_LIB = resolveFusedLibraryPath(modelsDir, process.env);
if (!FUSED_LIB) {
  skip(
    "fused libelizainference not found.\n" +
      "  Set $ELIZA_INFERENCE_LIBRARY (exact) or $ELIZA_INFERENCE_LIB_DIR, or build it via packages/app-core/scripts/build-llama-cpp-mtp.mjs.",
  );
}
const FFI = loadElizaInferenceFfi(FUSED_LIB);
const FFI_CTX = FFI.create(BUNDLE.root);
if (!FusedSpeakerEncoder.isSupported(FFI)) {
  skip(
    `the fused lib at ${FUSED_LIB} (ABI v${FFI.libraryAbiVersion}) lacks the speaker ABI (eliza_inference_speaker_supported() == 0). Rebuild with the WeSpeaker forward graph linked in.`,
  );
}
if (!FusedDiarizer.isSupported(FFI)) {
  skip(
    `the fused lib at ${FUSED_LIB} (ABI v${FFI.libraryAbiVersion}) lacks the diarizer ABI (eliza_inference_diariz_supported() == 0). Rebuild with the pyannote forward graph linked in.`,
  );
}
const FUSED_VAD_AVAILABLE = GgmlSileroVad.isSupported(FFI);

/** Decode a PCM16 mono WAV → { pcm, sampleRate }. */
function decodeWavMono(file: string): {
  pcm: Float32Array;
  sampleRate: number;
} {
  const b = readFileSync(file);
  if (
    b.toString("ascii", 0, 4) !== "RIFF" ||
    b.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("not a RIFF/WAVE file");
  }
  let off = 12;
  let sampleRate = 16_000;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "fmt ") sampleRate = b.readUInt32LE(off + 12);
    if (id === "data") {
      const n = size >> 1;
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++)
        pcm[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return { pcm, sampleRate };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}

/** Linear resample to 16 kHz (the rate every voice model is dimensioned for). */
function to16k(pcm: Float32Array, sr: number): Float32Array {
  if (sr === 16_000) return pcm;
  const n = Math.floor((pcm.length * 16_000) / sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * sr) / 16_000;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    out[i] = pcm[i0] + (pcm[i1] - pcm[i0]) * (x - i0);
  }
  return out;
}

let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(
    `${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!cond) failures++;
};
const cos = (x: Float32Array, y: Float32Array) => {
  let d = 0;
  for (let i = 0; i < x.length; i++) d += x[i] * y[i];
  return d;
};

const { pcm: raw, sampleRate } = decodeWavMono(WAV);
const pcm = to16k(raw, sampleRate);
console.log(
  `[voice-attribution-smoke] ${path.basename(WAV)} → ${pcm.length} samples @16k (${(pcm.length / 16_000).toFixed(1)}s)`,
);

// VAD — fused-only; the fused ffi + ctx are booted above, but the VAD-driven
// turn-segmentation stage runs through GgmlSileroVad on the same FFI context.
if (FUSED_VAD_AVAILABLE) {
  const vad = await GgmlSileroVad.load({ ffi: FFI, ctx: FFI_CTX });
  const silence = new Float32Array(vad.windowSamples);
  let speechMax = 0;
  for (
    let off = 0;
    off + vad.windowSamples <= Math.min(pcm.length, 16_000 * 4);
    off += vad.windowSamples
  ) {
    const p = await vad.process(pcm.subarray(off, off + vad.windowSamples));
    if (p > speechMax) speechMax = p;
  }
  vad.reset();
  let silenceMax = 0;
  for (let i = 0; i < 8; i += 1) {
    const p = await vad.process(silence);
    if (p > silenceMax) silenceMax = p;
  }
  vad.close();
  ok(
    "Silero VAD: real speech scores above silence",
    speechMax > silenceMax && speechMax > 0.2,
    `speechMax=${speechMax.toFixed(3)} silenceMax=${silenceMax.toFixed(3)}`,
  );
} else {
  if (REQUIRE_REAL) {
    ok(
      "Silero VAD: fused lib advertises eliza_inference_vad_* support",
      false,
      "fused libelizainference does not advertise eliza_inference_vad_* support",
    );
  } else {
    console.log(
      "[voice-attribution-smoke] SKIP VAD stage — fused libelizainference does not advertise eliza_inference_vad_* support.",
    );
  }
}

// Encoder
{
  const enc = await FusedSpeakerEncoder.load({
    ffi: FFI,
    ctx: FFI_CTX,
    ggufPath: M.enc,
  });
  const eA = await enc.encode(pcm.subarray(0, 16_000 * 8));
  const eA2 = await enc.encode(pcm.subarray(0, 16_000 * 8));
  const eB = await enc.encode(pcm.subarray(16_000 * 8, 16_000 * 16));
  let norm = 0;
  for (const v of eA) norm += v * v;
  ok(
    "WeSpeaker encoder: 256-d, unit-norm",
    eA.length === 256 && Math.abs(Math.sqrt(norm) - 1) < 0.05,
    `|emb|=${Math.sqrt(norm).toFixed(3)}`,
  );
  ok(
    "WeSpeaker encoder: deterministic",
    cos(eA, eA2) > 0.999,
    `cos=${cos(eA, eA2).toFixed(4)}`,
  );
  ok(
    "WeSpeaker encoder: same speaker (8s) self-similar > 0.78 match threshold",
    cos(eA, eB) > 0.78,
    `cos(A,B)=${cos(eA, eB).toFixed(3)}`,
  );
  const selfVoiceSimilarity = cos(eA, eA2);
  const selfVoiceSignal = buildVoiceTurnSignal("misheard synthetic echo", {
    agentSpeaking: true,
    selfVoiceSimilarity,
  });
  ok(
    "Live selfVoiceSimilarity cosine suppresses an agent-echo turn",
    selfVoiceSignal.agentShouldSpeak === false &&
      selfVoiceSignal.source === "client-ambient+self-voice",
    `selfVoiceSimilarity=${selfVoiceSimilarity.toFixed(4)} source=${selfVoiceSignal.source}`,
  );
  await enc.dispose();
}

// Diarizer
{
  const dia = await FusedDiarizer.load({
    ffi: FFI,
    ctx: FFI_CTX,
    ggufPath: M.dia,
  });
  const win = new Float32Array(16_000 * 5);
  win.set(pcm.subarray(0, Math.min(pcm.length, 16_000 * 5)));
  const out = await dia.diarizeWindow(win);
  ok(
    "pyannote diarizer segments real speech",
    out.speechMs > 0 && out.segments.length >= 1,
    `segments=${out.segments.length} speakers=${out.localSpeakerCount} speechMs=${Math.round(out.speechMs)}`,
  );
  await dia.dispose?.();
}

// Attribution pipeline: enroll → bind → re-match
{
  const encoder = await FusedSpeakerEncoder.load({
    ffi: FFI,
    ctx: FFI_CTX,
    ggufPath: M.enc,
  });
  const diarizer = await FusedDiarizer.load({
    ffi: FFI,
    ctx: FFI_CTX,
    ggufPath: M.dia,
  });
  const store = new VoiceProfileStore({
    rootDir: mkdtempSync(path.join(tmpdir(), "vp-")),
  });
  await store.init();
  const pipeline = new VoiceAttributionPipeline({
    encoder,
    diarizer,
    profileStore: store,
  });

  const r1 = await pipeline.attribute({
    turnId: "t1",
    pcm: pcm.subarray(0, 16_000 * 8),
    startedAtMs: 0,
    endedAtMs: 8000,
  });
  ok(
    "Pipeline enrolls a new speaker (observation present, no entity yet)",
    r1.observation != null && r1.primarySpeaker?.entityId == null,
    `cluster=${r1.observation?.imprintClusterId}`,
  );

  const cluster = r1.observation?.imprintClusterId;
  if (cluster) {
    const p = (await store.list()).find((x) => x.imprintClusterId === cluster);
    if (p)
      await store.bindEntity({
        profileId: p.profileId,
        entityId: "entity-speaker-a",
        label: "Speaker A",
      });
  }

  // Re-attribute an overlapping span of the same speaker → should carry the bound entity.
  const r2 = await pipeline.attribute({
    turnId: "t2",
    pcm: pcm.subarray(0, 16_000 * 8),
    startedAtMs: 8000,
    endedAtMs: 16000,
  });
  ok(
    "Pipeline re-matches the same speaker and carries the bound entityId",
    r2.primarySpeaker?.entityId === "entity-speaker-a",
    `entity=${r2.primarySpeaker?.entityId ?? "null"} conf=${r2.primarySpeaker?.confidence?.toFixed(3)}`,
  );

  // ── handleLiveVoiceAttribution against the REAL attribution output ──────────
  // The runtime helper folds the diarization decision into the turn's
  // voiceTurnSignal (the gate the server reads). Same real `r2` output, two
  // gating contexts:
  //   (1) the matched entity IS the owner            → agent speaks
  //   (2) the matched entity is a CONFIDENT bystander → suppressed (no wake word)
  const emitted: Array<Record<string, unknown>> = [];
  const fakeRuntime = {
    emitEvent: async (_type: unknown, payload: Record<string, unknown>) => {
      emitted.push(payload);
    },
  } as never;

  // HONEST real-model behavior: a freshly-enrolled profile caps re-match
  // confidence well below the 0.7 bystander-suppress threshold (the profile's
  // confidence grows with sampleCount via Welford). So on a SINGLE turn the
  // confidence-based bystander gate does NOT fire — the agent fails OPEN
  // (responds) rather than risk silencing the owner on an uncertain match. The
  // gate becomes active only once a speaker's profile has refined over many
  // turns / an explicit enrollment flow. The suppression LOGIC at high
  // confidence is proven below (and in voice-entity-binding.test.ts).
  const conf = r2.primarySpeaker?.confidence ?? 0;
  ok(
    "Real fresh-profile re-match confidence is modest (< 0.7 → fail-open, conservative)",
    conf > 0 && conf < 0.7,
    `conf=${conf.toFixed(3)} (bystander gate stays open until the profile refines)`,
  );

  const ownerSignal = await handleLiveVoiceAttribution(fakeRuntime, r2, {
    ownerEntityId: "entity-speaker-a",
    knownSpeakerEntityIds: ["entity-speaker-a"],
    endOfTurnProbability: 0.95,
  });
  ok(
    "handleLiveVoiceAttribution: enrolled OWNER turn → agent speaks",
    ownerSignal.agentShouldSpeak === true &&
      ownerSignal.nextSpeaker === "agent",
    `agentShouldSpeak=${ownerSignal.agentShouldSpeak} next=${ownerSignal.nextSpeaker}`,
  );
  ok(
    "handleLiveVoiceAttribution: stamps voiceTurnSignal onto the turn metadata",
    (r2.turn.metadata as { voiceTurnSignal?: unknown } | undefined)
      ?.voiceTurnSignal === ownerSignal,
  );
  ok(
    "handleLiveVoiceAttribution: emits VOICE_TURN_OBSERVED for the attributed turn",
    emitted.length === 1 && emitted[0]?.matchedEntityId === "entity-speaker-a",
    `emits=${emitted.length} matchedEntityId=${String(emitted[0]?.matchedEntityId)}`,
  );

  // Same real turn, but the speaker is NOT the owner/enrolled. At the real
  // fresh-profile confidence (~0.5) this is an UNCERTAIN attribution → the gate
  // fails OPEN (agent still responds). This is the safe single-turn default.
  const uncertainBystander = await handleLiveVoiceAttribution(fakeRuntime, r2, {
    ownerEntityId: "entity-someone-else",
    knownSpeakerEntityIds: ["entity-someone-else"], // speaker-a is NOT enrolled
    endOfTurnProbability: 0.95,
  });
  ok(
    "handleLiveVoiceAttribution: UNCERTAIN bystander (real ~0.5 conf) → fails open (agent speaks)",
    uncertainBystander.agentShouldSpeak === true,
    `agentShouldSpeak=${uncertainBystander.agentShouldSpeak} conf=${conf.toFixed(3)}`,
  );

  // A REFINED profile (many turns) pushes match confidence past 0.7. Simulate
  // that by bumping the real output's confidence, and prove the bystander gate
  // then fires: a confident non-owner with no wake word is suppressed.
  const refined = {
    ...r2,
    primarySpeaker: r2.primarySpeaker
      ? { ...r2.primarySpeaker, confidence: 0.9 }
      : r2.primarySpeaker,
    observation: r2.observation
      ? { ...r2.observation, confidence: 0.9 }
      : r2.observation,
    turn: { ...r2.turn, metadata: { ...r2.turn.metadata } },
  } as typeof r2;
  const bystanderSignal = await handleLiveVoiceAttribution(
    fakeRuntime,
    refined,
    {
      ownerEntityId: "entity-someone-else",
      knownSpeakerEntityIds: ["entity-someone-else"],
      endOfTurnProbability: 0.95, // EOT says complete; bystander gate must win
    },
  );
  ok(
    "handleLiveVoiceAttribution: CONFIDENT bystander (refined profile, no wake word) → suppressed",
    bystanderSignal.agentShouldSpeak === false &&
      bystanderSignal.nextSpeaker === "user",
    `agentShouldSpeak=${bystanderSignal.agentShouldSpeak} next=${bystanderSignal.nextSpeaker}`,
  );

  const wakeSignal = await handleLiveVoiceAttribution(fakeRuntime, refined, {
    ownerEntityId: "entity-someone-else",
    knownSpeakerEntityIds: ["entity-someone-else"],
    endOfTurnProbability: 0.95,
    wakeWordActive: true, // explicit address overrides bystander doubt
  });
  ok(
    "handleLiveVoiceAttribution: wake word overrides bystander suppression",
    wakeSignal.agentShouldSpeak === true && wakeSignal.nextSpeaker === "agent",
    `agentShouldSpeak=${wakeSignal.agentShouldSpeak} next=${wakeSignal.nextSpeaker}`,
  );

  await encoder.dispose();
  await diarizer.dispose?.();
}

// ── AudioFrameConsumer: Android `audioFrame` stream → live segmented turns ─────
// Chunk freeman.wav into 20 ms base64 LE-s16 `audioFrame`-shaped frames (exactly
// what plugin-native-talkmode emits on Android), feed them through the
// platform-agnostic AudioFrameConsumer wired to the REAL ggml VAD/encoder/
// diarizer, and assert it segments ≥ 1 turn, attributes a speaker, and emits a
// voiceTurnSignal — the full on-device path minus the device.
//
// Gated on FUSED_VAD_AVAILABLE: AudioFrameConsumer needs a real VAD to segment
// turns, and the sole VAD runtime is now the fused libelizainference engine,
// which this standalone-model harness now boots from the same FFI context.
if (FUSED_VAD_AVAILABLE) {
  /** Encode a Float32 [-1,1] window → base64 LE-s16, as the native side does. */
  function encodeFrame(
    pcm: Float32Array,
    timestamp: number,
    frameIndex: number,
  ): AudioFrameEvent {
    const buf = Buffer.alloc(pcm.length * 2);
    let sumSq = 0;
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      sumSq += s * s;
      buf.writeInt16LE(Math.round(s * 32767), i * 2);
    }
    return {
      pcm16: buf.toString("base64"),
      sampleRate: 16_000,
      channels: 1,
      samples: pcm.length,
      rms: Math.sqrt(sumSq / Math.max(1, pcm.length)),
      timestamp,
      frameIndex,
    };
  }

  const fusedVad = await GgmlSileroVad.load({ ffi: FFI, ctx: FFI_CTX });
  const detector = new VadDetector(fusedVad, {
    onsetThreshold: 0.5,
    pauseHangoverMs: 120,
    endHangoverMs: 500,
    minSpeechMs: 250,
  });
  const encoder = await FusedSpeakerEncoder.load({
    ffi: FFI,
    ctx: FFI_CTX,
    ggufPath: M.enc,
  });
  const diarizer = await FusedDiarizer.load({
    ffi: FFI,
    ctx: FFI_CTX,
    ggufPath: M.dia,
  });
  const store = new VoiceProfileStore({
    rootDir: mkdtempSync(path.join(tmpdir(), "vp-consumer-")),
  });
  await store.init();
  const pipeline = new VoiceAttributionPipeline({
    encoder,
    diarizer,
    profileStore: store,
  });
  const emitted: Array<Record<string, unknown>> = [];
  const runtime = {
    emitEvent: async (_type: unknown, payload: Record<string, unknown>) => {
      emitted.push(payload);
    },
  };
  const consumer = new AudioFrameConsumer(
    { vad: detector, pipeline, runtime },
    {
      source: { kind: "device", deviceId: "freeman-wav" },
      attributionOptions: {
        ownerEntityId: "entity-owner",
        knownSpeakerEntityIds: ["entity-owner"],
        endOfTurnProbability: 0.95,
      },
      preRollSeconds: 0.3,
      maxTurnSeconds: 30,
    },
  );

  const turns: Array<{
    turnId: string;
    samples: number;
    hasSpeaker: boolean;
    agentShouldSpeak: boolean | null;
  }> = [];
  consumer.onTurn((t) => {
    turns.push({
      turnId: t.turnId,
      samples: t.samples,
      hasSpeaker: t.output.primarySpeaker != null,
      agentShouldSpeak: t.signal.agentShouldSpeak,
    });
  });

  // Stream the WAV as 20 ms (320-sample) frames on a 20 ms mic clock.
  const FRAME_SAMPLES = 320;
  let micClockMs = 0;
  let frameIndex = 0;
  for (let off = 0; off + FRAME_SAMPLES <= pcm.length; off += FRAME_SAMPLES) {
    const frame = encodeFrame(
      pcm.subarray(off, off + FRAME_SAMPLES),
      micClockMs,
      frameIndex++,
    );
    await consumer.onAudioFrame(frame);
    micClockMs += 20;
  }
  await consumer.flush();

  ok(
    "AudioFrameConsumer segments ≥ 1 turn from the audioFrame stream",
    turns.length >= 1,
    `turns=${turns.length} frames=${frameIndex}`,
  );
  ok(
    "AudioFrameConsumer buffers real turn PCM and attributes a speaker",
    turns.some((t) => t.samples > 16_000 && t.hasSpeaker),
    `firstTurnSamples=${turns[0]?.samples ?? 0} hasSpeaker=${turns[0]?.hasSpeaker}`,
  );
  ok(
    "AudioFrameConsumer emits VOICE_TURN_OBSERVED for an attributed turn",
    emitted.length >= 1,
    `emits=${emitted.length}`,
  );
  ok(
    "AudioFrameConsumer produces a voiceTurnSignal per turn (fail-open on a fresh profile)",
    turns.every((t) => t.agentShouldSpeak !== false),
    `agentShouldSpeak=[${turns.map((t) => String(t.agentShouldSpeak)).join(",")}]`,
  );
  ok(
    "AudioFrameConsumer dropped no frames during the stream",
    consumer.droppedFrames === 0,
    `dropped=${consumer.droppedFrames}`,
  );

  await consumer.close();
  fusedVad.close();
  await encoder.dispose();
  await diarizer.dispose?.();
}

console.log(
  failures === 0
    ? "\n[voice-attribution-smoke] ALL PASS ✅"
    : `\n[voice-attribution-smoke] ${failures} FAILURE(S) ❌`,
);
process.exit(failures === 0 ? 0 : 1);
