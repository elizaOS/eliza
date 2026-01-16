/**
 * Streaming utilities for filtering and extracting streamable content.
 *
 * WHY THIS MODULE EXISTS:
 * -----------------------
 * LLM outputs are streamed in chunks for better UX (users see responses as they're
 * generated, not after a long wait). But raw LLM output often contains structure
 * (XML tags, JSON) that users shouldn't see. This module provides extractors that
 * filter and validate streaming content before it reaches the user.
 *
 * ARCHITECTURE:
 * -------------
 * All extractors implement {@link IStreamExtractor} interface:
 * - push(chunk) - Process incoming chunk, return content safe to display
 * - flush() - Get any buffered content when stream ends
 * - reset() - Clear state for reuse
 * - done - Whether extractor has finished
 *
 * EXTRACTOR TYPES:
 * ----------------
 * - PassthroughExtractor: No filtering (for trusted/raw output)
 * - XmlTagExtractor: Extract content from a specific XML tag
 * - ResponseStreamExtractor: Action-aware XML (knows REPLY vs delegated actions)
 * - ActionStreamFilter: Content-type aware (JSON/XML/plain text detection)
 * - ValidationStreamExtractor: Validation-aware streaming with retry support
 *
 * VALIDATION-AWARE STREAMING (ValidationStreamExtractor):
 * -------------------------------------------------------
 * The key innovation is handling validation DURING streaming, not just after.
 *
 * Problem: LLMs can truncate output mid-response (context window exhausted).
 * If we stream everything and then validate, user sees invalid partial content.
 *
 * Solution: Validation codes - short UUID snippets around fields. If the code
 * before and after a field match, we know it wasn't truncated.
 *
 * Validation Levels:
 * - Level 0 (Trusted): No codes, stream immediately. Fast but no safety.
 * - Level 1 (Progressive): Per-field codes, stream as each field validates.
 * - Level 2 (First Checkpoint): Single code at start, buffer until validated.
 * - Level 3 (Full): Codes at start AND end, maximum safety.
 *
 * For interface definition, see types/streaming.ts.
 *
 * @module streaming
 */

import type { IStreamExtractor, IStreamingRetryState } from '../types/streaming';
import type { StreamingContext } from '../streaming-context';
import type { UUID, SchemaRow, StreamEvent, StreamEventType } from '../types';

// Re-export interfaces for convenience
export type { IStreamExtractor, IStreamingRetryState } from '../types/streaming';

// ============================================================================
// StreamError - Standardized error handling for streaming
// ============================================================================

/** Error codes for streaming operations */
export type StreamErrorCode =
  | 'CHUNK_TOO_LARGE'
  | 'BUFFER_OVERFLOW'
  | 'PARSE_ERROR'
  | 'TIMEOUT'
  | 'ABORTED';

/**
 * Standardized error class for streaming operations.
 * Provides structured error codes for easier handling.
 */
export class StreamError extends Error {
  readonly code: StreamErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: StreamErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'StreamError';
    this.code = code;
    this.details = details;
  }

  /** Check if an error is a StreamError */
  static isStreamError(error: unknown): error is StreamError {
    return error instanceof StreamError;
  }
}

// ============================================================================
// Streaming Retry State - For intelligent retry handling
// ============================================================================

/**
 * Creates a streaming retry state from an extractor.
 * Use this to track streaming state for intelligent retry logic.
 *
 * @example
 * ```ts
 * const extractor = new ResponseStreamExtractor();
 * const retryState = createStreamingRetryState(extractor);
 *
 * // After streaming fails...
 * if (retryState.isComplete()) {
 *   // Text extraction finished - use streamedText, no retry needed
 *   return retryState.getStreamedText();
 * } else {
 *   // Text was cut - retry with continuation prompt
 *   retryState.reset();
 *   // ... retry with: "You started: '${streamedText}', continue..."
 * }
 * ```
 */
export function createStreamingRetryState(
  extractor: IStreamExtractor
): IStreamingRetryState & { _appendText: (text: string) => void } {
  let streamedText = '';

  return {
    getStreamedText: () => {
      // Include any buffered content that wasn't returned yet (SAFE_MARGIN)
      // Accumulate flushed content into streamedText to ensure consistent results
      const buffered = extractor.flush?.() ?? '';
      if (buffered) {
        streamedText += buffered;
      }
      return streamedText;
    },
    isComplete: () => extractor.done,
    reset: () => {
      extractor.reset();
      streamedText = '';
    },
    // Internal: called by streaming callback to accumulate text
    _appendText: (text: string) => {
      streamedText += text;
    },
  };
}

/**
 * Creates a complete streaming context with retry state management.
 * Use this to avoid duplicating streaming context creation logic.
 *
 * @param extractor - The stream extractor to use (e.g., ResponseStreamExtractor, XmlTagExtractor)
 * @param onStreamChunk - Callback to send chunks to the client
 * @param messageId - Optional message ID for the streaming context
 * @returns A complete StreamingContext with retry state methods
 *
 * @example
 * ```ts
 * const ctx = createStreamingContext(
 *   new ResponseStreamExtractor(),
 *   async (chunk) => res.write(chunk),
 *   responseId
 * );
 *
 * await runWithStreamingContext(ctx, () => runtime.useModel(...));
 *
 * // After streaming, check retry state
 * if (ctx.isComplete()) {
 *   return ctx.getStreamedText();
 * }
 * ```
 */
