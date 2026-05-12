/**
 * Voice turn controller — the turn-taking layer above `VoiceScheduler`.
 *
 * Sits between W1's `VadEvent` stream + W2's `StreamingTranscriber` events
 * and the generation path (the runtime message handler / the local engine's
 * `generate`, which routes through `voiceStreamingArgs` → `VoiceScheduler` →
 * phrase chunker → TTS). Implements the brief's items A4 / A5 / A6:
 *
 *   - `speech-start`           → fire `prewarm(roomId)` immediately (the
 *                                response-handler stable prefix / DFlash
 *                                slot KV-prefill) — before STT finishes.
 *   - `speech-pause(ms > thr)` → kick a SPECULATIVE response off W2's
 *                                current partial transcript. The generate
 *                                call gets an `AbortSignal`; the in-flight
 *                                generation is stashed.
 *   - `speech-active` / a new `speech-start` / VAD re-trigger
 *                              → ABORT the speculative generation (the abort
 *                                propagates into `dispatcher.generate`).
 *   - `speech-end` (no new speech)
 *                              → finalize: flush the transcriber for the
 *                                final transcript; if the speculative result
 *                                is still valid against it, PROMOTE it; else
 *                                discard and run the real turn on the
 *                                finalized transcript.
 *
 * Barge-in: while the agent is speaking the controller flips
 * `scheduler.bargeIn.setAgentSpeaking(true)` (and binds the VAD into the
 * barge-in controller). A provisional `pause-tts` pauses TTS in the
 * scheduler; a `blip` → `resume-tts`; ASR-confirmed words → `hard-stop` →
 * the scheduler drains the ring buffer + flushes the chunker, and the
 * controller aborts the in-flight turn (the same `AbortSignal` the engine
 * threads into `dispatcher.generate`). The transcriber's `words` event is
 * wired into `bargeIn.onWordsDetected({wordCount})` so a blip alone only
 * pauses, but real recognized words hard-stop.
 *
 * No fallback sludge: `prewarm` failures surface via `onError`; a speculative
 * abort is a real `AbortSignal.abort()`, never a swallowed flag.
 */

import type { BargeInController } from "./barge-in";
import type { VoiceScheduler } from "./scheduler";
import type {
  StreamingTranscriber,
  TranscriberEvent,
  TranscriptUpdate,
  VadEvent,
  VadEventSource,
  VoiceInputSource,
  VoiceSegment,
  VoiceSpeaker,
  VoiceTurnMetadata,
} from "./types";

/** Outcome of one generation pass (speculative or final). */
export interface VoiceTurnOutcome {
  /** The transcript the generation ran against (so the controller can
   *  decide whether a speculative result is still valid). */
  transcript: string;
  /** Voice attribution metadata for the transcript that produced this outcome. */
  source?: VoiceInputSource;
  speaker?: VoiceSpeaker;
  segments?: VoiceSegment[];
  turn?: VoiceTurnMetadata;
  /** Final reply text the model produced (already streamed into TTS by the
   *  generate callee). May be empty for an IGNORE turn. */
  replyText: string;
}

export interface VoiceGenerateRequest {
  /** Best transcript available at the time the request is issued. */
  transcript: string;
  /** Optional source/speaker metadata for attribution-only storage. */
  source?: VoiceInputSource;
  speaker?: VoiceSpeaker;
  segments?: VoiceSegment[];
  turn?: VoiceTurnMetadata;
  /** True for the finalized turn (post `speech-end` + `flush()`), false for
   *  a speculative pass off a partial. */
  final: boolean;
  /** Aborted when speech resumes (speculative) or on a hard-stop barge-in. */
  signal: AbortSignal;
}

export interface VoiceTurnControllerDeps {
  /** W1: the authoritative VAD event stream (a `VadDetector` is structurally one of these). */
  vad: VadEventSource;
  /** W2: the live streaming transcriber. The controller subscribes to its
   *  events and calls `flush()` on `speech-end`. */
  transcriber: StreamingTranscriber;
  /** W9: the voice scheduler — used for the barge-in controller + agent-speaking flag. */
  scheduler: VoiceScheduler;
  /**
   * KV-prefill / response-handler-prefix prewarm. Called on `speech-start`.
   * Fire-and-forget; a rejection is surfaced via `onError`, not swallowed.
   * (In the engine this wraps `engine.prewarmConversation(roomId, ...)` /
   * `runtime.prewarmResponseHandler(roomId)`.)
   */
  prewarm?: (roomId: string) => void | Promise<void>;
  /**
   * Run a generation pass. The callee builds the message, calls the runtime
   * message handler / `useModel`, and streams `replyText` into TTS via the
   * scheduler. Must honour `request.signal` (abort = stop the LLM/drafter at
   * the next kernel boundary). Resolves with the produced reply + the
   * transcript it ran against. Rejecting with the request's `AbortError` is
   * fine — the controller treats that as "aborted".
   */
  generate: (request: VoiceGenerateRequest) => Promise<VoiceTurnOutcome>;
}

