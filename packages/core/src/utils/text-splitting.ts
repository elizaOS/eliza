/**
 * Splits text into the first sentence and the rest of the text.
 * Handles common abbreviations to avoid false positives.
 *
 * The walk is linear. Origin called `text.substring(0, i).match(/([\w.]+)$/)`
 * at every abbreviation-period, which is O(n²) on stacked titles
 * (`"Mr. ".repeat(n)`). Reply/TTS early-emit calls this on streaming model
 * text; a hostile or degenerate abbreviation run hung the turn.
 */

const ABBREVIATIONS = new Set([
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

const SENTENCE_END = new Set([".", "?", "!"]);
const BOUNDARY_FOLLOWERS = new Set([
	'"',
	"'",
	"\u201D",
	"\u2019",
	")",
	"]",
	"}",
]);
const TRAILING_CLOSERS = "\"'\u201D\u2019)]}";

function isAsciiWordChar(ch: string): boolean {
	return (
		(ch >= "A" && ch <= "Z") ||
		(ch >= "a" && ch <= "z") ||
		(ch >= "0" && ch <= "9") ||
		ch === "_"
	);
}

function isBoundaryFollower(ch: string | undefined): boolean {
	return ch === undefined || /\s/.test(ch) || BOUNDARY_FOLLOWERS.has(ch);
}

export function extractFirstSentence(text: string): {
	first: string;
	rest: string;
	/** Whether a sentence boundary was actually found in `text`. */
	complete: boolean;
} {
	let lastWord = "";
	let boundaryIndex = -1;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (SENTENCE_END.has(char) && isBoundaryFollower(text[i + 1])) {
			// Include "." in the preceding word so dotted abbreviations match.
			// Strip a trailing dot before comparing to the list (e.g. "e.g.").
			const word = lastWord.endsWith(".") ? lastWord.slice(0, -1) : lastWord;
			if (!ABBREVIATIONS.has(word.toLowerCase())) {
				boundaryIndex = i + 1;
				while (
					boundaryIndex < text.length &&
					TRAILING_CLOSERS.includes(text[boundaryIndex])
				) {
					boundaryIndex++;
				}
				break;
			}
		}
		if (isAsciiWordChar(char) || char === ".") {
			lastWord += char;
		} else {
			lastWord = "";
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
