/**
 * Unit coverage for playback-to-mic echo delay estimation and seed delays in echo-delay.ts.
 *
 * Exercises normalized cross-correlation delay estimation across shifted signals,
 * gain variations, edge cases (empty arrays, minLag > maxLag), and platform seed lookups.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAYBACK_DELAY_MS,
  estimateEchoDelaySamples,
  PLATFORM_PLAYBACK_DELAY_DEFAULTS,
  platformPlaybackDelayMs,
  platformPlaybackDelaySamples,
} from "./echo-delay.js";

describe("echo-delay", () => {
  describe("estimateEchoDelaySamples", () => {
    it("estimates correct sample lag for time-shifted signals with high confidence", () => {
      const length = 500;
      const trueLag = 25;
      const far = new Float32Array(length);
      const near = new Float32Array(length);

      // Generate a distinct pulse signal in far
      for (let i = 0; i < 50; i++) {
        far[i + 100] = Math.sin((i / 50) * Math.PI * 4);
      }

      // Place the same signal in near with a delay of trueLag and gain factor of 0.8
      for (let i = 0; i < 50; i++) {
        near[i + 100 + trueLag] = far[i + 100] * 0.8;
      }

      const estimate = estimateEchoDelaySamples(near, far, {
        minLagSamples: 0,
        maxLagSamples: 100,
      });

      expect(estimate.lagSamples).toBe(trueLag);
      expect(estimate.confidence).toBeGreaterThan(0.95);
    });

    it("returns zero lag and zero confidence for empty buffers", () => {
      const empty = new Float32Array(0);
      const filled = new Float32Array(100);

      expect(estimateEchoDelaySamples(empty, filled)).toEqual({
        lagSamples: 0,
        confidence: 0,
      });
      expect(estimateEchoDelaySamples(filled, empty)).toEqual({
        lagSamples: 0,
        confidence: 0,
      });
    });

    it("returns zero lag and zero confidence when minLag exceeds maxLag", () => {
      const a = new Float32Array(100);
      const b = new Float32Array(100);

      const estimate = estimateEchoDelaySamples(a, b, {
        minLagSamples: 200,
        maxLagSamples: 50,
      });

      expect(estimate).toEqual({
        lagSamples: 0,
        confidence: 0,
      });
    });

    it("handles silent signals gracefully with zero confidence", () => {
      const near = new Float32Array(200);
      const far = new Float32Array(200);

      const estimate = estimateEchoDelaySamples(near, far, {
        minLagSamples: 0,
        maxLagSamples: 50,
      });

      expect(estimate.confidence).toBe(0);
    });
  });

  describe("platformPlaybackDelayMs", () => {
    it("returns platform defaults for known platforms", () => {
      expect(platformPlaybackDelayMs("darwin")).toBe(
        PLATFORM_PLAYBACK_DELAY_DEFAULTS.darwin,
      );
      expect(platformPlaybackDelayMs("ios")).toBe(
        PLATFORM_PLAYBACK_DELAY_DEFAULTS.ios,
      );
      expect(platformPlaybackDelayMs("android")).toBe(
        PLATFORM_PLAYBACK_DELAY_DEFAULTS.android,
      );
      expect(platformPlaybackDelayMs("win32")).toBe(
        PLATFORM_PLAYBACK_DELAY_DEFAULTS.win32,
      );
      expect(platformPlaybackDelayMs("linux")).toBe(
        PLATFORM_PLAYBACK_DELAY_DEFAULTS.linux,
      );
    });

    it("falls back to DEFAULT_PLAYBACK_DELAY_MS for unknown platform", () => {
      expect(platformPlaybackDelayMs("freebsd")).toBe(
        DEFAULT_PLAYBACK_DELAY_MS,
      );
      expect(platformPlaybackDelayMs("unknown-os")).toBe(
        DEFAULT_PLAYBACK_DELAY_MS,
      );
    });
  });

  describe("platformPlaybackDelaySamples", () => {
    it("computes sample delays correctly for default 16kHz sample rate", () => {
      // darwin = 20ms -> (20 / 1000) * 16000 = 320 samples
      expect(platformPlaybackDelaySamples("darwin")).toBe(320);

      // android = 45ms -> (45 / 1000) * 16000 = 720 samples
      expect(platformPlaybackDelaySamples("android")).toBe(720);
    });

    it("computes sample delays correctly for custom sample rates", () => {
      // darwin = 20ms at 48kHz -> (20 / 1000) * 48000 = 960 samples
      expect(platformPlaybackDelaySamples("darwin", 48_000)).toBe(960);
    });
  });
});
