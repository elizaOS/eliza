/**
 * VAD tests — the two-tier audio gate.
 *
 *   - `RmsEnergyGate`: hysteresis on synthetic sine / silence frames.
 *   - `VadDetector`: speech state machine driven by a *deterministic fake
 *     Silero* (probability scripted per window), asserting the full
 *     `VadEvent` sequence (start → active → pause → end / blip).
 *   - `SileroVad` / `createSileroVadDetector`: a network-gated test against
 *     the real MIT Silero VAD ONNX model — downloaded into a temp dir on
 *     first run, skipped offline. This is the only test that touches
 *     `onnxruntime-node`.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeSpeechWithSilenceFixture } from "./__test-helpers__/synthetic-speech";
import type { PcmFrame, VadEvent } from "./types";
import {
  createSileroVadDetector,
  RmsEnergyGate,
  rms,
  SileroVad,
  VadDetector,
  VadUnavailableError,
} from "./vad";

const SR = 16_000;
const FRAME = 512; // one Silero window
const FRAME_MS = (FRAME / SR) * 1000; // 32 ms

function silenceFrame(ts: number): PcmFrame {
  return { pcm: new Float32Array(FRAME), sampleRate: SR, timestampMs: ts };
}

function sineFrame(ts: number, amplitude: number, freq = 220): PcmFrame {
  const pcm = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    pcm[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
  }
  return { pcm, sampleRate: SR, timestampMs: ts };
}

// --- Deterministic fake Silero --------------------------------------------

class ScriptedSilero {
  readonly sampleRate = SR;
  readonly windowSamples = FRAME;
  private idx = 0;
  resets = 0;
  constructor(private readonly probs: readonly number[]) {}
  async process(window: Float32Array): Promise<number> {
    expect(window.length).toBe(FRAME);
    const p = this.probs[this.idx] ?? this.probs[this.probs.length - 1] ?? 0;
    this.idx++;
    return p;
  }
  /** Real Silero clears its LSTM state here; it does NOT rewind the input
   *  stream — so the scripted probability cursor stays where it is. */
  reset(): void {
    this.resets++;
  }
}

async function feedProbs(
  detector: VadDetector,
  probs: readonly number[],
): Promise<VadEvent[]> {
  const events: VadEvent[] = [];
  detector.onVadEvent((e) => events.push(e));
  let ts = 1000;
  for (let i = 0; i < probs.length; i++) {
    await detector.pushFrame(silenceFrame(ts));
    ts += FRAME_MS;
  }
  await detector.flush();
  return events;
}

describe("rms", () => {
  it("is zero for silence and ~amplitude/√2 for a sine", () => {
    expect(rms(new Float32Array(256))).toBe(0);
    const pcm = sineFrame(0, 0.5).pcm;
    expect(rms(pcm)).toBeGreaterThan(0.3);
    expect(rms(pcm)).toBeLessThan(0.4);
  });
});

describe("RmsEnergyGate", () => {
  it("rises above riseThreshold and falls after the hold window", () => {
    const gate = new RmsEnergyGate({ riseThreshold: 0.05, fallHoldMs: 60 });
    const events: string[] = [];
    gate.onEvent((e) => events.push(`${e.type}`));

    let ts = 0;
    // Silence — no event.
    gate.push(silenceFrame(ts));
    ts += FRAME_MS;
    expect(events).toEqual([]);
    expect(gate.isActive).toBe(false);

    // Loud — rise.
    gate.push(sineFrame(ts, 0.3));
    ts += FRAME_MS;
    expect(events).toEqual(["energy-rise"]);
    expect(gate.isActive).toBe(true);

    // Stay loud — no extra rise.
    gate.push(sineFrame(ts, 0.3));
    ts += FRAME_MS;
    expect(events).toEqual(["energy-rise"]);

    // First quiet frame — starts the hold timer; still active.
    gate.push(silenceFrame(ts));
    ts += FRAME_MS;
    expect(gate.isActive).toBe(true);

    // Second quiet frame — 32 ms quiet, still inside the 60 ms window.
    gate.push(silenceFrame(ts));
    ts += FRAME_MS;
    expect(gate.isActive).toBe(true);

    // Third quiet frame — 64 ms quiet, past the hold window → fall.
    gate.push(silenceFrame(ts));
    expect(events).toEqual(["energy-rise", "energy-fall"]);
    expect(gate.isActive).toBe(false);
  });

  it("does not fall when energy returns inside the hold window", () => {
    const gate = new RmsEnergyGate({ riseThreshold: 0.05, fallHoldMs: 200 });
    const events: string[] = [];
    gate.onEvent((e) => events.push(e.type));
    let ts = 0;
    gate.push(sineFrame(ts, 0.3));
    ts += FRAME_MS; // rise
    gate.push(silenceFrame(ts));
    ts += FRAME_MS; // quiet, 32ms < 200ms
    gate.push(sineFrame(ts, 0.3));
    ts += FRAME_MS; // loud again — cancels the fall
    gate.push(silenceFrame(ts));
    ts += FRAME_MS;
    expect(events).toEqual(["energy-rise"]);
  });
});

