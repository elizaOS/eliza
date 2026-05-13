/**
 * Voice state machine — explicit state-machine wrapper that drives the
 * optimistic-rollback path the C1 checkpoint enables.
 *
 * This is the thin layer the brief calls for: the existing
 * `OptimisticRollbackController` already covers the pre-draft / draft-response
 * path; this module adds the SPEAKING state and the barge-in restore path on
 * top, exposed as a single state-machine surface (`getState`, `dispatch`)
 * that the voice loop drives from VAD events + scheduler events.
 *
 *   IDLE
 *     │ speech-start
 *     ▼
 *   LISTENING ────────────── speech-pause ────────────▶ PAUSE_TENTATIVE
 *     ▲                                                       │
 *     │ speech-active (within 2× hangover)                    │
 *     │ ──── discard C1 ──────────────────────────────────────┤
 *     │                                                       │
 *     │                                                       │ speech-end
 *     │                                                       ▼
 *     │                                                  SPEAKING
 *     │                                                       │
 *     │ ◀──── restore C1, re-enter LISTENING ───── barge-in ──┘
 *
 * Key transitions (all wired to a `CheckpointManagerLike`):
 *
 *   - `speech-pause` (LISTENING → PAUSE_TENTATIVE)
 *       Save checkpoint named "pre-draft" (C1). Kick the drafter on the
 *       current partial transcript via the caller-supplied `startDrafter`.
 *
 *   - `speech-active` within 2× hangover (PAUSE_TENTATIVE → LISTENING)
 *       Discard C1. Abort the speculative drafter. No rollback is required
 *       because the drafter's KV writes were speculative against a snapshot
 *       we never committed.
 *
 *   - `speech-end` (PAUSE_TENTATIVE → SPEAKING)
 *       Commit the ASR final. The drafter's output is promoted: callers
 *       wire the verifier on top via `onCommit`. **Retain** C1 — a barge-in
 *       while the agent is speaking must roll the KV cache back to the
 *       pre-draft point so the next user turn doesn't see the agent's own
 *       half-spoken response in the prompt.
 *
 *   - `barge-in` (SPEAKING → LISTENING)
 *       Restore C1. Hand the new user speech to the next LISTENING turn.
 *       The same C1 may be restored multiple times — useful when two
 *       consecutive barge-ins land before the next checkpoint is taken
 *       (the test suite covers this).
 *
 * No fallback sludge: a checkpoint failure surfaces via `onError`. The
 * state machine never silently downgrades to a non-checkpointed path —
 * callers turn the feature off via the constructor option.
 */

import type {
  CheckpointHandle,
  CheckpointManagerLike,
} from "./checkpoint-manager";
import type { ContextPartial } from "./eager-context-builder";
import {
  EOT_COMMIT_SILENCE_MS,
  EOT_COMMIT_THRESHOLD,
  EOT_HANGOVER_EXTENSION_MS,
  EOT_MID_CLAUSE_THRESHOLD,
  EOT_TENTATIVE_SILENCE_MS,
  EOT_TENTATIVE_THRESHOLD,
  type EotClassifier,
} from "./eot-classifier";
import {
  prefillOptimistic,
  type PrefillOptimisticOptions,
  type PrefillOptimisticResult,
} from "./prefill-client";

/** Public state. Closed union — exhaustive switches catch new variants. */
export type VoiceState = "IDLE" | "LISTENING" | "PAUSE_TENTATIVE" | "SPEAKING";

/**
 * Events that drive the state machine. Wall-clock timestamps are caller-
 * supplied so the machine is testable without a fake clock.
 */
