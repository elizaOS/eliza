/**
 * Conservative local speech-onset detection for provisional realtime barge-in.
 *
 * This detector never commits a turn or cancels remote work. It only identifies
 * a sustained, high-energy microphone onset quickly enough for the client to
 * pause local playback while server STT confirms or rejects the interruption.
 */

import { measurePcmAudio } from "./local-asr-capture";

export interface ProvisionalSpeechStartConfig {
  /** Minimum RMS needed during agent playback. Default 0.012. */
  rmsThreshold?: number;
  /** Minimum absolute peak needed during agent playback. Default 0.048. */
  peakThreshold?: number;
  /** Sustained above-threshold audio required before firing. Default 60ms. */
  minimumSpeechMs?: number;
  /** Below-threshold audio required before the detector can fire again. Default 120ms. */
  rearmSilenceMs?: number;
}

export interface ProvisionalSpeechStartEvent {
  atMs: number;
  rms: number;
  peak: number;
}

export const DEFAULT_PROVISIONAL_SPEECH_START_CONFIG: Required<ProvisionalSpeechStartConfig> =
  {
    // These match the existing post-TTS echo gate: 4x the normal local-ASR
    // thresholds. Browser AEC remains the first defense against self-echo.
    rmsThreshold: 0.012,
    peakThreshold: 0.048,
    minimumSpeechMs: 60,
    rearmSilenceMs: 120,
  };

const ANALYSIS_WINDOW_MS = 20;

function requireFiniteNonNegative(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

export class ProvisionalSpeechStartDetector {
  private readonly config: Required<ProvisionalSpeechStartConfig>;
  private speechMs = 0;
  private silenceMs = 0;
  private latched = false;

  constructor(config: ProvisionalSpeechStartConfig = {}) {
    this.config = {
      rmsThreshold: requireFiniteNonNegative(
        "rmsThreshold",
        config.rmsThreshold ??
          DEFAULT_PROVISIONAL_SPEECH_START_CONFIG.rmsThreshold,
      ),
      peakThreshold: requireFiniteNonNegative(
        "peakThreshold",
        config.peakThreshold ??
          DEFAULT_PROVISIONAL_SPEECH_START_CONFIG.peakThreshold,
      ),
      minimumSpeechMs: requireFiniteNonNegative(
        "minimumSpeechMs",
        config.minimumSpeechMs ??
          DEFAULT_PROVISIONAL_SPEECH_START_CONFIG.minimumSpeechMs,
      ),
      rearmSilenceMs: requireFiniteNonNegative(
        "rearmSilenceMs",
        config.rearmSilenceMs ??
          DEFAULT_PROVISIONAL_SPEECH_START_CONFIG.rearmSilenceMs,
      ),
    };
  }

  /** Drop all accumulated evidence when playback is not eligible for interruption. */
  reset(): void {
    this.speechMs = 0;
    this.silenceMs = 0;
    this.latched = false;
  }

  /**
   * Consume one 16 kHz-domain PCM block. Returns one event per speech episode;
   * sustained speech stays latched until the configured silence window passes.
   */
  push(
    pcm: Float32Array,
    sampleRate: number,
    atMs: number,
  ): ProvisionalSpeechStartEvent | null {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new TypeError("sampleRate must be a finite positive number");
    }
    if (pcm.length === 0) return null;

    // Browser callback sizes vary widely. Analyze fixed short windows so one
    // click cannot count as the full duration of a 100-250ms callback.
    const windowSamples = Math.max(
      1,
      Math.round((sampleRate * ANALYSIS_WINDOW_MS) / 1000),
    );
    for (let offset = 0; offset < pcm.length; offset += windowSamples) {
      const window = pcm.subarray(
        offset,
        Math.min(offset + windowSamples, pcm.length),
      );
      const durationMs = (window.length / sampleRate) * 1000;
      const stats = measurePcmAudio(window);
      const aboveThreshold =
        stats.rms >= this.config.rmsThreshold &&
        stats.peak >= this.config.peakThreshold;

      if (aboveThreshold) {
        this.silenceMs = 0;
        if (this.latched) continue;
        this.speechMs += durationMs;
        if (this.speechMs < this.config.minimumSpeechMs) continue;
        this.latched = true;
        return { atMs, ...stats };
      }

      this.speechMs = 0;
      if (!this.latched) continue;
      this.silenceMs += durationMs;
      if (this.silenceMs >= this.config.rearmSilenceMs) {
        this.latched = false;
        this.silenceMs = 0;
      }
    }
    return null;
  }
}