export function createStreamingContext(
  extractor: IStreamExtractor,
  onStreamChunk: (chunk: string, messageId?: string) => Promise<void>,
  messageId?: string
): StreamingContext {
  const retryState = createStreamingRetryState(extractor);

  return {
    onStreamChunk: async (chunk: string, msgId?: string) => {
      if (extractor.done) return;
      const textToStream = extractor.push(chunk);
      if (textToStream) {
        retryState._appendText(textToStream);
        await onStreamChunk(textToStream, msgId);
      }
    },
    messageId,
    reset: retryState.reset,
    getStreamedText: retryState.getStreamedText,
    isComplete: retryState.isComplete,
  };
}

// ============================================================================
// Shared constants and utilities
// ============================================================================

/** Safe margin to keep when streaming to avoid splitting closing tags */
const SAFE_MARGIN = 10;

/** Maximum buffer size to prevent memory exhaustion (100KB) */
const MAX_BUFFER = 100 * 1024;

/** Maximum chunk size to prevent DoS (1MB) */
const MAX_CHUNK_SIZE = 1024 * 1024;

/**
 * Result of attempting to extract content from an XML tag.
 */
interface TagExtractionResult {
  /** Content extracted (empty string if nothing yet) */
  content: string;
  /** Whether the closing tag was found */
  closed: boolean;
  /** Updated buffer after extraction */
  buffer: string;
  /** Whether we're now inside the tag */
  insideTag: boolean;
}

/**
 * Extracts content from an XML tag in a streaming-friendly way.
 * Shared utility used by multiple extractors.
 *
 * @param buffer - Current accumulated buffer
 * @param openTag - Opening tag (e.g., "<text>")
 * @param closeTag - Closing tag (e.g., "</text>")
 * @param insideTag - Whether we're currently inside the tag
 * @param safeMargin - Margin to keep for potential split tags
 * @returns Extraction result with content and updated state
 */
function extractTagContent(
  buffer: string,
  openTag: string,
  closeTag: string,
  insideTag: boolean,
  safeMargin: number = SAFE_MARGIN
): TagExtractionResult {
  let currentBuffer = buffer;
  let currentInsideTag = insideTag;

  // Look for opening tag if not inside
  if (!currentInsideTag) {
    const idx = currentBuffer.indexOf(openTag);
    if (idx !== -1) {
      currentInsideTag = true;
      currentBuffer = currentBuffer.slice(idx + openTag.length);
    } else {
      return { content: '', closed: false, buffer: currentBuffer, insideTag: false };
    }
  }

  // Check for closing tag
  const closeIdx = currentBuffer.indexOf(closeTag);
  if (closeIdx !== -1) {
    const content = currentBuffer.slice(0, closeIdx);
    const newBuffer = currentBuffer.slice(closeIdx + closeTag.length);
    return { content, closed: true, buffer: newBuffer, insideTag: false };
  }

  // Stream safe content (keep margin for potential closing tag split)
  if (currentBuffer.length > safeMargin) {
    const content = currentBuffer.slice(0, -safeMargin);
    const newBuffer = currentBuffer.slice(-safeMargin);
    return { content, closed: false, buffer: newBuffer, insideTag: true };
  }

  return { content: '', closed: false, buffer: currentBuffer, insideTag: true };
}

/**
 * Validates and limits chunk size to prevent DoS attacks.
 * @throws StreamError if chunk exceeds maximum size
 */
function validateChunkSize(chunk: string): void {
  if (chunk.length > MAX_CHUNK_SIZE) {
    throw new StreamError(
      'CHUNK_TOO_LARGE',
      `Chunk size ${chunk.length} exceeds maximum allowed ${MAX_CHUNK_SIZE}`,
      {
        chunkSize: chunk.length,
        maxAllowed: MAX_CHUNK_SIZE,
      }
    );
  }
}

/**
 * Trims buffer to prevent unbounded growth.
 */
function trimBuffer(buffer: string, maxSize: number = MAX_BUFFER, keepSize: number = 1024): string {
  if (buffer.length > maxSize) {
    return buffer.slice(-keepSize);
  }
  return buffer;
}

// ============================================================================
// PassthroughExtractor - Simplest implementation
// ============================================================================

/**
 * Streams all content as-is without any filtering.
 * Use when LLM output is already in the desired format (e.g., plain text responses).
 */
export class PassthroughExtractor implements IStreamExtractor {
  get done(): boolean {
    return false; // Never "done" - always accepts more
  }

  push(chunk: string): string {
    validateChunkSize(chunk);
    return chunk; // Pass through everything
  }

  reset(): void {
    // Nothing to reset
  }
}

/**
 * Passthrough extractor that can be marked complete externally.
 *
 * WHY: When using ValidationStreamExtractor inside dynamicPromptExecFromState,
 * extraction/completion is handled internally. But the outer streaming context
 * still needs to know when streaming is complete for retry/fallback logic.
 *
 * This extractor passes through all content and provides a markComplete() method
 * that the caller can invoke when the underlying operation completes successfully.
 *
 * @example
 * ```ts
 * const extractor = new MarkableExtractor();
 * const ctx = createStreamingContext(extractor, callback);
 *
 * const result = await dynamicPromptExecFromState({ ... });
 * if (result) {
 *   extractor.markComplete(); // Signal success
 * }
 *
 * if (ctx.isComplete()) {
 *   // Now returns true after markComplete()
 * }
 * ```
 */
export class MarkableExtractor implements IStreamExtractor {
  private _done = false;

  get done(): boolean {
    return this._done;
  }

  push(chunk: string): string {
    validateChunkSize(chunk);
    return chunk; // Pass through everything
  }

  flush(): string {
    return '';
  }

