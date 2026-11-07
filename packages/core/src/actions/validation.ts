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

/** The current message plus every retained recent message, joined; null when none has text. */
function recentMessageText(
	message: Memory,
	recentMessages: Memory[],
): string | null {
	const texts: string[] = [];
	if (message.content.text) texts.push(message.content.text);
	for (const msg of recentMessages) {
		if (msg.content.text) texts.push(msg.content.text);
	}
	return texts.length > 0 ? texts.join("\n") : null;
}

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
	const normalizedKeywords = keywords
		.filter((keyword) => keyword.trim().length > 0)
		.map((keyword) => keyword.toLowerCase());
	if (normalizedKeywords.length === 0) return false;
	const combinedText = recentMessageText(
		message,
		recentMessages,
	)?.toLowerCase();
	return (
		combinedText !== undefined &&
		normalizedKeywords.some((keyword) => combinedText.includes(keyword))
	);
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
	const combinedText = recentMessageText(message, recentMessages);
	if (combinedText === null) return false;
	// A global or sticky regex carries `lastIndex`; test a copy so the caller's
	// regex is never mutated and repeated calls agree.
	const matcher =
		regex.global || regex.sticky
			? new RegExp(regex.source, regex.flags)
			: regex;
	return matcher.test(combinedText);
}
