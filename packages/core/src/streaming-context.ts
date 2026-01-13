/**
 * Streaming context management for automatic streaming in useModel calls.
 *
 * Follows the OpenTelemetry ContextManager pattern:
 * - Interface for context management
 * - Platform-specific implementations (Node.js AsyncLocalStorage, Browser Stack)
 * - Global singleton configured at startup
 *
 */
import type { UUID } from './types';

/**
 * Streaming context containing callbacks for streaming lifecycle.
 */
export interface StreamingContext {
  /** Called for each chunk of streamed content */
  onStreamChunk: (chunk: string, messageId?: UUID) => Promise<void>;
  /** Called when a useModel streaming call completes (allows reset between calls) */
  onStreamEnd?: () => void;
  messageId?: UUID;
  /** Optional abort signal to cancel streaming */
  abortSignal?: AbortSignal;
  /**
   * Reset streaming state for retry attempts.
   * Clears extractor buffer and any accumulated state.
   * Call before retrying a failed streaming operation.
   */
  reset?: () => void;
  /**
   * Get text that has been streamed to the user so far.
   * Useful for retry continuation prompts.
   */
  getStreamedText?: () => string;
  /**
   * Check if text extraction is complete (closing tag found).
   * Used for intelligent retry decisions:
   * - true: Use streamedText as final response, skip retry
   * - false: Text was cut mid-stream, retry with continuation prompt
   */
  isComplete?: () => boolean;
}

/**
 * Interface for streaming context managers.
 * Different implementations exist for Node.js (AsyncLocalStorage) and Browser (Stack).
 */
export interface IStreamingContextManager {
  /**
   * Run a function with a streaming context.
   * The context will be available to all nested async calls via `active()`.
   */
  run<T>(context: StreamingContext | undefined, fn: () => T): T;

  /**
   * Get the currently active streaming context.
   * Returns undefined if no context is active.
   */
  active(): StreamingContext | undefined;
}

/**
 * Default no-op context manager used before platform-specific manager is configured.
 * Always returns undefined - streaming will not be automatic.
 */
class NoopContextManager implements IStreamingContextManager {
  run<T>(_context: StreamingContext | undefined, fn: () => T): T {
    return fn();
  }

  active(): StreamingContext | undefined {
    return undefined;
  }
}

// Global singleton - will be configured by index.node.ts or index.browser.ts
let globalContextManager: IStreamingContextManager = new NoopContextManager();

/**
 * Set the global streaming context manager.
 * Called during initialization by platform-specific entry points.
 *
 * @param manager - The context manager to use globally
 */
export function setStreamingContextManager(manager: IStreamingContextManager): void {
  globalContextManager = manager;
}

/**
 * Get the global streaming context manager.
 * Useful for testing or advanced use cases.
 */
export function getStreamingContextManager(): IStreamingContextManager {
  return globalContextManager;
}

/**
 * Run a function with a streaming context.
 * All useModel calls within this function will automatically use streaming.
 *
 * @example
 * ```typescript
 * await runWithStreamingContext(
 *   { onStreamChunk: async (chunk) => sendSSE(chunk), messageId },
 *   async () => {
 *     // All useModel calls here will stream automatically
 *     await runtime.processMessage(message);
 *   }
 * );
 * ```
 *
 * @param context - The streaming context with onStreamChunk callback
 * @param fn - The function to run with streaming context
 * @returns The result of the function
 */
export function runWithStreamingContext<T>(context: StreamingContext | undefined, fn: () => T): T {
  return globalContextManager.run(context, fn);
}

/**
 * Get the currently active streaming context.
 * Called by useModel to check if automatic streaming should be enabled.
 *
 * @returns The current streaming context or undefined
 */
export function getStreamingContext(): StreamingContext | undefined {
  return globalContextManager.active();
}