export type VoiceStateEvent =
  | { type: "speech-start"; timestampMs: number }
  | { type: "speech-pause"; timestampMs: number; partialTranscript: string }
  | { type: "speech-active"; timestampMs: number }
  | { type: "speech-end"; timestampMs: number; finalTranscript: string }
  | { type: "barge-in"; timestampMs: number }
  /**
   * Tier-3 — streamed partial transcript chunk from the ASR. When an
   * `eotClassifier` is configured the machine will run `checkEot()` and may
   * transition to PAUSE_TENTATIVE early or commit immediately depending on
   * the returned probability and the elapsed silence since the last speech
   * audio frame (provided by the caller via `silenceSinceMs`).
   */
  | {
      type: "partial-transcript";
      timestampMs: number;
      text: string;
      /** Milliseconds of silence elapsed since the last speech audio frame. */
      silenceSinceMs: number;
    };

/**
 * Reason a speculative drafter handle was aborted by the state machine.
 *
 *   - `resumed` — `speech-active` re-entered LISTENING; the draft was
 *                 speculative against a transcript that turned out to be
 *                 incomplete.
 *   - `barge-in` — the user interrupted while the agent was speaking; the
 *                  draft's downstream TTS has already been hard-stopped.
 *   - `shutdown` — `dispose()` was called.
 */
export type DrafterAbortReason = "resumed" | "barge-in" | "shutdown";

/**
 * Handle returned by `startDrafter`. The state machine calls `abort()`
 * (idempotent) when the draft must be cancelled.
 */
export interface DrafterHandle {
  abort(reason: DrafterAbortReason): void;
}

/**
 * Caller-supplied drafter starter. Receives the partial transcript at the
 * `speech-pause` instant and a turn id. Must return synchronously; the
 * draft itself runs in the background until the state machine calls
 * `abort()` or the draft completes (which is observed via `onCommit`).
 */
export type StartDrafterFn = (args: {
  partialTranscript: string;
  turnId: string;
  /** Aborted when the drafter must be cancelled. */
  signal: AbortSignal;
}) => DrafterHandle;

export interface VoiceStateMachineEvents {
  /** State transition occurred. Called AFTER the new state is set. */
  onStateChange?(prev: VoiceState, next: VoiceState, turnId: string): void;
  /** Speculative drafter was started on `speech-pause`. */
  onDrafterStart?(turnId: string, partialTranscript: string): void;
  /** Speculative drafter was aborted (resumed / barge-in / shutdown). */
  onDrafterAbort?(turnId: string, reason: DrafterAbortReason): void;
  /**
   * `speech-end` reached SPEAKING. The verifier should now run on top of
   * the speculative drafter output against the final transcript.
   *
   * `prefillResult` is present when the C7 optimistic prefill completed
   * before `speech-end` arrived. The verifier can resume generation from
   * `prefillResult.checkpointHandle` to skip one full prefill RTT.
   */
  onCommit?(
    turnId: string,
    finalTranscript: string,
    prefillResult?: PrefillOptimisticResult,
  ): void;
  /**
   * A barge-in restored C1. The voice loop should drop any in-flight TTS
   * (separate concern owned by the barge-in controller) and begin a new
   * LISTENING turn with the new user audio.
   */
  onRollback?(turnId: string, restoredFrom: CheckpointHandle): void;
  /**
   * Surfaced when `CheckpointManager.{save,restore,discard}` rejects.
   * The state machine continues — checkpoint failures must not break the
   * voice loop — but the operator can flip the feature flag off in
   * response.
   */
  onError?(
    op: "save" | "restore" | "discard",
    error: unknown,
    turnId: string,
  ): void;
  /**
   * Fired when the Tier-3 EOT classifier scores a partial transcript.
   * Useful for telemetry and debugging — P values are emitted before the
   * state machine decides whether to act on them.
   */
  onEotScore?(turnId: string, text: string, pDone: number): void;
  /**
   * Fired when the C7 optimistic prefill completes (either successfully or
   * with an error). On success `result` is set; on error `error` is set.
   * The state machine never blocks on the prefill result — it resolves or
   * rejects in the background while PAUSE_TENTATIVE is active.
   */
  onPrefill?(
    turnId: string,
    result: PrefillOptimisticResult | null,
    error: unknown | null,
  ): void;
}

