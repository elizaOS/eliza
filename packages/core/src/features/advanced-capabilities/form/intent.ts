/**
 * @module intent
 * @description Two-tier intent detection for form interactions
 *
 * ## Design Rationale
 *
 * Intent detection determines what the user wants to do:
 * - Fill form fields? Submit? Cancel? Undo?
 *
 * We use a two-tier approach:
 *
 * ### Tier 1: Fast Path (English Keywords)
 * Simple regex matching for common English phrases.
 *
 * ### Tier 2: LLM Fallback
 * When fast path returns null, we use LLM for non-English, ambiguous, or complex messages.
 */

import type { FormIntent } from "./types.ts";

/**
 * Quick intent detection using English keywords.
 *
 * Fast path for common English phrases - avoids LLM call for obvious intents.
 * Returns null if no match found, triggering LLM fallback.
 *
 * @param text - User message text
 * @returns Detected intent or null if no fast-path match
 */
export function quickIntentDetect(text: string): FormIntent | null {
	const lower = text.toLowerCase().trim();

	// Empty or too short - probably not a command
	if (lower.length < 2) {
		return null;
	}

	// ═══ LIFECYCLE INTENTS ═══

	// Restore - resume a saved form
	if (
		/\b(resume|continue|pick up where|go back to|get back to)\b/.test(lower)
	) {
		return "restore";
	}

	// Submit - complete and submit the form
	if (
		/\b(submit|done|finish|send it|that'?s all|i'?m done|complete|all set)\b/.test(
			lower,
		)
	) {
		return "submit";
	}

	// Stash - save for later without submitting
	if (
		/\b(save|stash|later|hold on|pause|save for later|come back|save this)\b/.test(
			lower,
		)
	) {
		// But not "save" in context of submitting
		if (!/\b(save and submit|save and send)\b/.test(lower)) {
			return "stash";
		}
	}

	// Cancel - abandon the form
	if (
		/\b(cancel|abort|nevermind|never mind|forget it|stop|quit|exit)\b/.test(
			lower,
		)
	) {
		return "cancel";
	}

	// ═══ UX MAGIC INTENTS ═══

	// Undo - revert the last change
	if (
		/\b(undo|go back|wait no|change that|oops|that'?s wrong|wrong|not right)\b/.test(
			lower,
		)
	) {
		return "undo";
	}

	// Skip - skip the current optional field
	if (
		/\b(skip|pass|don'?t know|next one|next|don'?t have|no idea)\b/.test(lower)
	) {
		// But not "skip to" (navigation)
		if (!/\bskip to\b/.test(lower)) {
			return "skip";
		}
	}

	// Explain - "why do you need this?"
	if (
		/\b(why|what'?s that for|explain|what do you mean|what is|purpose|reason)\b\??$/i.test(
			lower,
		)
	) {
		return "explain";
	}
	// Also match standalone "why?"
	if (/^why\??$/i.test(lower)) {
		return "explain";
	}

	// Example - "give me an example"
	if (
		/\b(example|like what|show me|such as|for instance|sample)\b\??$/i.test(
			lower,
		)
	) {
		return "example";
	}
	// Also match standalone "example?" or "e.g.?"
	if (/^(example|e\.?g\.?)\??$/i.test(lower)) {
		return "example";
	}

	// Progress - "how far am I?"
	if (
		/\b(how far|how many left|progress|status|how much more|where are we)\b/.test(
			lower,
		)
	) {
		return "progress";
	}

	// Autofill - "use my usual values"
	if (
		/\b(same as|last time|use my usual|like before|previous|from before)\b/.test(
			lower,
		)
	) {
		return "autofill";
	}

	// No match - let LLM handle it
	return null;
}

// ============================================================================
// INTENT HELPERS
// ============================================================================

/**
 * Check if intent is a lifecycle intent (affects session state).
 */
export function isLifecycleIntent(intent: FormIntent): boolean {
	return ["submit", "stash", "restore", "cancel"].includes(intent);
}

/**
 * Check if intent is a UX intent (doesn't directly provide data).
 */
export function isUXIntent(intent: FormIntent): boolean {
	return [
		"undo",
		"skip",
		"explain",
		"example",
		"progress",
		"autofill",
	].includes(intent);
}

/**
 * Check if intent likely contains data to extract.
 */
export function hasDataToExtract(intent: FormIntent): boolean {
	return intent === "fill_form" || intent === "other";
}
