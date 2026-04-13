import type { Memory } from "@elizaos/core";

function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!content || typeof content !== "object") return "";
	const text = (content as { text?: unknown }).text;
	return typeof text === "string" ? text : "";
}

function toHaystack(message: Memory, recentMessages: unknown): string {
	const recent = Array.isArray(recentMessages) ? recentMessages : [];
	return [
		getMessageText(message),
		...recent.map((entry) => getMessageText(entry)),
	]
		.join(" ")
		.toLowerCase();
}

export function validateActionKeywords(
	message: Memory,
	recentMessages: unknown,
	keywords: string[],
): boolean {
	const haystack = toHaystack(message, recentMessages);
	if (!haystack.trim()) return true;
	return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

export function validateActionRegex(
	message: Memory,
	recentMessages: unknown,
	regex: RegExp,
): boolean {
	const haystack = toHaystack(message, recentMessages);
	if (!haystack.trim()) return true;
	return regex.test(haystack);
}
