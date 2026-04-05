/**
 * Streaming context management for automatic streaming in useModel calls.
 *
 * Follows the OpenTelemetry ContextManager pattern:
 * - Interface for context management
 * - Platform-specific implementations (Node.js AsyncLocalStorage, Browser Stack)
 * - Auto-detected at runtime - no separate entry points needed
 *
 * @see https://opentelemetry.io/docs/languages/js/context/
 */

/**
 * Streaming context containing callbacks for streaming lifecycle.
 */
export interface StreamingContext {
	/** Called for each chunk of streamed content */
	onStreamChunk: (chunk: string, messageId?: string) => Promise<void>;
	/** Called when a useModel streaming call completes (allows reset between calls) */
	onStreamEnd?: () => void;
	messageId?: string;
	/** Optional abort signal to cancel streaming */
	abortSignal?: AbortSignal;
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
 * Stack-based context manager for browser environments.
 * Safe because browser typically has 1 runtime per request.
 * Supports nested contexts via stack push/pop.
 */
class StackContextManager implements IStreamingContextManager {
	private stack: Array<StreamingContext | undefined> = [];

	run<T>(context: StreamingContext | undefined, fn: () => T): T {
		this.stack.push(context);
		try {
			return fn();
		} finally {
			this.stack.pop();
		}
	}

	active(): StreamingContext | undefined {
		return this.stack.length > 0
			? this.stack[this.stack.length - 1]
			: undefined;
	}
}

// Global singleton - auto-configured on first access
let globalContextManager: IStreamingContextManager | null = null;

function isNodeEnvironment(): boolean {
	return (
		typeof process !== "undefined" &&
		typeof process.versions !== "undefined" &&
		typeof process.versions.node !== "undefined"
	);
}

// Initialize synchronously to avoid the race where early calls use the
// StackContextManager fallback (which doesn't propagate through async/await).
function initContextManagerSync(): IStreamingContextManager {
	if (isNodeEnvironment()) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { AsyncLocalStorage } =
				require("node:async_hooks") as typeof import("node:async_hooks");
			const storage = new AsyncLocalStorage<StreamingContext | undefined>();
			return {
				run<T>(context: StreamingContext | undefined, fn: () => T): T {
					return storage.run(context, fn);
				},
				active(): StreamingContext | undefined {
					return storage.getStore();
				},
			} as IStreamingContextManager;
		} catch {
			// AsyncLocalStorage unavailable — fall back to stack
		}
	}
	return new StackContextManager();
}

function getOrCreateContextManager(): IStreamingContextManager {
	if (!globalContextManager) {
		globalContextManager = initContextManagerSync();
	}
	return globalContextManager;
}

/**
 * Set the global streaming context manager.
 * Can be used to override the auto-detected manager.
 *
 * @param manager - The context manager to use globally
 */
export function setStreamingContextManager(
	manager: IStreamingContextManager,
): void {
	globalContextManager = manager;
}

/**
 * Get the global streaming context manager.
 * Auto-detects and creates the appropriate manager on first access.
 */
export function getStreamingContextManager(): IStreamingContextManager {
	return getOrCreateContextManager();
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
export function runWithStreamingContext<T>(
	context: StreamingContext | undefined,
	fn: () => T,
): T {
	return getOrCreateContextManager().run(context, fn);
}

/**
 * Get the currently active streaming context.
 * Called by useModel to check if automatic streaming should be enabled.
 *
 * @returns The current streaming context or undefined
 */
export function getStreamingContext(): StreamingContext | undefined {
	return getOrCreateContextManager().active();
}