export interface VoiceTurnControllerConfig {
  /** Conversation / room id passed to `prewarm` and (implicitly) `generate`. */
  roomId: string;
  /**
   * Minimum `speech-pause` duration before a speculative response is kicked.
   * Default 300 ms — long enough that mid-sentence breath pauses don't
   * trigger one, short enough to win latency on a real end-of-utterance.
   */
  speculatePauseMs?: number;
}

export interface VoiceTurnControllerEvents {
  /** A speculative generation was started off a partial transcript. */
  onSpeculativeStart?(transcript: string): void;
  /** The in-flight speculative generation was aborted (speech resumed). */
  onSpeculativeAbort?(): void;
  /** The speculative result was promoted as the turn's answer (it matched the final transcript). */
  onSpeculativePromoted?(outcome: VoiceTurnOutcome): void;
  /** A turn finished (promoted speculative OR a fresh final run). */
  onTurnComplete?(outcome: VoiceTurnOutcome): void;
  /** `prewarm` rejected, or a `generate` pass rejected with a non-abort error. */
  onError?(error: Error): void;
}

const DEFAULT_SPECULATE_PAUSE_MS = 300;

interface InFlightGeneration {
  /** Transcript the generation ran against. */
  transcript: string;
  controller: AbortController;
  promise: Promise<VoiceTurnOutcome | null>;
}

export class VoiceTurnController {
  private readonly deps: VoiceTurnControllerDeps;
  private readonly events: VoiceTurnControllerEvents;
  private readonly roomId: string;
  private readonly speculatePauseMs: number;
  private readonly bargeIn: BargeInController;

  private speculative: InFlightGeneration | null = null;
  /** A finalize() in progress (awaiting `transcriber.flush()` + generate). */
  private finalizing: Promise<void> | null = null;
  private latestPartial = "";
  private started = false;
  private vadUnsub: (() => void) | null = null;
  private transcriberUnsub: (() => void) | null = null;
  /** True once `speech-end` ran and finalize is pending/done for this segment. */
  private segmentEnded = false;
  private latestUpdate: TranscriptUpdate | null = null;

  constructor(
    deps: VoiceTurnControllerDeps,
    config: VoiceTurnControllerConfig,
    events: VoiceTurnControllerEvents = {},
  ) {
    this.deps = deps;
    this.events = events;
    this.roomId = config.roomId;
    this.speculatePauseMs = Math.max(
      0,
      config.speculatePauseMs ?? DEFAULT_SPECULATE_PAUSE_MS,
    );
    this.bargeIn = deps.scheduler.bargeIn;
  }

