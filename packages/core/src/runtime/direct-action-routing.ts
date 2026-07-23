/**
 * Per-runtime registry for deterministic user-intent routes owned by plugins.
 * Plugins declare the natural-language boundary, eligible action names,
 * capability tags, and contexts; the message pipeline applies the normal
 * role, context, connector, and validation gates before promoting a simple
 * Stage-1 answer to the planner.
 */

import type { AgentContext } from "../types/contexts";
import type { IAgentRuntime } from "../types/runtime";

export interface DirectActionRoutingRule {
	/** Stable diagnostic identifier owned by the registering plugin. */
	readonly id: string;
	/** Runtime action names that can satisfy this intent. */
	readonly actionNames: readonly string[];
	/**
	 * Every selected action must declare all of these tags. This prevents a
	 * same-named or context-adjacent action from masquerading as the required
	 * read/write capability.
	 */
	readonly requiredActionTags: readonly string[];
	/** Contexts to add when the route is selected. */
	readonly contexts: readonly AgentContext[];
	/** True only for a current-turn request owned by this route. */
	matches(messageText: string): boolean;
}

const rules = new WeakMap<IAgentRuntime, DirectActionRoutingRule[]>();

export function registerDirectActionRoutingRule(
	runtime: IAgentRuntime,
	rule: DirectActionRoutingRule,
): void {
	const existing = rules.get(runtime);
	if (existing) {
		const index = existing.findIndex((candidate) => candidate.id === rule.id);
		if (index >= 0) {
			existing[index] = rule;
		} else {
			existing.push(rule);
		}
	} else {
		rules.set(runtime, [rule]);
	}
}

export function getDirectActionRoutingRules(
	runtime: IAgentRuntime,
): readonly DirectActionRoutingRule[] {
	return rules.get(runtime) ?? [];
}

export function __resetDirectActionRoutingRulesForTests(
	runtime: IAgentRuntime,
): void {
	rules.delete(runtime);
}
