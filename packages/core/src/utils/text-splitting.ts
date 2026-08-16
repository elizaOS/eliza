/**
 * Splits text into the first sentence and the rest of the text.
 * Handles common abbreviations to avoid false positives.
 */
const SENTENCE_ABBREVIATIONS = new Set([
	"mr",
	"mrs",
	"ms",
	"dr",
	"prof",
	"sr",
	"jr",
	"st",
	"vs",
	"etc",
	"e.g",
	"i.e",
]);

/**
 * Returns whether the period at `periodOffset` belongs to a common
 * abbreviation rather than ending a sentence. Offsets are UTF-16 code-unit
 * offsets, matching `RegExp#index` and `String#slice`.
 */
export function isAbbreviationPeriod(
	text: string,
	periodOffset: number,
): boolean {
	if (text[periodOffset] !== ".") return false;
	const precedingToken = text.slice(0, periodOffset).match(/([\w.]+)$/)?.[1];
	if (!precedingToken) return false;
	return SENTENCE_ABBREVIATIONS.has(
		precedingToken.replace(/\.$/, "").toLowerCase(),
	);
}

export function extractFirstSentence(text: string): {
	first: string;
	rest: string;
	/** Whether a sentence boundary was actually found in `text`. */
	complete: boolean;
} {
	// Regex for finding sentence boundaries.
	// Looks for a period, question mark, or exclamation mark followed by a space or end of string.
	let boundaryIndex = -1;

	// Simple iteration to find the first valid boundary
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (".?!".includes(char)) {
			// Check if it's followed by a space or end of string
			const nextChar = text[i + 1];
			if (
				nextChar === undefined ||
				/\s/.test(nextChar) ||
				nextChar === '"' ||
				nextChar === "'"
			) {
				if (!isAbbreviationPeriod(text, i)) {
					boundaryIndex = i + 1;
					break;
				}
			}
		}
	}

	if (boundaryIndex !== -1) {
		const first = text.substring(0, boundaryIndex).trim();
		const rest = text.substring(boundaryIndex).trim();
		return { first, rest, complete: true };
	}

	return { first: text.trim(), rest: "", complete: false };
}

/**
 * Checks if the text likely contains a complete first sentence.
 * Useful for streaming to know when to call extractFirstSentence.
 */
export function hasFirstSentence(text: string): boolean {
	// A boundary at the end of the text still completes a sentence, so this
	// cannot key off `rest`: a reply that is exactly one sentence leaves it
	// empty and would report false.
	return extractFirstSentence(text).complete;
}