describe("VadDetector", () => {
  it("emits speech-start → speech-active → speech-pause → speech-end for a clean utterance", async () => {
    // 0..2 silence, 3..13 speech (~350 ms), then long silence to end.
    const probs = [
      0.01, 0.01, 0.01, 0.9, 0.95, 0.9, 0.92, 0.88, 0.9, 0.91, 0.93, 0.9, 0.9,
      0.9, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02,
      0.02, 0.02, 0.02, 0.02, 0.02,
    ];
    const det = new VadDetector(new ScriptedSilero(probs), {
      onsetThreshold: 0.5,
      pauseHangoverMs: 100,
      endHangoverMs: 300,
      minSpeechMs: 150,
      activeHeartbeatMs: 64,
    });
    const events = await feedProbs(det, probs);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("speech-start");
    expect(types).toContain("speech-active");
    expect(types).toContain("speech-pause");
    expect(types[types.length - 1]).toBe("speech-end");
    const end = events.find((e) => e.type === "speech-end");
    expect(
      end && end.type === "speech-end" && end.speechDurationMs,
    ).toBeGreaterThan(150);
  });

  it("classifies a too-short burst as a blip, not speech-end", async () => {
    // One speech window only (~32 ms), then silence.
    const probs = [
      0.01, 0.9, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02,
      0.02,
    ];
    const det = new VadDetector(new ScriptedSilero(probs), {
      onsetThreshold: 0.5,
      pauseHangoverMs: 64,
      endHangoverMs: 128,
      minSpeechMs: 200,
    });
    const events = await feedProbs(det, probs);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("speech-start");
    expect(types).toContain("blip");
    expect(types).not.toContain("speech-end");
  });

  it("reopens speech when energy returns during the pause hangover", async () => {
    // speech, brief dip (1 window), speech again, then end — single segment.
    const probs = [
      0.9, 0.9, 0.9, 0.9, 0.9, 0.1, 0.9, 0.9, 0.9, 0.9, 0.9, 0.02, 0.02, 0.02,
      0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02,
    ];
    const det = new VadDetector(new ScriptedSilero(probs), {
      onsetThreshold: 0.5,
      pauseHangoverMs: 100, // 3+ windows
      endHangoverMs: 250,
      minSpeechMs: 150,
      activeHeartbeatMs: 1000, // suppress heartbeats so we count starts cleanly
    });
    const events = await feedProbs(det, probs);
    const starts = events.filter((e) => e.type === "speech-start");
    expect(starts).toHaveLength(1); // not a new segment after the dip
    expect(events[events.length - 1].type).toBe("speech-end");
  });

  it("re-windows arbitrarily-sized input frames into 512-sample windows", async () => {
    const probs = [0.9, 0.9, 0.9, 0.9, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02];
    const silero = new ScriptedSilero(probs);
    const det = new VadDetector(silero, {
      onsetThreshold: 0.5,
      pauseHangoverMs: 64,
      endHangoverMs: 128,
      minSpeechMs: 1,
    });
    const events: VadEvent[] = [];
    det.onVadEvent((e) => events.push(e));
    // Feed 1280 samples in one 700-sample chunk + one 580-sample chunk +
    // tail in flush — that's 2.5 windows; flush pads the rest.
    await det.pushFrame({
      pcm: new Float32Array(700),
      sampleRate: SR,
      timestampMs: 0,
    });
    await det.pushFrame({
      pcm: new Float32Array(580),
      sampleRate: SR,
      timestampMs: 50,
    });
    // Tail of zeros to drive the segment to end.
    for (let i = 0; i < 8; i++) {
      await det.pushFrame({
        pcm: new Float32Array(512),
        sampleRate: SR,
        timestampMs: 100 + i * FRAME_MS,
      });
    }
    await det.flush();
    expect(events.some((e) => e.type === "speech-start")).toBe(true);
  });

  it("rejects a sample-rate mismatch", async () => {
    const det = new VadDetector(new ScriptedSilero([0.1]));
    await expect(
      det.pushFrame({
        pcm: new Float32Array(512),
        sampleRate: 8000,
        timestampMs: 0,
      }),
    ).rejects.toThrow(/16000/);
  });
});

describe("SileroVad — model not found", () => {
  it("throws VadUnavailableError(model-missing) when the ONNX file is absent", async () => {
    await expect(
      SileroVad.load({ modelPath: "/nonexistent/silero.onnx" }),
    ).rejects.toMatchObject({
      name: "VadUnavailableError",
      code: "model-missing",
    });
  });
});

// --- Network-gated real-model test ----------------------------------------

const SILERO_URL =
  "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx";

