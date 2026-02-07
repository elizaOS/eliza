/**
 * Streaming type definitions.
 *
 * This module defines the interface contract for stream content extractors.
 * Implementations are in utils/streaming.ts.
 *
 * VALIDATION-AWARE STREAMING:
 * ---------------------------
 * LLMs can silently truncate output when hitting token limits. This is catastrophic
 * for structured outputs - you might stream half a broken response.
 *
 * Solution: Validation codes - short UUIDs the LLM must echo back. If the echoed
 * code matches, we know that part wasn't truncated.
 *
 * Validation Levels:
 * - 0 (Trusted): No codes, stream immediately. Fast but no safety.
 * - 1 (Progressive): Per-field codes, stream as each field validates.
 * - 2 (First Checkpoint): Code at start, buffer until validated.
 * - 3 (Full): Codes at start AND end, maximum safety.
 */

/**
 * Interface for stream content extractors.
 *
 * Implementations decide HOW to filter LLM output for streaming.
 * Could be XML parsing, JSON parsing, plain text passthrough, or custom logic.
 *
 * The framework doesn't care about format - that's implementation choice.
 *
 * Usage: Create a new instance for each stream. Don't reuse instances.
 *
 * @example
 * ```ts
 * // Simple passthrough - streams everything as-is
 * const extractor = new PassthroughExtractor();
 *
 * // XML tag extraction - extracts content from <text> tag
 * const extractor = new XmlTagExtractor('text');
 *
 * // Action-aware XML (DefaultMessageService)
 * const extractor = new ResponseStreamExtractor();
 *
 * // Custom implementation
 * class MyExtractor implements IStreamExtractor {
 *   private _done = false;
 *   get done() { return this._done; }
 *   push(chunk: string) { return this.myCustomLogic(chunk); }
 * }
 * ```
 */
export interface IStreamExtractor {
  /** Whether extraction is complete (no more content expected from this stream) */
  readonly done: boolean;

  /**
   * Process a chunk from the LLM stream.
   * @param chunk - Raw chunk from LLM
   * @returns Text to stream to client (empty string = nothing to stream yet)
   */
  push(chunk: string): string;

  /**
   * Flush any buffered content (called when stream ends).
   * @returns Any remaining buffered content
   */
  flush?(): string;

  /**
   * Reset internal state for reuse (e.g., between retry attempts).
   */
  reset?(): void;
}

/**
 * Interface for streaming retry state tracking.
 *
 * WHY: When streaming fails mid-response, we need to:
 * 1. Know what was successfully streamed (for continuation prompts)
 * 2. Know if the stream completed (don't retry complete streams)
 * 3. Reset state for retry attempts
 */
export interface IStreamingRetryState {
  /**
   * Get all text that was successfully streamed.
   * Use this for building continuation prompts on retry.
   */
  getStreamedText(): string;

  /**
   * Check if streaming completed successfully.
   * If true, no retry needed. If false, can retry with continuation.
   */
  isComplete(): boolean;

  /**
   * Reset state for a new streaming attempt.
   */
  reset(): void;
}
