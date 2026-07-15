/**
 * Phrase aggregator — the SINGLE phrase-chunking policy feeding Cartesia
 * (contract §10: "reuse PhraseChunkedTts semantics; do NOT add a third
 * chunker"). This is that one policy for the realtime WS path.
 *
 * The LLM leg streams token deltas. Sending each token to Cartesia as its own
 * phrase would thrash the TTS context and hurt prosody; buffering the whole
 * reply would destroy first-audio latency. This aggregator emits a phrase as
 * soon as a natural boundary is reached (sentence terminator, hard clause
 * break, or a max-buffer threshold), so the first spoken phrase leaves for
 * Cartesia the moment the model has produced a speakable unit — before the LLM
 * has finished the full reply (the §Phase-1 acceptance criterion).
 *
 * Pure and deterministic: no timers, no I/O. The session drives it with
 * `push(delta)` and `flush()`, and forwards each returned phrase to the
 * Cartesia stream with `continueContext: true` after the first.
 */

/** Emit a phrase once the buffer reaches this many chars even without a boundary. */
export const PHRASE_MAX_BUFFER_CHARS = 180;
/** Don't emit a boundary phrase shorter than this (avoid choppy one-word TTS). */
export const PHRASE_MIN_EMIT_CHARS = 2;

const TERMINATORS = new Set([".", "!", "?", "…", "。", "！", "？", "\n"]);
const CLAUSE_BREAKS = new Set([",", ";", ":", "—"]);

export interface PhraseAggregatorOptions {
  maxBufferChars?: number;
  minEmitChars?: number;
}

export class PhraseAggregator {
  private buffer = "";
  private emittedCount = 0;
  private readonly maxBufferChars: number;
  private readonly minEmitChars: number;

  constructor(options?: PhraseAggregatorOptions) {
    this.maxBufferChars = options?.maxBufferChars ?? PHRASE_MAX_BUFFER_CHARS;
    this.minEmitChars = options?.minEmitChars ?? PHRASE_MIN_EMIT_CHARS;
  }

  /** Number of phrases emitted so far (for `continueContext` sequencing). */
  get emitted(): number {
    return this.emittedCount;
  }

  /**
   * Push a token/delta. Returns zero or more complete phrases ready for
   * Cartesia. A phrase is emitted at a sentence terminator, at a clause break
   * once the buffer is already substantial, or when the max buffer is hit.
   */
  push(delta: string): string[] {
    if (!delta) return [];
    const phrases: string[] = [];
    for (const ch of delta) {
      this.buffer += ch;
      if (TERMINATORS.has(ch)) {
        const phrase = this.take();
        if (phrase) phrases.push(phrase);
        continue;
      }
      if (CLAUSE_BREAKS.has(ch) && this.buffer.trim().length >= Math.max(this.minEmitChars, 40)) {
        const phrase = this.take();
        if (phrase) phrases.push(phrase);
        continue;
      }
      if (this.buffer.length >= this.maxBufferChars) {
        const phrase = this.take();
        if (phrase) phrases.push(phrase);
      }
    }
    return phrases;
  }

  /**
   * Flush the trailing buffer as a final phrase (end of LLM stream). Returns
   * the remaining text or null if nothing speakable is left.
   */
  flush(): string | null {
    return this.take();
  }

  /** Discard buffered text without emitting — used on interruption. */
  reset(): void {
    this.buffer = "";
  }

  private take(): string | null {
    const trimmed = this.buffer.trim();
    this.buffer = "";
    if (trimmed.length < this.minEmitChars) {
      return trimmed.length > 0 ? null : null;
    }
    this.emittedCount += 1;
    return trimmed;
  }
}
