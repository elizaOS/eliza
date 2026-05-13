/**
 * V1 / V4 — fast-endpoint and adaptive-hangover VAD tests.
 *
 * V1: when `fastEndpointEnabled` is true, the detector uses
 * `fastPauseHangoverMs` instead of the conservative 220 ms default.
 *
 * V4: with `adaptiveHangoverScaleOnDrop` set, a sharp downward RMS
 * trajectory (energy trailing off) collapses the pause hangover to the
 * configured floor — the detector decides "you stopped talking" sooner
 * when the audio confirms it.
 */

import { describe, expect, it } from "vitest";
import type { PcmFrame, VadEvent } from "./types";
import { VadDetector, type VadLike } from "./vad";

const SR = 16_000;
const FRAME = 512;
const FRAME_MS = (FRAME / SR) * 1000; // 32 ms

/**
 * Scripted Silero whose speech probability AND the input PCM RMS are
 * scripted in lockstep. The V4 path reads `rms(window)` from the
 * detector — so the input pcm samples must produce the desired RMS.
 */
class ScriptedSileroWithEnergy implements VadLike {
  readonly sampleRate = SR;
  readonly windowSamples = FRAME;
  resets = 0;
  private idx = 0;
  constructor(private readonly probs: readonly number[]) {}
  async process(_window: Float32Array): Promise<number> {
    const p = this.probs[this.idx] ?? this.probs[this.probs.length - 1] ?? 0;
    this.idx++;
    return p;
  }
  reset(): void {
    this.resets++;
  }
}

/**
 * Build a frame whose RMS is approximately `targetRms`. A constant-value
 * PCM block has RMS = |value| — easiest scriptable shape.
 */
function frameWithRms(targetRms: number, ts: number): PcmFrame {
  const pcm = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) pcm[i] = targetRms;
  return { pcm, sampleRate: SR, timestampMs: ts };
}

async function runScript(
  det: VadDetector,
  rmsScript: readonly number[],
): Promise<VadEvent[]> {
  const events: VadEvent[] = [];
  det.onVadEvent((e) => events.push(e));
  let ts = 1000;
  for (const r of rmsScript) {
    await det.pushFrame(frameWithRms(r, ts));
    ts += FRAME_MS;
  }
  await det.flush();
  return events;
}

describe("V1 — fast-endpoint pause hangover", () => {
  it("uses fastPauseHangoverMs when fastEndpointEnabled=true", async () => {
    // 3 speech windows, then silence. With fast=100 ms and FRAME=32 ms,
    // pause fires after ceil(100/32) ≈ 4 silence windows.
    const probs = [
      0.9, 0.9, 0.9, 0.9, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05,
    ];
    const det = new VadDetector(new ScriptedSileroWithEnergy(probs), {
      onsetThreshold: 0.5,
      pauseHangoverMs: 220,
      fastPauseHangoverMs: 100,
      fastEndpointEnabled: true,
      endHangoverMs: 700,
      minSpeechMs: 1,
      activeHeartbeatMs: 10_000,
      // Disable V4 so this test isolates V1.
      adaptiveHangoverScaleOnDrop: 1,
    });
    const events = await runScript(
      det,
      [
        0.4, 0.4, 0.4, 0.4, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001,
        0.001,
      ],
    );
    const pauseIndex = events.findIndex((e) => e.type === "speech-pause");
    expect(pauseIndex).toBeGreaterThanOrEqual(0);
    const pause = events[pauseIndex];
    if (pause.type !== "speech-pause") throw new Error("type narrow failed");
    // Pause fired after ~4 silence windows (~128 ms), well under the
    // legacy 220 ms hangover.
    expect(pause.pauseDurationMs).toBeLessThan(200);
    expect(pause.pauseDurationMs).toBeGreaterThan(80);
  });

  it("uses the conservative pauseHangoverMs when fastEndpointEnabled=false", async () => {
    const probs = [
      0.9, 0.9, 0.9, 0.9, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05,
      0.05,
    ];
    const det = new VadDetector(new ScriptedSileroWithEnergy(probs), {
      onsetThreshold: 0.5,
      pauseHangoverMs: 220,
      fastPauseHangoverMs: 100,
      fastEndpointEnabled: false,
      endHangoverMs: 700,
      minSpeechMs: 1,
      activeHeartbeatMs: 10_000,
      adaptiveHangoverScaleOnDrop: 1,
    });
    const events = await runScript(
      det,
      [
        0.4, 0.4, 0.4, 0.4, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001,
        0.001, 0.001, 0.001,
      ],
    );
    const pause = events.find((e) => e.type === "speech-pause");
    expect(pause).toBeDefined();
    if (!pause || pause.type !== "speech-pause") throw new Error("missing");
    // Pause fired only after >= 220 ms (7 silence windows = ~224 ms).
    expect(pause.pauseDurationMs).toBeGreaterThanOrEqual(220);
  });
});

