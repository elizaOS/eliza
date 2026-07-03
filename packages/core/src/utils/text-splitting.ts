/**
 * Splits text into the first sentence and the rest of the text.
 * Handles common abbreviations to avoid false positives.
 */
export function extractFirstSentence(text: string): {
	first: string;
	rest: string;
} {
	// Regex for finding sentence boundaries.
	// Looks for a period, question mark, or exclamation mark followed by a space or end of string.
	const abbreviations = [
		"Mr",
		"Mrs",
		"Ms",
		"Dr",
		"Prof",
		"Sr",
		"Jr",
		"St",
		"vs",
		"etc",
		"e.g",
		"i.e",
	];

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
				// Potential boundary. Check prior context for abbreviations.
				// We look at the word preceding the punctuation.
				const preText = text.substring(0, i);
				// Include "." in the preceding word so dotted abbreviations match.
				// \w excludes ".", so the old \b(\w+)$ extracted only "g" from
				// "e.g" — the "e.g"/"i.e" list entries were dead and those got split
				// mid-token (the first-sentence / TTS early-emit path chopped "e.g."
				// into "e."). Strip a trailing dot before comparing to the list.
				// No prefix anchor: leftmost matching captures the maximal trailing
				// [\w.] run, and any other char (space, quote, paren, asterisk, dash)
				// or start-of-string delimits it — a (?:^|\s) anchor rejected
				// punctuation-preceded abbreviations ('"Dr' / '(Mr') that the
				// original \b handled, chopping mid-name.
				const lastWordMatch = preText.match(/([\w.]+)$/);

				let isAbbreviation = false;
				if (lastWordMatch) {
					const lastWord = lastWordMatch[1].replace(/\.$/, "");
					// Case insensitive check
					if (
						abbreviations.some(
							(abbr) => abbr.toLowerCase() === lastWord.toLowerCase(),
						)
					) {
						isAbbreviation = true;
					}
				}

				if (!isAbbreviation) {
					boundaryIndex = i + 1;
					break;
				}
			}
		}
	}

	if (boundaryIndex !== -1) {
		const first = text.substring(0, boundaryIndex).trim();
		const rest = text.substring(boundaryIndex).trim();
		return { first, rest };
	}

	return { first: text.trim(), rest: "" };
}

/**
 * Checks if the text likely contains a complete first sentence.
 * Useful for streaming to know when to call extractFirstSentence.
 */
export function hasFirstSentence(text: string): boolean {
	const { rest } = extractFirstSentence(text);
	return rest.length > 0;
}
