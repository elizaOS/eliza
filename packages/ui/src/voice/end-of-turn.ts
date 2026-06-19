/**
 * Semantic end-of-turn detection for voice capture.
 *
 * The platform recognizers finalize a turn purely on a fixed silence window
 * (Android SODA ~700ms, web VAD ~900ms). That cuts a slow speaker off the
 * instant they pause to think mid-sentence ("schedule a meeting with… [pause]
 * …Bob"). This module adds a lightweight, deterministic semantic layer ON TOP of
 * the recognizer's finals: when the accumulated transcript looks syntactically
 * UNFINISHED (ends on a conjunction / preposition / article), we hold the turn
 * open and keep listening instead of sending; when it looks complete (sentence-
 * final punctuation, a short command, or simply a clause that doesn't trail off)
 * we commit immediately so the agent still replies snappily.
 *
 * The scorer mirrors the `HeuristicEotClassifier` in
 * `@elizaos/plugin-local-inference` (services/voice/eot-classifier.ts) — that
 * one drives the unwired native voice-session engine; this one drives the live
 * shell capture path. Pure + synchronous so it's trivially testable.
 */

/** Conjunctions that strongly suggest the speaker is mid-clause. */
const TRAILING_CONJUNCTIONS = new Set([
  "and",
  "but",
  "or",
  "nor",
  "yet",
  "so",
  "because",
  "although",
  "though",
  "while",
  "whereas",
  "if",
  "unless",
  "until",
  "since",
  "when",
  "where",
  "which",
  "that",
  "who",
  "whom",
  "whose",
]);

/** Prepositions / articles that imply an incomplete noun phrase follows. */
const TRAILING_INCOMPLETE = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "into",
  "about",
  "through",
  "between",
  "against",
  "during",
  "before",
  "after",
  "without",
  "under",
  "over",
  "above",
  "below",
  "around",
  "beside",
  "beyond",
  "like",
  "near",
  "past",
  "via",
]);

/** Question-tag suffixes that end an utterance (matched case-insensitively). */
const QUESTION_TAGS = [
  "right?",
  "yeah?",
  "ok?",
  "okay?",
  "correct?",
  "hm?",
  "huh?",
  "eh?",
];

/**
 * Probability in [0,1] that `transcript` is a COMPLETE turn (the speaker is
 * done). High → commit; low → the utterance trails off, keep listening.
 */
export function scoreEndOfTurn(transcript: string): number {
  const text = transcript.trim();
  if (text.length === 0) return 0.5;

  // A trailing ellipsis ("…" / "..") is the strongest trail-off signal — the
  // speaker paused mid-thought. Checked BEFORE sentence-final punctuation, since
  // "..." also ends in ".".
  if (/(\.{2,}|…)$/.test(text)) return 0.2;
  // Sentence-final punctuation → almost certainly done.
  if (/[.!?]$/.test(text)) return 0.95;

  const lower = text.toLowerCase();
  for (const tag of QUESTION_TAGS) {
    if (lower.endsWith(tag)) return 0.85;
  }

  const words = lower
    .replace(/[^a-z0-9'\s-]/gi, "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 0.5;

  const lastWord = words[words.length - 1].replace(/[',;:-]+$/, "");
  // Trailing conjunction / preposition / article → mid-clause, the speaker is
  // continuing. Checked BEFORE the short-utterance rule so a 2-word trail-off
  // ("going to", "and so") is NOT misread as a complete short command.
  if (TRAILING_CONJUNCTIONS.has(lastWord)) return 0.15;
  if (TRAILING_INCOMPLETE.has(lastWord)) return 0.2;

  // Short utterance that doesn't trail off (a command / acknowledgement) →
  // likely complete ("go home", "yes", "stop").
  if (words.length < 3) return 0.7;

  // No strong signal either way — the recognizer's silence is enough.
  return 0.5;
}

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