  reset(): void {
    this._done = false;
  }

  /**
   * Mark the extractor as complete.
   * WHY: Called by the outer code when the underlying operation (e.g., dynamicPromptExecFromState)
   * completes successfully. This allows isComplete() to return true for retry/fallback logic.
   */
  markComplete(): void {
    this._done = true;
  }
}

// ============================================================================
// XmlTagExtractor - Simple XML tag content extraction
// ============================================================================

/**
 * Extracts content from a specific XML tag, streaming it progressively.
 * Use when you have a simple XML format like `<response><text>content</text></response>`.
 *
 * @example
 * ```ts
 * const extractor = new XmlTagExtractor('text');
 * extractor.push('<response><text>Hello'); // Returns 'Hel' (keeps margin for split tags)
 * extractor.push(' world!</text></response>'); // Returns 'lo world!'
 * ```
 */
export class XmlTagExtractor implements IStreamExtractor {
  private readonly openTag: string;
  private readonly closeTag: string;

  private buffer = '';
  private insideTag = false;
  private finished = false;

  constructor(tagName: string) {
    this.openTag = `<${tagName}>`;
    this.closeTag = `</${tagName}>`;
  }

  get done(): boolean {
    return this.finished;
  }

  push(chunk: string): string {
    if (this.finished) return '';

    validateChunkSize(chunk);
    this.buffer += chunk;

    // Trim buffer if too large and not inside tag
    if (!this.insideTag) {
      this.buffer = trimBuffer(this.buffer);
    }

    const result = extractTagContent(
      this.buffer,
      this.openTag,
      this.closeTag,
      this.insideTag,
      SAFE_MARGIN
    );

    this.buffer = result.buffer;
    this.insideTag = result.insideTag;

    if (result.closed) {
      this.finished = true;
    }

    return result.content;
  }

  reset(): void {
    this.buffer = '';
    this.insideTag = false;
    this.finished = false;
  }

  /**
   * Flush remaining buffered content when stream ends unexpectedly.
   */
  flush(): string {
    if (this.insideTag && this.buffer.length > 0) {
      const content = this.buffer;
      this.buffer = '';
      return content;
    }
    return '';
  }
}

// ============================================================================
// ResponseStreamExtractor - Action-aware XML extraction (DefaultMessageService)
// ============================================================================

/** Response strategy based on <actions> content */
type ResponseStrategy = 'pending' | 'direct' | 'delegated';

/**
 * Extracts streamable text from XML-structured LLM responses with action-based routing.
 *
 * This is the default implementation used by DefaultMessageService.
 * It understands the `<actions>` tag to determine whether to stream `<text>` content.
 *
 * Strategy:
 * - Parse <actions> to determine if response is direct (REPLY) or delegated (other actions)
 * - If direct: stream <text> content immediately
 * - If delegated: skip <text> (action handler will generate its own response via ActionStreamFilter)
 *
 * For simpler use cases without action routing, use {@link XmlTagExtractor} instead.
 */
export class ResponseStreamExtractor implements IStreamExtractor {
  private static readonly STREAM_TAGS = ['text'] as const;

  private buffer = '';
  private insideTag = false;
  private currentTag: string | null = null;
  private finished = false;
  private responseStrategy: ResponseStrategy = 'pending';

  get done(): boolean {
    return this.finished;
  }

  reset(): void {
    this.buffer = '';
    this.insideTag = false;
    this.currentTag = null;
    this.finished = false;
    this.responseStrategy = 'pending';
  }

  /**
   * Flush remaining buffered content when stream ends unexpectedly.
   * Returns content that was held back due to SAFE_MARGIN.
   */
  flush(): string {
    if (this.insideTag && this.buffer.length > 0) {
      const content = this.buffer;
      this.buffer = '';
      return content;
    }
    return '';
  }

  push(chunk: string): string {
    validateChunkSize(chunk);
    this.buffer += chunk;

    // Detect strategy from <actions> tag (comes before <text>)
    if (this.responseStrategy === 'pending') {
      this.detectResponseStrategy();
    }

    // Look for streamable tags
    if (!this.insideTag) {
      for (const tag of ResponseStreamExtractor.STREAM_TAGS) {
        const openTag = `<${tag}>`;
        const closeTag = `</${tag}>`;
        const idx = this.buffer.indexOf(openTag);

        if (idx !== -1) {
          // Check if we should stream this tag
          if (!this.shouldStreamTag(tag)) {
            // Skip tag entirely - wait for closing tag and remove
            const closeIdx = this.buffer.indexOf(closeTag);
            if (closeIdx !== -1) {
              this.buffer = this.buffer.slice(closeIdx + closeTag.length);
              continue;
            }
            break; // Wait for closing tag
          }

          this.insideTag = true;
          this.currentTag = tag;
          this.buffer = this.buffer.slice(idx + openTag.length);
          break;
        }
      }
    }

    // Trim buffer if too large and not inside tag
    if (!this.insideTag) {
      this.buffer = trimBuffer(this.buffer);
      return '';
    }

    // Extract content from current tag using shared helper
    const closeTag = `</${this.currentTag}>`;
    const closeIdx = this.buffer.indexOf(closeTag);

    if (closeIdx !== -1) {
      const content = this.buffer.slice(0, closeIdx);
      this.buffer = this.buffer.slice(closeIdx + closeTag.length);
      this.insideTag = false;
      this.currentTag = null;
      this.finished = true;
      return content;
    }

    // Stream safe content (keep margin for potential closing tag split)
    if (this.buffer.length > SAFE_MARGIN) {
      const toStream = this.buffer.slice(0, -SAFE_MARGIN);
      this.buffer = this.buffer.slice(-SAFE_MARGIN);
      return toStream;
    }

    return '';
  }

