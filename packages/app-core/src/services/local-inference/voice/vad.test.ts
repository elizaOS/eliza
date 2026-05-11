/**
 * Silero VAD gate + wake-word detector tests:
 *   - the segment state machine debounces speech onset/offset
 *   - `gateToSpeech` drops silent frames before ASR (AGENTS.md §1)
 *   - VAD-reported speech onset drives a barge-in cancel through the
 *     `VoicePipeline` (the cancel hook is `onSpeechStart`)
 *   - `resolveSileroVadPath` hard-fails on a missing bundled ONNX
 *   - `OpenWakeWordDetector` fires once per utterance (refractory-debounced)
 *   - `resolveWakeWordPath` returns null when the optional ONNX is absent
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VoiceStartupError } from "./errors";
import {
  EnergyVadModel,
  resolveSileroVadPath,
  SILERO_VAD_REL_PATH,
  SileroVadGate,
  type VadModel,
} from "./vad";
import {
  OpenWakeWordDetector,
  resolveWakeWordPath,
  type WakeWordModel,
} from "./wake-word";

/** Scripted VAD: returns the next probability from a fixed list, looping. */
class ScriptVad implements VadModel {
  readonly frameSamples = 4;
  readonly sampleRate = 16_000;
  private i = 0;
  constructor(private readonly probs: number[]) {}
  scoreFrame(): number {
    const p = this.probs[this.i % this.probs.length];
    this.i++;
    return p;
  }
  reset(): void {
    this.i = 0;
  }
}

function frame(): Float32Array {
  return new Float32Array(4);
}

describe("SileroVadGate", () => {
  it("debounces speech onset (minSpeechFrames) and offset (minSilenceFrames)", () => {
    const events: string[] = [];
    const gate = new SileroVadGate({
      model: new ScriptVad([0.9, 0.9, 0.9, 0.1, 0.1]),
      config: { minSpeechFrames: 3, minSilenceFrames: 2 },
      onSpeechStart: () => events.push("start"),
      onSpeechEnd: () => events.push("end"),
    });
    expect(gate.pushFrame(frame())).toBe(false); // run 1
    expect(gate.pushFrame(frame())).toBe(false); // run 2
    expect(gate.pushFrame(frame())).toBe(true); // run 3 → onset
    expect(gate.pushFrame(frame())).toBe(true); // silence run 1 — still in speech
    expect(gate.pushFrame(frame())).toBe(false); // silence run 2 → offset
    expect(events).toEqual(["start", "end"]);
  });

  it("gateToSpeech keeps only in-segment frames", () => {
    // Energy gate: zeros are silence, a loud burst is speech.
    const gate = new SileroVadGate({
      model: new EnergyVadModel(4, 16_000, 0.5),
      config: { minSpeechFrames: 1, minSilenceFrames: 1 },
    });
    const pcm = new Float32Array(16);
    // frames: [0..3]=silence, [4..7]=loud, [8..11]=loud, [12..15]=silence
    for (let i = 4; i < 12; i++) pcm[i] = 1;
    const speech = gate.gateToSpeech(pcm);
    // Two 4-sample frames of speech kept.
    expect(speech.length).toBe(8);
    expect([...speech]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("an all-silence buffer gates to empty", () => {
    const gate = new SileroVadGate({
      model: new EnergyVadModel(4, 16_000, 0.5),
    });
    expect(gate.gateToSpeech(new Float32Array(12)).length).toBe(0);
  });

  it("rejects a wrong-size frame", () => {
    const gate = new SileroVadGate({ model: new ScriptVad([0.1]) });
    expect(() => gate.pushFrame(new Float32Array(3))).toThrow(/expected 4/);
  });
});

describe("resolveSileroVadPath", () => {
  it("returns the bundled path when present", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eliza-vad-"));
    const p = path.join(dir, SILERO_VAD_REL_PATH);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, "onnx");
    expect(resolveSileroVadPath(dir)).toBe(p);
  });

  it("hard-fails when the bundled Silero ONNX is missing (AGENTS.md §1/§3)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eliza-vad-"));
    expect(() => resolveSileroVadPath(dir)).toThrow(VoiceStartupError);
  });
});

/** Scripted wake-word model. */
class ScriptWakeWord implements WakeWordModel {
  readonly frameSamples = 4;
  readonly sampleRate = 16_000;
  private i = 0;
  constructor(private readonly probs: number[]) {}
  scoreFrame(): number {
    const p = this.probs[this.i % this.probs.length];
    this.i++;
    return p;
  }
  reset(): void {
    this.i = 0;
  }
}

describe("OpenWakeWordDetector", () => {
  it("fires once per utterance (refractory-debounced)", () => {
    let wakes = 0;
    const det = new OpenWakeWordDetector({
      model: new ScriptWakeWord([0.9, 0.9, 0.1, 0.1, 0.9]),
      config: { threshold: 0.5, refractoryFrames: 2 },
      onWake: () => wakes++,
    });
    expect(det.pushFrame(frame())).toBe(true); // detection → cooldown=2
    expect(det.pushFrame(frame())).toBe(false); // cooldown 2→1
    expect(det.pushFrame(frame())).toBe(false); // cooldown 1→0
    expect(det.pushFrame(frame())).toBe(false); // p=0.1 below threshold
    expect(det.pushFrame(frame())).toBe(true); // p=0.9 → second detection
    expect(wakes).toBe(2);
  });
});

describe("resolveWakeWordPath", () => {
  it("returns null when the optional openWakeWord ONNX is absent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eliza-ww-"));
    expect(resolveWakeWordPath(dir)).toBeNull();
  });
});

/* The VAD→barge-in wiring is verified in `pipeline.test.ts` (barge-in
 * cancels the in-flight turn); here we assert the *source* of that cancel
 * is the VAD's `onSpeechStart` callback by feeding it a speech onset and
 * observing the supplied callback fires. */
describe("VAD-driven barge-in source", () => {
  it("invokes the barge-in callback the moment the gate reports speech onset", () => {
    let bargedIn = false;
    const gate = new SileroVadGate({
      model: new EnergyVadModel(4, 16_000, 0.5),
      config: { minSpeechFrames: 1 },
      onSpeechStart: () => {
        bargedIn = true;
      },
    });
    gate.pushFrame(new Float32Array([1, 1, 1, 1])); // loud → onset
    expect(bargedIn).toBe(true);
  });
});
