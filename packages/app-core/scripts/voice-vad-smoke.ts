#!/usr/bin/env bun
/**
 * VAD / wake-word ONNX smoke harness.
 *
 * Feeds a `silence + synthesized-speech + silence` PCM fixture through the
 * real Silero VAD ONNX model (`SileroVad` + `VadDetector`) and asserts it
 * detects exactly one speech segment whose boundaries land inside the
 * voiced region — i.e. the leading/trailing silence is gated out. If the
 * openWakeWord graphs resolve, it also runs ~2 s of silence through the
 * `OpenWakeWordModel` streaming pipeline and asserts P(wake) stays low.
 *
 * Usage:
 *   # use the bundled model under <state-dir>/local-inference/vad/silero-vad-int8.onnx
 *   bun packages/app-core/scripts/voice-vad-smoke.ts
 *   # or point at an explicit model:
 *   ELIZA_VAD_MODEL_PATH=/path/to/silero-vad-int8.onnx bun packages/app-core/scripts/voice-vad-smoke.ts
 *   # or a staged bundle dir (expects vad/silero-vad-int8.onnx, optionally wake/*.onnx):
 *   bun packages/app-core/scripts/voice-vad-smoke.ts --bundle /path/to/eliza-1-9b
 *
 * Exit code: 0 on pass, 1 on any assertion failure or unavailable runtime.
 */

import process from "node:process";
import { makeSpeechWithSilenceFixture } from "../src/services/local-inference/voice/__test-helpers__/synthetic-speech";
import type { VadEvent } from "../src/services/local-inference/voice/types";
import {
  createSileroVadDetector,
  resolveSileroVadPath,
  SileroVad,
  VadUnavailableError,
} from "../src/services/local-inference/voice/vad";
import {
  loadBundledWakeWordModel,
  resolveWakeWordModel,
  WakeWordUnavailableError,
} from "../src/services/local-inference/voice/wake-word";

const SR = 16_000;
const WINDOW = 512;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(`[voice-vad-smoke] FAIL: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const bundleRoot = arg("--bundle");
  const modelPath = process.env.ELIZA_VAD_MODEL_PATH;
  const resolved = resolveSileroVadPath({ modelPath, bundleRoot });
  if (!resolved) {
    fail(
      "no Silero VAD model found. Stage vad/silero-vad-int8.onnx into a bundle (--bundle) or set ELIZA_VAD_MODEL_PATH. See packages/training/scripts/manifest/stage_eliza1_bundle_assets.py.",
    );
  }
  console.log(`[voice-vad-smoke] Silero VAD model: ${resolved}`);

  let vad: SileroVad;
  try {
    vad = await SileroVad.load({ modelPath: resolved });
  } catch (err) {
    if (err instanceof VadUnavailableError) {
      fail(`Silero VAD unavailable (${err.code}): ${err.message}`);
    }
    throw err;
  }
  if (vad.windowSamples !== WINDOW)
    fail(`unexpected window size ${vad.windowSamples}`);

  // Sanity: pure silence reads low.
  vad.reset();
  const pSilence = await vad.process(new Float32Array(WINDOW));
  console.log(`[voice-vad-smoke] P(speech | silence) = ${pSilence.toFixed(3)}`);
  if (pSilence >= 0.3) fail(`silence read too high (${pSilence})`);

  // Build the fixture and run it through the full VadDetector.
  const fx = makeSpeechWithSilenceFixture({
    sampleRate: SR,
    leadSilenceSec: 0.6,
    speechSec: 1.2,
    tailSilenceSec: 0.6,
  });
  const speechStartMs = (fx.speechStartSample / SR) * 1000;
  const speechEndMs = (fx.speechEndSample / SR) * 1000;
  const det = await createSileroVadDetector({
    modelPath: resolved,
    config: {
      onsetThreshold: 0.5,
      pauseHangoverMs: 220,
      endHangoverMs: 500,
      minSpeechMs: 150,
    },
  });
  const events: VadEvent[] = [];
  det.onVadEvent((e) => events.push(e));
  for (let i = 0; (i + 1) * WINDOW <= fx.pcm.length; i++) {
    await det.pushFrame({
      pcm: fx.pcm.slice(i * WINDOW, (i + 1) * WINDOW),
      sampleRate: SR,
      timestampMs: (i * WINDOW * 1000) / SR,
    });
  }
  await det.flush();
  const starts = events.filter((e) => e.type === "speech-start");
  const ends = events.filter((e) => e.type === "speech-end");
  console.log(
    `[voice-vad-smoke] events: ${events.map((e) => e.type).join(", ")}`,
  );
  if (starts.length !== 1)
    fail(`expected 1 speech-start, got ${starts.length}`);
  if (ends.length !== 1) fail(`expected 1 speech-end, got ${ends.length}`);
  const start = starts[0];
  if (start.type !== "speech-start") fail("unreachable");
  if (
    start.timestampMs <= speechStartMs - 100 ||
    start.timestampMs >= speechEndMs
  ) {
    fail(
      `speech-start at ${start.timestampMs.toFixed(0)} ms is outside the voiced region [${speechStartMs.toFixed(0)}, ${speechEndMs.toFixed(0)}] — silence not gated out`,
    );
  }
  console.log(
    `[voice-vad-smoke] PASS: one speech segment, onset at ${start.timestampMs.toFixed(0)} ms (voiced region ${speechStartMs.toFixed(0)}-${speechEndMs.toFixed(0)} ms)`,
  );

  // Optional wake-word smoke.
  const wwPaths = resolveWakeWordModel({ bundleRoot });
  if (!wwPaths) {
    console.log(
      "[voice-vad-smoke] wake-word: no bundled openWakeWord graphs (optional asset) — skipping.",
    );
    return;
  }
  console.log(
    `[voice-vad-smoke] wake-word graphs: ${wwPaths.melspectrogram} / ${wwPaths.embedding} / ${wwPaths.head}`,
  );
  let maxWake = 0;
  try {
    const model = await loadBundledWakeWordModel({ bundleRoot });
    if (!model) fail("resolveWakeWordModel succeeded but load returned null");
    for (let i = 0; i < Math.floor((2 * SR) / model.frameSamples); i++) {
      const p = await model.scoreFrame(new Float32Array(model.frameSamples));
      maxWake = Math.max(maxWake, p);
    }
  } catch (err) {
    if (err instanceof WakeWordUnavailableError) {
      fail(`wake-word unavailable (${err.code}): ${err.message}`);
    }
    throw err;
  }
  console.log(
    `[voice-vad-smoke] max P(wake | silence) = ${maxWake.toFixed(4)}`,
  );
  if (maxWake >= 0.3) fail(`wake-word read too high on silence (${maxWake})`);
  console.log("[voice-vad-smoke] PASS: wake-word stayed quiet on silence.");
}

main().catch((err) => {
  console.error("[voice-vad-smoke] error:", err);
  process.exit(1);
});
