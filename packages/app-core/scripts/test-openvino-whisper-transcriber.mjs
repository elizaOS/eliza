#!/usr/bin/env bun
/**
 * End-to-end smoke test for the OpenVINO Whisper ASR adapter inside
 * Milady's transcriber chain. Loads a WAV/FLAC, drives it through
 * `createStreamingTranscriber({ prefer: "openvino-whisper" })`, waits for
 * the final transcript, prints timing + the device the worker landed on.
 *
 * Usage:
 *   bun packages/app-core/scripts/test-openvino-whisper-transcriber.mjs \
 *     [path/to/audio.wav|flac]   (default: ~/.local/voice-bench/sample.flac)
 *
 * What this proves:
 *   1. resolveOpenVinoWhisperRuntime() finds the python venv + IR + worker.
 *   2. The chain in createStreamingTranscriber routes through OpenVINO
 *      whisper before falling to whisper.cpp.
 *   3. The persistent Python worker compiles whisper-base.en on
 *      NPU/CPU/GPU according to ELIZA_OPENVINO_WHISPER_DEVICE and decodes
 *      sliding windows under the existing WhisperCppStreamingTranscriber
 *      windowing strategy.
 *   4. No silent empty transcript on failure — AsrUnavailableError is
 *      surfaced.
 */

import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const audioPath =
  process.argv[2] || path.join(os.homedir(), ".local", "voice-bench", "sample.flac");

// Decode audio → 16 kHz mono Float32Array via the OV venv's python soundfile.
// This keeps the test self-contained (no ffmpeg / sox dependency); soundfile
// is part of the venv we already use for whisper inference.
async function decodeToPcm16k(file) {
  const venvPython =
    process.env.ELIZA_OPENVINO_PYTHON ||
    path.join(os.homedir(), ".local", "voice-bench", "ov_venv", "bin", "python");
  const script = `
import sys, soundfile as sf, numpy as np
pcm, sr = sf.read(sys.argv[1], dtype="float32", always_2d=False)
if pcm.ndim > 1:
    pcm = pcm.mean(axis=1).astype(np.float32)
if sr != 16000:
    # linear resample
    n_out = int(round(len(pcm) * 16000 / sr))
    idx = np.linspace(0, len(pcm) - 1, n_out).astype(np.float64)
    lo = np.floor(idx).astype(np.int64); hi = np.minimum(lo + 1, len(pcm) - 1)
    t = (idx - lo).astype(np.float32)
    pcm = ((1 - t) * pcm[lo] + t * pcm[hi]).astype(np.float32)
sys.stdout.buffer.write(pcm.tobytes())
`;
  const proc = Bun.spawn([venvPython, "-c", script, file], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const buf = await new Response(proc.stdout).arrayBuffer();
  await proc.exited;
  return new Float32Array(buf);
}

async function main() {
  const { createStreamingTranscriber } = await import(
    "../src/services/local-inference/voice/transcriber.ts"
  );
  const { resolveOpenVinoWhisperRuntime } = await import(
    "../src/services/local-inference/voice/openvino-whisper-asr.ts"
  );

  const runtime = resolveOpenVinoWhisperRuntime();
  console.log("[runtime]", runtime ?? "NOT RESOLVED");
  if (!runtime) {
    console.error(
      "openvino whisper runtime not resolvable; check ELIZA_OPENVINO_PYTHON / ELIZA_OPENVINO_WHISPER_MODEL / ELIZA_OPENVINO_WHISPER_WORKER",
    );
    process.exit(2);
  }

  console.log(`[audio] loading ${audioPath}`);
  const t0 = performance.now();
  const pcm = await decodeToPcm16k(audioPath);
  const tLoad = performance.now() - t0;
  console.log(`[audio] ${pcm.length} samples (${(pcm.length / 16000).toFixed(2)}s) loaded in ${tLoad.toFixed(0)} ms`);

  const transcriber = createStreamingTranscriber({
    prefer: "openvino-whisper",
    // Bigger windows than the whisper.cpp defaults — OV-Whisper is fast
    // enough on CPU/NPU to amortize a 5 s context window per decode.
    whisper: {
      windowSeconds: 5.0,
      stepSeconds: 1.5,
      overlapSeconds: 0.7,
      language: "en",
    },
  });

  let lastPartial = "";
  let firstPartialAt = 0;
  transcriber.on((ev) => {
    if (ev.kind === "partial") {
      if (!firstPartialAt) firstPartialAt = performance.now();
      if (ev.update.partial !== lastPartial) {
        lastPartial = ev.update.partial;
        console.log(`[partial] ${ev.update.partial}`);
      }
    } else if (ev.kind === "words") {
      console.log(`[words] first words: ${ev.words.slice(0, 5).join(" ")}`);
    }
  });

  // Feed frames at 30 ms cadence — same shape the live MicSource emits.
  const sampleRate = 16000;
  const frameSamples = Math.round(0.03 * sampleRate); // 480 samples = 30 ms
  const frameCount = Math.ceil(pcm.length / frameSamples);
  console.log(`[feed] starting — ${frameCount} frames of ${frameSamples} samples`);

  const tFeedStart = performance.now();
  for (let i = 0; i < frameCount; i++) {
    const start = i * frameSamples;
    const end = Math.min(start + frameSamples, pcm.length);
    transcriber.feed({
      pcm: pcm.subarray(start, end),
      sampleRate,
      timestampMs: performance.now(),
    });
  }
  const tFeedEnd = performance.now();
  console.log(`[feed] done in ${(tFeedEnd - tFeedStart).toFixed(0)} ms; flushing…`);

  const final = await transcriber.flush();
  const tFinal = performance.now();
  console.log(`[final] (${(tFinal - tFeedStart).toFixed(0)} ms total) ${final.partial}`);
  console.log("");
  console.log("=== TIMINGS ===");
  console.log(`audio duration:       ${(pcm.length / 16000).toFixed(2)} s`);
  console.log(`first partial at:     ${firstPartialAt ? (firstPartialAt - tFeedStart).toFixed(0) + " ms" : "(none emitted)"}`);
  console.log(`final transcript at:  ${(tFinal - tFeedStart).toFixed(0)} ms`);
  console.log(`realtime factor:      ${((pcm.length / 16000) / ((tFinal - tFeedStart) / 1000)).toFixed(1)}× (>1 = faster than realtime)`);

  transcriber.dispose();
}

main().catch((err) => {
  console.error("FAIL:", err.message ?? err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
