import type { AgentContext, Memory, State } from "../types/index.ts";
import {
	getActiveRoutingContextsForTurn,
	routingContextsOverlap,
} from "./context-routing.ts";

export interface ContextKeywordValidationOptions {
	contexts: readonly AgentContext[];
	/** @deprecated Keyword routing belongs to action retrieval, not validate(). */
	keywords?: readonly string[];
	/** @deprecated Keyword routing belongs to action retrieval, not validate(). */
	keywordKeys?: readonly string[];
}

function getStringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

export function getActionValidationText(
	message: Memory,
	state?: State,
): string {
	const values = state?.values ?? {};
	return [
		getStringValue(message.content.text),
		getStringValue(values.recentMessages),
		getStringValue(values.recentPosts),
		getStringValue(values.recentInteractions),
	]
		.filter((value): value is string => Boolean(value))
		.join("\n");
}

export function getAllValidationKeywordTerms(
	keys: readonly string[] = [],
): string[] {
	void keys;
	return [];
}

export function hasActionContextOrKeyword(
	message: Memory,
	state: State | undefined,
	options: ContextKeywordValidationOptions,
): boolean {
	const activeContexts = getActiveRoutingContextsForTurn(state, message);
	return routingContextsOverlap(options.contexts, activeContexts);
}
