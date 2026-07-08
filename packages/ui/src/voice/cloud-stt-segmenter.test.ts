// Unit tests for the chunked-streaming capture segmenter (voice V2a).
// Pure state-machine over frames + explicit timestamps (no AudioContext).
// Covers boundary emission (length + pause), the min-speech floor, and the
// echo-gate interaction.

import { describe, expect, it } from "vitest";
import {
  createCloudSttSegmenter,
  DEFAULT_CLOUD_STT_SEGMENTER,
} from "./cloud-stt-segmenter";

/** A loud (speech-level) mono frame. */
function speechFrame(n = 320): Float32Array {
  return new Float32Array(n).fill(0.3);
}
/** A silent frame (below the RMS/peak gates). */
function silentFrame(n = 320): Float32Array {
  return new Float32Array(n).fill(0);
}

const noEchoGate = { isTtsEchoGateActive: () => false };

describe("createCloudSttSegmenter — length-based boundary", () => {
  it("cuts a boundary after ~segmentMs of speech", () => {
    const { update } = createCloudSttSegmenter({
      segmentMs: 1000,
      minSegmentMs: 400,
      ...noEchoGate,
    });
    let t = 0;
    const boundaries: number[] = [];
    // Feed 20 speech frames at 100ms spacing = ~2000ms of speech.
    for (let i = 0; i < 20; i += 1) {
      t += 100;
      const r = update(speechFrame(), t);
      if (r.boundary) boundaries.push(t);
    }
    // First boundary near 1000ms of accumulated speech, second near 2000ms.
    expect(boundaries.length).toBeGreaterThanOrEqual(1);
    expect(boundaries[0]).toBeGreaterThanOrEqual(1000);
  });

  it("does not cut before minSegmentMs of speech", () => {
    const { update } = createCloudSttSegmenter({
      segmentMs: 1000,
      minSegmentMs: 400,
      pauseMs: 100,
      ...noEchoGate,
    });
    let t = 0;
    // 3 speech frames (~300ms) then a long pause — under the 400ms floor, so a
    // pause boundary must NOT fire.
    for (let i = 0; i < 3; i += 1) {
      t += 100;
      expect(update(speechFrame(), t).boundary).toBe(false);
    }
    t += 500;
    expect(update(silentFrame(), t).boundary).toBe(false);
  });

  it("reports speech vs silence per frame", () => {
    const { update } = createCloudSttSegmenter(noEchoGate);
    expect(update(speechFrame(), 100).speech).toBe(true);
    expect(update(silentFrame(), 200).speech).toBe(false);
  });
});

describe("createCloudSttSegmenter — pause-based boundary", () => {
  it("cuts a clean boundary on an intra-utterance pause once min speech met", () => {
    const { update } = createCloudSttSegmenter({
      segmentMs: 5000, // long, so length can't be what triggers
      minSegmentMs: 400,
      pauseMs: 350,
      ...noEchoGate,
    });
    let t = 0;
    // ~600ms of speech (clears the 400ms floor).
    for (let i = 0; i < 6; i += 1) {
      t += 100;
      update(speechFrame(), t);
    }
    // A 400ms silence gap > pauseMs → boundary on the silent frame.
    t += 400;
    const r = update(silentFrame(), t);
    expect(r.boundary).toBe(true);
    expect(r.speech).toBe(false);
  });

  it("resets the speech clock after a boundary (next segment re-accumulates)", () => {
    const { update } = createCloudSttSegmenter({
      segmentMs: 5000,
      minSegmentMs: 400,
      pauseMs: 350,
      ...noEchoGate,
    });
    let t = 0;
    for (let i = 0; i < 6; i += 1) {
      t += 100;
      update(speechFrame(), t);
    }
    t += 400;
    expect(update(silentFrame(), t).boundary).toBe(true);
    // Immediately after: a short burst must NOT instantly re-fire (clock reset).
    t += 100;
    expect(update(speechFrame(), t).boundary).toBe(false);
  });
});

describe("createCloudSttSegmenter — echo gate", () => {
  it("suppresses speech detection while the TTS echo gate is active", () => {
    // With the gate active, the speech threshold is multiplied up; a 0.3 frame
    // that normally reads as speech should read as silence under the 4x gate.
    const { update } = createCloudSttSegmenter({
      isTtsEchoGateActive: () => true,
    });
    // Default gates: rms 0.003, peak 0.012. Under the 4x echo gate they become
    // rms 0.012, peak 0.048. A 0.008 fill (rms=peak=0.008) is above the ungated
    // bar but below BOTH raised bars, so it must read as silence while the gate
    // is active (faint far-field TTS echo suppressed). A loud 0.3 frame would
    // still clear even the raised bar (a real barge-in).
    const faint = new Float32Array(320).fill(0.008);
    expect(update(faint, 100).speech).toBe(false);
    // Sanity: the same faint frame reads as speech with the gate OFF.
    const { update: ungated } = createCloudSttSegmenter({
      isTtsEchoGateActive: () => false,
    });
    expect(ungated(new Float32Array(320).fill(0.008), 100).speech).toBe(true);
  });
});

describe("DEFAULT_CLOUD_STT_SEGMENTER", () => {
  it("has sane defaults (min < segment, pause < turn-end silence)", () => {
    expect(DEFAULT_CLOUD_STT_SEGMENTER.minSegmentMs).toBeLessThan(
      DEFAULT_CLOUD_STT_SEGMENTER.segmentMs,
    );
    // Pause boundary must be softer than the 650ms end-of-turn VAD window.
    expect(DEFAULT_CLOUD_STT_SEGMENTER.pauseMs).toBeLessThan(650);
    expect(DEFAULT_CLOUD_STT_SEGMENTER.overlapMs).toBeGreaterThan(0);
  });
});
