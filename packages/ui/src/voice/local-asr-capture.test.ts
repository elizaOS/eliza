/**
 * Unit coverage for local-ASR capture helpers: WAV encoding, silence detection,
 * and audio measurement. Pure functions over PCM buffers, no mic.
 */
import { describe, expect, it } from "vitest";
import {
  createLocalAsrAutoStopDetector,
  encodeMonoPcm16Wav,
  isSilentPcmAudio,
  measurePcmAudio,
} from "./local-asr-capture";

describe("local ASR capture", () => {
  it("detects truly silent PCM before sending it to ASR", () => {
    const pcm = new Float32Array(16000);

    expect(measurePcmAudio(pcm)).toEqual({ rms: 0, peak: 0 });
    expect(isSilentPcmAudio(pcm)).toBe(true);
  });

  it("keeps low but real microphone signal eligible for ASR", () => {
    const pcm = new Float32Array(16000);
    pcm[1200] = 0.001;
    pcm[1201] = -0.001;

    expect(measurePcmAudio(pcm).peak).toBeCloseTo(0.001);
    expect(isSilentPcmAudio(pcm)).toBe(false);
  });

  it("encodes mono PCM16 WAV with the requested sample rate", () => {
    const wav = encodeMonoPcm16Wav(new Float32Array([0, 1, -1]), 16000);
    const view = new DataView(wav.buffer);

    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(6);
  });

  it("ignores startup audio and stops after speech followed by silence", () => {
    const detect = createLocalAsrAutoStopDetector(
      {
        startGraceMs: 100,
        minSpeechMs: 100,
        silenceMs: 200,
        speechPeakThreshold: 0.01,
      },
      0,
    );
    if (!detect) throw new Error("auto-stop detector was not created");

    const speech = new Float32Array([0.02, -0.02, 0.015]);
    const silence = new Float32Array([0, 0, 0]);

    expect(detect(speech, 50)).toEqual({
      shouldBuffer: false,
      shouldStop: false,
    });
    expect(detect(speech, 120)).toEqual({
      shouldBuffer: true,
      shouldStop: false,
    });
    expect(detect(speech, 260)).toEqual({
      shouldBuffer: true,
      shouldStop: false,
    });
    expect(detect(silence, 520)).toEqual({
      shouldBuffer: false,
      shouldStop: true,
    });
  });

  it("suppresses quiet echo while the TTS echo gate is active (#12256 layer 1)", () => {
    // Gate always on: the 4x multiplier lifts the RMS bar 0.003→0.012 and the
    // peak bar 0.012→0.048. The echo below (rms ~0.0077, peak 0.008) is above
    // the DEFAULT bar (would be heard) but below the raised gate → suppressed.
    const detect = createLocalAsrAutoStopDetector(
      { startGraceMs: 0, isTtsEchoGateActive: () => true },
      0,
    );
    if (!detect) throw new Error("auto-stop detector was not created");
    const quietEcho = new Float32Array([0.008, -0.008, 0.007]);
    expect(detect(quietEcho, 100)).toEqual({
      shouldBuffer: false,
      shouldStop: false,
    });
  });

  it("still hears a loud barge-in through the active echo gate", () => {
    const detect = createLocalAsrAutoStopDetector(
      { startGraceMs: 0, isTtsEchoGateActive: () => true },
      0,
    );
    if (!detect) throw new Error("auto-stop detector was not created");
    // A loud, close interjection (0.2 peak) clears even the raised 0.048 bar.
    const loudInterjection = new Float32Array([0.2, -0.22, 0.19]);
    expect(detect(loudInterjection, 100)).toEqual({
      shouldBuffer: true,
      shouldStop: false,
    });
  });

  it("returns to the normal bar once the gate is inactive", () => {
    const detect = createLocalAsrAutoStopDetector(
      { startGraceMs: 0, isTtsEchoGateActive: () => false },
      0,
    );
    if (!detect) throw new Error("auto-stop detector was not created");
    // Same quiet echo, gate off → now above the default 0.003 RMS bar.
    const quiet = new Float32Array([0.008, -0.008, 0.007]);
    expect(detect(quiet, 100)).toEqual({
      shouldBuffer: true,
      shouldStop: false,
    });
  });
});
