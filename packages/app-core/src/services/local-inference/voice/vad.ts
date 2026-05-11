/**
 * Voice activity detection (Silero VAD) — the barge-in + silence-gate
 * driver for the fused voice loop.
 *
 * Per `packages/inference/AGENTS.md` §1 + §4:
 *   - Silero VAD (MIT, ~2 MB ONNX) ships in *every* voice-enabled bundle
 *     under `vad/silero-vad-int8.onnx`.
 *   - It drives **barge-in cancellation**: the moment the mic detects new
 *     user speech while the assistant is talking, `VoicePipeline.cancel()`
 *     fires (ring-buffer drain + chunker flush + in-flight TTS cancel at
 *     the next kernel boundary).
 *   - It **gates ASR**: silent frames are dropped before they reach the
 *     ASR forward pass so the model never decodes silence.
 *
 * This module is the runtime seam. The actual ONNX inference is a thin
 * boundary (`VadModel.scoreFrame`) so platform bindings can choose their
 * ONNX runtime (onnxruntime-node on desktop, the Capacitor ONNX bridge
 * on mobile) without this file binding to one. A `EnergyVadModel`
 * fallback (RMS-threshold gate) is provided for tests and dev — it is NOT
 * a product path; voice mode hard-fails if the bundled Silero ONNX is
 * missing (AGENTS.md §3, no silent fallback to a worse detector).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { VoiceStartupError } from "./errors";

/** Relative path of the bundled Silero VAD ONNX inside an Eliza-1 bundle. */
export const SILERO_VAD_REL_PATH = "vad/silero-vad-int8.onnx";

/**
 * Per-frame speech probability source. `scoreFrame` takes one fixed-size
 * PCM frame (Silero's native window is 512 samples @ 16 kHz / 256 @ 8 kHz)
 * and returns P(speech) in [0, 1]. Stateful: the implementation carries
 * the model's recurrent hidden state across calls; `reset()` clears it at
 * an utterance boundary.
 */
export interface VadModel {
  readonly frameSamples: number;
  readonly sampleRate: number;
  scoreFrame(frame: Float32Array): number;
  reset(): void;
}

export interface VadConfig {
  /** P(speech) above this starts a speech segment. Silero default ~0.5. */
  startThreshold?: number;
  /** P(speech) below this (after `minSilenceFrames`) ends a segment. */
  endThreshold?: number;
  /** Consecutive sub-threshold frames before a segment is considered ended. */
  minSilenceFrames?: number;
  /** Minimum speech frames before a segment is reported (debounce blips). */
  minSpeechFrames?: number;
}

const DEFAULTS: Required<VadConfig> = {
  startThreshold: 0.5,
  endThreshold: 0.35,
  minSilenceFrames: 8, // ~256 ms @ 16 kHz/512
  minSpeechFrames: 3,
};

/**
 * Streaming VAD gate. Feed frames; it tracks whether you are currently
 * inside a speech segment. The voice loop uses it two ways:
 *   1. While the assistant is *speaking* → any reported speech onset
 *      triggers barge-in (`onSpeechStart`).
 *   2. While *listening for the user* → only in-segment frames are
 *      forwarded to ASR (`isSpeech()` gate).
 */
export class SileroVadGate {
  private readonly model: VadModel;
  private readonly cfg: Required<VadConfig>;
  private inSpeech = false;
  private speechRun = 0;
  private silenceRun = 0;
  private readonly onSpeechStart?: () => void;
  private readonly onSpeechEnd?: () => void;

  constructor(args: {
    model: VadModel;
    config?: VadConfig;
    onSpeechStart?: () => void;
    onSpeechEnd?: () => void;
  }) {
    this.model = args.model;
    this.cfg = { ...DEFAULTS, ...(args.config ?? {}) };
    this.onSpeechStart = args.onSpeechStart;
    this.onSpeechEnd = args.onSpeechEnd;
  }

  /** Current segment state. */
  isSpeech(): boolean {
    return this.inSpeech;
  }

  /**
   * Score one PCM frame and update segment state. Returns `true` when this
   * frame is part of an active speech segment (i.e. should be forwarded to
   * ASR). Frame size MUST equal `model.frameSamples` — a mismatch is a
   * caller bug and throws.
   */
  pushFrame(frame: Float32Array): boolean {
    if (frame.length !== this.model.frameSamples) {
      throw new Error(
        `[vad] frame has ${frame.length} samples, expected ${this.model.frameSamples}`,
      );
    }
    const p = this.model.scoreFrame(frame);
    if (!this.inSpeech) {
      if (p >= this.cfg.startThreshold) {
        this.speechRun++;
        if (this.speechRun >= this.cfg.minSpeechFrames) {
          this.inSpeech = true;
          this.silenceRun = 0;
          this.onSpeechStart?.();
        }
      } else {
        this.speechRun = 0;
      }
    } else {
      if (p < this.cfg.endThreshold) {
        this.silenceRun++;
        if (this.silenceRun >= this.cfg.minSilenceFrames) {
          this.inSpeech = false;
          this.speechRun = 0;
          this.onSpeechEnd?.();
        }
      } else {
        this.silenceRun = 0;
      }
    }
    return this.inSpeech;
  }

  /**
   * Filter a PCM buffer to only its speech regions, frame by frame. Used
   * by the ASR gate: silent frames are dropped before the ASR forward
   * pass (AGENTS.md §1 — "gates ASR to skip silent frames"). The output
   * is the concatenation of in-segment frames; an all-silence input
   * yields an empty buffer.
   */
  gateToSpeech(pcm: Float32Array): Float32Array {
    const f = this.model.frameSamples;
    const kept: Float32Array[] = [];
    for (let off = 0; off + f <= pcm.length; off += f) {
      const frame = pcm.subarray(off, off + f);
      if (this.pushFrame(frame)) kept.push(frame);
    }
    let total = 0;
    for (const k of kept) total += k.length;
    const out = new Float32Array(total);
    let w = 0;
    for (const k of kept) {
      out.set(k, w);
      w += k.length;
    }
    return out;
  }

  reset(): void {
    this.model.reset();
    this.inSpeech = false;
    this.speechRun = 0;
    this.silenceRun = 0;
  }
}

/**
 * Resolve the bundled Silero VAD ONNX path, hard-failing if absent. Every
 * voice-enabled Eliza-1 bundle ships it (AGENTS.md §1) — a missing file
 * means the bundle is broken, not a "skip VAD" path.
 */
export function resolveSileroVadPath(bundleRoot: string): string {
  const p = path.join(bundleRoot, SILERO_VAD_REL_PATH);
  if (!existsSync(p)) {
    throw new VoiceStartupError(
      "missing-fused-build",
      `[vad] Bundle is missing the required Silero VAD model at ${p}. Every voice-enabled Eliza-1 bundle ships ${SILERO_VAD_REL_PATH} (AGENTS.md §1).`,
    );
  }
  return p;
}

/**
 * RMS-energy VAD model. Test/dev fallback ONLY — not a product path. The
 * product path is the bundled Silero ONNX via `resolveSileroVadPath` +
 * an `onnxruntime`-backed `VadModel`. Returns `1` for frames whose RMS
 * exceeds `threshold`, else `0` — enough to exercise the segment state
 * machine and the ASR gate deterministically.
 */
export class EnergyVadModel implements VadModel {
  constructor(
    readonly frameSamples = 512,
    readonly sampleRate = 16_000,
    private readonly threshold = 0.02,
  ) {}
  scoreFrame(frame: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    return rms >= this.threshold ? 1 : 0;
  }
  reset(): void {
    // Stateless.
  }
}
