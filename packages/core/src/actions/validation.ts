import type { AgentContext } from "../types/contexts.js";
import type { Memory } from "../types/memory.js";
import type { State } from "../types/state.js";
import {
	getActiveRoutingContextsForTurn,
	routingContextsOverlap,
} from "../utils/context-routing.ts";

/**
 * Decides whether an action is eligible this turn by testing that the action's
 * declared routing contexts overlap the routing contexts active for the current
 * message and state. Eligibility depends only on active routing contexts, not on
 * natural-language keyword matching.
 */

export interface ActionContextValidationOptions {
	contexts: readonly AgentContext[];
	/**
	 * Optional localized keyword-data KEYS (into the i18n keyword DB under
	 * `@elizaos/core/.../keywords`). Forward-looking search metadata only;
	 * `hasActionContext` decides purely on active routing contexts and never
	 * matches raw natural-language keywords (which would be English-hostile).
	 */
	keywordKeys?: readonly string[];
}
export function hasActionContext(
	message: Memory,
	state: State | undefined,
	options?: ActionContextValidationOptions,
): boolean {
	const activeContexts = getActiveRoutingContextsForTurn(state, message);
	return routingContextsOverlap(options?.contexts, activeContexts);
}

/**
 * Keyword and regex matchers over recent message history, used by action
 * `validate()` paths to gate on message content. Both scan the current message
 * plus every retained recent message; keyword matching is case-insensitive.
 */

/**
 * Validates if any of the given keywords are present in the recent message history.
 *
 * This function checks the current message content and every message in the provided
 * list for the presence of any of the provided keywords. The check is case-insensitive.
 *
 * @param message The current message memory
 * @param recentMessages List of recent memories
 * @param keywords List of keywords to check for
 * @returns true if any keyword matches, false otherwise
 */
export function validateActionKeywords(
	message: Memory,
	recentMessages: Memory[],
	keywords: string[],
): boolean {
	if (!keywords || keywords.length === 0) {
		return false;
	}

	const normalizedKeywords = keywords
		.filter((keyword) => keyword.trim().length > 0)
		.map((keyword) => keyword.toLowerCase());
	if (normalizedKeywords.length === 0) {
		return false;
	}

	const relevantText: string[] = [];

	// 1. Current message content
	if (message.content.text) {
		relevantText.push(message.content.text);
	}

	// 2. Every retained recent message
	for (const msg of recentMessages || []) {
		if (msg.content.text) {
			relevantText.push(msg.content.text);
		}
	}

	if (relevantText.length === 0) {
		return false;
	}

	const combinedText = relevantText.join("\n").toLowerCase();

	for (const keyword of normalizedKeywords) {
		if (combinedText.includes(keyword)) {
			return true;
		}
	}

	return false;
}

/**
 * Validates if any of the recent message history matches the given regex.
 *
 * This function checks the current message content and every message in the provided
 * list against the provided regex pattern.
 *
 * @param message The current message memory
 * @param recentMessages List of recent memories
 * @param regex The regular expression to check against
 * @returns true if the regex matches any message content, false otherwise
 */
export function validateActionRegex(
	message: Memory,
	recentMessages: Memory[],
	regex: RegExp,
): boolean {
	if (!regex) {
		return false;
	}

	const relevantText: string[] = [];

	// 1. Current message content
	if (message.content.text) {
		relevantText.push(message.content.text);
	}

	// 2. Every retained recent message
	for (const msg of recentMessages || []) {
		if (msg.content.text) {
			relevantText.push(msg.content.text);
		}
	}

	if (relevantText.length === 0) {
		return false;
	}

	const combinedText = relevantText.join("\n");
	return new RegExp(regex.source, regex.flags).test(combinedText);
}
