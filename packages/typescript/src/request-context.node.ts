/**
 * Node.js-specific request context manager using AsyncLocalStorage.
 *
 * AsyncLocalStorage provides proper async context isolation, ensuring that
 * parallel message processing doesn't interfere with each other's entity settings.
 * Each async execution chain maintains its own context, even when interleaved.
 *
 * @see https://nodejs.org/api/async_context.html
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { IRequestContextManager, RequestContext } from "./request-context";

/**
 * AsyncLocalStorage-based context manager for Node.js.
 * Provides proper async context isolation across parallel async operations.
 *
 * When User A and User B send messages concurrently:
 * - User A's async chain sees User A's entitySettings
 * - User B's async chain sees User B's entitySettings
 * - No race conditions or cross-contamination
 */
export class AsyncLocalStorageRequestContextManager
	implements IRequestContextManager
{
	private storage = new AsyncLocalStorage<RequestContext | undefined>();

	/**
	 * Run a function with a request context.
	 * The context is automatically propagated through all async operations.
	 *
	 * @param context - The request context to use, or undefined to clear
	 * @param fn - The function to execute within the context
	 * @returns The result of the function
	 */
	run<T>(context: RequestContext | undefined, fn: () => T): T {
		return this.storage.run(context, fn);
	}

	/**
	 * Get the currently active request context.
	 * Returns the context that was passed to the enclosing run() call.
	 *
	 * @returns The current request context or undefined if outside a run() scope
	 */
	active(): RequestContext | undefined {
		return this.storage.getStore();
	}
}

/**
 * Create and return a configured AsyncLocalStorage context manager.
 * Called by index.node.ts during initialization.
 *
 * @returns A new AsyncLocalStorageRequestContextManager instance
 */
export function createNodeRequestContextManager(): IRequestContextManager {
	return new AsyncLocalStorageRequestContextManager();
}
