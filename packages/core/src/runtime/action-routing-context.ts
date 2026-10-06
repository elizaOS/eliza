/** AsyncLocalStorage propagates the executing action’s modelClass to nested useModel calls across asynchronous boundaries. */

import { getAmbientSingleton, setAmbientSingleton } from "../ambient-context";
import type { ActionModelClass } from "../types/components";
import { AsyncContextManager } from "../utils/async-context-manager";

export interface ActionRoutingContext {
	/** Name of the action currently executing. Surfaced for telemetry. */
	readonly actionName: string;
	/** The action's `modelClass` hint, if set. */
	readonly modelClass: ActionModelClass | undefined;
	/** Trusted caller owns final synthesis; never inferred from tool arguments. */
	readonly replyOwner?: "planner";
	readonly messageId?: string;
}

interface IActionRoutingContextManager {
	run<T>(
		ctx: ActionRoutingContext | undefined,
		fn: () => T | Promise<T>,
	): T | Promise<T>;
	active(): ActionRoutingContext | undefined;
}

const MANAGER_KEY = Symbol.for("elizaos.actionRoutingContextManager");

function initManagerSync(): IActionRoutingContextManager {
	return new AsyncContextManager<ActionRoutingContext | undefined>();
}

function getOrCreate(): IActionRoutingContextManager {
	// Shared global slot is the single source of truth (no module-local cache),
	// matching the trajectory context manager — see ambient-context.ts.
	return getAmbientSingleton(MANAGER_KEY, initManagerSync);
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
	setAmbientSingleton(MANAGER_KEY, manager);
}
