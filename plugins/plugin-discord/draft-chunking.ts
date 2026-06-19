export type BreakPreference = "paragraph" | "newline" | "sentence";

export interface DraftChunkConfig {
	minChars: number;
	maxChars: number;
	breakPreference: BreakPreference;
}

export const DEFAULT_DRAFT_CHUNK_CONFIG: DraftChunkConfig = {
	minChars: 80,
	maxChars: 1900,
	breakPreference: "sentence",
};

export function findBreakPoint(
	text: string,
	maxLen: number,
	breakPreference: BreakPreference = "sentence",
): number {
	if (text.length <= maxLen) {
		return text.length;
	}

	const region = text.slice(0, maxLen);
	if (breakPreference === "paragraph" || breakPreference === "newline") {
		const paragraphBreak = region.lastIndexOf("\n\n");
		if (paragraphBreak > maxLen * 0.3) {
			return paragraphBreak + 2;
		}
	}

	if (breakPreference !== "sentence") {
		const newlineBreak = region.lastIndexOf("\n");
		if (newlineBreak > maxLen * 0.3) {
			return newlineBreak + 1;
		}
	}

	const sentenceMatch = region.match(/[.!?]\s+(?=[A-Z])/g);
	if (sentenceMatch) {
		const lastSentenceEnd = region.lastIndexOf(
			sentenceMatch[sentenceMatch.length - 1],
		);
		if (lastSentenceEnd > maxLen * 0.3) {
			return lastSentenceEnd + sentenceMatch[sentenceMatch.length - 1].length;
		}
	}

	const simpleSentenceBreak = region.lastIndexOf(". ");
	if (simpleSentenceBreak > maxLen * 0.3) {
		return simpleSentenceBreak + 2;
	}

	const wordBreak = region.lastIndexOf(" ");
	if (wordBreak > maxLen * 0.5) {
		return wordBreak + 1;
	}

	return maxLen;
}
