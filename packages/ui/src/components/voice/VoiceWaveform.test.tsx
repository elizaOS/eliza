// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computeBlobRadii,
  type FrequencyAnalyser,
  sampleFrequencyLevels,
  VoiceWaveform,
} from "./VoiceWaveform";

afterEach(() => cleanup());

/** Fake analyser that fills the byte-frequency buffer with a constant value. */
function fakeAnalyser(bins: number, value: number): FrequencyAnalyser {
  return {
    frequencyBinCount: bins,
    getByteFrequencyData: (buf: Uint8Array) => {
      buf.fill(value);
    },
  };
}

function maxRadius(radii: Float32Array): number {
  let max = -Infinity;
  for (const r of radii) max = Math.max(max, r);
  return max;
}

describe("VoiceWaveform", () => {
  it("renders a canvas with the active mode and accessible label", () => {
    render(<VoiceWaveform mode="idle" ariaLabel="Voice activity" />);
    const canvas = screen.getByRole("img", { name: /voice activity/i });
    expect(canvas.tagName).toBe("CANVAS");
    expect(canvas.getAttribute("data-mode")).toBe("idle");
  });

  it("reflects the listening mode", () => {
    render(<VoiceWaveform mode="listening" />);
    expect(screen.getByTestId("voice-waveform").getAttribute("data-mode")).toBe(
      "listening",
    );
  });

  it("does not open its own microphone by default in listening mode", () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    render(<VoiceWaveform mode="listening" />);

    expect(getUserMedia).not.toHaveBeenCalled();
  });
});

describe("sampleFrequencyLevels", () => {
  it("returns zeros when no analyser is supplied", () => {
    const levels = sampleFrequencyLevels(null, 8);
    expect(levels).toHaveLength(8);
    expect([...levels].every((v) => v === 0)).toBe(true);
  });

  it("normalizes loud frequency data toward 1 and silence toward 0", () => {
    const loud = sampleFrequencyLevels(fakeAnalyser(128, 255), 16);
    const quiet = sampleFrequencyLevels(fakeAnalyser(128, 0), 16);
    expect(loud).toHaveLength(16);
    expect(Math.min(...loud)).toBeCloseTo(1, 5);
    expect(Math.max(...quiet)).toBe(0);
  });
});

describe("computeBlobRadii", () => {
  const base = { points: 24, baseRadius: 100, maxDeform: 40 };

  it("pushes the outline further out as amplitude rises (reactive)", () => {
    const silent = computeBlobRadii({
      ...base,
      levels: new Float32Array(base.points).fill(0),
      time: 1,
      mode: "listening",
    });
    const loud = computeBlobRadii({
      ...base,
      levels: new Float32Array(base.points).fill(1),
      time: 1,
      mode: "listening",
    });
    expect(maxRadius(loud)).toBeGreaterThan(maxRadius(silent));
    // Every vertex never collapses below the base radius.
    expect(Math.min(...silent)).toBeGreaterThanOrEqual(base.baseRadius);
  });

  it("breathes over time while idle, ignoring amplitude", () => {
    const levels = new Float32Array(base.points).fill(1);
    const t0 = computeBlobRadii({ ...base, levels, time: 0, mode: "idle" });
    const t1 = computeBlobRadii({ ...base, levels, time: 5, mode: "idle" });
    // Idle ignores levels, so the loud buffer must not blow the radius out.
    expect(maxRadius(t0)).toBeLessThan(base.baseRadius + base.maxDeform * 0.5);
    // The outline still moves between frames.
    const moved = [...t0].some((r, i) => Math.abs(r - (t1[i] ?? 0)) > 1e-3);
    expect(moved).toBe(true);
  });
});