  /** Detect response strategy from <actions> tag using indexOf (ReDoS-safe) */
  private detectResponseStrategy(): void {
    const openTag = '<actions>';
    const closeTag = '</actions>';
    const startIdx = this.buffer.indexOf(openTag);
    if (startIdx === -1) return;

    const contentStart = startIdx + openTag.length;
    const endIdx = this.buffer.indexOf(closeTag, contentStart);
    if (endIdx === -1) return;

    const actionsContent = this.buffer.substring(contentStart, endIdx);
    const actions = this.parseActions(actionsContent);
    this.responseStrategy = this.isDirectReply(actions) ? 'direct' : 'delegated';
  }

  /** Parse comma-separated actions */
  private parseActions(raw: string): string[] {
    return raw
      .split(',')
      .map((a) => a.trim().toUpperCase())
      .filter(Boolean);
  }

  /** Check if actions represent a direct reply */
  private isDirectReply(actions: string[]): boolean {
    return actions.length === 1 && actions[0] === 'REPLY';
  }

  /** Determine if a tag should be streamed based on strategy */
  private shouldStreamTag(tag: string): boolean {
    return tag === 'text' && this.responseStrategy === 'direct';
  }
}

// ============================================================================
// ActionStreamFilter - For action handler response filtering
// ============================================================================

/** Detected content type from first character */
type ContentType = 'json' | 'xml' | 'text';

/**
 * Filters action handler output for streaming.
 * Used by runtime.ts processActions() for each action's useModel calls.
 *
 * Auto-detects content type from first non-whitespace character:
 * - JSON (starts with { or [) → Don't stream (structured data for parsing)
 * - XML (starts with <) → Look for <text> tag and stream its content
 * - Plain text → Stream immediately
 */
export class ActionStreamFilter implements IStreamExtractor {
  private buffer = '';
  private decided = false;
  private contentType: ContentType | null = null;
  private insideTextTag = false;
  private finished = false;

  get done(): boolean {
    return this.finished;
  }

  reset(): void {
    this.buffer = '';
    this.decided = false;
    this.contentType = null;
    this.insideTextTag = false;
    this.finished = false;
  }

  /**
   * Flush remaining buffered content when stream ends unexpectedly.
   */
  flush(): string {
    // Only flush if inside XML text tag (text content is buffered)
    if (this.contentType === 'xml' && this.insideTextTag && this.buffer.length > 0) {
      const content = this.buffer;
      this.buffer = '';
      return content;
    }
    return '';
  }

  push(chunk: string): string {
    validateChunkSize(chunk);
    this.buffer += chunk;

    // Decide content type on first non-whitespace character
    if (!this.decided) {
      const contentType = this.detectContentType();
      if (contentType) {
        this.contentType = contentType;
        this.decided = true;
      } else {
        return '';
      }
    }

    // Route based on content type
    switch (this.contentType) {
      case 'json':
        return ''; // Never stream JSON

      case 'text':
        return this.handlePlainText();

      case 'xml':
        return this.handleXml();

      default:
        return '';
    }
  }

  /** Detect content type from first non-whitespace character */
  private detectContentType(): ContentType | null {
    const trimmed = this.buffer.trimStart();
    if (trimmed.length === 0) return null;

    const firstChar = trimmed[0];
    if (firstChar === '{' || firstChar === '[') return 'json';
    if (firstChar === '<') return 'xml';
    return 'text';
  }

  /** Handle plain text - stream everything */
  private handlePlainText(): string {
    const toStream = this.buffer;
    this.buffer = '';
    return toStream;
  }

  /** Handle XML content - extract and stream <text> tag content */
  private handleXml(): string {
    const result = extractTagContent(
      this.buffer,
      '<text>',
      '</text>',
      this.insideTextTag,
      SAFE_MARGIN
    );

    this.buffer = result.buffer;
    this.insideTextTag = result.insideTag;

    if (result.closed) {
      this.finished = true;
    }

    // Trim buffer if not inside tag and not found yet
    if (!this.insideTextTag && !result.closed) {
      this.buffer = trimBuffer(this.buffer, 1024, 1024);
    }

    return result.content;
  }
}

// ============================================================================
// ValidationStreamExtractor - Validation-aware streaming for dynamicPromptExecFromState
// ============================================================================

/**
 * Extractor state machine for validation-aware streaming.
 *
 * WHY: The extractor needs to track complex state across multiple concerns:
 * - Receiving chunks from the LLM
 * - Validating codes to ensure context wasn't truncated
 * - Managing retry flow when validation fails
 * - Signaling completion or failure to consumers
 *
 * The state machine ensures these transitions are explicit and debuggable.
 */
export type ExtractorState =
  | 'streaming' // Normal operation - actively receiving chunks from LLM
  | 'validating' // Stream ended, checking validation codes
  | 'retrying' // Validation failed, preparing context for retry
  | 'complete' // Successfully finished - all validation passed
  | 'failed'; // Unrecoverable error (max retries, abort, etc.)

/**
 * Per-field state tracking for progressive validation.
 *
 * WHY: For level 1 (progressive), we need to track each field independently.
 * This allows us to:
 * - Emit validated fields early (better UX)
 * - Include only validated fields in retry context (smarter retries)
 * - Diagnose exactly what went wrong (better error messages)
 */
