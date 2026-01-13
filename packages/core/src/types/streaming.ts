/**
 * Streaming type definitions.
 *
 * This module defines the interface contract for stream content extractors.
 * Implementations are in utils/streaming.ts.
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
   * Reset extractor state for retry or reuse.
   * Clears buffer, resets done flag, and any internal state.
   */
  reset(): void;

  /**
   * Flush any buffered content that hasn't been returned yet.
   * Called when stream ends unexpectedly to recover partial content.
   * Optional - extractors that don't buffer can omit this.
   * @returns Remaining buffered content (empty string if none)
   */
  flush?(): string;
}

/**
 * Tracks extractor state for intelligent retry decisions.
 * Enables:
 * - Skip retry when text extraction is complete (isComplete)
 * - Continuation prompts when text is cut mid-stream
 */
export interface IStreamingRetryState {
  /** Text that has been streamed to the user */
  getStreamedText: () => string;
  /** Whether the extractor found the closing tag (text is complete) */
  isComplete: () => boolean;
  /** Reset extractor for fresh streaming on continuation */
  reset: () => void;
}
