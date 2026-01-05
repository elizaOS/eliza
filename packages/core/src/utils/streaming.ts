/**
 * Streaming utilities for filtering and extracting streamable content.
 *
 * This module provides implementations of {@link IStreamExtractor}:
 * - PassthroughExtractor - Simple passthrough (no filtering)
 * - XmlTagExtractor - Extract content from a specific XML tag
 * - ResponseStreamExtractor - Action-aware XML (for DefaultMessageService)
 * - ActionStreamFilter - Content-type aware filter (for action handlers)
 *
 * For the interface definition, see types/streaming.ts.
 * Implementations can use these or create their own extractors.
 */

import type { IStreamExtractor, IStreamingRetryState } from '../types/streaming';
import type { StreamingContext } from '../streaming-context';
import type { UUID } from '../types';

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
  onStreamChunk: (chunk: string, messageId?: UUID) => Promise<void>,
  messageId?: UUID
): StreamingContext {
  const retryState = createStreamingRetryState(extractor);

  return {
    onStreamChunk: async (chunk: string, msgId?: UUID) => {
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