export type FieldState =
  | 'pending' // Haven't seen this field yet
  | 'partial' // Found opening tag but no closing tag (might be streaming)
  | 'complete' // Found both tags, content extracted
  | 'invalid'; // Validation codes didn't match

/**
 * Configuration for ValidationStreamExtractor.
 *
 * WHY: This is a complex component with many knobs. Explicit config makes it
 * testable and reusable. The config is immutable after construction.
 */
export interface ValidationStreamExtractorConfig {
  /**
   * Validation level (0-3).
   * WHY: Different use cases need different tradeoffs:
   * - Level 0: Maximum speed, trust the model
   * - Level 1: Per-field validation, good balance
   * - Level 2-3: Maximum correctness, may be slower
   */
  level: 0 | 1 | 2 | 3;

  /** Schema rows with field definitions and validateField hints */
  schema: SchemaRow[];

  /**
   * Which fields to stream to the consumer.
   * WHY: Not all fields are user-visible. 'thought' is internal reasoning,
   * 'actions' is for the runtime. Usually only 'text' is streamed.
   */
  streamFields: string[];

  /**
   * Expected validation codes per field.
   * WHY: We generate random codes and tell the LLM to echo them.
   * If the echoed code matches, we know that part wasn't truncated.
   */
  expectedCodes: Map<string, string>;

  /**
   * Callback for streaming chunks to the consumer.
   * WHY: We need to push content out as it's validated, not return it.
   * The field parameter lets consumers know which field the chunk is from.
   */
  onChunk: (chunk: string, field?: string) => void;

  /**
   * Rich event callback for sophisticated consumers.
   * WHY: Simple consumers just want text. Advanced UIs want to know
   * about retries, validation progress, and errors to show appropriate UI.
   */
  onEvent?: (event: StreamEvent) => void;

  /**
   * Abort signal for user-initiated cancellation.
   * WHY: Long-running LLM calls should be cancellable. Users might navigate
   * away, click "stop", or timeout. This integrates with standard AbortController.
   */
  abortSignal?: AbortSignal;

  /**
   * Whether the consumer has an onEvent handler.
   * WHY: Simple consumers (just onStreamChunk) get an auto-generated separator
   * on retry: "-- that's not right, let me start again:". This prevents
   * confusing concatenated output. Rich consumers handle retries themselves.
   */
  hasRichConsumer?: boolean;
}

/**
 * Diagnosis result for error analysis.
 *
 * WHY: When validation fails, we need to know WHY to:
 * - Log useful debug info
 * - Build smarter retry prompts (include what we do have)
 * - Surface meaningful error messages to users
 */
export interface ValidationDiagnosis {
  /** Fields that were never started - LLM didn't output them at all */
  missingFields: string[];
  /** Fields with wrong validation codes - context was truncated */
  invalidFields: string[];
  /** Fields that started but didn't complete - stream cut mid-field */
  incompleteFields: string[];
}

/**
 * Validation-aware stream extractor for dynamicPromptExecFromState.
 *
 * WHY THIS EXISTS:
 * ------------------
 * LLMs can silently truncate output when they hit token limits or context windows.
 * This is catastrophic for structured outputs - you might get half a JSON object
 * or a response with missing fields. The user sees broken content.
 *
 * Traditional approach: Wait for complete response, validate, retry if invalid.
 * Problem: No streaming UX. Users stare at a blank screen.
 *
 * This extractor bridges the gap: it enables streaming while detecting truncation.
 * It uses "validation codes" - random UUIDs that the LLM must echo. If the echoed
 * code matches what we sent, we know that part wasn't truncated.
 *
 * VALIDATION LEVELS:
 * ------------------
 * Level 0 (Trusted): No validation codes. Stream immediately.
 *   WHY: Fast models (GPT-4, Claude) rarely truncate. Skip overhead.
 *   Use case: Chat responses, non-critical content.
 *
 * Level 1 (Progressive): Per-field validation codes. Emit as each field validates.
 *   WHY: Best balance of safety and UX. User sees content as it's confirmed safe.
 *   Use case: Important responses where you want both speed AND safety.
 *
 * Level 2 (First Checkpoint): Codes at response start only. Buffer until validated.
 *   WHY: Catches truncation at the beginning (e.g., model didn't read the prompt).
 *   Use case: Default behavior, good for most use cases.
 *
 * Level 3 (Full): Codes at start AND end. Buffer until both validate.
 *   WHY: Maximum safety. Catches truncation anywhere in the response.
 *   Use case: Critical operations, unreliable models, high-stakes content.
 *
 * CONSUMER PATTERNS:
 * ------------------
 * Simple consumer (just onStreamChunk):
 *   - Gets text chunks as they're validated
 *   - On retry, sees "-- that's not right, let me start again:" separator
 *   - Works without any special handling
 *
 * Rich consumer (onStreamChunk + onStreamEvent):
 *   - Gets typed events for validation, retry, error states
 *   - Can show spinners, clear partial content, display errors
 *   - Full control over UX
 *
 * @example Simple consumer
 * ```ts
 * const result = await runtime.dynamicPromptExecFromState({
 *   state,
 *   params: { prompt },
 *   schema: [{ field: 'text', description: 'Response', required: true }],
 *   options: {
 *     contextCheckLevel: 1,
 *     onStreamChunk: (chunk) => process.stdout.write(chunk),
 *   },
 * });
 * ```
 *
 * @example Rich consumer
 * ```ts
 * const result = await runtime.dynamicPromptExecFromState({
 *   state,
 *   params: { prompt },
 *   schema: [{ field: 'text', description: 'Response', required: true }],
 *   options: {
 *     contextCheckLevel: 1,
 *     onStreamChunk: (chunk) => appendToUI(chunk),
 *     onStreamEvent: (event) => {
 *       if (event.type === 'retry_start') {
 *         showSpinner('Retrying...');
 *         clearPartialContent();
 *       } else if (event.type === 'error') {
 *         showError(event.error);
 *       }
 *     },
 *   },
 * });
 * ```
 */
