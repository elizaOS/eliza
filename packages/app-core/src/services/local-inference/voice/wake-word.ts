/**
 * Wake-word detection (openWakeWord) — opt-in, local-mode only.
 *
 * Per `packages/inference/AGENTS.md` §1 + the three-mode rules (§1, §5):
 *   - openWakeWord (Apache-2.0, ~3 MB) ships in the bundle but is
 *     **opt-in**: voice mode works without it (push-to-talk / VAD-gated).
 *   - It is **local-mode only**. In `cloud` mode the surface is hidden
 *     *and inert* (hide-not-disable §5): the model is not loaded, the
 *     setting is rejected by the API, no background job runs it.
 *   - Detections feed the same place a push-to-talk press would: they arm
 *     a listening window that the VAD gate then bounds.
 *
 * This module is the runtime seam — the ONNX inference is behind
 * `WakeWordModel.scoreFrame` so the platform picks the runtime. There is
 * no test-only fallback model here (unlike VAD's energy gate) because a
 * wake word has no meaningful heuristic stand-in; tests inject a scripted
 * `WakeWordModel`.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/** Relative path of the bundled openWakeWord ONNX inside an Eliza-1 bundle. */
export const OPENWAKEWORD_REL_PATH = "wake/openwakeword.onnx";

/**
 * Per-frame wake-word probability source. openWakeWord runs on 80 ms
 * frames of 16 kHz mel features; `scoreFrame` takes one PCM frame and
 * returns P(wake) in [0, 1]. Stateful (the model has a streaming
 * front-end); `reset()` clears it.
 */
export interface WakeWordModel {
  readonly frameSamples: number;
  readonly sampleRate: number;
  scoreFrame(frame: Float32Array): number;
  reset(): void;
}

export interface WakeWordConfig {
  /** P(wake) above this fires a detection. openWakeWord default ~0.5. */
  threshold?: number;
  /**
   * Refractory frames after a detection during which no new detection
   * fires (debounce a single utterance into one event).
   */
  refractoryFrames?: number;
}

const DEFAULTS: Required<WakeWordConfig> = {
  threshold: 0.5,
  refractoryFrames: 25, // ~2 s @ 80 ms frames
};

/**
 * Streaming wake-word detector. Feed frames; `onWake` fires once per
 * detected utterance (refractory-debounced). The voice loop wires `onWake`
 * to "start a listening window" — exactly what a push-to-talk press does.
 *
 * Only constructed in `local` mode. `cloud` mode never instantiates this
 * (and `resolveWakeWordPath` is never called there), so the surface is
 * inert per the hide-not-disable rule.
 */
export class OpenWakeWordDetector {
  private readonly model: WakeWordModel;
  private readonly cfg: Required<WakeWordConfig>;
  private cooldown = 0;
  private readonly onWake: () => void;

  constructor(args: {
    model: WakeWordModel;
    config?: WakeWordConfig;
    onWake: () => void;
  }) {
    this.model = args.model;
    this.cfg = { ...DEFAULTS, ...(args.config ?? {}) };
    this.onWake = args.onWake;
  }

  /**
   * Score one PCM frame; fire `onWake` on a fresh detection. Returns true
   * when this frame fired the wake word.
   */
  pushFrame(frame: Float32Array): boolean {
    if (frame.length !== this.model.frameSamples) {
      throw new Error(
        `[wake-word] frame has ${frame.length} samples, expected ${this.model.frameSamples}`,
      );
    }
    if (this.cooldown > 0) {
      this.cooldown--;
      this.model.scoreFrame(frame); // keep the model's streaming state warm
      return false;
    }
    const p = this.model.scoreFrame(frame);
    if (p >= this.cfg.threshold) {
      this.cooldown = this.cfg.refractoryFrames;
      this.onWake();
      return true;
    }
    return false;
  }

  reset(): void {
    this.model.reset();
    this.cooldown = 0;
  }
}

/**
 * Resolve the bundled openWakeWord ONNX path. Unlike the VAD model this
 * is *optional* — a missing file means "wake word unavailable for this
 * bundle", not "broken bundle". Returns null when absent so callers can
 * keep voice mode working (push-to-talk / VAD-gated) without it.
 *
 * MUST only be called in `local` mode. The cloud-mode router does not
 * reach this (the wake-word setting is rejected there) — see AGENTS.md §5
 * hide-not-disable.
 */
export function resolveWakeWordPath(bundleRoot: string): string | null {
  const p = path.join(bundleRoot, OPENWAKEWORD_REL_PATH);
  return existsSync(p) ? p : null;
}
