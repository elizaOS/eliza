/**
 * Deterministic post-generation verbosity enforcement for the personality
 * capability. Approximates a token count via whitespace/punctuation splitting
 * and hard-caps `terse` responses at `MAX_TERSE_TOKENS`, truncating at the
 * nearest sentence boundary (`normal` and `verbose` pass through unchanged).
 * Runs after the model returns so the truncation is observable in the
 * trajectory.
 */

import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../../utils/well-formed.ts";
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
	// Cut the ORIGINAL text at the character offset of the word cap instead of
	// rebuilding from split words: `split(/\s+/).join(" ")` flattened newlines,
	// so a four-bullet reply shipped as one run-on line (observed live on the
	// Discord group surface with a terse personality slot).
	const wellFormed = toWellFormedUnicode(text);
	const trimmed = wellFormed.trim();
	let wordCount = 0;
	let cutOffset = trimmed.length;
	for (const match of trimmed.matchAll(/\S+/g)) {
		wordCount += 1;
		if (wordCount > maxWords) {
			cutOffset = match.index;
			break;
		}
	}
	if (cutOffset >= trimmed.length) return wellFormed;
	const block = truncateWellFormed(trimmed, cutOffset);

	// A sentence terminator is [.!?] followed by whitespace or end-of-block. A
	// bare lastIndexOf(".") treated the dot inside "app/layout.tsx" as a
	// sentence end and cut the reply mid-filename (observed live: an 86-char
	// delivery ending "app/layout."). Filenames, versions, and inline code
	// never terminate at a dot glued to the next character.
	let lastTerminator = -1;
	for (const match of block.matchAll(/[.!?](?=\s|$)/g)) {
		lastTerminator = match.index;
	}
	if (lastTerminator > 0) {
		return truncateWellFormed(block, lastTerminator + 1);
	}
	// No clean boundary — hard cut with ellipsis.
	return `${block.trimEnd()}…`;
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
