/**
 * Unit coverage for local-ASR capture helpers: WAV encoding, silence detection,
 * and audio measurement. Pure functions over PCM buffers, no mic.
 */
import { describe, expect, it } from "vitest";
import {
  createLocalAsrAutoStopDetector,
  encodeMonoPcm16Wav,
  isLocalAsrTtsCooldownStartAllowed,
  isSilentPcmAudio,
  measurePcmAudio,
  resolveLocalAsrTtsCooldownGateConfig,
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

  it("parses the post-TTS cooldown with the conservative default", () => {
    expect(resolveLocalAsrTtsCooldownGateConfig().postTtsCooldownMs).toBe(1500);
    expect(
      resolveLocalAsrTtsCooldownGateConfig({ postTtsCooldownMs: 250 })
        .postTtsCooldownMs,
    ).toBe(250);
    expect(
      resolveLocalAsrTtsCooldownGateConfig({ postTtsCooldownMs: -1 })
        .postTtsCooldownMs,
    ).toBe(1500);
  });

  it("raises the capture start gate during TTS cooldown but allows loud barge-in", () => {
    const quietEcho = measurePcmAudio(new Float32Array([0.01, -0.01, 0.008]));
    const loudBargeIn = measurePcmAudio(new Float32Array([0.04, -0.04, 0.035]));
    const gate = {
      lastPlaybackEndedAtMs: () => 1_000,
      postTtsCooldownMs: 1_500,
    };

    expect(isLocalAsrTtsCooldownStartAllowed(quietEcho, gate, 1_400)).toBe(
      false,
    );
    expect(isLocalAsrTtsCooldownStartAllowed(loudBargeIn, gate, 1_400)).toBe(
      true,
    );
    expect(isLocalAsrTtsCooldownStartAllowed(quietEcho, gate, 2_600)).toBe(
      true,
    );
  });

  it("applies the TTS start gate only before speech begins", () => {
    const detect = createLocalAsrAutoStopDetector(
      {
        startGraceMs: 0,
        minSpeechMs: 100,
        silenceMs: 200,
        speechRmsThreshold: 0.003,
        speechPeakThreshold: 0.012,
        ttsCooldownGate: {
          isPlaybackActive: () => true,
          bargeInRmsThreshold: 0.025,
          bargeInPeakThreshold: 0.08,
        },
      },
      0,
    );
    if (!detect) throw new Error("auto-stop detector was not created");

    const quietEcho = new Float32Array([0.01, -0.01, 0.008]);
    const loudBargeIn = new Float32Array([0.04, -0.04, 0.035]);

    expect(detect(quietEcho, 10)).toEqual({
      shouldBuffer: false,
      shouldStop: false,
    });
    expect(detect(loudBargeIn, 20)).toEqual({
      shouldBuffer: true,
      shouldStop: false,
    });
    expect(detect(quietEcho, 30)).toEqual({
      shouldBuffer: true,
      shouldStop: false,
    });
  });
});
