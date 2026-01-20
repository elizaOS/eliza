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

import type { IStreamExtractor } from "../types/streaming";

// ============================================================================
// StreamError - Standardized error handling for streaming
// ============================================================================

/** Error codes for streaming operations */
export type StreamErrorCode =
  | "CHUNK_TOO_LARGE"
  | "BUFFER_OVERFLOW"
  | "PARSE_ERROR"
  | "TIMEOUT"
  | "ABORTED";

/**
 * Standardized error class for streaming operations.
 * Provides structured error codes for easier handling.
 */
export class StreamError extends Error {
  readonly code: StreamErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: StreamErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StreamError";
    this.code = code;
    this.details = details;
  }

  /** Check if an error is a StreamError */
  static isStreamError(error: unknown): error is StreamError {
    return error instanceof StreamError;
  }
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

/** Pre-compiled regex for actions tag extraction */
const ACTIONS_REGEX = /<actions>([\s\S]*?)<\/actions>/;

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
  safeMargin: number = SAFE_MARGIN,
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
      return {
        content: "",
        closed: false,
        buffer: currentBuffer,
        insideTag: false,
      };
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

  return { content: "", closed: false, buffer: currentBuffer, insideTag: true };
}

/**
 * Validates and limits chunk size to prevent DoS attacks.
 * @throws StreamError if chunk exceeds maximum size
 */
function validateChunkSize(chunk: string): void {
  if (chunk.length > MAX_CHUNK_SIZE) {
    throw new StreamError(
      "CHUNK_TOO_LARGE",
      `Chunk size ${chunk.length} exceeds maximum allowed ${MAX_CHUNK_SIZE}`,
      {
        chunkSize: chunk.length,
        maxAllowed: MAX_CHUNK_SIZE,
      },
    );
  }
}

/**
 * Trims buffer to prevent unbounded growth.
 */
function trimBuffer(
  buffer: string,
  maxSize: number = MAX_BUFFER,
  keepSize: number = 1024,
): string {
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

  private buffer = "";
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
    if (this.finished) return "";

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
      SAFE_MARGIN,
    );

    this.buffer = result.buffer;
    this.insideTag = result.insideTag;

    if (result.closed) {
      this.finished = true;
    }

    return result.content;
  }

  reset(): void {
    this.buffer = "";
    this.insideTag = false;
    this.finished = false;
  }
}

// ============================================================================
// ResponseStreamExtractor - Action-aware XML extraction (DefaultMessageService)
// ============================================================================

/** Response strategy based on <actions> content */
type ResponseStrategy = "pending" | "direct" | "delegated";

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
  private static readonly STREAM_TAGS = ["text"] as const;
  private static readonly OPEN_TEXT_TAG = "<text>";
  private static readonly CLOSE_TEXT_TAG = "</text>";

  private buffer = "";
  private insideTag = false;
  private currentTag: string | null = null;
  private finished = false;
  private responseStrategy: ResponseStrategy = "pending";

  get done(): boolean {
    return this.finished;
  }

  reset(): void {
    this.buffer = "";
    this.insideTag = false;
    this.currentTag = null;
    this.finished = false;
    this.responseStrategy = "pending";
  }

  push(chunk: string): string {
    validateChunkSize(chunk);
    this.buffer += chunk;

    // Detect strategy from <actions> tag (comes before <text>)
    if (this.responseStrategy === "pending") {
      this.detectResponseStrategy();
    }

    // Look for streamable tags
    if (!this.insideTag) {
      const tag = ResponseStreamExtractor.STREAM_TAGS[0];
      const openTag = ResponseStreamExtractor.OPEN_TEXT_TAG;
      const closeTag = ResponseStreamExtractor.CLOSE_TEXT_TAG;
      const idx = this.buffer.indexOf(openTag);

      if (idx !== -1) {
        // Check if we should stream this tag
        if (!this.shouldStreamTag(tag)) {
          // Skip tag entirely - wait for closing tag and remove
          const closeIdx = this.buffer.indexOf(closeTag);
          if (closeIdx !== -1) {
            this.buffer = this.buffer.slice(closeIdx + closeTag.length);
          }
        } else {
          this.insideTag = true;
          this.currentTag = tag;
          this.buffer = this.buffer.slice(idx + openTag.length);
        }
      }
    }

    // Trim buffer if too large and not inside tag
    if (!this.insideTag) {
      this.buffer = trimBuffer(this.buffer);
      return "";
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

    return "";
  }

  /** Detect response strategy from <actions> tag using pre-compiled regex */
  private detectResponseStrategy(): void {
    const match = this.buffer.match(ACTIONS_REGEX);
    if (match) {
      const actions = this.parseActions(match[1]);
      this.responseStrategy = this.isDirectReply(actions)
        ? "direct"
        : "delegated";
    }
  }

  /** Parse comma-separated actions */
  private parseActions(raw: string): string[] {
    return raw
      .split(",")
      .map((a) => a.trim().toUpperCase())
      .filter(Boolean);
  }

  /** Check if actions represent a direct reply */
  private isDirectReply(actions: string[]): boolean {
    return actions.length === 1 && actions[0] === "REPLY";
  }

  /** Determine if a tag should be streamed based on strategy */
  private shouldStreamTag(tag: string): boolean {
    return tag === "text" && this.responseStrategy === "direct";
  }
}

