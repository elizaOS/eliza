/**
 * Optimistic-decode-with-rollback controller for the voice loop.
 *
 *   IDLE
 *     │ speech-start
 *     ▼
 *   LISTENING
 *     │ speech-pause
 *     ▼
 *   PAUSE_TENTATIVE  ── speech-active (within rollback window) ──▶ LISTENING
 *     │                                                              ▲
 *     │ speech-end (or pause > rollback window)                       │
 *     ▼                                                               │
 *   DRAFT_RESPONSE  ──── speech-active (within rollback window) ──────┘
 *     │                  (restore checkpoint, abort drafter)
 *     │ commit
 *     ▼
 *   COMMITTED → IDLE
 *
 * On `speech-pause` we snapshot the slot's KV state (`C1-<turn-id>`) and
 * speculatively start the drafter against the partial transcript so that
 * when the user IS done, the response is already underway. If they resume
 * within the rollback window (~2× pause hangover), we restore the snapshot
 * and abort the speculative draft — net cost is one checkpoint write/read.
 *
 * This module deliberately does NOT modify `turn-controller.ts`,
 * `vad.ts`, `scheduler.ts`, `phrase-chunker.ts`, `barge-in.ts`, `pipeline.ts`,
 * `pipeline-impls.ts`, or `transcriber.ts` — those are owned elsewhere.
 * Instead, the turn controller composes this controller after the upstream
 * llama.cpp merge lands and the feature flag flips.
 */

import type {
  CheckpointClient,
  CheckpointHandle,
} from "../dflash-checkpoint-client";
import type { VadEvent, VadEventSource } from "./types";

/**
 * State of the optimistic-rollback controller. Mirrors the comment-block
 * state machine above; exported so tests and telemetry can assert on it.
 */
export type OptimisticRollbackState =
  | "idle"
  | "listening"
  | "pause-tentative"
  | "draft-response"
  | "committed";

/**
 * Telemetry event stream. Stays narrow — the controller emits exactly four
 * lifecycle events per turn (save, restore-or-commit, draft-start,
 * draft-abort). Consumers wire these into the existing voice-bench
 * trajectory captures.
 */
export interface OptimisticRollbackTelemetry {
  onCheckpointSaved?: (handle: CheckpointHandle, turnId: string) => void;
  onCheckpointRestored?: (handle: CheckpointHandle, turnId: string) => void;
  onSpeculativeDraftStarted?: (turnId: string) => void;
  onSpeculativeDraftAborted?: (turnId: string, reason: AbortReason) => void;
  /**
   * Fired when the controller silently swallows an error from the
   * checkpoint client — surfacing it via telemetry rather than rethrowing
   * keeps a failing checkpoint endpoint from breaking the voice loop. The
   * caller decides whether to flip the feature flag off.
   */
  onCheckpointError?: (
    op: "save" | "restore" | "cancel",
    error: unknown,
    turnId: string,
  ) => void;
}

export type AbortReason = "resumed" | "committed" | "shutdown";

/**
 * Speculative drafter handle. The voice turn controller hands one of these
 * in when starting the drafter so this module can abort it without
 * importing the drafter's internals. `abort()` MUST be idempotent — the
 * controller may call it again on shutdown.
 */
export interface SpeculativeDraftHandle {
  abort(): void;
}

/**
 * Caller-supplied drafter starter. Returns a handle the controller can
 * abort. Called on entry to `pause-tentative`. The promise must resolve
 * synchronously (or near-synchronously) — the speculative draft runs in
 * the background.
 */
export type StartSpeculativeDraft = (
  partialTranscript: string,
  turnId: string,
) => SpeculativeDraftHandle;

/**
 * Caller-supplied source for the partial transcript captured at the
 * `speech-pause` instant. Kept as a function so the controller doesn't
 * have to hold a reference to the transcriber.
 */
export type ReadPartialTranscript = () => string;

