/**
 * Candidate-action backstop registry — lets a host plugin declare which
 * candidate action names belong to it and how to recognize a message that is
 * genuinely addressed to those actions.
 *
 * The message pipeline's coding-delegation backstop consults these rules before
 * it strips candidate actions in favor of a coding-delegation action: when a
 * message reads as coding work but a registered rule both owns one of the
 * candidate actions AND matches the message text, the rule protects its
 * candidates from being overridden. When the backstop does force coding
 * delegation, every action owned by a registered rule is filtered out of the
 * candidate set.
 *
 * Cycle-avoidance: core defines the slot, plugins fill it. Core never imports
 * plugin-side symbols or hardcodes plugin-specific action names / heuristics.
 *
 * Registration uses a module-scoped WeakMap keyed by runtime instance so the
 * rule lifetime tracks the runtime and we don't leak across tests — same shape
 * as `SendPolicy` and `LocalizedExamplesProvider`.
 */

import type { IAgentRuntime } from "../types/runtime";

export interface CandidateActionBackstopRule {
	/**
	 * Action names this rule protects. Compared against candidate actions using
	 * the pipeline's canonical action-identifier normalization, so callers may
	 * register either the canonical or a loosely-cased form.
	 */
	readonly actionNames: readonly string[];
	/**
	 * True when `messageText` is genuinely a request for this rule's actions.
	 * Used to decide whether the candidates are protected from the coding
	 * backstop on a given turn.
	 */
	matches(messageText: string): boolean;
}

const rules = new WeakMap<IAgentRuntime, CandidateActionBackstopRule[]>();

export function registerCandidateActionBackstopRule(
	runtime: IAgentRuntime,
	rule: CandidateActionBackstopRule,
): void {
	const existing = rules.get(runtime);
	if (existing) {
		existing.push(rule);
	} else {
		rules.set(runtime, [rule]);
	}
}

export function getCandidateActionBackstopRules(
	runtime: IAgentRuntime,
): readonly CandidateActionBackstopRule[] {
	return rules.get(runtime) ?? [];
}

export function __resetCandidateActionBackstopRulesForTests(
	runtime: IAgentRuntime,
): void {
	rules.delete(runtime);
}