// ============================================================================
// ActionStreamFilter - For action handler response filtering
// ============================================================================

/** Detected content type from first character */
type ContentType = "json" | "xml" | "text";

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
  private buffer = "";
  private decided = false;
  private contentType: ContentType | null = null;
  private insideTextTag = false;
  private finished = false;

  get done(): boolean {
    return this.finished;
  }

  reset(): void {
    this.buffer = "";
    this.decided = false;
    this.contentType = null;
    this.insideTextTag = false;
    this.finished = false;
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
        return "";
      }
    }

    // Route based on content type
    switch (this.contentType) {
      case "json":
        return ""; // Never stream JSON

      case "text":
        return this.handlePlainText();

      case "xml":
        return this.handleXml();

      default:
        return "";
    }
  }

  /** Detect content type from first non-whitespace character */
  private detectContentType(): ContentType | null {
    const trimmed = this.buffer.trimStart();
    if (trimmed.length === 0) return null;

    const firstChar = trimmed[0];
    if (firstChar === "{" || firstChar === "[") return "json";
    if (firstChar === "<") return "xml";
    return "text";
  }

  /** Handle plain text - stream everything */
  private handlePlainText(): string {
    const toStream = this.buffer;
    this.buffer = "";
    return toStream;
  }

  /** Handle XML content - extract and stream <text> tag content */
  private handleXml(): string {
    const result = extractTagContent(
      this.buffer,
      "<text>",
      "</text>",
      this.insideTextTag,
      SAFE_MARGIN,
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
// MarkableExtractor - Passthrough with external completion control
// ============================================================================

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
    return "";
  }

  reset(): void {
    this._done = false;
  }

  /**
   * Mark the extractor as complete.
   * WHY: Called by the outer code when the underlying operation completes
   * successfully. This allows isComplete() to return true for retry/fallback logic.
   */
  markComplete(): void {
    this._done = true;
  }
}

// ============================================================================
// ValidationStreamExtractor - Validation-aware streaming
// ============================================================================

import type {
  SchemaRow,
  StreamEvent,
  StreamEventType,
} from "../types/state";
import type { IStreamingRetryState } from "../types/streaming";

/**
 * Extractor state machine for validation-aware streaming.
 */
export type ExtractorState =
  | "streaming" // Normal operation - actively receiving chunks
  | "validating" // Stream ended, checking validation codes
  | "retrying" // Validation failed, preparing for retry
  | "complete" // Successfully finished
  | "failed"; // Unrecoverable error

/**
 * Per-field state tracking for progressive validation.
 */
export type FieldState =
  | "pending" // Haven't seen this field yet
  | "partial" // Found opening tag but no closing tag
  | "complete" // Found both tags, content extracted
  | "invalid"; // Validation codes didn't match

/**
 * Configuration for ValidationStreamExtractor.
 */
export interface ValidationStreamExtractorConfig {
  /** Validation level (0-3) */
  level: 0 | 1 | 2 | 3;
  /** Schema rows with field definitions */
  schema: SchemaRow[];
  /** Which fields to stream to the consumer */
  streamFields: string[];
  /** Expected validation codes per field */
  expectedCodes: Map<string, string>;
  /** Callback for streaming chunks */
  onChunk: (chunk: string, field?: string) => void;
  /** Rich event callback for sophisticated consumers */
  onEvent?: (event: StreamEvent) => void;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Whether the consumer has an onEvent handler */
  hasRichConsumer?: boolean;
}

/**
 * Diagnosis result for error analysis.
 */
export interface ValidationDiagnosis {
  /** Fields that were never started */
  missingFields: string[];
  /** Fields with wrong validation codes */
  invalidFields: string[];
  /** Fields that started but didn't complete */
  incompleteFields: string[];
}

