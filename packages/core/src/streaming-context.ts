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

import type { StreamChunkCallback } from "./types/components";
import type {
	StreamingContextEventPayload,
	StreamingEvaluationPayload,
	StreamingEventHooks,
	StreamingToolCallPayload,
	StreamingToolResultPayload,
} from "./types/streaming";
import { StackContextManager } from "./utils/stack-context-manager";

/**
 * Streaming context containing callbacks for streaming lifecycle.
 */
export interface StreamingContext extends StreamingEventHooks {
	/** Called for each chunk of streamed content */
	onStreamChunk: StreamChunkCallback;
	/** Called when a useModel streaming call completes (allows reset between calls) */
	onStreamEnd?: () => void;
	messageId?: string;
	/** Optional abort signal to cancel streaming */
	abortSignal?: AbortSignal;
}

export interface StreamingHookPayloads {
	onToolCall: StreamingToolCallPayload;
	onToolResult: StreamingToolResultPayload;
	onEvaluation: StreamingEvaluationPayload;
	onContextEvent: StreamingContextEventPayload;
}

/**
 * Safely emit an optional streaming event hook.
 * Missing hooks are no-ops, and hook failures are isolated from runtime flow.
 */
export async function emitStreamingHook<K extends keyof StreamingHookPayloads>(
	context: StreamingContext | undefined,
	hook: K,
	payload: StreamingHookPayloads[K],
): Promise<void> {
	const callback = context?.[hook];
	if (!callback) {
		return;
	}

	try {
		await (
			callback as (value: StreamingHookPayloads[K]) => void | Promise<void>
		)(payload);
	} catch {
		// Streaming observers must not break the underlying model/action flow.
	}
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
	return new StackContextManager<StreamingContext | undefined>();
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

// ---------------------------------------------------------------------------
// useModel → chunk callback delivery (dedupe `model_stream_chunk` hooks)
// ---------------------------------------------------------------------------
// The same provider chunk is often forwarded from useModel's textStream loop *and* from
// DefaultMessageService. Without a turn-scoped marker, pipeline hooks would run twice per
// token (inflated metrics, duplicate side effects). Node uses AsyncLocalStorage depth so
// nested async work stays scoped; non-Node has no ALS store and returns depth 0 (no skip).
// See docs/PIPELINE_HOOKS.md § "Stream hook dedupe (Node)".

let modelStreamChunkDeliveryDepthStorage:
	| import("node:async_hooks").AsyncLocalStorage<number>
	| null = null;
let modelStreamChunkDeliveryStorageInitialized = false;

function getModelStreamChunkDeliveryStorage():
	| import("node:async_hooks").AsyncLocalStorage<number>
	| null {
	if (!modelStreamChunkDeliveryStorageInitialized) {
		modelStreamChunkDeliveryStorageInitialized = true;
		if (isNodeEnvironment()) {
			try {
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				const { AsyncLocalStorage } =
					require("node:async_hooks") as typeof import("node:async_hooks");
				modelStreamChunkDeliveryDepthStorage = new AsyncLocalStorage();
			} catch {
				modelStreamChunkDeliveryDepthStorage = null;
			}
		}
	}
	return modelStreamChunkDeliveryDepthStorage;
}

/**
 * While `> 0`, the runtime is inside `useModel`'s delivery of one `textStream` chunk to
 * `paramsChunk` / `ctxChunk` (after `model_stream_chunk` with `source: "use_model"`).
 * `DefaultMessageService` skips its own `model_stream_chunk` (`source: "message_service"`) in
 * this window so the same raw token is not processed twice. Non-Node environments return `0`.
 */
export function getModelStreamChunkDeliveryDepth(): number {
	const s = getModelStreamChunkDeliveryStorage();
	return s?.getStore() ?? 0;
}

/** Wrap `paramsChunk` / `ctxChunk` invocations from `useModel`'s stream loop. */
export function runInsideModelStreamChunkDelivery<T>(
	fn: () => T | Promise<T>,
): T | Promise<T> {
	const s = getModelStreamChunkDeliveryStorage();
	if (!s) {
		return fn();
	}
	const parent = s.getStore() ?? 0;
	return s.run(parent + 1, fn);
}
