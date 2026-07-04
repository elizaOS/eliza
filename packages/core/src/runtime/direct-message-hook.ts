/**
 * Pre-LLM direct-message hook registry — lets a host plugin fully handle
 * certain requests deterministically before the planner/model runs.
 *
 * The message pipeline invokes registered hooks (in registration order) right
 * after the pre-LLM shortcut gate and before any planner/model call. The first
 * hook that returns an `ActionResult` short-circuits the turn with a direct
 * reply; a hook returning `null`/`undefined` defers to the next hook and,
 * ultimately, to the normal pipeline.
 *
 * Cycle-avoidance: core defines the typed slot, plugins fill it, and core never
 * imports plugin-side symbols.
 *
 * Registration uses a module-scoped WeakMap keyed by runtime instance so the
 * hook lifetime tracks the runtime and we don't leak across tests — same shape
 * as `SendPolicy` and `LocalizedExamplesProvider`.
 */

import type { ActionResult } from "../types/components";
import type { Memory } from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

export interface DirectMessageHookInput {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
}

/**
 * Async handler: returns an `ActionResult` when it fully handled the message,
 * or `null`/`undefined` to defer to the next hook / the normal pipeline.
 */
export type DirectMessageHook = (
	input: DirectMessageHookInput,
) => Promise<ActionResult | null | undefined>;

const hooks = new WeakMap<IAgentRuntime, DirectMessageHook[]>();

export function registerDirectMessageHook(
	runtime: IAgentRuntime,
	hook: DirectMessageHook,
): void {
	const existing = hooks.get(runtime);
	if (existing) {
		existing.push(hook);
	} else {
		hooks.set(runtime, [hook]);
	}
}

export function unregisterDirectMessageHook(
	runtime: IAgentRuntime,
	hook: DirectMessageHook,
): void {
	const existing = hooks.get(runtime);
	if (!existing) {
		return;
	}
	const next = existing.filter((entry) => entry !== hook);
	if (next.length === 0) {
		hooks.delete(runtime);
	} else {
		hooks.set(runtime, next);
	}
}

export function getDirectMessageHooks(
	runtime: IAgentRuntime,
): readonly DirectMessageHook[] {
	return hooks.get(runtime) ?? [];
}

/**
 * Run registered hooks in order, returning the first `ActionResult` produced.
 * Returns `null` when no hook handled the message.
 */
export async function runDirectMessageHooks(
	runtime: IAgentRuntime,
	input: DirectMessageHookInput,
): Promise<ActionResult | null> {
	for (const hook of getDirectMessageHooks(runtime)) {
		const result = await hook(input);
		if (result) {
			return result;
		}
	}
	return null;
}

export function __resetDirectMessageHooksForTests(
	runtime: IAgentRuntime,
): void {
	hooks.delete(runtime);
}