export interface OptimisticRollbackControllerOptions {
  /** The slot id the voice loop is pinned to for this turn. */
  slotId: number;
  /**
   * Per-process feature flag. Defaults to `false` — flip on once the
   * upstream `--ctx-checkpoints` merge lands AND the rollout plan in
   * `docs/eliza-1-optimistic-rollback.md` reaches the desired bucket.
   * Forwards every VAD event to the wrapped state machine when off but
   * never makes a checkpoint REST call.
   */
  enableOptimisticRollback?: boolean;
  /**
   * VAD pause hangover (ms). Default 220 ms — matches the voice loop's
   * standard hangover. The rollback window is `2 ×` this value.
   */
  pauseHangoverMs?: number;
  /** Source of VAD events; usually `VadDetector`. */
  vadSource: VadEventSource;
  client: CheckpointClient;
  startSpeculativeDraft: StartSpeculativeDraft;
  readPartialTranscript: ReadPartialTranscript;
  telemetry?: OptimisticRollbackTelemetry;
  /**
   * Wall-clock function. Injected for tests; defaults to `Date.now`. The
   * controller uses this to enforce the rollback window — if a
   * `speech-active` arrives more than `2 × pauseHangoverMs` after the
   * `speech-pause`, the controller commits rather than restores.
   */
  now?: () => number;
}

const DEFAULT_PAUSE_HANGOVER_MS = 220;
/** Rollback window = ROLLBACK_WINDOW_MULTIPLIER × pauseHangoverMs. */
const ROLLBACK_WINDOW_MULTIPLIER = 2;

/**
 * Optimistic-rollback controller. Subscribes to a `VadEventSource` and
 * drives the checkpoint REST client + a caller-supplied speculative
 * drafter. Idempotent `dispose()` for clean shutdown.
 */
export class OptimisticRollbackController {
  private state: OptimisticRollbackState = "idle";
  private currentTurnId = 0;
  private pauseTimestampMs: number | null = null;
  private currentCheckpoint: CheckpointHandle | null = null;
  private currentDraft: SpeculativeDraftHandle | null = null;
  private readonly unsubscribe: () => void;
  private readonly enabled: boolean;
  private readonly pauseHangoverMs: number;
  private readonly slotId: number;
  private readonly client: CheckpointClient;
  private readonly startSpeculativeDraft: StartSpeculativeDraft;
  private readonly readPartialTranscript: ReadPartialTranscript;
  private readonly telemetry: OptimisticRollbackTelemetry;
  private readonly now: () => number;
  private disposed = false;

  constructor(opts: OptimisticRollbackControllerOptions) {
    this.slotId = opts.slotId;
    this.enabled = opts.enableOptimisticRollback ?? false;
    this.pauseHangoverMs = opts.pauseHangoverMs ?? DEFAULT_PAUSE_HANGOVER_MS;
    this.client = opts.client;
    this.startSpeculativeDraft = opts.startSpeculativeDraft;
    this.readPartialTranscript = opts.readPartialTranscript;
    this.telemetry = opts.telemetry ?? {};
    this.now = opts.now ?? Date.now;
    this.unsubscribe = opts.vadSource.onVadEvent((event) =>
      this.handleVadEvent(event),
    );
  }

  /** Current state — read-only view for tests / telemetry. */
  getState(): OptimisticRollbackState {
    return this.state;
  }

