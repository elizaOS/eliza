/**
 * Action-scoped routing context.
 *
 * The runtime wraps every action handler invocation in
 * {@link runWithActionRoutingContext}, exposing the executing action's
 * `modelClass` (if any) to any `useModel` call made transitively. The
 * `useModel` resolver reads {@link getActionRoutingContext} to decide whether
 * to reroute via the strategy registry in {@link ./action-model-routing}.
 *
 * Node.js: AsyncLocalStorage for async-safe propagation across `await`s
 * inside action handlers.
 * Browser / non-Node: stack-based fallback (sync-only).
 *
 * Why a separate context (rather than threading an extra `useModel` param):
 *   - `useModel` callers inside action handlers are deep call chains — every
 *     helper would have to take an extra param. The async-context pattern
 *     keeps the call sites unchanged and back-compat clean.
 *   - The trajectory recorder already uses the same pattern; this matches.
 */

import type { ActionModelClass } from "../types/components";
import { StackContextManager } from "../utils/stack-context-manager";

export interface ActionRoutingContext {
	/** Name of the action currently executing. Surfaced for telemetry. */
	readonly actionName: string;
	/** The action's `modelClass` hint, if set. */
	readonly modelClass: ActionModelClass | undefined;
}

interface IActionRoutingContextManager {
	run<T>(
		ctx: ActionRoutingContext | undefined,
		fn: () => T | Promise<T>,
	): T | Promise<T>;
	active(): ActionRoutingContext | undefined;
}

const MANAGER_KEY = Symbol.for("elizaos.actionRoutingContextManager");
type GlobalWithManager = typeof globalThis & {
	[MANAGER_KEY]?: IActionRoutingContextManager;
};

function isNodeEnvironment(): boolean {
	return (
		typeof process !== "undefined" &&
		typeof process.versions !== "undefined" &&
		typeof process.versions.node !== "undefined"
	);
}

function initManagerSync(): IActionRoutingContextManager {
	if (isNodeEnvironment()) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { AsyncLocalStorage } =
				require("node:async_hooks") as typeof import("node:async_hooks");
			const storage = new AsyncLocalStorage<ActionRoutingContext | undefined>();
			return {
				run<T>(
					ctx: ActionRoutingContext | undefined,
					fn: () => T | Promise<T>,
				): T | Promise<T> {
					return storage.run(ctx, fn);
				},
				active(): ActionRoutingContext | undefined {
					return storage.getStore();
				},
			};
		} catch {
			// fall through to stack
		}
	}
	return new StackContextManager<ActionRoutingContext | undefined>();
}

let globalManager: IActionRoutingContextManager | null = null;

function getOrCreate(): IActionRoutingContextManager {
	if (!globalManager) {
		const existing = (globalThis as GlobalWithManager)[MANAGER_KEY];
		if (existing) {
			globalManager = existing;
		} else {
			globalManager = initManagerSync();
			(globalThis as GlobalWithManager)[MANAGER_KEY] = globalManager;
		}
	}
	return globalManager;
}

export function runWithActionRoutingContext<T>(
	ctx: ActionRoutingContext | undefined,
	fn: () => T | Promise<T>,
): T | Promise<T> {
	return getOrCreate().run(ctx, fn);
}

export function getActionRoutingContext(): ActionRoutingContext | undefined {
	return getOrCreate().active();
}

/**
 * Run `fn` with the action routing context temporarily cleared. Used by the
 * runtime's `useModel` to invoke a routed sub-call without re-entering the
 * routing seam (which would otherwise loop on the same chain).
 */
export function runWithoutActionRoutingContext<T>(
	fn: () => T | Promise<T>,
): T | Promise<T> {
	return getOrCreate().run(undefined, fn);
}

/**
 * Test-only helper to inject a context manager (e.g. a deterministic stack
 * implementation). Not used in production.
 */
export function setActionRoutingContextManager(
	manager: IActionRoutingContextManager,
): void {
	globalManager = manager;
	(globalThis as GlobalWithManager)[MANAGER_KEY] = manager;
}