export class ValidationStreamExtractor implements IStreamExtractor {
  // Buffer accumulates raw LLM output until we can parse it
  private buffer = '';

  // Extracted content from each field (may be partial or complete)
  private fieldContents: Map<string, string> = new Map();

  // Fields that have passed validation - safe to emit and include in retry context
  private validatedFields: Set<string> = new Set();

  // What we've already emitted per field - for delta calculation
  // WHY: When streaming incrementally, we only emit the NEW content, not the whole field
  private emittedContent: Map<string, string> = new Map();

  // Per-field state tracking for diagnosis
  private fieldStates: Map<string, FieldState> = new Map();

  // Overall extractor state machine
  private state: ExtractorState = 'streaming';

  constructor(private readonly config: ValidationStreamExtractorConfig) {
    // Initialize all tracked fields to 'pending'
    // WHY: We need to know which fields we're expecting so we can diagnose missing ones
    for (const field of config.streamFields) {
      this.fieldStates.set(field, 'pending');
    }
  }

  // ============================================================================
  // IStreamExtractor interface
  // ============================================================================

  /**
   * Whether the extractor has finished (successfully or with error).
   * WHY: Callers need to know when to stop pushing chunks and read results.
   */
  get done(): boolean {
    return this.state === 'complete' || this.state === 'failed';
  }

  /**
   * Process an incoming chunk from the LLM.
   *
   * WHY: This is the hot path - called for every chunk from the LLM stream.
   * It needs to be efficient while also handling complex validation logic.
   *
   * The method:
   * 1. Checks for cancellation (user might have aborted)
   * 2. Accumulates chunk into buffer
   * 3. Extracts field contents from buffer
   * 4. For levels 0-1, checks if we can emit validated content
   *
   * Note: Returns empty string because we emit via callbacks, not return value.
   * WHY: IStreamExtractor interface expects string return, but our emission is
   * more complex (per-field, with events). We use callbacks instead.
   */
  push(chunk: string): string {
    // Check for cancellation FIRST - abort signal might have fired
    // WHY: User clicked "stop" or navigated away. Respect their intent immediately.
    if (this.config.abortSignal?.aborted) {
      if (this.state === 'streaming') {
        this.state = 'failed';
        this.emitEvent({ type: 'error', error: 'Cancelled by user' });
      }
      return '';
    }

    // Only accept chunks when actively streaming
    // WHY: After retry/complete/failed, we shouldn't process more chunks
    if (this.state !== 'streaming') return '';

    // Validate chunk size to prevent DoS
    // WHY: Malicious or buggy LLM could send huge chunks
    validateChunkSize(chunk);
    this.buffer += chunk;

    // Extract field contents from accumulated buffer
    // WHY: We need to see full field content to validate codes
    this.extractAllFields();

    // For levels 0-1, try to emit validated content immediately
    // WHY: Better UX - user sees content as soon as it's safe
    if (this.config.level <= 1) {
      this.checkPerFieldEmission();
    }
    // Levels 2-3: buffer only, emit on flush()
    // WHY: These levels need checkpoint validation before ANY emission

    return ''; // We handle emission via callback, not return value
  }

  // ============================================================================
  // Field extraction
  // ============================================================================

  /**
   * Extract all field contents from the accumulated buffer.
   *
   * WHY: As chunks arrive, we need to continuously scan for field boundaries.
   * This is called on every push() to detect when fields complete.
   *
   * Note: Uses simple indexOf() instead of regex for ReDoS safety.
   */
  private extractAllFields(): void {
    for (const field of this.config.streamFields) {
      const openTag = `<${field}>`;
      const closeTag = `</${field}>`;

      const startIdx = this.buffer.indexOf(openTag);
      if (startIdx === -1) continue;

      const contentStart = startIdx + openTag.length;
      const endIdx = this.buffer.indexOf(closeTag, contentStart);

      if (endIdx !== -1) {
        // Complete field found - both tags present
        const content = this.buffer.substring(contentStart, endIdx);
        this.fieldContents.set(field, content);
        // Update state only if we haven't already marked it invalid
        if (this.fieldStates.get(field) === 'pending' || this.fieldStates.get(field) === 'partial') {
          this.fieldStates.set(field, 'complete');
        }
      } else if (startIdx !== -1) {
        // Partial field - opened but not closed (might still be streaming)
        const content = this.buffer.substring(contentStart);
        this.fieldContents.set(field, content);
        if (this.fieldStates.get(field) === 'pending') {
          this.fieldStates.set(field, 'partial');
        }
      }
    }
  }

  // ============================================================================
  // Level 0-1: Per-field emission
  // ============================================================================

