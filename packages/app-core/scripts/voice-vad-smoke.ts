#!/usr/bin/env bun
/**
 * VAD / wake-word smoke harness.
 *
 * Feeds a `silence + synthesized-speech + silence` PCM fixture through the
 * real Silero VAD ONNX model (`SileroVad` + `VadDetector`) and asserts it
 * detects exactly one speech segment whose boundaries land inside the
 * voiced region — i.e. the leading/trailing silence is gated out.
 *
 * The wake-word portion of this smoke ran through `OpenWakeWordModel`
 * (ONNX) until the GGUF port (`packages/plugin-local-inference/native/
 * libelizainference` ABI v5, `eliza_inference_wakeword_*`). The native
 * runtime requires a loaded FFI context, which this lightweight script
 * does not bring up — wake-word smoke now lives in
 * `packages/inference/voice-bench/` against the fused library and the
 * bundled `wake/openwakeword.gguf`. This script still resolves the
 * bundled GGUF to report its presence, then exits the wake-word section.
 *
 * Usage:
 *   # use the bundled model under <state-dir>/local-inference/vad/silero-vad-int8.onnx
 *   bun packages/app-core/scripts/voice-vad-smoke.ts
 *   # or point at an explicit model:
 *   ELIZA_VAD_MODEL_PATH=/path/to/silero-vad-int8.onnx bun packages/app-core/scripts/voice-vad-smoke.ts
 *   # or a staged bundle dir (expects vad/silero-vad-int8.onnx, optionally wake/openwakeword.gguf):
 *   bun packages/app-core/scripts/voice-vad-smoke.ts --bundle /path/to/eliza-1-9b
 *
 * Exit code: 0 on pass, 1 on any assertion failure or unavailable runtime.
 */

import process from "node:process";

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
  const { makeSpeechWithSilenceFixture } = await import(
    "../../../plugins/plugin-local-inference/src/services/voice/__test-helpers__/synthetic-speech"
  );
  const {
    createSileroVadDetector,
    resolveSileroVadPath,
    SileroVad,
    VadUnavailableError,
  } = await import(
    "../../../plugins/plugin-local-inference/src/services/voice/vad"
  );
  const { resolveWakeWordModel } = await import(
    "../../../plugins/plugin-local-inference/src/services/voice/wake-word"
  );
  const bundleRoot = arg("--bundle");
  const modelPath = process.env.ELIZA_VAD_MODEL_PATH;
  const resolved = resolveSileroVadPath({ modelPath, bundleRoot });
  if (!resolved) {
    fail(
      "no Silero VAD model found. Stage vad/silero-vad-int8.onnx into a bundle (--bundle) or set ELIZA_VAD_MODEL_PATH. See packages/training/scripts/manifest/stage_eliza1_bundle_assets.py.",
    );
  }
  console.log(`[voice-vad-smoke] Silero VAD model: ${resolved}`);

  let vad: InstanceType<typeof SileroVad>;
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
  const events: import("../../../plugins/plugin-local-inference/src/services/voice/types").VadEvent[] =
    [];
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

  // Wake-word: report bundled GGUF presence only. Runtime inference is
  // covered by the fused-library smoke under packages/inference/voice-bench/
  // — this script doesn't bring up a libelizainference FFI context.
  const wwPaths = bundleRoot
    ? resolveWakeWordModel({ bundleRoot })
    : resolveWakeWordModel({});
  if (!wwPaths) {
    console.log(
      "[voice-vad-smoke] wake-word: no bundled openwakeword.gguf (optional asset) — skipping.",
    );
    return;
  }
  console.log(
    `[voice-vad-smoke] wake-word GGUF present: ${wwPaths.gguf} (head=${wwPaths.head}). Runtime inference smoke lives in packages/inference/voice-bench/.`,
  );
}

main().catch((err) => {
  console.error("[voice-vad-smoke] error:", err);
  process.exit(1);
});
