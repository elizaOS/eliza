/**
 * MockPipelineDriver — a deterministic stand-in for the real voice
 * pipeline. Used by unit tests and CI hosts without a model.
 *
 * Behavior model:
 *   - Plays the synthetic audio source so frame timing is preserved.
 *   - When the audio source's elapsed time crosses a configured speech
 *     onset, emits `speech-start`.
 *   - When silence (or end-of-audio) is detected for `hangoverMs` it
 *     emits `speech-end`. A configurable `falseEosResponseMs` simulates
 *     the false-EOS hangover gate.
 *   - After speech-end, simulates an ASR-to-first-audio pipeline by
 *     advancing fake `t_*` timestamps at scripted offsets.
 *   - If `injection.bargeInAtMs` is set, the driver emits a
 *     `barge-in-trigger` and `barge-in-hard-stop` pair.
 *
 * The defaults reflect a healthy pipeline (TTFA ~ 900 ms after speech end)
 * — gates should pass on a mock run.
 */

import { SyntheticAudioSource, FRAME_DURATION_MS_16K } from "./audio-source.ts";
import type {
  BenchAudioPayload,
  BenchDriverResult,
  BenchInjection,
  PipelineDriver,
  VoiceBenchProbe,
} from "./types.ts";

export interface MockPipelineDriverOpts {
  backend?: string;
  /** ms of speech proxy before VAD onset fires. */
  vadOnsetMs?: number;
  /** ms of trailing silence before VAD `speech-end` fires. */
  hangoverMs?: number;
  /** ms from speech-end to ASR final token (= drafter kickoff). */
  asrCompleteMs?: number;
  /** ms from ASR final to the first verifier-accepted token. */
  firstAcceptMs?: number;
  /** ms from first accept to first PCM emitted by TTS. */
  ttsFirstPcmMs?: number;
  /** Total draft tokens "generated" (rollback-waste denominator). */
  draftTokensTotal?: number;
  /** Drafter tokens "rejected" by the verifier. */
  draftTokensWasted?: number;
  /** When set, the driver also reports DFlash stats. */
  dflashAccepted?: number;
  dflashDrafted?: number;
  /** ms latency for the barge-in hard-stop after the trigger. */
  bargeInResponseMs?: number;
}

const DEFAULTS: Required<Omit<MockPipelineDriverOpts, "dflashAccepted" | "dflashDrafted" | "backend">> = {
  vadOnsetMs: 12,
  hangoverMs: 70,
  asrCompleteMs: 6,
  firstAcceptMs: 35,
  ttsFirstPcmMs: 12,
  draftTokensTotal: 50,
  draftTokensWasted: 6,
  bargeInResponseMs: 9,
};

export class MockPipelineDriver implements PipelineDriver {
  readonly name = "mock";
  readonly backend: string;
  private readonly opts: typeof DEFAULTS;
  private readonly dflashAccepted: number | undefined;
  private readonly dflashDrafted: number | undefined;

  constructor(opts: MockPipelineDriverOpts = {}) {
    this.backend = opts.backend ?? "mock";
    this.opts = {
      vadOnsetMs: opts.vadOnsetMs ?? DEFAULTS.vadOnsetMs,
      hangoverMs: opts.hangoverMs ?? DEFAULTS.hangoverMs,
      asrCompleteMs: opts.asrCompleteMs ?? DEFAULTS.asrCompleteMs,
      firstAcceptMs: opts.firstAcceptMs ?? DEFAULTS.firstAcceptMs,
      ttsFirstPcmMs: opts.ttsFirstPcmMs ?? DEFAULTS.ttsFirstPcmMs,
      draftTokensTotal: opts.draftTokensTotal ?? DEFAULTS.draftTokensTotal,
      draftTokensWasted: opts.draftTokensWasted ?? DEFAULTS.draftTokensWasted,
      bargeInResponseMs: opts.bargeInResponseMs ?? DEFAULTS.bargeInResponseMs,
    };
    this.dflashAccepted = opts.dflashAccepted;
    this.dflashDrafted = opts.dflashDrafted;
  }