  /**
   * Detach from the VAD source and abort any in-flight speculative draft.
   * Safe to call multiple times.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    if (this.currentDraft) {
      this.currentDraft.abort();
      this.telemetry.onSpeculativeDraftAborted?.(
        this.turnIdString(),
        "shutdown",
      );
      this.currentDraft = null;
    }
    if (this.currentCheckpoint && this.enabled) {
      // Best-effort cancellation of any in-flight decode on the slot. We do
      // NOT delete the snapshot file — upstream evicts on slot reuse, and a
      // dangling snapshot is cheap. Errors here are swallowed (the loop is
      // shutting down) but surfaced via telemetry.
      this.client
        .cancelSlot(this.slotId)
        .catch((error: unknown) =>
          this.telemetry.onCheckpointError?.(
            "cancel",
            error,
            this.turnIdString(),
          ),
        );
    }
    this.currentCheckpoint = null;
    this.state = "idle";
  }

  private handleVadEvent(event: VadEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case "speech-start":
        this.transitionToListening();
        return;
      case "speech-pause":
        this.handleSpeechPause(event.timestampMs);
        return;
      case "speech-active":
        this.handleSpeechActive(event.timestampMs);
        return;
      case "speech-end":
        this.handleSpeechEnd();
        return;
      case "blip":
        return;
      default: {
        // exhaustive — VadEvent is a closed union; if it gains a variant
        // the compiler will flag this cast.
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }

  private transitionToListening(): void {
    if (this.state === "idle") {
      this.currentTurnId += 1;
    }
    this.state = "listening";
  }

  private handleSpeechPause(timestampMs: number): void {
    if (this.state !== "listening") return;
    this.pauseTimestampMs = timestampMs;
    if (!this.enabled) {
      this.state = "pause-tentative";
      return;
    }
    const turnId = this.turnIdString();
    const filename = `C1-${turnId}`;
    this.state = "pause-tentative";
    void this.client
      .saveCheckpoint(this.slotId, filename)
      .then((handle) => {
        if (this.state !== "pause-tentative") return;
        this.currentCheckpoint = handle;
        this.telemetry.onCheckpointSaved?.(handle, turnId);
        this.startDraftIfStillPaused(turnId);
      })
      .catch((error: unknown) => {
        this.telemetry.onCheckpointError?.("save", error, turnId);
      });
  }

  private startDraftIfStillPaused(turnId: string): void {
    if (this.state !== "pause-tentative") return;
    const partial = this.readPartialTranscript();
    this.currentDraft = this.startSpeculativeDraft(partial, turnId);
    this.state = "draft-response";
    this.telemetry.onSpeculativeDraftStarted?.(turnId);
  }

  private handleSpeechActive(timestampMs: number): void {
    if (this.state !== "pause-tentative" && this.state !== "draft-response") {
      // `listening → speech-active` is a heartbeat; ignore.
      return;
    }
    const pauseAt = this.pauseTimestampMs;
    if (pauseAt === null) {
      this.state = "listening";
      return;
    }
    const elapsed = timestampMs - pauseAt;
    const rollbackWindowMs = this.pauseHangoverMs * ROLLBACK_WINDOW_MULTIPLIER;
    if (elapsed > rollbackWindowMs) {
      // Resumed too late to roll back — commit and let the drafter's
      // output flow as the response.
      this.commit();
      return;
    }
    this.rollback("resumed");
  }

  private handleSpeechEnd(): void {
    if (this.state === "pause-tentative" || this.state === "draft-response") {
      this.commit();
      return;
    }
    this.state = "idle";
  }

  private rollback(reason: AbortReason): void {
    const turnId = this.turnIdString();
    if (this.currentDraft) {
      this.currentDraft.abort();
      this.telemetry.onSpeculativeDraftAborted?.(turnId, reason);
      this.currentDraft = null;
    }
    if (this.enabled && this.currentCheckpoint) {
      const handle = this.currentCheckpoint;
      void this.client
        .restoreCheckpoint(this.slotId, handle.filename)
        .then(() => this.telemetry.onCheckpointRestored?.(handle, turnId))
        .catch((error: unknown) => {
          this.telemetry.onCheckpointError?.("restore", error, turnId);
        });
    }
    this.currentCheckpoint = null;
    this.pauseTimestampMs = null;
    this.state = "listening";
  }

  private commit(): void {
    // Commit drops the snapshot reference and leaves the drafter's
    // in-flight decode to flow into the response. We do NOT abort the
    // drafter — its output IS the response.
    this.currentCheckpoint = null;
    this.currentDraft = null;
    this.pauseTimestampMs = null;
    this.state = "committed";
    // Auto-return to idle so the next `speech-start` opens a new turn.
    this.state = "idle";
  }

  private turnIdString(): string {
    return `turn-${this.currentTurnId.toString(36)}`;
  }
}
