/**
 * Browser-specific streaming context manager using a simple stack.
 *
 * In browser environments, each API call typically creates its own runtime instance,
 * so there's no risk of parallel context collision. A simple stack-based approach
 * is sufficient and performant.
 *
 * Inspired by OpenTelemetry's StackContextManager for browser environments.
 * @see https://opentelemetry.io/docs/languages/js/context/
 */
import type {
	IStreamingContextManager,
	StreamingContext,
} from "./streaming-context";
import { StackContextManager as BaseStackContextManager } from "./utils/stack-context-manager";

export type { StreamingContext } from "./streaming-context";

/**
 * Stack-based context manager for browser environments.
 * Safe because browser typically has 1 runtime per request.
 * Supports nested contexts via stack push/pop.
 */
export class StackContextManager
	extends BaseStackContextManager<StreamingContext | undefined>
	implements IStreamingContextManager {}

/**
 * Create and return a configured Stack context manager.
 * Called by index.browser.ts during initialization.
 */
export function createBrowserStreamingContextManager(): IStreamingContextManager {
	return new StackContextManager();
}
