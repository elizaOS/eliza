/**
 * A2 — LocalAgreement-n streaming-ASR partial stabilizer.
 *
 * Streaming ASR (the Qwen3-ASR fused build, or any whisper-style decoder
 * running on partial windows) emits a fresh partial transcript on every
 * audio frame. Each partial can revise tokens the previous partial
 * already showed — "the cat sa" → "the cat sat" → "the cat sat on" is
 * fine, but "the cat sa" → "the cap sat" rewrites earlier text. Handing
 * a TTS chunker every revision causes audible stutter when the agent's
 * drafter starts speaking text the verifier later rejects.
 *
 * The LocalAgreement-n trick: only commit a prefix to downstream once it
 * has appeared identically in `n` consecutive partials. Below that
 * threshold the text is "pending" — visible to UI for confirmation
 * latency, but never sent to the drafter / phrase chunker. n=2 is the
 * sweet spot for voice — large enough to suppress single-frame ASR
 * jitter, small enough that the stable prefix tracks the speaker
 * within ~one extra frame.
 *
 * Wiring: the streaming-ASR adapter calls `feed(partial)` per frame; the
 * `stable` portion is what flows into `splitTranscriptToTokens` and the
 * drafter. `pending` is suffix-only, fed to UI for visual feedback. The
 * stabilizer is feature-flagged off until the streaming-ASR backend is
 * wired (see `voice/pipeline.ts`'s `usePartialStabilizer`).
 *
 * No `any`, no fallbacks: a malformed partial (e.g. an empty string)
 * collapses the stable prefix to whatever the agreement window still
 * supports — this is correctness, not a swallow.
 */

export interface PartialStabilizerOptions {
  /**
   * Number of consecutive identical partials a token has to appear in
   * before it migrates from `pending` → `stable`. Default 2 (the
   * LocalAgreement-2 setting that the streaming-ASR literature finds
   * close to optimal for English voice input).
   */
  agreementCount?: number;
}

export interface StabilizerOutput {
  /** The agreed-on prefix — safe to hand the drafter / phrase chunker. */
  stable: string;
  /**
   * The suffix that has not yet been agreed `n` times — surface in UI but
   * do not commit. Concatenating `stable + pending` reconstructs the
   * latest raw partial.
   */
  pending: string;
}

const DEFAULT_AGREEMENT_COUNT = 2;

/**
 * Find the longest character prefix shared by both strings. Character-level
 * (not word-level) so a partial that finished a word ("sa" → "sat") still
 * shows agreement on the shared prefix "sa" and only "t" stays pending.
 */
function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

export class PartialStabilizer {
  private readonly agreementCount: number;
  /**
   * The most recent partials, oldest first. We only need the last
   * `agreementCount` entries — the agreed prefix is the intersection of
   * all of them. Length 0 before any feed.
   */
  private history: string[] = [];
  /** The longest committed stable prefix so far. Monotonically grows. */
  private committed = "";

  constructor(options: PartialStabilizerOptions = {}) {
    const requested = options.agreementCount ?? DEFAULT_AGREEMENT_COUNT;
    if (!Number.isFinite(requested) || requested < 1) {
      throw new Error(
        `[partial-stabilizer] agreementCount must be a finite integer >= 1; got ${String(requested)}`,
      );
    }
    this.agreementCount = Math.floor(requested);
  }

  /**
   * Feed the latest streaming-ASR partial. Returns the stable / pending
   * split. The stable prefix is monotonically non-decreasing across calls
   * — once a span has been agreed `n` times it stays committed even if a
   * later partial briefly disagrees (the ASR will catch up; rolling back
   * would cause downstream stutter).
   */
  feed(partial: string): StabilizerOutput {
    this.history.push(partial);
    if (this.history.length > this.agreementCount) {
      this.history.shift();
    }
    if (this.history.length < this.agreementCount) {
      // Not enough partials yet to confirm anything new — only the
      // already-committed prefix is stable.
      return {
        stable: this.committed,
        pending: partial.startsWith(this.committed)
          ? partial.slice(this.committed.length)
          : partial,
      };
    }
    // Intersect: agreed prefix = common prefix across the whole agreement
    // window.
    let agreed = this.history[0];
    for (let i = 1; i < this.history.length; i++) {
      const sharedLen = commonPrefixLength(agreed, this.history[i]);
      if (sharedLen < agreed.length) {
        agreed = agreed.slice(0, sharedLen);
      }
      if (agreed.length === 0) break;
    }
    if (agreed.length > this.committed.length) {
      this.committed = agreed;
    }
    return {
      stable: this.committed,
      pending: partial.startsWith(this.committed)
        ? partial.slice(this.committed.length)
        : partial,
    };
  }

  /** The current committed stable prefix (read-only view). */
  stable(): string {
    return this.committed;
  }

  /** Clear all history. Call at utterance boundaries. */
  reset(): void {
    this.history = [];
    this.committed = "";
  }
}
