import { MAX_TERSE_TOKENS, type VerbosityLevel } from "./types.ts";

/**
 * Approximate token counter. Real tokenizers depend on the model — for a
 * hard cap on output verbosity, splitting on whitespace + punctuation is
 * close enough and avoids the cost of a real tokenizer in the hot path.
 *
 * 1 word ≈ 1.3 tokens for English, so MAX_TERSE_TOKENS=60 ≈ 46 words.
 * Returning `Math.ceil(words * 1.3)` keeps callers in the same units.
 */
export function approximateTokenCount(text: string): number {
	if (!text) return 0;
	const words = text.trim().split(/\s+/).filter(Boolean);
	return Math.ceil(words.length * 1.3);
}

/**
 * Result of a verbosity enforcement pass.
 */
export interface VerbosityEnforcementResult {
	text: string;
	truncated: boolean;
	originalTokens: number;
	finalTokens: number;
}

function truncateAtSentenceBoundary(text: string, maxWords: number): string {
	const words = text.trim().split(/\s+/);
	if (words.length <= maxWords) return text;
	const truncated = words.slice(0, maxWords).join(" ");

	// Find the last sentence-ending punctuation in the truncated block.
	const sentenceEnd = truncated.search(/[.!?][^.!?]*$/);
	if (sentenceEnd > 0) {
		// Keep up to (and including) the punctuation.
		const lastTerminator = truncated.lastIndexOf(".");
		const lastBang = truncated.lastIndexOf("!");
		const lastQ = truncated.lastIndexOf("?");
		const cut = Math.max(lastTerminator, lastBang, lastQ);
		if (cut > 0) {
			return truncated.slice(0, cut + 1);
		}
	}
	// No clean boundary — hard cut with ellipsis.
	return `${truncated.trimEnd()}…`;
}

/**
 * Apply verbosity enforcement to a generated response. For `terse` we enforce
 * a hard cap; `normal` and `verbose` are pass-through.
 *
 * This is a deterministic post-generation transform — it runs after the model
 * returns, so the truncation is observable in the trajectory.
 */
export function enforceVerbosity(
	text: string,
	verbosity: VerbosityLevel | null | undefined,
): VerbosityEnforcementResult {
	const originalTokens = approximateTokenCount(text);
	if (verbosity !== "terse") {
		return {
			text,
			truncated: false,
			originalTokens,
			finalTokens: originalTokens,
		};
	}
	if (originalTokens <= MAX_TERSE_TOKENS) {
		return {
			text,
			truncated: false,
			originalTokens,
			finalTokens: originalTokens,
		};
	}
	// MAX_TERSE_TOKENS tokens ≈ MAX_TERSE_TOKENS / 1.3 words
	const maxWords = Math.max(1, Math.floor(MAX_TERSE_TOKENS / 1.3));
	const truncated = truncateAtSentenceBoundary(text, maxWords);
	return {
		text: truncated,
		truncated: true,
		originalTokens,
		finalTokens: approximateTokenCount(truncated),
	};
}
