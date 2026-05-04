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
				const lastWordMatch = preText.match(/\b(\w+)$/);

				let isAbbreviation = false;
				if (lastWordMatch) {
					const lastWord = lastWordMatch[1];
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
