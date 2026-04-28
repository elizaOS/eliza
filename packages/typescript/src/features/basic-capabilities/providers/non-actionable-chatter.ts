import type { Memory } from "../../../types/index.ts";
import { normalizeUserMessageText } from "../../../utils/message-text.ts";

export function normalizeMessageText(message: Memory): string {
	return normalizeUserMessageText(message);
}

const GREETING_PATTERN =
	/^(h(i|ey|ello|owdy|ola)|yo|sup|gm|gn|what'?s\s*up|how'?s\s*it\s*going|good\s*(morning|afternoon|evening|night))[\s!?.,]*$/;

export function looksLikeNonActionableChatter(message: Memory): boolean {
	const text = normalizeMessageText(message);
	if (!text) return false;
	if (GREETING_PATTERN.test(text)) return true;
	return (
		/\bi hate\b.*\b(email|gmail|inbox|mail)\b/.test(text) ||
		/^my calendar has been\b/.test(text) ||
		(/\b(any )?(tips|advice|suggestions?)\b/.test(text) &&
			/\bgoals?\b/.test(text)) ||
		/\bi think i spend\b.*\btoo much time\b.*\b(phone|screen)\b/.test(text) ||
		/^do you think blocking websites\b/.test(text) ||
		/^should i call .*\bor just email\b/.test(text)
	);
}

export function looksLikeRelationshipFollowUpReminder(
	message: Memory,
): boolean {
	const text = normalizeMessageText(message);
	return (
		/\bfollow up with\b/.test(text) &&
		/\b(next\s+(week|month)|tomorrow|today|tonight|this\s+week|on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|at\s+\d)\b/.test(
			text,
		) &&
		!/\bevery\b/.test(text)
	);
}
