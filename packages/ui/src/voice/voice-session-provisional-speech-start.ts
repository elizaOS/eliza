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
  /**
   * Total sustained above-threshold audio required to confirm local speech.
   * Default 300ms. This stays below the coordinator's 350ms provisional
   * deadline so a real continuing utterance cannot briefly resume stale audio
   * while waiting for a slower provider partial.
   */
  confirmationSpeechMs?: number;
  /** Below-threshold audio required before the detector can fire again. Default 120ms. */
  rearmSilenceMs?: number;
}

export interface ProvisionalSpeechStartEvent {
  phase: "started" | "confirmed" | "ended";
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
    confirmationSpeechMs: 300,
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
  private started = false;
  private confirmed = false;

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
      confirmationSpeechMs: requireFiniteNonNegative(
        "confirmationSpeechMs",
        config.confirmationSpeechMs ??
          DEFAULT_PROVISIONAL_SPEECH_START_CONFIG.confirmationSpeechMs,
      ),
      rearmSilenceMs: requireFiniteNonNegative(
        "rearmSilenceMs",
        config.rearmSilenceMs ??
          DEFAULT_PROVISIONAL_SPEECH_START_CONFIG.rearmSilenceMs,
      ),
    };
    if (this.config.confirmationSpeechMs < this.config.minimumSpeechMs) {
      throw new TypeError(
        "confirmationSpeechMs must be greater than or equal to minimumSpeechMs",
      );
    }
  }

  /** Drop all accumulated evidence when playback is not eligible for interruption. */
  reset(): void {
    this.speechMs = 0;
    this.silenceMs = 0;
    this.started = false;
    this.confirmed = false;
  }

  /**
   * Consume one 16 kHz-domain PCM block. Returns ordered lifecycle evidence:
   * start, sustained local confirmation, then end/rearm after real silence.
   */
  push(
    pcm: Float32Array,
    sampleRate: number,
    atMs: number,
  ): readonly ProvisionalSpeechStartEvent[] {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new TypeError("sampleRate must be a finite positive number");
    }
    if (pcm.length === 0) return [];

    const events: ProvisionalSpeechStartEvent[] = [];
    const blockDurationMs = (pcm.length / sampleRate) * 1000;

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
      const windowAtMs =
        atMs - blockDurationMs + ((offset + window.length) / sampleRate) * 1000;
      const aboveThreshold =
        stats.rms >= this.config.rmsThreshold &&
        stats.peak >= this.config.peakThreshold;

      if (aboveThreshold) {
        this.silenceMs = 0;
        this.speechMs += durationMs;
        if (!this.started && this.speechMs >= this.config.minimumSpeechMs) {
          this.started = true;
          events.push({ phase: "started", atMs: windowAtMs, ...stats });
        }
        if (
          this.started &&
          !this.confirmed &&
          this.speechMs >= this.config.confirmationSpeechMs
        ) {
          this.confirmed = true;
          events.push({ phase: "confirmed", atMs: windowAtMs, ...stats });
        }
        continue;
      }

      if (!this.started) {
        this.speechMs = 0;
        continue;
      }
      this.silenceMs += durationMs;
      if (this.silenceMs >= this.config.rearmSilenceMs) {
        events.push({ phase: "ended", atMs: windowAtMs, ...stats });
        this.speechMs = 0;
        this.silenceMs = 0;
        this.started = false;
        this.confirmed = false;
      }
    }
    return events;
  }
}