  /** Subscribe to the VAD + transcriber streams and start turn-taking. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Barge-in controller takes the VAD directly so it can pause/resume TTS
    // while the agent is speaking; the scheduler already listens to its
    // `onSignal` stream.
    this.bargeIn.bindVad(this.deps.vad);
    this.vadUnsub = this.deps.vad.onVadEvent((e) => this.onVadEvent(e));
    this.transcriberUnsub = this.deps.transcriber.on((e) =>
      this.onTranscriberEvent(e),
    );
  }

  /** Detach from the streams and abort any in-flight speculative generation. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.vadUnsub?.();
    this.vadUnsub = null;
    this.transcriberUnsub?.();
    this.transcriberUnsub = null;
    this.bargeIn.unbindVad();
    this.abortSpeculative();
  }

  // --- VAD ---------------------------------------------------------------

  private onVadEvent(event: VadEvent): void {
    switch (event.type) {
      case "speech-start": {
        // New utterance onset. If we were mid-finalize from a previous
        // segment, that segment got *more* speech — abort the speculative
        // run for it (the finalize promise still resolves; its abort is
        // honoured). Reset segment state + the barge-in episode so the next
        // hard-stop gets a fresh `BargeInCancelToken`.
        this.segmentEnded = false;
        this.latestUpdate = null;
        this.latestPartial = "";
        this.abortSpeculative();
        this.bargeIn.reset();
        void this.firePrewarm();
        break;
      }
      case "speech-active": {
        // Speech is ongoing again — any speculative response we kicked on a
        // pause is stale. Abort it.
        if (this.speculative) this.abortSpeculative();
        break;
      }
      case "speech-pause": {
        if (
          event.pauseDurationMs >= this.speculatePauseMs &&
          !this.speculative &&
          !this.segmentEnded
        ) {
          this.startSpeculative(this.latestPartial, this.latestUpdate);
        }
        break;
      }
      case "speech-end": {
        this.segmentEnded = true;
        this.beginFinalize();
        break;
      }
      case "blip":
        // Handled entirely by the barge-in controller (resume-tts when the
        // agent is speaking; nothing otherwise). No turn-taking effect.
        break;
    }
  }

  private onTranscriberEvent(event: TranscriberEvent): void {
    switch (event.kind) {
      case "partial":
        this.latestPartial = event.update.partial;
        this.latestUpdate = event.update;
        break;
      case "final":
        this.latestPartial = event.update.partial;
        this.latestUpdate = event.update;
        break;
      case "words":
        // ASR confirmed real words during a barge-in window — promote a
        // provisional `pause-tts` into a `hard-stop` (TTS cancelled + LLM
        // aborted). A blip alone would never reach here.
        this.bargeIn.onWordsDetected({
          wordCount: event.words.length,
          partialText: event.words.join(" "),
          timestampMs: Date.now(),
        });
        break;
    }
  }

  // --- prewarm -----------------------------------------------------------

  private async firePrewarm(): Promise<void> {
    if (!this.deps.prewarm) return;
    try {
      await this.deps.prewarm(this.roomId);
    } catch (err) {
      this.events.onError?.(toError(err));
    }
  }

  // --- speculative generation -------------------------------------------

  private startSpeculative(
    transcript: string,
    update: TranscriptUpdate | null,
  ): void {
    const text = transcript.trim();
    if (text.length === 0) return;
    const controller = new AbortController();
    this.events.onSpeculativeStart?.(text);
    const promise = this.runGenerate({
      transcript: text,
      ...voiceRequestMetadata(update),
      final: false,
      signal: controller.signal,
    });
    this.speculative = { transcript: text, controller, promise };
  }

  private abortSpeculative(): void {
    const spec = this.speculative;
    if (!spec) return;
    this.speculative = null;
    if (!spec.controller.signal.aborted) spec.controller.abort();
    this.events.onSpeculativeAbort?.();
    // Drop the partial TTS the speculative run may have already streamed —
    // it was generated against a stale partial transcript. This is NOT a
    // user barge-in, so use the dedicated drop path (no `onCancel`).
    this.deps.scheduler.cancelPendingTts();
  }

  // --- finalize ----------------------------------------------------------

  private beginFinalize(): void {
    // Serialize finalize calls — `speech-end` should only fire once per
    // segment, but be defensive against a VAD that repeats it.
    if (this.finalizing) return;
    this.finalizing = this.finalize().finally(() => {
      this.finalizing = null;
    });
  }

  private async finalize(): Promise<void> {
    let finalUpdate: TranscriptUpdate;
    try {
      finalUpdate = await this.deps.transcriber.flush();
    } catch (err) {
      // Flush failure aborts any speculative run and bubbles up — no silent
      // empty-transcript turn.
      this.abortSpeculative();
      this.events.onError?.(toError(err));
      return;
    }
    const finalTranscript = finalUpdate.partial.trim();
    // If a new `speech-start` arrived while we were flushing, that segment
    // got more speech — drop this finalize.
    if (!this.segmentEnded) {
      this.abortSpeculative();
      return;
    }

    const spec = this.speculative;
    if (spec && spec.transcript === finalTranscript) {
      // The speculative run is valid — promote it (its TTS has already been
      // streaming).
      this.speculative = null;
      let outcome: VoiceTurnOutcome | null;
      try {
        outcome = await spec.promise;
      } catch (err) {
        outcome = null;
        this.events.onError?.(toError(err));
      }
      if (outcome) {
        this.events.onSpeculativePromoted?.(outcome);
        this.events.onTurnComplete?.(outcome);
        return;
      }
      // Speculative aborted or failed after all — fall through to a fresh
      // final run below.
    } else if (spec) {
      // The partial we speculated off didn't survive — discard it (its TTS
      // is stale).
      this.abortSpeculative();
    }

    if (finalTranscript.length === 0) {
      // Nothing was said (a blip the VAD let through). No turn.
      return;
    }
    const controller = new AbortController();
    let outcome: VoiceTurnOutcome | null;
    try {
      outcome = await this.runGenerate({
        transcript: finalTranscript,
        ...voiceRequestMetadata(finalUpdate),
        final: true,
        signal: controller.signal,
      });
    } catch (err) {
      outcome = null;
      this.events.onError?.(toError(err));
    }
    if (outcome) this.events.onTurnComplete?.(outcome);
  }

  // --- generate adapter --------------------------------------------------

  private async runGenerate(
    request: VoiceGenerateRequest,
  ): Promise<VoiceTurnOutcome | null> {
    try {
      return await this.deps.generate(request);
    } catch (err) {
      if (isAbortError(err) || request.signal.aborted) return null;
      this.events.onError?.(toError(err));
      return null;
    }
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.message.toLowerCase().includes("abort"))
  );
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function voiceRequestMetadata(
  update: TranscriptUpdate | null,
): Pick<VoiceGenerateRequest, "source" | "speaker" | "segments" | "turn"> {
  if (!update) return {};
  return {
    ...(update.source ? { source: update.source } : {}),
    ...(update.speaker ? { speaker: update.speaker } : {}),
    ...(update.segments ? { segments: update.segments } : {}),
    ...(update.turn ? { turn: update.turn } : {}),
  };
}
