import {
	findKeywordTermMatch,
	getValidationKeywordTerms,
} from "../i18n/validation-keywords.ts";
import type { AgentContext, Memory, State } from "../types/index.ts";
import {
	getActiveRoutingContextsForTurn,
	routingContextsOverlap,
} from "./context-routing.ts";

export interface ContextKeywordValidationOptions {
	contexts: readonly AgentContext[];
	keywords?: readonly string[];
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
	return keys.flatMap((key) =>
		getValidationKeywordTerms(key, { includeAllLocales: true }),
	);
}

export function hasActionContextOrKeyword(
	message: Memory,
	state: State | undefined,
	options: ContextKeywordValidationOptions,
): boolean {
	const activeContexts = getActiveRoutingContextsForTurn(state, message);
	if (routingContextsOverlap(options.contexts, activeContexts)) {
		return true;
	}

	const terms = [
		...(options.keywords ?? []),
		...getAllValidationKeywordTerms(options.keywordKeys),
	];
	if (terms.length === 0) {
		return false;
	}

	return (
		findKeywordTermMatch(getActionValidationText(message, state), terms) !==
		undefined
	);
}
