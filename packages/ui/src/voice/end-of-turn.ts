/**
 * Semantic end-of-turn detection for voice capture.
 *
 * The platform recognizers finalize a turn purely on a fixed silence window
 * (Android SODA ~700ms, web VAD ~900ms). That cuts a slow speaker off the
 * instant they pause to think mid-sentence ("schedule a meeting with… [pause]
 * …Bob"). The {@link TurnAggregator} below adds a lightweight, deterministic
 * semantic layer ON TOP of the recognizer's finals: when the accumulated
 * transcript looks syntactically UNFINISHED (ends on a conjunction / preposition
 * / article) it holds the turn open and keeps listening; when it looks complete
 * (sentence-final punctuation, a short command, or a clause that doesn't trail
 * off) it commits immediately so the agent still replies snappily.
 *
 * The syntactic scorer itself is the single canonical heuristic in
 * `@elizaos/shared/voice-eot` — the SAME definition the plugin's Tier-3
 * `HeuristicEotClassifier` (and, through it, the fused composite EOT) consume,
 * so the shell capture path and the native voice engine never drift.
 */

import { scoreEndOfTurnHeuristic } from "@elizaos/shared/voice-eot";

/**
 * Probability in [0,1] that `transcript` is a COMPLETE turn (the speaker is
 * done). High → commit; low → the utterance trails off, keep listening.
 * Re-exported from the canonical `@elizaos/shared/voice-eot` so the shell and
 * the plugin score identically.
 */
export const scoreEndOfTurn = scoreEndOfTurnHeuristic;

export interface TurnAggregatorOptions {
  /**
   * Commit immediately when the accumulated transcript scores at or above this.
   * Below it the turn looks unfinished and we hold for more speech. Default 0.5.
   */
  commitThreshold?: number;
  /**
   * Maximum time to hold an unfinished-looking turn before committing anyway, so
   * a speaker who genuinely trails off ("…and") isn't left hanging forever.
   * Default 3500ms.
   */
  maxHoldMs?: number;
  /** Schedule/clear the hold timer (injectable for tests). */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Called with the committed turn text exactly once per turn. */
  onCommit: (text: string) => void;
}

/**
 * Accumulates recognizer finals into one logical turn, applying {@link
 * scoreEndOfTurn} to decide when the speaker is actually done. A final that
 * looks complete commits at once; a final that trails off is buffered and the
 * NEXT final is appended (the speaker resumed), with a max-hold safety timer so
 * a true trail-off still commits.
 */
export class TurnAggregator {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly commitThreshold: number;
  private readonly maxHoldMs: number;
  private readonly onCommit: (text: string) => void;
  private readonly setTimer: NonNullable<TurnAggregatorOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<TurnAggregatorOptions["clearTimer"]>;

  constructor(options: TurnAggregatorOptions) {
    this.commitThreshold = options.commitThreshold ?? 0.5;
    this.maxHoldMs = options.maxHoldMs ?? 3500;
    this.onCommit = options.onCommit;
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  }

  /** The text currently held while waiting to see if the speaker continues. */
  get pending(): string {
    return this.buffer;
  }

  /**
   * Feed a recognizer FINAL segment. Returns true if the turn committed (was
   * sent), false if it was held open awaiting continuation.
   */
  addFinal(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    this.cancelTimer();
    this.buffer = this.buffer ? `${this.buffer} ${trimmed}` : trimmed;

    if (scoreEndOfTurn(this.buffer) >= this.commitThreshold) {
      this.commit();
      return true;
    }
    // Looks unfinished — hold for more speech, but not forever.
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.commit();
    }, this.maxHoldMs);
    return false;
  }

  /**
   * Pre-load a held turn carried over from a previous capture (a one-shot
   * backend like local-inference ends the capture on silence, so an unfinished
   * turn must be carried into the next capture to append the continuation). Arms
   * the max-hold timer so a carried turn that is never continued still commits.
   */
  seed(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.cancelTimer();
    this.buffer = this.buffer ? `${this.buffer} ${trimmed}` : trimmed;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.commit();
    }, this.maxHoldMs);
  }

  /** Commit whatever is buffered right now (e.g. a hard stop that should send). */
  flush(): void {
    this.cancelTimer();
    if (this.buffer) this.commit();
  }

  /** Discard any buffered turn without committing (e.g. toggle-off / barge-in). */
  reset(): void {
    this.cancelTimer();
    this.buffer = "";
  }

  /** Release the hold timer. Idempotent. */
  dispose(): void {
    this.cancelTimer();
    this.buffer = "";
  }

  private commit(): void {
    const text = this.buffer;
    this.buffer = "";
    if (text) this.onCommit(text);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