/**
 * Validation-aware stream extractor for dynamicPromptExecFromState.
 *
 * WHY THIS EXISTS:
 * LLMs can silently truncate output when they hit token limits. This is catastrophic
 * for structured outputs - you might get half a JSON object. Traditional streaming
 * has no validation - you might stream half a broken response.
 *
 * This extractor bridges the gap: it enables streaming while detecting truncation.
 * It uses "validation codes" - random UUIDs that the LLM must echo. If the echoed
 * code matches, we know that part wasn't truncated.
 *
 * VALIDATION LEVELS:
 * - Level 0 (Trusted): No codes, stream immediately. Fast but no safety.
 * - Level 1 (Progressive): Per-field codes, emit as each field validates.
 * - Level 2 (First Checkpoint): Code at start only, buffer until validated.
 * - Level 3 (Full): Codes at start AND end, maximum safety.
 */
export class ValidationStreamExtractor implements IStreamExtractor {
  private buffer = "";
  private fieldContents: Map<string, string> = new Map();
  private validatedFields: Set<string> = new Set();
  private emittedContent: Map<string, string> = new Map();
  private fieldStates: Map<string, FieldState> = new Map();
  private state: ExtractorState = "streaming";

  constructor(private readonly config: ValidationStreamExtractorConfig) {
    for (const field of config.streamFields) {
      this.fieldStates.set(field, "pending");
    }
  }

  get done(): boolean {
    return this.state === "complete" || this.state === "failed";
  }

  push(chunk: string): string {
    // Check for cancellation
    if (this.config.abortSignal?.aborted) {
      if (this.state === "streaming") {
        this.state = "failed";
        this.emitEvent({ eventType: "error", error: "Cancelled by user", timestamp: Date.now() });
      }
      return "";
    }

    if (this.state !== "streaming") return "";

    validateChunkSize(chunk);
    this.buffer += chunk;

    // Extract field contents from buffer
    this.extractFieldContents();

    // For levels 0-1, check if we can emit validated content
    if (this.config.level <= 1) {
      this.checkPerFieldEmission();
    }

    return ""; // We emit via callbacks, not return value
  }

  flush(): string {
    // For levels 2-3, emit all buffered content when validation passes
    if (this.config.level >= 2) {
      for (const field of this.config.streamFields) {
        const content = this.fieldContents.get(field) || "";
        if (content) {
          this.emitFieldContent(field, content);
        }
      }
    }
    this.state = "complete";
    this.emitEvent({ eventType: "complete", timestamp: Date.now() });
    return "";
  }

  reset(): void {
    this.buffer = "";
    this.fieldContents.clear();
    this.validatedFields.clear();
    this.emittedContent.clear();
    for (const field of this.config.streamFields) {
      this.fieldStates.set(field, "pending");
    }
    this.state = "streaming";
  }

  /**
   * Signal a retry attempt. Returns info about validated fields for smart retry prompts.
   */
  signalRetry(retryCount: number): { validatedFields: string[] } {
    this.state = "retrying";

    // Emit separator for simple consumers
    if (!this.config.hasRichConsumer) {
      this.config.onChunk("\n-- that's not right, let me start again:\n");
    }

    this.emitEvent({ eventType: "retry_start", retryCount, timestamp: Date.now() });

    return { validatedFields: Array.from(this.validatedFields) };
  }

  /**
   * Signal an unrecoverable error.
   */
  signalError(message: string): void {
    this.state = "failed";
    this.emitEvent({ eventType: "error", error: message, timestamp: Date.now() });
  }

  /**
   * Get fields that passed validation (for smart retry context).
   */
  getValidatedFields(): Map<string, string> {
    const result = new Map<string, string>();
    for (const field of this.validatedFields) {
      const content = this.fieldContents.get(field);
      if (content) {
        result.set(field, content);
      }
    }
    return result;
  }

  /**
   * Diagnose what went wrong for error reporting.
   */
  diagnose(): ValidationDiagnosis {
    const missingFields: string[] = [];
    const invalidFields: string[] = [];
    const incompleteFields: string[] = [];

    for (const row of this.config.schema) {
      const state = this.fieldStates.get(row.field);
      switch (state) {
        case "pending":
          missingFields.push(row.field);
          break;
        case "invalid":
          invalidFields.push(row.field);
          break;
        case "partial":
          incompleteFields.push(row.field);
          break;
      }
    }

    return { missingFields, invalidFields, incompleteFields };
  }

  /**
   * Get current extractor state.
   */
  getState(): ExtractorState {
    return this.state;
  }

