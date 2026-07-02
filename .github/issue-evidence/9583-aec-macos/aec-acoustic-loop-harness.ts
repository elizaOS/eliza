/**
 * #9583 — macOS speaker→mic acoustic-loop AEC evidence harness (bun).
 *
 * What this does — REAL engines, REAL acoustics, no mocks of the subject:
 *
 *  Phase A (physical): synthesizes a spoken far-end reference (`say`), plays it
 *    through the Mac's speakers with `afplay` while `sox` records the built-in
 *    mic — a genuine speaker→air→mic echo path on this M4 Max.
 *
 *  Phase B (live route): boots an HTTP server that mounts the PRODUCTION
 *    `handleLiveDiarizationRoute` (real `LiveDiarizationSession` → fused ggml
 *    Silero VAD / WeSpeaker / pyannote via `libelizainference.dylib`), then
 *    streams the far-end PCM to POST /api/voice/playback-frames (the live
 *    playback-reference producer this issue asks for) interleaved in capture
 *    order with the recorded mic PCM to POST /api/voice/audio-frames, all in
 *    the same wire format the device uses (base64 LE-s16 16 kHz mono, 20 ms
 *    frames, capture-clock timestamps). Reads GET /api/voice/audio-frames/status
 *    before/after: the session's own delay SELF-CALIBRATION
 *    (`estimateEchoDelaySamples`, #9586) and AEC wiring state are the DTO
 *    evidence.
 *
 *  Phase C (measurement): replays the same near/far pair through the PRODUCTION
 *    `EchoReferenceBuffer` + `NlmsEchoCanceller` exactly the way
 *    `AudioFrameConsumer.cancelEcho` + `LiveDiarizationSession.echoReferenceFrame`
 *    drive them, and reports ERLE via the production `computeErle`, plus the
 *    playback→mic delay recovered by the production `estimateEchoDelaySamples`.
 *
 * Run (from the repo root, bun only — the fused FFI is bun:ffi):
 *   ELIZA_INFERENCE_LIBRARY=<libelizainference.dylib> \
 *   ELIZA_VOICE_MODEL_DIR=<staged vad/speaker/diariz bundle> \
 *   bun .github/issue-evidence/9583-aec-macos/aec-acoustic-loop-harness.ts \
 *     [--reuse] [--port 36510] [--out .github/issue-evidence/9583-aec-macos]
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

// Production modules under test (relative to this file, into the worktree).
const ROOT = path.resolve(import.meta.dir, "../../..");
const VOICE = path.join(
  ROOT,
  "plugins/plugin-local-inference/src/services/voice",
);
const { handleLiveDiarizationRoute, resetLiveDiarizationSession } =
  await import(
    path.join(
      ROOT,
      "plugins/plugin-local-inference/src/routes/live-diarization-route.ts",
    )
  );
const { EchoReferenceBuffer } = await import(
  path.join(VOICE, "echo-reference-buffer.ts")
);
const { NlmsEchoCanceller } = await import(
  path.join(VOICE, "nlms-echo-canceller.ts")
);
const { computeErle } = await import(path.join(VOICE, "echo-metrics.ts"));
const { estimateEchoDelaySamples } = await import(
  path.join(VOICE, "echo-delay.ts"),
);

const SR = 16_000;
const FRAME = 320; // 20 ms @ 16 kHz — the device wire frame size
const argvArg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const OUT = path.resolve(argvArg("--out") ?? path.dirname(import.meta.path));
const PORT = Number(argvArg("--port") ?? 36510);
const REUSE = process.argv.includes("--reuse");

const FAR_WAV = path.join(OUT, "farend-16k.wav");
const MIC_WAV = path.join(OUT, "mic-capture-16k.wav");
const TIMING = path.join(OUT, "capture-timing.json");

const FAR_TEXT =
  "Hello, this is the Eliza agent speaking through the laptop speakers. " +
  "The acoustic echo canceller should remove this playback from the microphone " +
  "signal before voice activity detection runs. Testing one two three four five. " +
  "The quick brown fox jumps over the lazy dog while the agent keeps talking.";

function sh(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "pipe" });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr?.toString()}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Phase A — physical speaker→mic capture
// ---------------------------------------------------------------------------
async function capturePhase(): Promise<{
  playStartOffsetMs: number;
  playedMs: number;
}> {
  if (REUSE && existsSync(FAR_WAV) && existsSync(MIC_WAV) && existsSync(TIMING)) {
    const t = JSON.parse(readFileSync(TIMING, "utf8"));
    console.log(`[capture] reusing existing capture (${TIMING})`);
    return t;
  }
  const tmpAiff = path.join(OUT, "farend-say.aiff");
  console.log("[capture] synthesizing far-end speech via `say`…");
  sh("say", ["-o", tmpAiff, FAR_TEXT]);
  sh("sox", [tmpAiff, "-r", String(SR), "-c", "1", "-b", "16", FAR_WAV]);
  const farDurMs = (readWav(FAR_WAV).length / SR) * 1000;

  // Modest volume (issue guidance), restore afterwards.
  const prevVol = spawnSync("osascript", ["-e", "output volume of (get volume settings)"])
    .stdout.toString()
    .trim();
  sh("osascript", ["-e", "set volume output volume 45"]);

  const recDurS = Math.ceil(farDurMs / 1000) + 3;
  console.log(
    `[capture] recording mic for ${recDurS}s while playing ${Math.round(farDurMs)}ms of speech through the speakers…`,
  );
  const recStart = Date.now();
  const rec = spawn("sox", [
    "-d",
    "-r",
    String(SR),
    "-c",
    "1",
    "-b",
    "16",
    MIC_WAV,
    "trim",
    "0",
    String(recDurS),
  ]);
  await new Promise((r) => setTimeout(r, 1200)); // let capture settle
  const playStart = Date.now();
  await new Promise<void>((resolve, reject) => {
    const p = spawn("afplay", [FAR_WAV]);
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`afplay ${c}`))));
  });
  const playedMs = Date.now() - playStart;
  await new Promise<void>((resolve) => rec.on("exit", () => resolve()));
  sh("osascript", ["-e", `set volume output volume ${prevVol || "45"}`]);

  const timing = { playStartOffsetMs: playStart - recStart, playedMs };
  writeFileSync(TIMING, JSON.stringify(timing, null, 2));
  console.log(`[capture] done: play offset ${timing.playStartOffsetMs}ms in mic clock`);
  return timing;
}

// ---------------------------------------------------------------------------
// WAV I/O (16-bit PCM only) + frame packing
// ---------------------------------------------------------------------------
function readWav(file: string): Float32Array {
  const buf = readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error(`${file}: not RIFF`);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      const fmt = buf.readUInt16LE(off + 8);
      const ch = buf.readUInt16LE(off + 10);
      const rate = buf.readUInt32LE(off + 12);
      const bits = buf.readUInt16LE(off + 22);
      if (fmt !== 1 || ch !== 1 || rate !== SR || bits !== 16) {
        throw new Error(`${file}: expected s16le mono ${SR} Hz (got fmt=${fmt} ch=${ch} rate=${rate} bits=${bits})`);
      }
    } else if (id === "data") {
      const n = size >> 1;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

function frameEvents(
  pcm: Float32Array,
  clockOffsetMs: number,
): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for (let i = 0, fi = 0; i + FRAME <= pcm.length; i += FRAME, fi++) {
    const bytes = Buffer.alloc(FRAME * 2);
    let rms = 0;
    for (let j = 0; j < FRAME; j++) {
      const v = Math.max(-1, Math.min(1, pcm[i + j]));
      bytes.writeInt16LE(Math.round(v * 32767), j * 2);
      rms += v * v;
    }
    frames.push({
      pcm16: bytes.toString("base64"),
      sampleRate: SR,
      channels: 1,
      samples: FRAME,
      rms: Math.sqrt(rms / FRAME),
      timestamp: clockOffsetMs + (i / SR) * 1000,
      frameIndex: fi,
    });
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Phase B — live production route + playback-frames producer
// ---------------------------------------------------------------------------
async function liveRoutePhase(
  mic: Float32Array,
  far: Float32Array,
  playStartOffsetMs: number,
): Promise<{ statusBefore: unknown; statusAfter: unknown; events: unknown[] }> {
  const events: unknown[] = [];
  const state = {
    current: {
      emitEvent: async (type: unknown, payload: Record<string, unknown>) => {
        events.push({ type, keys: Object.keys(payload ?? {}) });
      },
    },
  };
  const server = http.createServer((req, res) => {
    handleLiveDiarizationRoute(req, res, state as never).then((handled: boolean) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
  const base = `http://127.0.0.1:${PORT}`;
  const post = async (p: string, body: unknown) => {
    const r = await fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`${p} → ${r.status}: ${JSON.stringify(j)}`);
    return j;
  };

  console.log("[live] building session (first status call loads the fused ggml stack)…");
  const statusBefore = await (await fetch(`${base}/api/voice/audio-frames/status`)).json();
  console.log(`[live] status.ready=${(statusBefore as { ready?: boolean }).ready} libs=${JSON.stringify((statusBefore as { libs?: unknown }).libs)}`);

  const micFrames = frameEvents(mic, 0);
  const farFrames = frameEvents(far, playStartOffsetMs);
  // Interleave in capture-clock order, far-end first within a block, streamed
  // with real-time pacing in 200 ms blocks — the same shape as the device's
  // concurrent playback-pump + mic-pump traffic.
  const BLOCK_MS = 200;
  const endMs = Math.max(
    (mic.length / SR) * 1000,
    playStartOffsetMs + (far.length / SR) * 1000,
  );
  let farIdx = 0;
  let micIdx = 0;
  const t0 = Date.now();
  for (let block = 0; block * BLOCK_MS < endMs; block++) {
    const hi = (block + 1) * BLOCK_MS;
    const farBatch: typeof farFrames = [];
    while (farIdx < farFrames.length && (farFrames[farIdx].timestamp as number) < hi) {
      farBatch.push(farFrames[farIdx++]);
    }
    const micBatch: typeof micFrames = [];
    while (micIdx < micFrames.length && (micFrames[micIdx].timestamp as number) < hi) {
      micBatch.push(micFrames[micIdx++]);
    }
    if (farBatch.length) await post("/api/voice/playback-frames", { frames: farBatch });
    if (micBatch.length) await post("/api/voice/audio-frames", { frames: micBatch });
    const ahead = hi - (Date.now() - t0);
    if (ahead > 0) await new Promise((r) => setTimeout(r, ahead));
  }
  await post("/api/voice/audio-frames", { frames: [], flush: true });
  const statusAfter = await (await fetch(`${base}/api/voice/audio-frames/status`)).json();
  await new Promise<void>((r) => server.close(() => r()));
  await resetLiveDiarizationSession();
  return { statusBefore, statusAfter, events };
}

// ---------------------------------------------------------------------------
// Phase C — production-class ERLE + delay measurement
// ---------------------------------------------------------------------------
function measure(
  mic: Float32Array,
  far: Float32Array,
  playStartOffsetMs: number,
  delaySamples: number,
  residualSuppression: boolean,
): {
  erleOverallDb: number;
  erleConvergedDb: number;
  perSecondErleDb: number[];
  framesCancelled: number;
  framesPassthrough: number;
} {
  const buffer = new EchoReferenceBuffer();
  const canceller = new NlmsEchoCanceller(
    residualSuppression ? { residualSuppression: true } : {},
  );
  const farFrames = frameEvents(far, playStartOffsetMs);
  let farIdx = 0;
  const nearActive: Float32Array[] = [];
  const residActive: Float32Array[] = [];
  const perSec: { near: number; resid: number }[] = [];
  let cancelled = 0;
  let passthrough = 0;
  for (let i = 0; i + FRAME <= mic.length; i += FRAME) {
    const ts = (i / SR) * 1000;
    while (farIdx < farFrames.length && (farFrames[farIdx].timestamp as number) <= ts + 20) {
      const f = farFrames[farIdx++];
      const bytes = Buffer.from(f.pcm16 as string, "base64");
      const pcm = new Float32Array(FRAME);
      for (let j = 0; j < FRAME; j++) pcm[j] = bytes.readInt16LE(j * 2) / 32768;
      buffer.pushAt(f.timestamp as number, pcm);
    }
    const near = mic.subarray(i, i + FRAME);
    const ref = buffer.referenceAt(ts, FRAME, delaySamples);
    let refEnergy = 0;
    for (let j = 0; j < FRAME; j++) refEnergy += ref[j] * ref[j];
    if (refEnergy / FRAME < 1e-7) {
      canceller.observeFarEndSilence(near);
      passthrough++;
      continue;
    }
    const out = canceller.process(near, ref);
    cancelled++;
    nearActive.push(near.slice());
    residActive.push(out.slice());
    const sec = Math.floor(ts / 1000);
    while (perSec.length <= sec) perSec.push({ near: 0, resid: 0 });
    for (let j = 0; j < FRAME; j++) {
      perSec[sec].near += near[j] * near[j];
      perSec[sec].resid += out[j] * out[j];
    }
  }
  const cat = (chunks: Float32Array[]) => {
    const n = chunks.reduce((a, c) => a + c.length, 0);
    const out = new Float32Array(n);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  };
  const near = cat(nearActive);
  const resid = cat(residActive);
  const half = near.length >> 1;
  return {
    erleOverallDb: computeErle(near, resid),
    erleConvergedDb: computeErle(near.subarray(half), resid.subarray(half)),
    perSecondErleDb: perSec.map((s) =>
      s.near > 0 && s.resid > 0 ? 10 * Math.log10(s.near / s.resid) : 0,
    ),
    framesCancelled: cancelled,
    framesPassthrough: passthrough,
  };
}

// ---------------------------------------------------------------------------
const timing = await capturePhase();
const mic = readWav(MIC_WAV);
const far = readWav(FAR_WAV);
console.log(
  `[load] mic=${(mic.length / SR).toFixed(1)}s far=${(far.length / SR).toFixed(1)}s playOffset=${timing.playStartOffsetMs}ms`,
);

// Independent ground-truth delay via the PRODUCTION estimator over the whole
// active window: how far the mic echo lags the pushed far-end reference.
const searchStart = Math.max(0, Math.round((timing.playStartOffsetMs / 1000) * SR));
const nearWin = mic.subarray(searchStart, Math.min(mic.length, searchStart + far.length));
const est = estimateEchoDelaySamples(nearWin, far.subarray(0, nearWin.length), {
  maxLagSamples: 8000,
});
console.log(
  `[delay] production estimateEchoDelaySamples: lag=${est.lagSamples} samples (${((est.lagSamples / SR) * 1000).toFixed(1)}ms) confidence=${est.confidence.toFixed(3)}`,
);

const live = await liveRoutePhase(mic, far, timing.playStartOffsetMs);
const aec = (live.statusAfter as { aec?: Record<string, number> }).aec ?? {};
console.log(`[live] status.aec after run: ${JSON.stringify(aec)}`);

const delayForMeasure =
  typeof aec.echoDelaySamples === "number" && aec.echoDelayConfidence
    ? aec.echoDelaySamples
    : est.lagSamples;
const linear = measure(mic, far, timing.playStartOffsetMs, delayForMeasure, false);
const suppressed = measure(mic, far, timing.playStartOffsetMs, delayForMeasure, true);
console.log(
  `[erle] linear NLMS: overall=${linear.erleOverallDb.toFixed(2)}dB converged-half=${linear.erleConvergedDb.toFixed(2)}dB (cancelled=${linear.framesCancelled} passthrough=${linear.framesPassthrough})`,
);
console.log(
  `[erle] +residual suppression: overall=${suppressed.erleOverallDb.toFixed(2)}dB converged-half=${suppressed.erleConvergedDb.toFixed(2)}dB`,
);

const report = {
  issue: 9583,
  host: "macOS (Apple M4 Max), built-in speakers → built-in mic",
  capturedAt: new Date().toISOString(),
  sampleRateHz: SR,
  frameSamples: FRAME,
  capture: timing,
  productionDelayEstimate: {
    lagSamples: est.lagSamples,
    lagMs: (est.lagSamples / SR) * 1000,
    confidence: est.confidence,
  },
  liveRoute: {
    port: PORT,
    statusBefore: live.statusBefore,
    statusAfter: live.statusAfter,
    runtimeEventsObserved: live.events.length,
  },
  erle: { delaySamplesUsed: delayForMeasure, linear, residualSuppression: suppressed },
};
writeFileSync(path.join(OUT, "aec-loop-report.json"), JSON.stringify(report, null, 2));
console.log(`[done] wrote ${path.join(OUT, "aec-loop-report.json")}`);