  async run(args: {
    audio: BenchAudioPayload;
    injection?: BenchInjection;
    probe: VoiceBenchProbe;
    signal?: AbortSignal;
  }): Promise<BenchDriverResult> {
    const { audio, injection, probe, signal } = args;
    let cancelled = false;
    const onAbort = (): void => {
      cancelled = true;
    };
    if (signal) signal.addEventListener("abort", onAbort);

    // Drive a synthetic source in "fast" mode (no realtime delays) so
    // unit tests stay quick. The real-pipeline driver will replace this
    // with a wall-clock playback.
    const src = new SyntheticAudioSource({
      payload: audio,
      realtime: false,
      injection,
    });

    let firedStart = false;
    let firedEnd = false;
    let firedBargeIn = false;
    let bargeInScheduledStop = false;

    const unsubscribe = src.onFrame((frame) => {
      if (cancelled) return;
      // VAD onset after `vadOnsetMs` of audio.
      if (!firedStart && frame.timestampMs >= this.opts.vadOnsetMs) {
        probe("speech-start", { atSourceMs: frame.timestampMs });
        firedStart = true;
      }
      // Barge-in trigger (sim).
      if (
        injection?.bargeInAtMs !== undefined &&
        !firedBargeIn &&
        frame.timestampMs >= injection.bargeInAtMs
      ) {
        probe("barge-in-trigger", { atSourceMs: frame.timestampMs });
        firedBargeIn = true;
        // Hard-stop after `bargeInResponseMs`.
        bargeInScheduledStop = true;
        setTimeout(() => {
          if (cancelled) return;
          probe("barge-in-hard-stop");
        }, this.opts.bargeInResponseMs);
      }
    });

    try {
      await src.start();
    } finally {
      unsubscribe();
      if (signal) signal.removeEventListener("abort", onAbort);
    }

    if (cancelled) {
      return {
        exitReason: "cancelled",
        draftTokensTotal: 0,
        draftTokensWasted: 0,
      };
    }

    if (!firedStart) {
      // Pure-silence input — nothing to do; emit synthesized
      // speech-start/end so metric collection has *something* coherent
      // for diagnostic runs.
      probe("speech-start", { atSourceMs: 0, note: "silence-input" });
    }

    // Mid-clause false-EOS: emit speech-pause early, then speech-active
    // and a rollback-drop attributing the wasted draft tokens to the
    // optimistic-decode-with-rollback path. This is the C1 → discard path
    // the voice state machine drives.
    let rollbackWasteFromFalseEos = 0;
    if (injection?.falseEosAtMs !== undefined) {
      probe("speech-pause", { atSourceMs: injection.falseEosAtMs });
      probe("draft-start", { note: "speculative-on-pause" });
      await sleep(this.opts.hangoverMs);
      probe("speech-active", { atSourceMs: injection.falseEosAtMs + 32 });
      // The drafter produced ~half its budget before being aborted —
      // attribute that to rollback waste.
      const wasted = Math.floor(this.opts.draftTokensWasted / 2);
      rollbackWasteFromFalseEos = wasted;
      probe("rollback-drop", { tokens: wasted, reason: "false-eos" });
    }

    // Speech-end fires after audio finishes + hangover.
    probe("speech-pause", { atSourceMs: audio.durationMs });
    await sleep(this.opts.hangoverMs);
    probe("speech-end", { atSourceMs: audio.durationMs });

    // ASR completes shortly after speech-end.
    await sleep(this.opts.asrCompleteMs);
    probe("asr-final", { tokens: 12 });
    probe("draft-start");
    probe("verifier-start");

    // First verifier-accepted token + phrase emit.
    await sleep(this.opts.firstAcceptMs);
    probe("verifier-first-token");
    probe("draft-first-token");
    probe("phrase-emit");

    // First PCM hits the ring buffer.
    await sleep(this.opts.ttsFirstPcmMs);
    probe("tts-first-pcm");
    probe("audio-out-first-frame");

    // Wait for any pending barge-in hard-stop to fire so its timestamp
    // is recorded before we exit.
    let rollbackWasteFromBargeIn = 0;
    if (bargeInScheduledStop) {
      await sleep(this.opts.bargeInResponseMs + FRAME_DURATION_MS_16K);
      // Barge-in restored C1 — attribute the in-flight drafter tokens to
      // rollback waste so the harness's `rollback_waste_tokens` is non-zero
      // for this scenario.
      const wasted = Math.floor(this.opts.draftTokensWasted / 2);
      rollbackWasteFromBargeIn = wasted;
      probe("rollback-drop", { tokens: wasted, reason: "barge-in" });
    }

    // Wrap up.
    probe("verifier-complete");
    probe("draft-complete");

    const result: BenchDriverResult = {
      exitReason: "done",
      draftTokensTotal: this.opts.draftTokensTotal,
      draftTokensWasted: this.opts.draftTokensWasted,
      rollbackWasteTokens:
        rollbackWasteFromFalseEos + rollbackWasteFromBargeIn,
    };
    if (this.dflashAccepted !== undefined) result.dflashAccepted = this.dflashAccepted;
    if (this.dflashDrafted !== undefined) result.dflashDrafted = this.dflashDrafted;
    return result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