  /**
   * Check each field and emit if validation passes.
   *
   * WHY: For levels 0-1, we want to emit content as soon as it's validated.
   * This gives the best streaming UX while maintaining safety.
   *
   * The logic respects validateField hints:
   * - Level 0 default: no validation (opt-in via validateField: true)
   * - Level 1 default: validation required (opt-out via validateField: false)
   */
  private checkPerFieldEmission(): void {
    for (const field of this.config.streamFields) {
      // Skip already validated fields
      if (this.validatedFields.has(field)) continue;

      // Skip already invalid fields to prevent duplicate error events
      // WHY: Once a field is marked invalid, we've already emitted the error.
      // Re-checking would emit duplicate errors on every push() call.
      if (this.fieldStates.get(field) === 'invalid') continue;

      // Find schema row to check validateField hint
      const schemaField = this.config.schema.find((s) => s.field === field);

      // Determine if this field needs validation codes
      // WHY: Level 0 is "trusted" so default is no codes (opt-in)
      //      Level 1 is "progressive" so default is codes (opt-out)
      const defaultValidate = this.config.level === 1;
      const needsValidation = schemaField?.validateField ?? defaultValidate;

      const content = this.fieldContents.get(field);
      if (!content) continue;

      if (needsValidation) {
        // Check for validation codes around this field
        const startCodeValid = this.checkValidationCode(field, 'start');
        const endCodeValid = this.checkValidationCode(field, 'end');

        if (startCodeValid === false) {
          // Start code present but WRONG - context was definitely truncated
          // WHY: If the code is present but doesn't match, something is very wrong
          this.fieldStates.set(field, 'invalid');
          this.emitEvent({ type: 'error', field, error: `Invalid start code for ${field}` });
          continue;
        }

        if (endCodeValid === false) {
          // End code present but WRONG - truncated at the end of this field
          // WHY: Start was valid but end isn't - field content was corrupted
          this.fieldStates.set(field, 'invalid');
          this.emitEvent({ type: 'error', field, error: `Invalid end code for ${field}` });
          continue;
        }

        if (startCodeValid && endCodeValid) {
          // Both codes valid! This field is safe to emit
          this.validatedFields.add(field);
          this.emitEvent({ type: 'field_validated', field });
          this.emitFieldContent(field, content);
        }
        // If we have start but not end (endCodeValid === undefined), keep waiting
        // WHY: Field might still be streaming, closing tag not arrived yet
      } else {
        // No validation needed - emit incrementally as content arrives
        // WHY: For trusted fields, show content immediately (best UX)
        this.emitFieldContent(field, content);
      }
    }
  }

  /**
   * Check if a validation code matches expectations.
   *
   * WHY: Validation codes are short UUID snippets that the LLM must echo.
   * If the echoed code matches what we sent, we know that part of the response
   * wasn't truncated or corrupted.
   *
   * @returns true if code matches, false if code present but wrong, null if code not found
   */
  private checkValidationCode(field: string, position: 'start' | 'end'): boolean | null {
    const codeTag = `code_${field}_${position}`;
    const openTag = `<${codeTag}>`;
    const closeTag = `</${codeTag}>`;

    const startIdx = this.buffer.indexOf(openTag);
    if (startIdx === -1) return null;

    const contentStart = startIdx + openTag.length;
    const endIdx = this.buffer.indexOf(closeTag, contentStart);
    if (endIdx === -1) return null;

    const codeValue = this.buffer.substring(contentStart, endIdx).trim();
    const expected = this.config.expectedCodes.get(field);

    return codeValue === expected;
  }

  // ============================================================================
  // Content emission
  // ============================================================================

  /**
   * Emit field content incrementally using delta calculation.
   *
   * WHY: When streaming level 0-1, we call this repeatedly as content grows.
   * We need to emit only NEW content, not re-emit what was already sent.
   *
   * Example: Field content grows "Hello" → "Hello world"
   *   - First call: emits "Hello"
   *   - Second call: emits " world" (only the delta)
   *
   * This ensures smooth streaming without duplicate text.
   */
  private emitFieldContent(field: string, fullContent: string): void {
    const previouslyEmitted = this.emittedContent.get(field) || '';
    if (fullContent.length > previouslyEmitted.length) {
      // Calculate delta - only the NEW content
      const delta = fullContent.slice(previouslyEmitted.length);
      this.emittedContent.set(field, fullContent);

      // Emit via chunk callback (for simple consumers)
      this.config.onChunk(delta, field);

      // Also emit as event (for rich consumers)
      this.emitEvent({ type: 'chunk', content: delta, field });
    }
  }

  /**
   * Emit a stream event to rich consumers.
   *
   * WHY: Rich consumers want typed events, not just text.
   * This is a no-op if onEvent wasn't provided (simple consumer pattern).
   */
  private emitEvent(event: StreamEvent): void {
    this.config.onEvent?.(event);
  }

  // ============================================================================
  // Lifecycle methods
  // ============================================================================

  /**
   * Called when the LLM stream ends successfully.
   * For levels 2-3, this is when we finally emit buffered content.
   *
   * WHY: Levels 2-3 buffer ALL content until validation passes.
   * flush() is called after checkpoint codes are verified, signaling it's safe
   * to release the buffered content to the consumer.
   *
   * @returns Empty string (IStreamExtractor interface compatibility)
   */
  flush(): string {
    this.state = 'complete';

    // For levels 2-3, emit everything now that validation passed
    // WHY: We buffered content waiting for checkpoint validation
    if (this.config.level >= 2) {
      for (const field of this.config.streamFields) {
        const content = this.fieldContents.get(field);
        if (content) {
          this.config.onChunk(content, field);
          this.emitEvent({ type: 'chunk', content, field });
        }
      }
    }

    this.emitEvent({ type: 'complete' });
    return '';
  }

