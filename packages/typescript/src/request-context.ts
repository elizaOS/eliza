/**
 * Request context management for per-entity settings in multi-tenant deployments.
 *
 * Follows the OpenTelemetry ContextManager pattern (same as streaming-context.ts):
 * - Interface for context management
 * - Platform-specific implementations (Node.js AsyncLocalStorage, Browser Stack)
 * - Global singleton configured at startup
 *
 * This enables sharing a single agent runtime across multiple users while ensuring
 * each user's API keys, OAuth tokens, and configuration are used for their specific requests.
 *
 * @example
 * ```typescript
 * // Before processing a user's message
 * const entitySettings = await prefetchEntitySettings(userId, agentId);
 *
 * await runWithRequestContext({
 *   entityId: userId,
 *   agentId: agentId,
 *   entitySettings: new Map([
 *     ['OPENAI_API_KEY', 'sk-user-specific-key'],
 *     ['TWITTER_ACCESS_TOKEN', 'oauth-token-for-user'],
 *   ]),
 *   requestStartTime: Date.now(),
 * }, async () => {
 *   // All getSetting() calls here check entitySettings first
 *   await runtime.handleMessage(message);
 * });
 * ```
 */
import type { UUID } from "./types";

/**
 * The value types that can be stored in entity settings.
 * Matches the return type of getSetting().
 */
export type EntitySettingValue = string | boolean | number | null;

/**
 * Request-scoped context containing per-entity settings.
 * Used to isolate user settings across concurrent requests sharing the same runtime.
 */
export interface RequestContext {
	/**
	 * The entity (user) ID for this request.
	 * Used to identify which user's settings should be used.
	 */
	entityId: UUID;

	/**
	 * The agent ID for this request.
	 * Used for agent-specific entity settings lookup.
	 */
	agentId: UUID;

	/**
	 * Pre-fetched entity-specific settings.
	 * These take highest priority in getSetting() resolution chain.
	 *
	 * The Map contains setting keys and their values:
	 * - string/boolean/number: The actual setting value to use
	 * - null: Explicitly unset (use agent default)
	 * - undefined (key not present): Fall through to agent settings
	 */
	entitySettings: Map<string, EntitySettingValue>;

	/**
	 * Request start timestamp for observability and debugging.
	 * Useful for tracking request duration and timeout handling.
	 */
	requestStartTime: number;

	/**
	 * Optional trace ID for distributed tracing.
	 * Can be passed from incoming request headers (e.g., X-Trace-Id).
	 */
	traceId?: string;

	/**
	 * Optional organization ID for multi-tenant deployments.
	 * Used for logging and auditing purposes.
	 */
	organizationId?: string;
}

/**
 * Interface for request context managers.
 * Different implementations exist for Node.js (AsyncLocalStorage) and Browser (fallback).
 */
export interface IRequestContextManager {
	/**
	 * Run a function with a request context.
	 * The context will be available to all nested async calls via `active()`.
	 *
	 * @param context - The request context to make available, or undefined to clear context
	 * @param fn - The function to run within the context
	 * @returns The result of the function
	 */
	run<T>(context: RequestContext | undefined, fn: () => T): T;

	/**
	 * Get the currently active request context.
	 * Returns undefined if no context is active (e.g., during plugin init).
	 *
	 * @returns The current request context or undefined
	 */
	active(): RequestContext | undefined;
}

/**
 * Default no-op context manager used before platform-specific manager is configured.
 * Always returns undefined - entity settings will not override agent settings.
 * This is safe for backward compatibility: getSetting() falls through to existing behavior.
 */
class NoopRequestContextManager implements IRequestContextManager {
	run<T>(_context: RequestContext | undefined, fn: () => T): T {
		return fn();
	}

	active(): RequestContext | undefined {
		return undefined;
	}
}

// Global singleton - will be configured by index.node.ts or index.browser.ts
let globalRequestContextManager: IRequestContextManager =
	new NoopRequestContextManager();

/**
 * Set the global request context manager.
 * Called during initialization by platform-specific entry points.
 *
 * @param manager - The context manager to use globally
 */
export function setRequestContextManager(
	manager: IRequestContextManager,
): void {
	globalRequestContextManager = manager;
}

/**
 * Get the global request context manager.
 * Useful for testing or advanced use cases.
 *
 * @returns The current global request context manager
 */
export function getRequestContextManager(): IRequestContextManager {
	return globalRequestContextManager;
}

/**
 * Run a function with a request context.
 * All getSetting() calls within this function will check entitySettings first.
 *
 * @example
 * ```typescript
 * const result = await runWithRequestContext({
 *   entityId: userId as UUID,
 *   agentId: agentId as UUID,
 *   entitySettings: new Map([['API_KEY', 'user-specific-key']]),
 *   requestStartTime: Date.now(),
 * }, async () => {
 *   // Inside here, runtime.getSetting('API_KEY') returns 'user-specific-key'
 *   return await runtime.processMessage(message);
 * });
 * ```
 *
 * @param context - The request context with entitySettings
 * @param fn - The function to run with request context
 * @returns The result of the function
 */
export function runWithRequestContext<T>(
	context: RequestContext | undefined,
	fn: () => T,
): T {
	return globalRequestContextManager.run(context, fn);
}

/**
 * Get the currently active request context.
 * Called by getSetting() to check for entity-specific settings.
 *
 * @returns The current request context or undefined if not in a request
 */
export function getRequestContext(): RequestContext | undefined {
	return globalRequestContextManager.active();
}
