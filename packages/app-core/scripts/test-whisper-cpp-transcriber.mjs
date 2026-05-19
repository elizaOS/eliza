#!/usr/bin/env bun
/**
 * End-to-end smoke test for the whisper.cpp ASR adapter inside Milady's
 * transcriber chain. Loads a WAV/FLAC, drives it through
 * `createStreamingTranscriber({ prefer: "whisper-cpp" })`, waits for the
 * final transcript, prints timing.
 *
 * Replaces the previous OpenVINO-Whisper smoke. The OpenVINO Python worker
 * path has been removed; the whisper.cpp path loads
 * `libwhisper_eliza_adapter.{so,dylib,dll}` via bun:ffi and links against
 * `libwhisper.{so,dylib,dll}` produced by
 * `plugins/plugin-local-inference/native/build-whisper.mjs`.
 *
 * Usage:
 *   bun packages/app-core/scripts/test-whisper-cpp-transcriber.mjs \
 *     [path/to/audio.wav|flac]   (default: ~/.local/voice-bench/sample.flac)
 *
 * Env knobs:
 *   ELIZA_WHISPER_LIBRARY     path to libwhisper_eliza_adapter
 *   ELIZA_WHISPER_MODEL       path to ggml-*.bin whisper model
 *   ELIZA_WHISPER_MODEL_NAME  model name resolver hint (default: base.en)
 *   ELIZA_WHISPER_LANGUAGE    decode language (default: en)
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const audioPath =
  process.argv[2] ||
  path.join(os.homedir(), ".local", "voice-bench", "sample.flac");

async function decodeToPcm16k(file) {
  // Minimal WAV-only decoder. For FLAC we'd need ffmpeg / sox; the smoke
  // bench script is best-effort and supports the canonical PCM16 mono 16k
  // WAV the OpenVINO smoke produced.
  if (file.endsWith(".wav")) {
    return decodeWav16k(readFileSync(file));
  }
  // Fall back to ffmpeg-on-PATH for everything else.
  return new Promise((resolve, reject) => {
    const args = [
      "-loglevel",
      "error",
      "-i",
      file,
      "-f",
      "f32le",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-",
    ];
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "inherit"] });
    const chunks = [];
    proc.stdout.on("data", (c) => chunks.push(c));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code} for ${file}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      resolve(
        new Float32Array(
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        ),
      );
    });
  });
}

function decodeWav16k(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Minimal RIFF/WAVE parse for PCM16 mono.
  if (view.getUint32(0, false) !== 0x52494646)
    throw new Error("not a RIFF file");
  if (view.getUint32(8, false) !== 0x57415645)
    throw new Error("not a WAVE file");
  let cursor = 12;
  let sampleRate = 0;
  let numChannels = 0;
  let bitsPerSample = 0;
  let dataOff = 0;
  let dataLen = 0;
  while (cursor + 8 <= bytes.byteLength) {
    const id = view.getUint32(cursor, false);
    const size = view.getUint32(cursor + 4, true);
    if (id === 0x666d7420 /* "fmt " */) {
      numChannels = view.getUint16(cursor + 10, true);
      sampleRate = view.getUint32(cursor + 12, true);
      bitsPerSample = view.getUint16(cursor + 22, true);
    } else if (id === 0x64617461 /* "data" */) {
      dataOff = cursor + 8;
      dataLen = size;
      break;
    }
    cursor += 8 + size + (size & 1);
  }
  if (bitsPerSample !== 16 || numChannels !== 1)
    throw new Error(
      `unsupported WAV format (channels=${numChannels}, bps=${bitsPerSample})`,
    );
  const nSamples = dataLen / 2;
  const out = new Float32Array(nSamples);
  for (let i = 0; i < nSamples; i++) {
    out[i] = view.getInt16(dataOff + i * 2, true) / 32768;
  }
  // Linear resample to 16 kHz if needed (whisper.cpp expects 16 kHz mono).
  if (sampleRate !== 16000) {
    const ratio = 16000 / sampleRate;
    const outLen = Math.max(1, Math.round(out.length * ratio));
    const resampled = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcPos = i / ratio;
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(i0 + 1, out.length - 1);
      const frac = srcPos - i0;
      resampled[i] = out[i0] * (1 - frac) + out[i1] * frac;
    }
    return resampled;
  }
  return out;
}

async function main() {
  const { createStreamingTranscriber } = await import(
    "../../../plugins/plugin-local-inference/src/services/voice/transcriber.ts"
  );
  const { resolveWhisperCppRuntime } = await import(
    "../../../plugins/plugin-local-inference/src/services/voice/whisper-cpp-asr.ts"
  );

  const runtime = resolveWhisperCppRuntime();
  console.log("[runtime]", runtime ?? "NOT RESOLVED");
  if (!runtime) {
    console.error(
      "whisper.cpp runtime not resolvable — set ELIZA_WHISPER_LIBRARY / ELIZA_WHISPER_MODEL, or run `node plugins/plugin-local-inference/native/build-whisper.mjs` + `bash packages/app-core/platforms/electrobun/scripts/ensure-whisper-gguf.sh base.en`",
    );
    process.exit(2);
  }
  if (!existsSync(audioPath)) {
    console.error(`audio file not found: ${audioPath}`);
    process.exit(2);
  }

  console.log(`[audio] loading ${audioPath}`);
  const t0 = performance.now();
  const pcm = await decodeToPcm16k(audioPath);
  const tLoad = performance.now() - t0;
  console.log(
    `[audio] ${pcm.length} samples (${(pcm.length / 16000).toFixed(2)}s) loaded in ${tLoad.toFixed(0)} ms`,
  );

  const transcriber = createStreamingTranscriber({
    prefer: "whisper-cpp",
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

  const sampleRate = 16000;
  const frameSamples = Math.round(0.03 * sampleRate); // 480 samples = 30 ms
  const frameCount = Math.ceil(pcm.length / frameSamples);
  console.log(
    `[feed] starting — ${frameCount} frames of ${frameSamples} samples`,
  );

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
  console.log(
    `[feed] done in ${(tFeedEnd - tFeedStart).toFixed(0)} ms; flushing…`,
  );

  const final = await transcriber.flush();
  const tFinal = performance.now();
  console.log(
    `[final] (${(tFinal - tFeedStart).toFixed(0)} ms total) ${final.partial}`,
  );
  console.log("");
  console.log("=== TIMINGS ===");
  console.log(`audio duration:       ${(pcm.length / 16000).toFixed(2)} s`);
  console.log(
    `first partial at:     ${firstPartialAt ? `${(firstPartialAt - tFeedStart).toFixed(0)} ms` : "(none emitted)"}`,
  );
  console.log(`final transcript at:  ${(tFinal - tFeedStart).toFixed(0)} ms`);
  console.log(
    `realtime factor:      ${(pcm.length / 16000 / ((tFinal - tFeedStart) / 1000)).toFixed(1)}× (>1 = faster than realtime)`,
  );

  transcriber.dispose();
}

main().catch((err) => {
  console.error("FAIL:", err.message ?? err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