  // Private helpers

  private extractFieldContents(): void {
    for (const row of this.config.schema) {
      const field = row.field;
      const openTag = `<${field}>`;
      const closeTag = `</${field}>`;

      const openIdx = this.buffer.indexOf(openTag);
      if (openIdx === -1) continue;

      const contentStart = openIdx + openTag.length;
      const closeIdx = this.buffer.indexOf(closeTag, contentStart);

      if (closeIdx !== -1) {
        // Complete field found
        const content = this.buffer.substring(contentStart, closeIdx);
        this.fieldContents.set(field, content);
        this.fieldStates.set(field, "complete");
      } else if (this.fieldStates.get(field) !== "complete") {
        // Partial field - still streaming
        this.fieldStates.set(field, "partial");
        // Store partial content for streaming
        const partialContent = this.buffer.substring(contentStart);
        this.fieldContents.set(field, partialContent);
      }
    }
  }

  private checkPerFieldEmission(): void {
    for (const field of this.config.streamFields) {
      const state = this.fieldStates.get(field);
      if (state === "invalid") continue; // Skip already invalid fields

      const content = this.fieldContents.get(field);
      if (!content) continue;

      // Check validation codes if required
      const expectedCode = this.config.expectedCodes.get(field);
      if (expectedCode) {
        const startCodeValid = this.checkValidationCode(field, "start", expectedCode);
        const endCodeValid = this.checkValidationCode(field, "end", expectedCode);

        if (state === "complete") {
          if (startCodeValid && endCodeValid) {
            this.validatedFields.add(field);
            this.emitFieldContent(field, content);
            this.emitEvent({ eventType: "field_validated", field, timestamp: Date.now() });
          } else if (startCodeValid && !endCodeValid) {
            // Start valid but end invalid
            this.fieldStates.set(field, "invalid");
            this.emitEvent({
              eventType: "error",
              field,
              error: `End validation code mismatch for ${field}`,
              timestamp: Date.now(),
            });
          } else {
            this.fieldStates.set(field, "invalid");
            this.emitEvent({
              eventType: "error",
              field,
              error: `Validation codes mismatch for ${field}`,
              timestamp: Date.now(),
            });
          }
        }
      } else {
        // No validation codes - stream immediately (level 0 default)
        if (this.config.level === 0) {
          this.emitFieldContent(field, content);
        }
      }
    }
  }

  private checkValidationCode(
    field: string,
    position: "start" | "end",
    expectedCode: string,
  ): boolean {
    const codeField = `code_${field}_${position}`;
    const openTag = `<${codeField}>`;
    const closeTag = `</${codeField}>`;

    const openIdx = this.buffer.indexOf(openTag);
    if (openIdx === -1) return false;

    const contentStart = openIdx + openTag.length;
    const closeIdx = this.buffer.indexOf(closeTag, contentStart);
    if (closeIdx === -1) return false;

    const actualCode = this.buffer.substring(contentStart, closeIdx).trim();
    return actualCode === expectedCode;
  }

  private emitFieldContent(field: string, content: string): void {
    const previouslyEmitted = this.emittedContent.get(field) || "";
    const newContent = content.substring(previouslyEmitted.length);

    if (newContent) {
      this.config.onChunk(newContent, field);
      this.emitEvent({ eventType: "chunk", field, chunk: newContent, timestamp: Date.now() });
      this.emittedContent.set(field, content);
    }
  }

  private emitEvent(event: StreamEvent): void {
    if (this.config.onEvent) {
      this.config.onEvent(event);
    }
  }
}

// ============================================================================
// Streaming Context Helpers
// ============================================================================

import type { StreamingContext } from "../streaming-context";

/**
 * Creates a streaming retry state from an extractor.
 */
export function createStreamingRetryState(
  extractor: IStreamExtractor,
): IStreamingRetryState & { _appendText: (text: string) => void } {
  let streamedText = "";

  return {
    getStreamedText: () => {
      const buffered = extractor.flush?.() ?? "";
      if (buffered) {
        streamedText += buffered;
      }
      return streamedText;
    },
    isComplete: () => extractor.done,
    reset: () => {
      extractor.reset?.();
      streamedText = "";
    },
    _appendText: (text: string) => {
      streamedText += text;
    },
  };
}

/**
 * Creates a complete streaming context with retry state management.
 */
export function createStreamingContext(
  extractor: IStreamExtractor,
  onStreamChunk: (chunk: string, messageId?: string) => Promise<void>,
  messageId?: string,
): StreamingContext & IStreamingRetryState {
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
