import type { Memory } from "../types";

/**
 * Validates if any of the given keywords are present in the recent message history.
 *
 * This function checks the current message content and the last 5 messages in the provided
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

	const relevantText: string[] = [];

	// 1. Current message content
	if (message.content?.text) {
		relevantText.push(message.content.text);
	}

	// 2. Recent messages (last 5)
	// Take the last 5 messages
	const recentSubset =
		recentMessages && recentMessages.length > 5
			? recentMessages.slice(-5)
			: recentMessages || [];

	for (const msg of recentSubset) {
		if (msg.content?.text) {
			relevantText.push(msg.content.text);
		}
	}

	if (relevantText.length === 0) {
		return false;
	}

	const combinedText = relevantText.join("\n").toLowerCase();

	for (const keyword of keywords) {
		if (combinedText.includes(keyword.toLowerCase())) {
			return true;
		}
	}

	return false;
}

/**
 * Validates if any of the recent message history matches the given regex.
 *
 * This function checks the current message content and the last 5 messages in the provided
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
	if (message.content?.text) {
		relevantText.push(message.content.text);
	}

	// 2. Recent messages (last 5)
	const recentSubset =
		recentMessages && recentMessages.length > 5
			? recentMessages.slice(-5)
			: recentMessages || [];

	for (const msg of recentSubset) {
		if (msg.content?.text) {
			relevantText.push(msg.content.text);
		}
	}

	if (relevantText.length === 0) {
		return false;
	}

	const combinedText = relevantText.join("\n");
	return regex.test(combinedText);
}
