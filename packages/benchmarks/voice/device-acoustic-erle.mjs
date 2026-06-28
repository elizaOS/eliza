/**
 * device-acoustic-erle.mjs — on-device acoustic ERLE for the live half-duplex
 * voice path (#9455), measured against the agent's OWN TTS playback.
 *
 * The synthetic tests (`nlms-echo-canceller.test.ts`) prove the canceller
 * converges on a *modeled* echo path. This harness closes the remaining #9455
 * gap: measuring the SHIPPED `NlmsEchoCanceller` (the class wired into
 * audio-frame-consumer.ts, #9575) against a REAL acoustic echo of REAL TTS
 * speech captured through the host's own speaker → room → microphone path —
 * exactly the failure mode the canceller exists for: the agent transcribing its
 * own spoken reply while the user is silent.
 *
 * Pipeline (no GPU, no model download, no external key — only a speaker + mic):
 *   1. Synthesise the far-end as real TTS speech. By default macOS `say`
 *      (genuine synthesized speech, not a tone); pass --tts-wav <file> to use a
 *      real Kokoro/agent-TTS WAV instead. A 1 s silence lead-in is prepended so
 *      the (unstable) first second of avfoundation capture is discarded.
 *   2. Play it out the default output while recording the default input — the
 *      mic captures the acoustic echo of the spoken reply (user silent).
 *   3. Cross-correlate a window of the known TTS waveform against the recording
 *      to align them (separate render/capture clocks → unknown start skew).
 *   4. Run the shipped `NlmsEchoCanceller` over the aligned frames and report the
 *      acoustic ERLE = 10·log10(E[mic²]/E[residual²]) over the converged region.
 *
 * Honest failure: if the recording has no measurable correlation with the TTS
 * (headphones, muted output, dead mic), it reports NO ACOUSTIC COUPLING rather
 * than a fabricated ERLE.
 *
 * Usage:
 *   bun run packages/benchmarks/voice/device-acoustic-erle.mjs [--device N]
 *       [--tts-wav <file>] [--say "<sentence>"] [--voice <name>]
 *
 * macOS: ffmpeg avfoundation for capture, afplay for playback. The host process
 * needs Microphone permission (System Settings → Privacy → Microphone).
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeErle } from "../../../plugins/plugin-local-inference/src/services/voice/echo-metrics.ts";
import { NlmsEchoCanceller } from "../../../plugins/plugin-local-inference/src/services/voice/nlms-echo-canceller.ts";

const SR = 16000;
const SILENCE_SEC = 1.0; // discard avfoundation capture warmup
const LOCK = 0.1; // pure-noise cross-correlation sits at ~0.04; 0.1 is a clear lock

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const audioDevice = arg("--device", "1"); // ffmpeg avfoundation audio index
const ttsWav = arg("--tts-wav", null); // real Kokoro/agent-TTS WAV (optional)
const voice = arg("--voice", "Samantha");
const sentence = arg(
  "--say",
  "Hi, I'm Eliza, your on-device assistant. I'm running entirely on this machine right now, with no cloud connection at all. Ask me anything and I'll do my best to help you out.",
);

// ---- WAV I/O (16 kHz mono s16le) --------------------------------------------

function writeWavMono16(path, float32) {
  const n = float32.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    buf.writeInt16LE((s * 32767) | 0, 44 + i * 2);
  }
  writeFileSync(path, buf);
}

function readWavMono16(path) {
  const buf = readFileSync(path);
  let off = 12;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      dataOff = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size + (size & 1);
  }
  if (dataOff < 0) throw new Error(`no data chunk in ${path}`);
  const n = Math.floor(Math.min(dataLen, buf.length - dataOff) / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(dataOff + i * 2) / 32768;
  return out;
}

// ---- Far-end: real TTS speech ----------------------------------------------

function ttsToWav16(tmp) {
  const out = join(tmp, "tts16.wav");
  if (ttsWav) {
    // Resample a provided Kokoro/agent-TTS WAV to 16 kHz mono.
    const r = spawnSync(
      "ffmpeg",
      ["-i", ttsWav, "-ar", String(SR), "-ac", "1", "-y", out],
      { stdio: "ignore" },
    );
    if (r.status !== 0)
      throw new Error(`ffmpeg failed to read --tts-wav ${ttsWav}`);
    console.log(`[device-aec] far-end = real TTS wav: ${ttsWav}`);
    return out;
  }
  // macOS `say` → genuine synthesized speech.
  const aiff = join(tmp, "tts.aiff");
  const s = spawnSync("say", ["-v", voice, "-o", aiff, sentence]);
  if (s.status !== 0)
    throw new Error("`say` failed — pass --tts-wav <file> on non-macOS");
  const r = spawnSync(
    "ffmpeg",
    ["-i", aiff, "-ar", String(SR), "-ac", "1", "-y", out],
    { stdio: "ignore" },
  );
  if (r.status !== 0) throw new Error("ffmpeg failed to convert `say` output");
  console.log(
    `[device-aec] far-end = macOS say (voice=${voice}): "${sentence.slice(0, 56)}…"`,
  );
  return out;
}

function buildFarEnd(tmp) {
  const speech = readWavMono16(ttsToWav16(tmp));
  const silenceN = Math.floor(SILENCE_SEC * SR);
  const far = new Float32Array(silenceN + speech.length);
  far.set(speech, silenceN);
  return { far, silenceN, speechN: speech.length };
}

// ---- Cross-correlation alignment -------------------------------------------

function rms(arr, from = 0, to = arr.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += arr[i] * arr[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

function findOnset(sig, noiseWinSamples) {
  // First sample where a 20 ms window's RMS clears the noise floor (measured
  // from the leading `noiseWinSamples`). The silence→speech transition is a
  // UNIQUE anchor — unlike a mid-speech window it can't alias to a repeated
  // phoneme, which is what makes raw speech cross-correlation lock falsely.
  const noise = rms(sig, 0, noiseWinSamples);
  const thresh = Math.max(2.5 * noise, 1e-3);
  const win = Math.floor(0.02 * SR);
  for (let i = noiseWinSamples; i + win < sig.length; i += win) {
    if (rms(sig, i, i + win) > thresh) return i;
  }
  return -1;
}

function refineOffset(near, ref, refStartInFar, coarseLag, searchSamples) {
  // Local normalised cross-correlation in a ±searchSamples window around the
  // onset-based coarse lag — removes onset jitter, locks the sub-window phase.
  const m = ref.length;
  let refEnergy = 0;
  for (let i = 0; i < m; i++) refEnergy += ref[i] * ref[i];
  refEnergy = Math.sqrt(refEnergy) || 1;
  let bestLag = coarseLag;
  let bestScore = -Infinity;
  const lo = Math.max(0, coarseLag - searchSamples);
  const hi = Math.min(near.length - m, coarseLag + searchSamples);
  for (let lag = lo; lag <= hi; lag++) {
    let dot = 0;
    let nearEnergy = 0;
    for (let i = 0; i < m; i++) {
      const v = near[lag + i];
      dot += ref[i] * v;
      nearEnergy += v * v;
    }
    const score = dot / (refEnergy * (Math.sqrt(nearEnergy) || 1));
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return { offset: bestLag - refStartInFar, score: bestScore };
}

// ---- Capture (play far-end while recording the mic) -------------------------

async function playAndRecord(farWavPath, outWavPath, captureSeconds) {
  const rec = spawn(
    "ffmpeg",
    [
      "-f",
      "avfoundation",
      "-i",
      `:${audioDevice}`,
      "-ar",
      String(SR),
      "-ac",
      "1",
      "-t",
      String(captureSeconds),
      "-y",
      outWavPath,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  await new Promise((r) => setTimeout(r, 500)); // let capture stabilise
  spawnSync("afplay", [farWavPath]); // blocking playback
  await new Promise((resolve) => rec.on("exit", resolve));
}

// ---- Main -------------------------------------------------------------------

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "aec-erle-"));
  const farPath = join(tmp, "far.wav");
  const nearPath = join(tmp, "near.wav");

  const { far, silenceN, speechN } = buildFarEnd(tmp);
  writeWavMono16(farPath, far);
  const farSeconds = far.length / SR;

  const captureSec = farSeconds + 2.0;
  console.log(
    `[device-aec] playing real TTS far-end (${farSeconds.toFixed(1)}s) + recording mic (avfoundation :${audioDevice}, ${captureSec.toFixed(1)}s)…`,
  );
  await playAndRecord(farPath, nearPath, captureSec);

  const near = readWavMono16(nearPath);
  console.log(
    `[device-aec] captured ${(near.length / SR).toFixed(2)}s mic (${near.length} samples)`,
  );

  // Align by the speech ONSET (unique silence→speech transition), then refine
  // with a local cross-correlation. far onset = silenceN (exact). near onset =
  // first energy above the recording's leading noise floor.
  const nearOnset = findOnset(near, Math.floor(0.4 * SR));
  if (nearOnset < 0) {
    console.log(
      "\n[device-aec] RESULT: NO ACOUSTIC COUPLING DETECTED (mic never rose above its noise floor).",
    );
    process.exitCode = 2;
    return;
  }
  const coarseOffset = nearOnset - silenceN;
  // Refine around the onset using a 1.5 s window 0.3 s into the speech.
  const refStart = silenceN + Math.floor(0.3 * SR);
  const refLen = Math.min(Math.floor(1.5 * SR), speechN - Math.floor(0.3 * SR));
  const ref = far.subarray(refStart, refStart + refLen);
  const coarseLag = refStart + coarseOffset; // expected position of ref in near
  const { offset, score } = refineOffset(
    near,
    ref,
    refStart,
    coarseLag,
    Math.floor(0.15 * SR),
  );
  const alignMs = (offset / SR) * 1000;
  console.log(
    `[device-aec] TTS onset@near ${nearOnset}; refined far→near offset=${offset} (${alignMs.toFixed(1)} ms, incl. capture-start skew), corr peak=${score.toFixed(3)}`,
  );

  if (score < LOCK) {
    console.log(
      `\n[device-aec] RESULT: NO ACOUSTIC COUPLING DETECTED (corr < ${LOCK}).`,
    );
    console.log(
      "  The mic did not capture the TTS playback — output muted/headphones, mic muted, or wrong device.",
    );
    console.log(
      "  Re-run with the speaker audible and the built-in mic selected: --device <N>.",
    );
    process.exitCode = 2;
    return;
  }

  // Align: far[i] ↔ near[i + offset]. Echo region = the TTS speech.
  const speechStart = silenceN;
  const nearStart = speechStart + offset;
  const usable = Math.min(far.length - speechStart, near.length - nearStart);
  if (usable < SR) {
    console.log(
      `\n[device-aec] RESULT: aligned overlap too short (${usable} samples) — re-run.`,
    );
    process.exitCode = 2;
    return;
  }
  const farSpeech = far.subarray(speechStart, speechStart + usable);
  const nearSpeech = near.subarray(nearStart, nearStart + usable);

  // Use the SHIPPED defaults (filterTaps 256 ≈ 16 ms, mu 0.3) — validate what
  // actually runs in the live consumer, not a tuned variant.
  const aec = new NlmsEchoCanceller();
  const BLOCK = 320; // 20 ms frames, as the live consumer feeds them
  const residual = new Float32Array(nearSpeech.length);
  for (let off = 0; off + BLOCK <= nearSpeech.length; off += BLOCK) {
    const out = aec.process(
      nearSpeech.subarray(off, off + BLOCK),
      farSpeech.subarray(off, off + BLOCK),
    );
    residual.set(out, off);
  }

  const half = Math.floor(nearSpeech.length / 2);
  const erleFull = computeErle(nearSpeech, residual);
  const erleConverged = computeErle(
    nearSpeech.subarray(half),
    residual.subarray(half),
  );
  const micRms = rms(nearSpeech, half, nearSpeech.length);
  const resRms = rms(residual, half, residual.length);

  console.log("\n[device-aec] ===== RESULT =====");
  console.log(
    `  alignment offset          : ${offset} samples / ${alignMs.toFixed(1)} ms (corr ${score.toFixed(3)})`,
  );
  console.log(`  mic RMS (echo, converged) : ${micRms.toExponential(3)}`);
  console.log(`  residual RMS (post-AEC)   : ${resRms.toExponential(3)}`);
  console.log(`  ERLE (whole utterance)    : ${erleFull.toFixed(2)} dB`);
  console.log(`  ERLE (converged 2nd half) : ${erleConverged.toFixed(2)} dB`);
  const verdict =
    erleConverged >= 6
      ? "PASS (≥6 dB real-acoustic cancellation of agent TTS)"
      : "LOW (mic/room coupling weak — agent self-echo near the mic noise floor)";
  console.log(`  verdict                   : ${verdict}`);
  console.log(`  artifacts                 : ${farPath} , ${nearPath}`);
}

main().catch((e) => {
  console.error("[device-aec] error:", e);
  process.exitCode = 1;
});