async function tryFetchSileroModel(): Promise<string | null> {
  if (process.env.ELIZA_VAD_MODEL_PATH) return process.env.ELIZA_VAD_MODEL_PATH;
  if (process.env.CI && !process.env.ELIZA_VAD_ALLOW_NETWORK) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(SILERO_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength < 1_000_000) return null;
    const dir = mkdtempSync(path.join(tmpdir(), "eliza-vad-"));
    const p = path.join(dir, "silero-vad-int8.onnx");
    writeFileSync(p, bytes);
    return p;
  } catch {
    return null;
  }
}

const modelPathPromise = tryFetchSileroModel();

describe("SileroVad — real ONNX model (network-gated)", () => {
  afterAll(() => {
    /* temp dir left for the OS to reap */
  });

  it("loads, runs 512-sample windows, and yields low prob on silence", async () => {
    const modelPath = await modelPathPromise;
    if (!modelPath) {
      console.warn(
        "[vad.test] Skipping real Silero ONNX test — model not available offline. Set ELIZA_VAD_MODEL_PATH or ELIZA_VAD_ALLOW_NETWORK=1.",
      );
      return;
    }
    let vad: SileroVad;
    try {
      vad = await SileroVad.load({ modelPath });
    } catch (err) {
      if (err instanceof VadUnavailableError && err.code === "ort-missing") {
        console.warn("[vad.test] Skipping — onnxruntime-node not installed.");
        return;
      }
      throw err;
    }
    expect(vad.windowSamples).toBe(512);
    const silence = new Float32Array(512);
    const p1 = await vad.process(silence);
    const p2 = await vad.process(silence);
    expect(p1).toBeGreaterThanOrEqual(0);
    expect(p1).toBeLessThan(0.3);
    expect(p2).toBeLessThan(0.3);
    // A loud-ish broadband-ish burst should read higher than dead silence.
    const noise = new Float32Array(512);
    for (let i = 0; i < 512; i++)
      noise[i] = (Math.sin(i * 0.7) + Math.sin(i * 1.9)) * 0.4;
    vad.reset();
    const pn = await vad.process(noise);
    expect(pn).toBeGreaterThanOrEqual(0);
    expect(pn).toBeLessThanOrEqual(1);
  }, 20_000);

  it("createSileroVadDetector wires a working VadDetector", async () => {
    const modelPath = await modelPathPromise;
    if (!modelPath) return;
    let det: VadDetector;
    try {
      det = await createSileroVadDetector({
        modelPath,
        config: { onsetThreshold: 0.5 },
      });
    } catch (err) {
      if (err instanceof VadUnavailableError && err.code === "ort-missing")
        return;
      throw err;
    }
    const events: VadEvent[] = [];
    det.onVadEvent((e) => events.push(e));
    // Feed 1 s of silence — should produce no speech events.
    let ts = 0;
    for (let i = 0; i < SR / 512; i++) {
      await det.pushFrame({
        pcm: new Float32Array(512),
        sampleRate: SR,
        timestampMs: ts,
      });
      ts += FRAME_MS;
    }
    await det.flush();
    expect(events.filter((e) => e.type === "speech-start")).toHaveLength(0);
  }, 20_000);

  it("detects exactly one speech segment in a silence+speech+silence fixture and gates out the silence", async () => {
    const modelPath = await modelPathPromise;
    if (!modelPath) return;
    let det: VadDetector;
    try {
      det = await createSileroVadDetector({
        modelPath,
        config: {
          onsetThreshold: 0.5,
          pauseHangoverMs: 220,
          endHangoverMs: 500,
          minSpeechMs: 150,
        },
      });
    } catch (err) {
      if (err instanceof VadUnavailableError && err.code === "ort-missing")
        return;
      throw err;
    }
    const fx = makeSpeechWithSilenceFixture({
      sampleRate: SR,
      leadSilenceSec: 0.6,
      speechSec: 1.2,
      tailSilenceSec: 0.6,
    });
    const speechStartMs = (fx.speechStartSample / SR) * 1000;
    const speechEndMs = (fx.speechEndSample / SR) * 1000;
    const events: VadEvent[] = [];
    det.onVadEvent((e) => events.push(e));
    // Feed the fixture in 512-sample windows on a mic-domain clock.
    for (let i = 0; (i + 1) * 512 <= fx.pcm.length; i++) {
      await det.pushFrame({
        pcm: fx.pcm.slice(i * 512, (i + 1) * 512),
        sampleRate: SR,
        timestampMs: (i * 512 * 1000) / SR,
      });
    }
    await det.flush();
    const starts = events.filter((e) => e.type === "speech-start");
    const ends = events.filter((e) => e.type === "speech-end");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    const start = starts[0];
    if (start.type !== "speech-start") throw new Error("unreachable");
    // The onset must land inside the voiced region, not in the leading
    // silence (small slack for Silero's look-ahead and the pause hangover).
    expect(start.timestampMs).toBeGreaterThan(speechStartMs - 100);
    expect(start.timestampMs).toBeLessThan(speechEndMs);
  }, 30_000);
});
