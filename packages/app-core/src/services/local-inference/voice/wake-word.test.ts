/**
 * Wake-word tests — openWakeWord streaming detector.
 *
 *   - `OpenWakeWordDetector`: refractory debounce + threshold gating,
 *     driven by a deterministic scripted `WakeWordModel`.
 *   - `OpenWakeWordModel` / `loadBundledWakeWordModel`: a network-gated
 *     test against the real Apache-2.0 openWakeWord ONNX graphs —
 *     downloaded into a temp dir on first run, skipped offline. This is
 *     the only test that touches `onnxruntime-node` here.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OpenWakeWordDetector,
  OpenWakeWordModel,
  resolveWakeWordModel,
  type WakeWordModel,
  WakeWordUnavailableError,
} from "./wake-word";

const FRAME = 1280; // 80 ms @ 16 kHz — what openWakeWord consumes per step.

// --- Deterministic scripted model -----------------------------------------

class ScriptedWakeWordModel implements WakeWordModel {
  readonly frameSamples = FRAME;
  readonly sampleRate = 16_000;
  private idx = 0;
  resets = 0;
  scored = 0;
  constructor(private readonly probs: readonly number[]) {}
  async scoreFrame(frame: Float32Array): Promise<number> {
    expect(frame.length).toBe(FRAME);
    this.scored++;
    const p = this.probs[this.idx] ?? this.probs[this.probs.length - 1] ?? 0;
    this.idx++;
    return p;
  }
  reset(): void {
    this.resets++;
    this.idx = 0;
  }
}

function zeroFrame(): Float32Array {
  return new Float32Array(FRAME);
}

describe("OpenWakeWordDetector", () => {
  it("fires onWake once when probability crosses the threshold", async () => {
    const model = new ScriptedWakeWordModel([0.1, 0.2, 0.9, 0.95, 0.1]);
    let fired = 0;
    const det = new OpenWakeWordDetector({
      model,
      config: { threshold: 0.5, refractoryFrames: 10 },
      onWake: () => fired++,
    });
    const hits: boolean[] = [];
    for (let i = 0; i < 5; i++) hits.push(await det.pushFrame(zeroFrame()));
    expect(fired).toBe(1);
    expect(hits).toEqual([false, false, true, false, false]);
    // Scored every frame, including during the refractory window.
    expect(model.scored).toBe(5);
  });

  it("debounces a sustained detection during the refractory window", async () => {
    const model = new ScriptedWakeWordModel([0.9, 0.9, 0.9, 0.9, 0.9]);
    let fired = 0;
    const det = new OpenWakeWordDetector({
      model,
      config: { threshold: 0.5, refractoryFrames: 25 },
      onWake: () => fired++,
    });
    for (let i = 0; i < 5; i++) await det.pushFrame(zeroFrame());
    expect(fired).toBe(1); // fire@0, then 4 frames all inside the 25-frame refractory window
  });

  it("re-arms after the refractory window elapses", async () => {
    const model = new ScriptedWakeWordModel([0.9, 0.1, 0.1, 0.9]);
    let fired = 0;
    const det = new OpenWakeWordDetector({
      model,
      config: { threshold: 0.5, refractoryFrames: 2 },
      onWake: () => fired++,
    });
    for (let i = 0; i < 4; i++) await det.pushFrame(zeroFrame());
    expect(fired).toBe(2); // fire@0, cooldown 2 → frames 1,2 silent, fire@3
  });

  it("rejects a wrong-length frame", async () => {
    const det = new OpenWakeWordDetector({
      model: new ScriptedWakeWordModel([0.1]),
      onWake: () => {},
    });
    await expect(det.pushFrame(new Float32Array(640))).rejects.toThrow(
      /1280/,
    );
  });

  it("reset() clears the cooldown and the model state", async () => {
    const model = new ScriptedWakeWordModel([0.9, 0.9]);
    let fired = 0;
    const det = new OpenWakeWordDetector({
      model,
      config: { threshold: 0.5, refractoryFrames: 50 },
      onWake: () => fired++,
    });
    await det.pushFrame(zeroFrame()); // fires, long cooldown
    expect(fired).toBe(1);
    det.reset();
    expect(model.resets).toBe(1);
    await det.pushFrame(zeroFrame()); // cooldown cleared → fires again
    expect(fired).toBe(2);
  });
});

describe("resolveWakeWordModel", () => {
  it("returns null when the bundle has no wake-word graphs (optional asset)", () => {
    expect(
      resolveWakeWordModel({ bundleRoot: "/nonexistent/bundle" }),
    ).toBeNull();
  });
});

// --- Network-gated real-model test ----------------------------------------

const OWW_BASE =
  "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1";
const OWW_FILES = [
  ["melspectrogram.onnx", "melspectrogram.onnx"],
  ["embedding_model.onnx", "embedding_model.onnx"],
  // openWakeWord ships several heads; "hey_jarvis" stands in for the
  // Eliza-1 default ("hey-eliza") in tests — the pipeline is identical.
  ["hey_jarvis_v0.1.onnx", "hey-eliza.onnx"],
] as const;

async function tryFetchWakeWordGraphs(): Promise<{
  melspectrogram: string;
  embedding: string;
  head: string;
} | null> {
  if (process.env.CI && !process.env.ELIZA_WAKEWORD_ALLOW_NETWORK) return null;
  try {
    const dir = mkdtempSync(path.join(tmpdir(), "eliza-oww-"));
    const out: Record<string, string> = {};
    for (const [remote, local] of OWW_FILES) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12_000);
      const res = await fetch(`${OWW_BASE}/${remote}`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength < 100_000) return null;
      const p = path.join(dir, local);
      writeFileSync(p, bytes);
      out[local] = p;
    }
    return {
      melspectrogram: out["melspectrogram.onnx"],
      embedding: out["embedding_model.onnx"],
      head: out["hey-eliza.onnx"],
    };
  } catch {
    return null;
  }
}

const graphsPromise = tryFetchWakeWordGraphs();

describe("OpenWakeWordModel — real ONNX graphs (network-gated)", () => {
  it("loads, runs 1280-sample frames, and reads near-zero P(wake) on silence", async () => {
    const graphs = await graphsPromise;
    if (!graphs) {
      console.warn(
        "[wake-word.test] Skipping real openWakeWord ONNX test — graphs not available offline. Set ELIZA_WAKEWORD_ALLOW_NETWORK=1.",
      );
      return;
    }
    let model: OpenWakeWordModel;
    try {
      model = await OpenWakeWordModel.load(graphs);
    } catch (err) {
      if (
        err instanceof WakeWordUnavailableError &&
        err.code === "ort-missing"
      ) {
        console.warn("[wake-word.test] Skipping — onnxruntime-node not installed.");
        return;
      }
      throw err;
    }
    expect(model.frameSamples).toBe(1280);
    expect(model.sampleRate).toBe(16_000);
    // ~2 s of silence; the head only re-runs once enough context accumulates.
    let maxP = 0;
    for (let i = 0; i < Math.floor((2 * 16_000) / 1280); i++) {
      const p = await model.scoreFrame(new Float32Array(1280));
      maxP = Math.max(maxP, p);
    }
    expect(maxP).toBeGreaterThanOrEqual(0);
    expect(maxP).toBeLessThan(0.3);
    // Reset must not throw and must let the pipeline run again.
    model.reset();
    const p = await model.scoreFrame(new Float32Array(1280));
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  }, 60_000);
});