export interface VoiceStateMachineOptions {
  /** Slot identifier for the conversation pinning. */
  slotId: string;
  /**
   * Whether to actually call into the `CheckpointManager`. When `false`,
   * the state machine still transitions through the same states but
   * never saves/restores. Default `true` — callers turn the feature off
   * here when upstream `--ctx-checkpoints` is not yet available.
   */
  enableCheckpoints?: boolean;
  /**
   * VAD pause hangover (ms). The rollback window is `2 × hangoverMs`. If
   * a `speech-active` arrives later than this after a `speech-pause`, the
   * machine treats the pause as a real speech-end equivalent (it commits
   * instead of discarding).
   */
  pauseHangoverMs?: number;
  checkpointManager: CheckpointManagerLike;
  /** Drafter starter — see `StartDrafterFn`. */
  startDrafter: StartDrafterFn;
  /** Events sink. */
  events?: VoiceStateMachineEvents;
  /**
   * Tier-3 semantic EOT classifier. When provided, partial transcripts are
   * scored on each `partial-transcript` dispatch:
   *
   *   P ≥ 0.9 AND silence ≥ 50 ms  → commit immediately (skip remaining hangover)
   *   P ≥ 0.6 AND silence ≥ 20 ms  → enter PAUSE_TENTATIVE early (start drafter)
   *   P < 0.4                        → extend hangover by 50 ms (user is mid-clause)
   *
   * When absent the machine behaves as before (tiers 1 + 2 only).
   */
  eotClassifier?: EotClassifier;
  /**
   * C7 — optimistic prefill configuration. When provided the machine fires
   * `prefillOptimistic` on `PAUSE_TENTATIVE` entry (fire-and-forget) so the
   * KV cache is pre-warmed with the partial transcript by the time ASR
   * finalizes. The prefill result is passed to `onCommit` via `prefillResult`.
   *
   * Omit to disable the prefill path entirely.
   */
  prefillConfig?: {
    /** Base URL of the llama-server (`http://host:port`). */
    baseUrl: string;
    /** `CheckpointManager` options forwarded to `prefillOptimistic`. */
    checkpointOptions?: Omit<PrefillOptimisticOptions, "checkpointManager">;
    /**
     * Optional deterministic context from `EagerContextBuilder` (C3).
     * When supplied, the prefill `/completion` call includes the system
     * prompt + conversation history so the KV cache is maximally warm.
     */
    getContext?: () => ContextPartial | null;
  };
}

// Lowered from 220ms; further reduction gated on semantic EOT classifier (V2).
const DEFAULT_PAUSE_HANGOVER_MS = 100;
const ROLLBACK_WINDOW_MULTIPLIER = 2;
const C1_NAME = "pre-draft";

interface ActiveDraft {
  handle: DrafterHandle;
  controller: AbortController;
  turnId: string;
  /** Partial transcript captured at speech-pause. */
  partial: string;
}

/**
 * Explicit state-machine implementation. Stateful (state + active
 * checkpoint + drafter handle); methods are NOT thread-safe — call them
 * from a single event loop.
 */
export class VoiceStateMachine {
  private readonly slotId: string;
  private readonly enabled: boolean;
  private readonly pauseHangoverMs: number;
  private readonly mgr: CheckpointManagerLike;
  private readonly startDrafterFn: StartDrafterFn;
  private readonly events: VoiceStateMachineEvents;
  /** Tier-3 semantic EOT classifier. Optional — omit for tiers 1+2 only. */
  private readonly eotClassifier: EotClassifier | undefined;

