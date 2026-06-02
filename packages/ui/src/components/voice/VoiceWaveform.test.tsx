// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type FrequencyAnalyser,
  sampleFrequencyLevels,
  summarizeLevels,
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

describe("VoiceWaveform", () => {
  it("renders the active mode and accessible label", () => {
    render(<VoiceWaveform mode="idle" ariaLabel="Voice activity" />);
    const waveform = screen.getByRole("img", { name: /voice activity/i });
    expect(waveform.getAttribute("data-mode")).toBe("idle");
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

describe("summarizeLevels", () => {
  it("returns zeros for an empty buffer", () => {
    expect(summarizeLevels(new Float32Array(0))).toEqual({
      energy: 0,
      low: 0,
      mid: 0,
      high: 0,
    });
  });

  it("averages a uniform spectrum to equal bands and energy", () => {
    const summary = summarizeLevels(new Float32Array(30).fill(1));
    expect(summary.energy).toBeCloseTo(1, 5);
    expect(summary.low).toBeCloseTo(1, 5);
    expect(summary.mid).toBeCloseTo(1, 5);
    expect(summary.high).toBeCloseTo(1, 5);
  });

  it("isolates energy into the band where it lives", () => {
    const bass = new Float32Array(30);
    bass.fill(1, 0, 10); // only the low third is loud
    const summary = summarizeLevels(bass);
    expect(summary.low).toBeCloseTo(1, 5);
    expect(summary.mid).toBe(0);
    expect(summary.high).toBe(0);
    expect(summary.energy).toBeCloseTo(1 / 3, 5);
  });
});
