/**
 * Shared parsing helpers for skill actions.
 *
 * Extracts skill slugs and intent from natural language messages.
 */
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";

/** Words to strip when extracting a skill slug from a message. */
const FILLER_WORDS =
	/\b(please|can\s+you|could\s+you|the|skill|called|named|for\s+me)\b/g;

/** Action verbs that indicate enable/install/uninstall intent. */
const ACTION_VERBS =
	/\b(enable|disable|turn\s+on|turn\s+off|activate|deactivate|start|stop|install|download|add|get|fetch|uninstall|remove|delete)\b/g;

/**
 * Extract a skill slug from a message by removing filler and action words.
 * Checks for quoted strings first (highest confidence), then falls back
 * to stripping known words from the text.
 *
 * @returns The extracted slug, or null if nothing usable remains.
 */
export function extractSlugFromMessage(text: string): string | null {
	// Prefer quoted strings — explicit and unambiguous. The capture is bounded
	// to one line and 64 chars: an unbounded [^"']+ crossed newlines, so a
	// single quote char in a large message (the external-content security
	// envelope's warning text contains an apostrophe) captured a giant span
	// that actions then echoed back to chat (tj-2dc95f75456876).
	const quotedMatch = text.match(/["']([^"'\r\n]{1,64})["']/);
	if (quotedMatch) return quotedMatch[1].trim();

	// Strip filler and action words, collapse whitespace
	const cleaned = text
		.toLowerCase()
		.replace(FILLER_WORDS, " ")
		.replace(ACTION_VERBS, " ")
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0 && cleaned.length < 100) return cleaned;
	return null;
}

/**
 * User-facing echo of a skill reference. Only name-shaped values (single line,
 * <=64 chars) are quoted back verbatim; anything else — a planner-supplied
 * blob, the external-content security envelope — renders as the neutral
 * fallback so an oversized or hostile reference never ships to chat.
 */
export function describeSkillReference(
	reference: string,
	fallback = "that skill",
): string {
	const trimmed = reference.trim();
	const nameShaped =
		trimmed.length > 0 && trimmed.length <= 64 && !/[\r\n]/.test(trimmed);
	return nameShaped ? `"${trimmed}"` : fallback;
}

/**
 * Log/machine-facing render of a skill reference. A blob must still never
 * travel whole — a weak planner echoes tool text verbatim and a multi-KB blob
 * bloats context — so collapse whitespace to one line and clamp to 120 chars.
 */
export function skillReferenceLogView(reference: string): string {
	const collapsed = reference.replace(/\s+/g, " ").trim();
	const wellFormed = toWellFormedUnicode(collapsed);
	return wellFormed.length > 120
		? `${truncateWellFormed(wellFormed, 120)}…`
		: wellFormed;
}

/**
 * Detect whether the user wants to enable or disable a skill.
 *
 * @returns `true` for enable, `false` for disable, `null` if ambiguous.
 */
export function detectEnableIntent(text: string): boolean | null {
	const normalized = text.toLowerCase();
	if (/\b(enable|turn\s+on|activate|start)\b/.test(normalized)) return true;
	if (/\b(disable|turn\s+off|deactivate|stop)\b/.test(normalized)) return false;
	return null;
}