  private state: VoiceState = "IDLE";
  private turnCounter = 0;
  /** Most recent C1 handle. Retained across `speech-end` until barge-in or next IDLE. */
  private checkpoint: CheckpointHandle | null = null;
  private activeDraft: ActiveDraft | null = null;
  private pauseTimestampMs: number | null = null;
  private disposed = false;
  /**
   * Accumulated hangover extension from EOT mid-clause detections (ms).
   * Reset on each new turn (speech-start). Added to the effective hangover
   * so that consecutive mid-clause detections stack.
   */
  private eotHangoverExtensionMs = 0;

  constructor(opts: VoiceStateMachineOptions) {
    this.slotId = opts.slotId;
    this.enabled = opts.enableCheckpoints ?? true;
    this.pauseHangoverMs = opts.pauseHangoverMs ?? DEFAULT_PAUSE_HANGOVER_MS;
    this.mgr = opts.checkpointManager;
    this.startDrafterFn = opts.startDrafter;
    this.events = opts.events ?? {};
    this.eotClassifier = opts.eotClassifier;
  }

  /** Current state — read-only view for tests / telemetry. */
  getState(): VoiceState {
    return this.state;
  }

  /** Internal turn id for the current turn. Stable across pause/active. */
  getTurnId(): string {
    return turnIdString(this.turnCounter);
  }

  /**
   * Active checkpoint handle, if any. Exposed for tests; production code
   * should use `onCommit` / `onRollback` events instead.
   */
  getActiveCheckpoint(): CheckpointHandle | null {
    return this.checkpoint;
  }

  /**
   * Accumulated EOT hangover extension (ms). The `VadDetector` (Tier 2)
   * should add this to its effective pause hangover so mid-clause pauses
   * are not committed prematurely. Resets to 0 on each `speech-start`.
   */
  getEotHangoverExtensionMs(): number {
    return this.eotHangoverExtensionMs;
  }

