/**
 * device-acoustic-erle.mjs — on-device acoustic ERLE + playback→mic delay
 * calibration for the live half-duplex voice path (#9455).
 *
 * The synthetic tests (`nlms-echo-canceller.test.ts`) prove the canceller
 * converges on a *modeled* echo path. This harness closes the remaining #9455
 * gap: measuring the SHIPPED `NlmsEchoCanceller` against a REAL acoustic echo
 * captured through the host's own speaker→room→microphone path, and measuring
 * the playback→mic transport delay that the live `echoReference` provider must
 * compensate.
 *
 * What it does (no GPU, no model, no external key — only a speaker + mic):
 *   1. Synthesise a 16 kHz far-end reference: a leading linear chirp (for delay
 *      estimation) followed by speech-like amplitude-modulated band-limited
 *      noise bursts (the "agent TTS").
 *   2. Play it out the default output while recording the default input — the
 *      mic captures the acoustic echo of the playback (user silent = echo-only,
 *      the dominant failure mode the canceller targets).
 *   3. Cross-correlate the recorded chirp against the reference chirp to recover
 *      the bulk playback→mic delay in samples/ms (the calibration value).
 *   4. Run the real shipped `NlmsEchoCanceller` (the class wired into
 *      audio-frame-consumer.ts, #9575) over the delay-aligned frames and report
 *      the acoustic ERLE = 10·log10(E[mic²]/E[residual²]) over the echo region.
 *
 * Honest failure: if the recorded near-end has no measurable correlation with
 * the reference (headphones, muted output, dead mic), it reports NO ACOUSTIC
 * COUPLING rather than a fabricated ERLE.
 *
 * Usage:
 *   bun run packages/benchmarks/voice/device-acoustic-erle.mjs [--device N] [--seconds S]
 *
 * macOS: ffmpeg avfoundation for capture, afplay for playback. The terminal/host
 * process needs Microphone permission (System Settings → Privacy → Microphone).
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeErle } from "../../../plugins/plugin-local-inference/src/services/voice/echo-canceller.ts";
import { NlmsEchoCanceller } from "../../../plugins/plugin-local-inference/src/services/voice/nlms-echo-canceller.ts";

const SR = 16000;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const audioDevice = arg("--device", "1"); // ffmpeg avfoundation audio index
const farSeconds = Number(arg("--seconds", "6"));

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
  // Locate the 'data' chunk (skip any LIST/fact chunks ffmpeg may emit).
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

// ---- Far-end synthesis ------------------------------------------------------

const CHIRP_SEC = 1.0;
// Silence lead-in before the chirp: ffmpeg/avfoundation capture is unstable for
// the first ~1 s (warmup + buffer fill), so the chirp must start well after the
// capture stabilises or the cross-correlation never locks.
const SILENCE_SEC = 1.0;

function synthFarEnd() {
  const total = Math.floor((SILENCE_SEC + farSeconds) * SR);
  const far = new Float32Array(total);
  const silenceN = Math.floor(SILENCE_SEC * SR);
  const chirpN = Math.floor(CHIRP_SEC * SR);
  // Linear chirp 300 → 3500 Hz — broadband + distinctive for cross-correlation.
  const f0 = 300;
  const f1 = 3500;
  for (let i = 0; i < chirpN; i++) {
    const t = i / SR;
    const k = (f1 - f0) / CHIRP_SEC;
    const phase = 2 * Math.PI * (f0 * t + 0.5 * k * t * t);
    far[silenceN + i] = 0.9 * Math.sin(phase);
  }
  // Speech-like: band-limited noise (1-pole LP) amplitude-modulated into bursts.
  let lp = 0;
  for (let i = silenceN + chirpN; i < total; i++) {
    const t = (i - silenceN - chirpN) / SR;
    // 0.4 s on / 0.2 s off bursts.
    const phase = t % 0.6;
    const gate = phase < 0.4 ? 1 : 0;
    // Syllabic envelope ~4 Hz.
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
    const white = Math.random() * 2 - 1;
    lp = 0.85 * lp + 0.15 * white; // ~2.4 kHz LP
    far[i] = 0.7 * gate * env * lp;
  }
  return far;
}

// ---- Cross-correlation delay estimation -------------------------------------

function estimateDelaySamples(near, refChirp, maxLagSamples) {
  // Normalised cross-correlation of the reference chirp against `near` over
  // [0, maxLag]. Returns { lag, score } where score ∈ [0,1] (peak correlation).
  const m = refChirp.length;
  let refEnergy = 0;
  for (let i = 0; i < m; i++) refEnergy += refChirp[i] * refChirp[i];
  refEnergy = Math.sqrt(refEnergy) || 1;
  let bestLag = 0;
  let bestScore = -Infinity;
  const maxLag = Math.min(maxLagSamples, near.length - m);
  for (let lag = 0; lag < maxLag; lag++) {
    let dot = 0;
    let nearEnergy = 0;
    for (let i = 0; i < m; i++) {
      const v = near[lag + i];
      dot += refChirp[i] * v;
      nearEnergy += v * v;
    }
    const score = dot / (refEnergy * (Math.sqrt(nearEnergy) || 1));
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return { lag: bestLag, score: bestScore };
}

function rms(arr, from = 0, to = arr.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += arr[i] * arr[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

// ---- Capture (play far-end while recording the mic) -------------------------

async function playAndRecord(farWavPath, outWavPath, captureSeconds) {
  // ffmpeg first so capture is live before playback starts.
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
  await new Promise((r) => setTimeout(r, 400)); // let the capture stabilise
  spawnSync("afplay", [farWavPath]); // blocking playback
  await new Promise((resolve) => rec.on("exit", resolve));
}

// ---- Main -------------------------------------------------------------------

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "aec-erle-"));
  const farPath = join(tmp, "far.wav");
  const nearPath = join(tmp, "near.wav");

  console.log(
    `[device-aec] synth far-end: ${farSeconds}s @ ${SR} Hz (chirp + speech-like bursts)`,
  );
  const far = synthFarEnd();
  writeWavMono16(farPath, far);

  const captureSec = SILENCE_SEC + farSeconds + 1.5;
  console.log(
    `[device-aec] playing far-end + recording mic (avfoundation :${audioDevice}, ${captureSec}s)…`,
  );
  await playAndRecord(farPath, nearPath, captureSec);

  const near = readWavMono16(nearPath);
  console.log(
    `[device-aec] captured ${(near.length / SR).toFixed(2)}s mic (${near.length} samples)`,
  );

  // --- Delay calibration via chirp cross-correlation. The chirp begins at far
  // index `silenceN`; find where it lands in the near recording, search the
  // whole capture (the playback→mic transport delay is unknown a-priori).
  const silenceN = Math.floor(SILENCE_SEC * SR);
  const chirpN = Math.floor(CHIRP_SEC * SR);
  const refChirp = far.subarray(silenceN, silenceN + chirpN);
  const { lag, score } = estimateDelaySamples(near, refChirp, near.length);
  // far index i ↔ near index (i + offset). offset = (chirp position in near) −
  // (chirp position in far). NB: afplay (render) and ffmpeg (capture) run on
  // independent, unsynchronised clocks and ffmpeg drops a variable capture
  // prefix, so this offset folds the true acoustic transport delay together
  // with the process-start skew — it is the *alignment* offset, not a clean
  // hardware transport-delay measurement (that needs a single render+capture
  // clock, which the on-device CoreAudio/AAudio tap provides).
  const offset = lag - silenceN;
  const alignMs = (offset / SR) * 1000;
  console.log(
    `[device-aec] chirp locked at near sample ${lag}; far→near alignment offset=${offset} (${alignMs.toFixed(1)} ms, incl. capture-start skew), corr peak=${score.toFixed(3)}`,
  );

  const LOCK = 0.12; // pure-noise correlation sat at ~0.04-0.05; 0.12 is a clear lock
  if (score < LOCK) {
    console.log(
      `\n[device-aec] RESULT: NO ACOUSTIC COUPLING DETECTED (corr < ${LOCK}).`,
    );
    console.log(
      "  The mic did not capture the playback — output muted/headphones, mic muted, or wrong device.",
    );
    console.log(
      "  Re-run with the speaker audible and the built-in mic selected: --device <N>.",
    );
    process.exitCode = 2;
    return;
  }

  // --- Align near to far by the measured offset, then run the SHIPPED
  // canceller. Echo region = the speech bursts after the chirp. far[i] ↔
  // near[i + offset]; offset may be negative (capture dropped its prefix), so
  // index near directly rather than slicing from a negative start.
  const speechStart = silenceN + chirpN;
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

  // delaySamples=0: we pre-aligned, so the adaptive taps model only the room
  // impulse. filterTaps=512 ≈ 32 ms tail (matches the live default scale).
  const aec = new NlmsEchoCanceller({ filterTaps: 512, mu: 0.5 });
  const BLOCK = 320; // 20 ms frames, as the live consumer feeds them
  const residual = new Float32Array(nearSpeech.length);
  for (let off = 0; off + BLOCK <= nearSpeech.length; off += BLOCK) {
    const out = aec.process(
      nearSpeech.subarray(off, off + BLOCK),
      farSpeech.subarray(off, off + BLOCK),
    );
    residual.set(out, off);
  }

  // Measure ERLE on the converged second half (the filter needs ~1-2 s to adapt).
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
  console.log(`  mic RMS (echo, post-adapt): ${micRms.toExponential(3)}`);
  console.log(`  residual RMS (post-AEC)   : ${resRms.toExponential(3)}`);
  console.log(`  ERLE (whole utterance)    : ${erleFull.toFixed(2)} dB`);
  console.log(`  ERLE (converged 2nd half) : ${erleConverged.toFixed(2)} dB`);
  const verdict =
    erleConverged >= 6
      ? "PASS (≥6 dB real-acoustic cancellation)"
      : "LOW (mic/room coupling weak or canceller under-converged)";
  console.log(`  verdict                   : ${verdict}`);
  console.log(`  artifacts                 : ${farPath} , ${nearPath}`);
}

main().catch((e) => {
  console.error("[device-aec] error:", e);
  process.exitCode = 1;
});
