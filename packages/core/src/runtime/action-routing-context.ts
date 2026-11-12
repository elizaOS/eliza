/** AsyncLocalStorage propagates the executing action’s modelClass to nested useModel calls across asynchronous boundaries. */

import type { BoundRequestOperationAttempt } from "../actions/task-extraction-context";
import { getAmbientSingleton } from "../ambient-context";
import type { ActionModelClass } from "../types/components";
import type { Memory } from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";
import { AsyncContextManager } from "../utils/async-context-manager";

export interface ActionRoutingContext {
	/** Name of the action currently executing. Surfaced for telemetry. */
	readonly actionName: string;
	/** The action's `modelClass` hint, if set. */
	readonly modelClass: ActionModelClass | undefined;
	/** Trusted caller owns final synthesis; never inferred from tool arguments. */
	readonly replyOwner?: "planner";
	readonly messageId?: string;
	/** Host-only current action provenance; never populated from tool arguments. */
	readonly requestMessage?: Memory;
	readonly requestState?: State;
	readonly requestRuntime?: IAgentRuntime;
	readonly hostAttemptId?: string;
	/** Actual opaque executor attempt, never reconstructed from that string. */
	readonly requestOperationAttempt?: BoundRequestOperationAttempt;
}

const MANAGER_KEY = Symbol.for("elizaos.actionRoutingContextManager");

function getOrCreate(): AsyncContextManager<ActionRoutingContext | undefined> {
	// Shared global slot is the single source of truth (no module-local cache),
	// matching the trajectory context manager — see ambient-context.ts.
	return getAmbientSingleton(
		MANAGER_KEY,
		() => new AsyncContextManager<ActionRoutingContext | undefined>(),
	);
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
