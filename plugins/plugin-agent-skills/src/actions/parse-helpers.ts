/**
 * Shared parsing helpers for skill actions.
 *
 * Extracts skill slugs and intent from natural language messages.
 */

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
	// Prefer quoted strings — explicit and unambiguous
	const quotedMatch = text.match(/["']([^"']+)["']/);
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