  /**
   * Signal to consumer that a retry is starting.
   *
   * WHY: When validation fails, dynamicPromptExecFromState retries the LLM call.
   * The consumer needs to know so they can:
   * - Clear any partial/invalid content shown to user
   * - Show a retry indicator (spinner, message)
   * - NOT concatenate the retry output with the invalid output
   *
   * For SIMPLE consumers (no onStreamEvent):
   *   We emit a separator: "-- that's not right, let me start again:"
   *   WHY: Without this, the user would see invalid text followed by retry text,
   *   which looks like concatenated gibberish.
   *
   * For RICH consumers (has onStreamEvent):
   *   They receive retry_start event and handle it themselves.
   *   WHY: They might want custom UX (clear content, show spinner, etc.)
   *
   * @param retryCount Current retry attempt (1-indexed)
   * @returns Info about emission state for retry prompt building
   */
  signalRetry(retryCount: number): { hasPartialEmission: boolean; validatedFields: string[] } {
    this.state = 'retrying';
    const validated = Array.from(this.validatedFields);
    const hasPartialEmission = this.emittedContent.size > 0;

    // For simple consumers, emit separator to prevent confusing concatenation
    // WHY: Without this, they'd see "partial invalid text" + "retry text" = gibberish
    if (!this.config.hasRichConsumer && hasPartialEmission) {
      this.config.onChunk("\n\n-- that's not right, let me start again:\n\n");
    }

    // Emit retry event for rich consumers
    this.emitEvent({
      type: 'retry_start',
      retryCount,
      validatedFields: validated,
    });

    // If we have validated fields, inform consumer for potential context reuse
    // WHY: Level 1 can include validated fields in retry prompt for smarter retries
    if (validated.length > 0) {
      this.emitEvent({
        type: 'retry_context',
        validatedFields: validated,
        content: `Keeping validated fields: ${validated.join(', ')}`,
      });
    }

    return { hasPartialEmission, validatedFields: validated };
  }

  /**
   * Signal unrecoverable error (e.g., max retries exceeded, abort).
   *
   * WHY: After max retries, we need to inform the consumer that we've given up.
   * This transitions the state machine to 'failed' and emits error event.
   * The consumer can then display an appropriate error message to the user.
   *
   * @param error Human-readable error message
   */
  signalError(error: string): void {
    this.state = 'failed';
    this.emitEvent({ type: 'error', error });
  }

  /**
   * Get validated field contents for building smarter retry prompts.
   *
   * WHY: For level 1 (progressive), some fields might have validated while
   * others failed. Instead of starting from scratch, we can include the
   * validated content in the retry prompt:
   *   "You already correctly produced these fields: {thought: 'xxx'}
   *    Please continue with the remaining fields."
   *
   * This makes retries faster and more likely to succeed.
   *
   * @returns Map of field name → validated content
   */
  getValidatedFields(): Map<string, string> {
    const result = new Map<string, string>();
    for (const field of this.validatedFields) {
      const content = this.fieldContents.get(field);
      if (content) result.set(field, content);
    }
    return result;
  }

  /**
   * Diagnose what went wrong for error messaging and debugging.
   *
   * WHY: When validation fails, we need to know WHY to:
   * - Log useful debug info for developers
   * - Build informative error messages for users
   * - Potentially build smarter retry prompts
   *
   * The diagnosis categorizes fields into three buckets:
   * - missing: LLM never started outputting this field
   * - invalid: Field was output but validation codes didn't match
   * - incomplete: Field started but never finished (truncated mid-field)
   *
   * @returns Diagnosis object with categorized field lists
   */
  diagnose(): ValidationDiagnosis {
    const missingFields: string[] = [];
    const invalidFields: string[] = [];
    const incompleteFields: string[] = [];

    for (const [field, state] of this.fieldStates) {
      switch (state) {
        case 'pending':
          // Never saw opening tag
          missingFields.push(field);
          break;
        case 'invalid':
          // Validation codes didn't match
          invalidFields.push(field);
          break;
        case 'partial':
          // Opened but never closed (truncated)
          incompleteFields.push(field);
          break;
        // 'complete' fields are fine, not included in diagnosis
      }
    }

    return { missingFields, invalidFields, incompleteFields };
  }

  // ============================================================================
  // State management
  // ============================================================================

  /**
   * Full reset for retry - clears all accumulated state.
   *
   * WHY: When retrying, we need a fresh start. The extractor is reused
   * (not recreated) so it can track validated fields across retries.
   * But the buffer, emission tracking, and field states must be cleared.
   *
   * Called by dynamicPromptExecFromState before each retry attempt.
   */
  reset(): void {
    this.buffer = '';
    this.fieldContents.clear();
    this.validatedFields.clear();
    this.emittedContent.clear();
    this.state = 'streaming';
    for (const field of this.config.streamFields) {
      this.fieldStates.set(field, 'pending');
    }
  }

  /**
   * Get current state machine state.
   * WHY: Useful for debugging and testing state transitions.
   */
  getState(): ExtractorState {
    return this.state;
  }

  /**
   * Check if any content has been emitted to the consumer.
   *
   * WHY: signalRetry needs to know whether to emit the separator.
   * If nothing was emitted, no separator is needed.
   */
  hasEmittedContent(): boolean {
    return this.emittedContent.size > 0;
  }

  // ============================================================================
  // Debug accessors (useful for testing and troubleshooting)
  // ============================================================================

  /**
   * Get raw accumulated buffer.
   * WHY: Useful for debugging - see exactly what the LLM output.
   */
  getBuffer(): string {
    return this.buffer;
  }

  /**
   * Get all extracted field contents (copy to avoid mutation).
   * WHY: Useful for debugging - see what we extracted from each field.
   */
  getFieldContents(): Map<string, string> {
    return new Map(this.fieldContents);
  }
}