  /**
   * Drive the machine. Returns a promise that resolves after any async
   * checkpoint work for this event finishes (await it in tests for
   * deterministic assertions). Callers in production may ignore the
   * returned promise — events fire synchronously regardless.
   */
  async dispatch(event: VoiceStateEvent): Promise<void> {
    if (this.disposed) return;
    switch (event.type) {
      case "speech-start":
        return this.handleSpeechStart();
      case "speech-pause":
        return this.handleSpeechPause(
          event.timestampMs,
          event.partialTranscript,
        );
      case "speech-active":
        return this.handleSpeechActive(event.timestampMs);
      case "speech-end":
        return this.handleSpeechEnd(event.finalTranscript);
      case "barge-in":
        return this.handleBargeIn();
      case "partial-transcript":
        return this.handlePartialTranscript(
          event.timestampMs,
          event.text,
          event.silenceSinceMs,
        );
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }

  /**
   * Tear down: abort any in-flight drafter, discard the live checkpoint.
   * Safe to call multiple times. After `dispose` the machine ignores
   * further events.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.activeDraft) {
      this.activeDraft.controller.abort();
      this.activeDraft.handle.abort("shutdown");
      this.events.onDrafterAbort?.(this.activeDraft.turnId, "shutdown");
      this.activeDraft = null;
    }
    if (this.checkpoint && this.enabled) {
      const handle = this.checkpoint;
      this.checkpoint = null;
      try {
        await this.mgr.discardCheckpoint(handle);
      } catch (error) {
        this.events.onError?.("discard", error, this.getTurnId());
      }
    } else {
      this.checkpoint = null;
    }
    this.setState("IDLE");
  }

  // --- handlers --------------------------------------------------------

  private handleSpeechStart(): void {
    if (this.state === "IDLE") {
      this.turnCounter += 1;
    }
    this.pauseTimestampMs = null;
    this.eotHangoverExtensionMs = 0;
    this.setState("LISTENING");
  }

  private async handleSpeechPause(
    timestampMs: number,
    partialTranscript: string,
  ): Promise<void> {
    if (this.state !== "LISTENING") return;
    this.pauseTimestampMs = timestampMs;
    this.setState("PAUSE_TENTATIVE");
    const turnId = this.getTurnId();

    if (this.enabled) {
      try {
        this.checkpoint = await this.mgr.saveCheckpoint(this.slotId, C1_NAME);
      } catch (error) {
        // Continue without a checkpoint — the drafter still runs, but a
        // barge-in won't have anything to restore from. Surface for the
        // operator to act on.
        this.events.onError?.("save", error, turnId);
      }
    }

    // State may have changed while we were awaiting the save (a fast
    // `speech-active` rebound, for instance). Only kick the drafter if
    // we're still in PAUSE_TENTATIVE. TS narrows `this.state` from the
    // entry guard (LISTENING) and doesn't see that `setState` or an
    // `await` may have mutated it — read through `currentState()` which
    // returns the wider `VoiceState` union.
    if (this.currentState() !== "PAUSE_TENTATIVE") return;
    this.startSpeculativeDrafter(partialTranscript, turnId);
  }

  private async handleSpeechActive(timestampMs: number): Promise<void> {
    if (this.state !== "PAUSE_TENTATIVE") return;
    const pauseAt = this.pauseTimestampMs;
    const rollbackWindowMs = this.pauseHangoverMs * ROLLBACK_WINDOW_MULTIPLIER;
    if (pauseAt !== null && timestampMs - pauseAt > rollbackWindowMs) {
      // Outside the rollback window — treat as speech-end equivalent.
      // The drafter keeps running; we promote to SPEAKING. The voice loop
      // expects the verifier to take over from here. There's no final
      // transcript to pass in this branch since the user never produced
      // one — callers that hit this path are unusual; surface via state
      // change only.
      this.setState("SPEAKING");
      return;
    }
    // Within the rollback window — abort the drafter and discard C1.
    this.abortActiveDraft("resumed");
    if (this.enabled && this.checkpoint) {
      const handle = this.checkpoint;
      this.checkpoint = null;
      try {
        await this.mgr.discardCheckpoint(handle);
      } catch (error) {
        this.events.onError?.("discard", error, this.getTurnId());
      }
    }
    this.pauseTimestampMs = null;
    this.setState("LISTENING");
  }

  private handleSpeechEnd(finalTranscript: string): void {
    if (this.state !== "PAUSE_TENTATIVE") {
      // `speech-end` without a prior `speech-pause` — happens when the
      // user finishes a single short utterance with no mid-clause pause.
      // No checkpoint exists; just transition to SPEAKING.
      if (this.state === "LISTENING") {
        this.setState("SPEAKING");
        this.events.onCommit?.(this.getTurnId(), finalTranscript);
      }
      return;
    }
    // C1 was saved on `speech-pause`. Retain it through SPEAKING so a
    // barge-in can restore. The drafter stays alive — its output is what
    // the verifier and TTS will stream from.
    this.pauseTimestampMs = null;
    this.setState("SPEAKING");
    this.events.onCommit?.(this.getTurnId(), finalTranscript);
  }

  private async handleBargeIn(): Promise<void> {
    if (this.state !== "SPEAKING") return;
    const turnId = this.getTurnId();
    this.abortActiveDraft("barge-in");
    if (this.enabled && this.checkpoint) {
      const handle = this.checkpoint;
      try {
        await this.mgr.restoreCheckpoint(handle);
        this.events.onRollback?.(turnId, handle);
      } catch (error) {
        this.events.onError?.("restore", error, turnId);
      }
      // Retain the handle — two consecutive barge-ins should be able to
      // restore from the same C1. The handle is discarded on the next
      // `speech-end` of a new turn (when a fresh C1 takes its place) or
      // on `dispose()`.
    }
    this.turnCounter += 1;
    this.setState("LISTENING");
  }

  /**
   * Handle a partial transcript chunk from streaming ASR.
   *
   * When an `eotClassifier` is configured, scores the text and applies:
   *
   *   P ≥ EOT_COMMIT_THRESHOLD  AND silence ≥ EOT_COMMIT_SILENCE_MS
   *     → behave as `speech-end` (commit immediately, skip remaining hangover)
   *
   *   P ≥ EOT_TENTATIVE_THRESHOLD AND silence ≥ EOT_TENTATIVE_SILENCE_MS
   *     AND state is LISTENING
   *     → behave as `speech-pause` (enter PAUSE_TENTATIVE, start drafter)
   *
   *   P < EOT_MID_CLAUSE_THRESHOLD
   *     → accumulate EOT_HANGOVER_EXTENSION_MS into the hangover extension
   *       (the VadDetector reads this via `getEotHangoverExtensionMs()`)
   *
   * No-ops when `eotClassifier` is not set, or when the machine is not in
   * LISTENING or PAUSE_TENTATIVE.
   */
  private async handlePartialTranscript(
    timestampMs: number,
    text: string,
    silenceSinceMs: number,
  ): Promise<void> {
    if (!this.eotClassifier) return;
    const validStates: VoiceState[] = ["LISTENING", "PAUSE_TENTATIVE"];
    if (!validStates.includes(this.currentState())) return;

    const pDone = await this.checkEot(text);
    this.events.onEotScore?.(this.getTurnId(), text, pDone);

    // Re-check state after async classifier — it may have changed.
    const stateNow = this.currentState();
    if (!validStates.includes(stateNow)) return;

    if (pDone >= EOT_COMMIT_THRESHOLD && silenceSinceMs >= EOT_COMMIT_SILENCE_MS) {
      // Treat as speech-end: commit immediately.
      // Use the partial as the final transcript (streaming ASR may not have
      // finalized yet; callers that have the final transcript should prefer
      // dispatching `speech-end` directly).
      this.handleSpeechEnd(text);
      return;
    }

    if (
      pDone >= EOT_TENTATIVE_THRESHOLD &&
      silenceSinceMs >= EOT_TENTATIVE_SILENCE_MS &&
      stateNow === "LISTENING"
    ) {
      // Enter PAUSE_TENTATIVE early — start the speculative drafter now.
      await this.handleSpeechPause(timestampMs, text);
      return;
    }

    if (pDone < EOT_MID_CLAUSE_THRESHOLD) {
      // User is mid-clause — accumulate extra patience into the hangover.
      this.eotHangoverExtensionMs += EOT_HANGOVER_EXTENSION_MS;
    }
  }

  /**
   * Score the partial transcript with the Tier-3 EOT classifier.
   * Returns 0.5 when no classifier is configured (uncertain — let tiers 1+2 decide).
   */
  private async checkEot(partial: string): Promise<number> {
    if (!this.eotClassifier) return 0.5;
    return this.eotClassifier.score(partial);
  }

  // --- internal helpers ----------------------------------------------

  private startSpeculativeDrafter(partial: string, turnId: string): void {
    const controller = new AbortController();
    const handle = this.startDrafterFn({
      partialTranscript: partial,
      turnId,
      signal: controller.signal,
    });
    this.activeDraft = { handle, controller, turnId, partial };
    this.events.onDrafterStart?.(turnId, partial);
  }

  private abortActiveDraft(reason: DrafterAbortReason): void {
    const draft = this.activeDraft;
    if (!draft) return;
    this.activeDraft = null;
    if (!draft.controller.signal.aborted) draft.controller.abort();
    draft.handle.abort(reason);
    this.events.onDrafterAbort?.(draft.turnId, reason);
  }

  private setState(next: VoiceState): void {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    this.events.onStateChange?.(prev, next, this.getTurnId());
  }

  /**
   * Returns `this.state` as the wider `VoiceState` union. Used in
   * post-`await` re-checks where the entry-guard narrowing would
   * otherwise convince TS the state can't have changed (it doesn't track
   * mutations through `setState`).
   */
  private currentState(): VoiceState {
    return this.state;
  }
}

function turnIdString(n: number): string {
  return `turn-${n.toString(36)}`;
}
