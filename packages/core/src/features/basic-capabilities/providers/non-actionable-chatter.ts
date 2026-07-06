/**
 * Text heuristic for one-off relationship follow-up reminders. The ACTIONS
 * provider uses this to keep follow-up-capable actions visible when a user gives
 * an informal reminder-like instruction without scheduling language broad
 * enough to warrant the whole catalog. Matching runs over normalized user text.
 */
import type { Memory } from "../../../types/index.ts";
import { normalizeUserMessageText } from "../../../utils/message-text.ts";

export function normalizeMessageText(message: Memory): string {
	return normalizeUserMessageText(message);
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
