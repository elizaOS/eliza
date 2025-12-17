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

import type { IStreamExtractor } from '../types/streaming';

// Re-export interface for convenience
export type { IStreamExtractor } from '../types/streaming';

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
  private static readonly SAFE_MARGIN = 10;
  private static readonly MAX_BUFFER = 100 * 1024;

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

    this.buffer += chunk;

    // Look for opening tag
    if (!this.insideTag) {
      const idx = this.buffer.indexOf(this.openTag);
      if (idx !== -1) {
        this.insideTag = true;
        this.buffer = this.buffer.slice(idx + this.openTag.length);
      } else {
        // Prevent unbounded buffer growth
        if (this.buffer.length > XmlTagExtractor.MAX_BUFFER) {
          this.buffer = this.buffer.slice(-1024);
        }
        return '';
      }
    }

    // Check for closing tag
    const closeIdx = this.buffer.indexOf(this.closeTag);
    if (closeIdx !== -1) {
      const content = this.buffer.slice(0, closeIdx);
      this.buffer = this.buffer.slice(closeIdx + this.closeTag.length);
      this.insideTag = false;
      this.finished = true;
      return content;
    }

    // Stream safe content (keep margin for potential closing tag split)
    if (this.buffer.length > XmlTagExtractor.SAFE_MARGIN) {
      const toStream = this.buffer.slice(0, -XmlTagExtractor.SAFE_MARGIN);
      this.buffer = this.buffer.slice(-XmlTagExtractor.SAFE_MARGIN);
      return toStream;
    }

    return '';
  }

  reset(): void {
    this.buffer = '';
    this.insideTag = false;
    this.finished = false;
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
  private static readonly MAX_BUFFER = 100 * 1024;
  private static readonly SAFE_MARGIN = 10;
  private static readonly STREAM_TAGS = ['text'];

  private buffer = '';
  private insideTag = false;
  private currentTag: string | null = null;
  private finished = false;
  private responseStrategy: ResponseStrategy = 'pending';

  /** Whether extraction is complete */
  get done(): boolean {
    return this.finished;
  }

  /** Reset extractor state for reuse */
  reset(): void {
    this.buffer = '';
    this.insideTag = false;
    this.currentTag = null;
    this.finished = false;
    this.responseStrategy = 'pending';
  }

  /**
   * Push a chunk and extract streamable text.
   * @param chunk - Raw chunk from LLM stream
   * @returns Text to stream to client (empty string if nothing to stream)
   */
  push(chunk: string): string {
    this.buffer += chunk;

    // Detect strategy from <actions> tag (comes before <text>)
    if (this.responseStrategy === 'pending') {
      this.detectResponseStrategy();
    }

    // Look for streamable tags
    if (!this.insideTag) {
      for (const tag of ResponseStreamExtractor.STREAM_TAGS) {
        const openTag = `<${tag}>`;
        const idx = this.buffer.indexOf(openTag);
        if (idx !== -1) {
          // Check if we should stream this tag
          if (!this.shouldStreamTag(tag)) {
            // Skip tag entirely - wait for closing tag and remove
            const closeTag = `</${tag}>`;
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

    // Prevent unbounded buffer growth
    if (!this.insideTag && this.buffer.length > ResponseStreamExtractor.MAX_BUFFER) {
      this.buffer = this.buffer.slice(-1024);
    }

    if (!this.insideTag) return '';

    // Check for closing tag
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
    if (this.buffer.length > ResponseStreamExtractor.SAFE_MARGIN) {
      const toStream = this.buffer.slice(0, -ResponseStreamExtractor.SAFE_MARGIN);
      this.buffer = this.buffer.slice(-ResponseStreamExtractor.SAFE_MARGIN);
      return toStream;
    }

    return '';
  }

  /** Detect response strategy from <actions> tag */
  private detectResponseStrategy(): void {
    const match = this.buffer.match(/<actions>([\s\S]*?)<\/actions>/);
    if (match) {
      const actions = this.parseActions(match[1]);
      this.responseStrategy = this.isDirectReply(actions) ? 'direct' : 'delegated';
    }
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
    if (tag === 'text') return this.responseStrategy === 'direct';
    return false;
  }
}

// ============================================================================
// Action Stream Filter - For action handler response filtering
// ============================================================================

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
  private static readonly SAFE_MARGIN = 10;

  private buffer = '';
  private decided = false;
  private contentType: 'json' | 'xml' | 'text' | null = null;
  private insideTextTag = false;
  private finished = false;

  /** Whether filtering is complete */
  get done(): boolean {
    return this.finished;
  }

  /** Reset filter state for reuse */
  reset(): void {
    this.buffer = '';
    this.decided = false;
    this.contentType = null;
    this.insideTextTag = false;
    this.finished = false;
  }

  /**
   * Push a chunk and filter for streaming.
   * @param chunk - Raw chunk from action's useModel stream
   * @returns Text to stream to client (empty string if filtered out)
   */
  push(chunk: string): string {
    this.buffer += chunk;

    // Decide content type on first non-whitespace character
    if (!this.decided) {
      const trimmed = this.buffer.trimStart();
      if (trimmed.length > 0) {
        const firstChar = trimmed[0];
        if (firstChar === '{' || firstChar === '[') {
          this.contentType = 'json';
        } else if (firstChar === '<') {
          this.contentType = 'xml';
        } else {
          this.contentType = 'text';
        }
        this.decided = true;
      }
    }

    if (!this.decided) return '';

    // JSON → Never stream (structured data)
    if (this.contentType === 'json') {
      return '';
    }

    // Plain text → Stream everything immediately
    if (this.contentType === 'text') {
      const toStream = this.buffer;
      this.buffer = '';
      return toStream;
    }

    // XML → Look for <text> tag and stream its content
    return this.handleXml();
  }

  /** Handle XML content - extract and stream <text> tag content */
  private handleXml(): string {
    if (!this.insideTextTag) {
      const openTag = '<text>';
      const idx = this.buffer.indexOf(openTag);
      if (idx !== -1) {
        this.insideTextTag = true;
        this.buffer = this.buffer.slice(idx + openTag.length);
      } else {
        if (this.buffer.length > 1024) {
          this.buffer = this.buffer.slice(-1024);
        }
        return '';
      }
    }

    const closeTag = '</text>';
    const closeIdx = this.buffer.indexOf(closeTag);
    if (closeIdx !== -1) {
      const content = this.buffer.slice(0, closeIdx);
      this.buffer = this.buffer.slice(closeIdx + closeTag.length);
      this.insideTextTag = false;
      this.finished = true;
      return content;
    }

    if (this.buffer.length > ActionStreamFilter.SAFE_MARGIN) {
      const toStream = this.buffer.slice(0, -ActionStreamFilter.SAFE_MARGIN);
      this.buffer = this.buffer.slice(-ActionStreamFilter.SAFE_MARGIN);
      return toStream;
    }

    return '';
  }
}
