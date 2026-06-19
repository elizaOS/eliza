#!/usr/bin/env bun
/**
 * Speaker-attribution / diarization smoke harness (real GGUF models).
 *
 * Runs the full native voice-attribution stack against a real-speech WAV and
 * asserts each stage produces correct output:
 *   - Silero VAD (`SileroVadGgml`)            → detects speech windows
 *   - WeSpeaker encoder (`SpeakerEncoderGgml`) → 256-d unit-norm, deterministic
 *   - pyannote diarizer (`PyannoteDiarizer`)   → segments real speech
 *   - `VoiceAttributionPipeline`               → enroll → bind entity → re-match
 *
 * The GGUFs are NOT in the repo (they are produced by the in-tree onnx→gguf
 * converters under packages/native/plugins/<lib>/scripts/). Point this at a
 * directory holding them; the native .so libs resolve automatically from the
 * cmake build dirs (or $ELIZA_SILERO_VAD_LIB / $ELIZA_VOICE_CLASSIFIER_LIB).
 *
 * Usage:
 *   bun packages/app-core/scripts/voice-attribution-smoke.ts \
 *     --models /path/to/dir/with/{silero-vad-v5,wespeaker-resnet34-lm,pyannote-segmentation-3.0}.gguf
 *   ELIZA_VOICE_REAL_MODEL_DIR=/path/to/models bun packages/app-core/scripts/voice-attribution-smoke.ts
 *
 * Exit 0 on pass OR when models are absent (skipped); 1 on any assertion fail.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { handleLiveVoiceAttribution } from "../../../plugins/plugin-local-inference/src/runtime/voice-entity-binding.ts";
import { VoiceProfileStore } from "../../../plugins/plugin-local-inference/src/services/voice/profile-store.ts";
import { VoiceAttributionPipeline } from "../../../plugins/plugin-local-inference/src/services/voice/speaker/attribution-pipeline.ts";
import { PyannoteDiarizer } from "../../../plugins/plugin-local-inference/src/services/voice/speaker/diarizer.ts";
import { SpeakerEncoderGgmlImpl } from "../../../plugins/plugin-local-inference/src/services/voice/speaker/encoder-ggml.ts";
import { SileroVadGgml } from "../../../plugins/plugin-local-inference/src/services/voice/vad-ggml.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const WAV = path.join(
  REPO_ROOT,
  "plugins/plugin-local-inference/native/omnivoice.cpp/examples/freeman.wav",
);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const modelsDir =
  arg("--models") ??
  process.env.ELIZA_VOICE_REAL_MODEL_DIR?.trim() ??
  "/tmp/voice-models";
const M = {
  vad: path.join(modelsDir, "silero-vad-v5.gguf"),
  enc: path.join(modelsDir, "wespeaker-resnet34-lm.gguf"),
  dia: path.join(modelsDir, "pyannote-segmentation-3.0.gguf"),
};

if (!existsSync(M.vad) || !existsSync(M.enc) || !existsSync(M.dia)) {
  console.log(
    `[voice-attribution-smoke] SKIP — GGUF models not found under ${modelsDir}.\n` +
      "  Produce them with the converters in packages/native/plugins/<lib>/scripts/ and pass --models <dir>.",
  );
  process.exit(0);
}

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

// VAD
{
  const vad = await SileroVadGgml.load({ ggufPath: M.vad });
  let speech = 0;
  let max = 0;
  const total = Math.floor(pcm.length / 512);
  for (let i = 0; i < total; i++) {
    const p = await vad.process(pcm.subarray(i * 512, i * 512 + 512));
    if (p > 0.5) speech++;
    if (p > max) max = p;
  }
  ok(
    "Silero VAD detects speech in a real-speech clip",
    speech > 50 && max > 0.9,
    `${speech}/${total} windows>0.5, max=${max.toFixed(3)}`,
  );
}

// Encoder
{
  const enc = new SpeakerEncoderGgmlImpl({ ggufPath: M.enc });
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
  await enc.dispose();
}

// Diarizer
{
  const dia = await PyannoteDiarizer.load(M.dia);
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
  const encoder = new SpeakerEncoderGgmlImpl({ ggufPath: M.enc });
  const diarizer = await PyannoteDiarizer.load(M.dia);
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

console.log(
  failures === 0
    ? "\n[voice-attribution-smoke] ALL PASS ✅"
    : `\n[voice-attribution-smoke] ${failures} FAILURE(S) ❌`,
);
process.exit(failures === 0 ? 0 : 1);