describe("V4 — adaptive hangover on sharp RMS drop", () => {
  it("collapses the pause hangover when RMS trails off sharply", async () => {
    // Probability tells the speech state machine "still speaking" /
    // "below offset"; the RMS shape decides whether V4 fires. Probs:
    // start speaking, three windows below offset threshold (so the
    // detector enters its "trailing off" window). RMS shape: high, high,
    // high, then a sharp drop across the last three windows.
    const probs = [0.9, 0.9, 0.9, 0.3, 0.3, 0.3, 0.05, 0.05, 0.05, 0.05];
    const det = new VadDetector(new ScriptedSileroWithEnergy(probs), {
      onsetThreshold: 0.5,
      offsetThreshold: 0.35,
      pauseHangoverMs: 400, // conservative; V4 should shorten it
      fastEndpointEnabled: false,
      endHangoverMs: 1500,
      minSpeechMs: 1,
      activeHeartbeatMs: 10_000,
      adaptiveHangoverScaleOnDrop: 0.25, // collapse to 25% of base
      adaptiveHangoverFloorMs: 50,
      adaptiveHangoverDropThreshold: -0.02,
    });
    // RMS script — sharp drop across last three windows so the rolling
    // window slope is well below -0.02.
    const rmsScript = [
      0.3, 0.3, 0.3, 0.3, 0.2, 0.05, 0.001, 0.001, 0.001, 0.001,
    ];
    const events = await runScript(det, rmsScript);
    const pause = events.find((e) => e.type === "speech-pause");
    expect(pause).toBeDefined();
    if (!pause || pause.type !== "speech-pause") throw new Error("missing");
    // Without V4 the pause would not fire until 400 ms (~12.5 windows).
    // With V4 shortening to 100 ms (25% of 400), pause fires after ~3-4
    // silence windows.
    expect(pause.pauseDurationMs).toBeLessThan(400);
  });

  it("disables adaptive hangover when scaleOnDrop is 1.0", async () => {
    // 3 speech windows + many silence windows — pause must wait the full
    // 400 ms conservative hangover (≈13 silence windows at 32 ms each).
    const probs = [
      0.9, 0.9, 0.9, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05,
      0.05, 0.05, 0.05, 0.05, 0.05,
    ];
    const det = new VadDetector(new ScriptedSileroWithEnergy(probs), {
      onsetThreshold: 0.5,
      offsetThreshold: 0.35,
      pauseHangoverMs: 400,
      fastEndpointEnabled: false,
      endHangoverMs: 1500,
      minSpeechMs: 1,
      activeHeartbeatMs: 10_000,
      // Adaptive disabled — pause must wait the full conservative 400 ms.
      adaptiveHangoverScaleOnDrop: 1,
    });
    const rmsScript = [
      0.3, 0.3, 0.3, 0.2, 0.05, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001,
      0.001, 0.001, 0.001, 0.001, 0.001, 0.001,
    ];
    const events = await runScript(det, rmsScript);
    const pause = events.find((e) => e.type === "speech-pause");
    expect(pause).toBeDefined();
    if (!pause || pause.type !== "speech-pause") throw new Error("missing");
    expect(pause.pauseDurationMs).toBeGreaterThanOrEqual(400);
  });

  it("respects the adaptiveHangoverFloorMs", async () => {
    const probs = [0.9, 0.9, 0.9, 0.3, 0.3, 0.3, 0.05, 0.05, 0.05, 0.05];
    const det = new VadDetector(new ScriptedSileroWithEnergy(probs), {
      onsetThreshold: 0.5,
      offsetThreshold: 0.35,
      pauseHangoverMs: 400,
      fastEndpointEnabled: false,
      endHangoverMs: 1500,
      minSpeechMs: 1,
      activeHeartbeatMs: 10_000,
      // Tiny scale + a floor — the effective hangover must be at least
      // the floor.
      adaptiveHangoverScaleOnDrop: 0.1,
      adaptiveHangoverFloorMs: 64,
      adaptiveHangoverDropThreshold: -0.02,
    });
    const rmsScript = [
      0.3, 0.3, 0.3, 0.3, 0.2, 0.05, 0.001, 0.001, 0.001, 0.001,
    ];
    const events = await runScript(det, rmsScript);
    const pause = events.find((e) => e.type === "speech-pause");
    expect(pause).toBeDefined();
    if (!pause || pause.type !== "speech-pause") throw new Error("missing");
    // Floor is 64 ms (~2 windows). Pause shouldn't fire before that.
    expect(pause.pauseDurationMs).toBeGreaterThanOrEqual(64);
  });
});
