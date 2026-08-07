/**
 * Reduces a model's written-form output to speakable prose for TTS.
 * `sanitizeSpeechText` NFKC-normalizes the input, then strips thinking /
 * analysis / tool tags, code fences and inline code, markdown links, raw HTML,
 * and URLs, removes parenthetical and bracketed stage directions, normalizes
 * punctuation and unusual glyphs, and collapses whitespace.
 */

function collapseWhitespace(input: string): string {
	return input.replace(/\s+/g, " ").trim();
}

function stripUrls(input: string): string {
	return input.replace(/\bhttps?:\/\/\S+/gi, " ");
}

function stripThinkingAndMarkup(input: string): string {
	let text = input;
	text = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, " ");
	text = text.replace(
		/<(analysis|reasoning|tool_calls?|tools?)\b[^>]*>[\s\S]*?<\/\1>/gi,
		" ",
	);
	text = text.replace(/```[\s\S]*?```/g, " ");
	text = text.replace(/`([^`]+)`/g, "$1");
	text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
	text = text.replace(/<[^>\n]+>/g, " ");
	text = stripUrls(text);
	return text;
}

const NON_SPEECH_SEGMENT_PATTERNS = [
	/\*{1,2}[^*\n]+\*{1,2}/g,
	/\([^()]*\)/g,
	/\[[^[\]]*\]/g,
	/\{[^{}]*\}/g,
];

function stripNonSpeechDirections(input: string): string {
	let text = input;
	while (true) {
		const previous = text;
		for (const pattern of NON_SPEECH_SEGMENT_PATTERNS) {
			text = text.replace(pattern, " ");
		}
		if (text === previous) {
			break;
		}
	}
	return text.replace(/[*()[\]{}]+/g, " ");
}

function sanitizeSpeechPunctuation(input: string): string {
	let text = input;
	text = text.replace(/[•·■▪◦]/g, " ");
	text = text.replace(/[“”]/g, '"');
	text = text.replace(/[‘’]/g, "'");
	text = text.replace(/[…]/g, "...");
	text = text.replace(/[–—]/g, ", ");
	text = text.replace(/\s{0,32}([,;:，；：])\s{0,32}/g, "$1 ");
	text = text.replace(/\s{0,32}([.!?。！？])\s{0,32}/g, "$1 ");
	text = text.replace(/[^\p{L}\p{N}\s.,!?'"%/$:+，。！？；：-]/gu, " ");
	text = text.replace(/([,.!?，。！？])\1+/g, "$1");
	text = text.replace(/^[,;:.!?，。！？；：]+/g, " ");
	return text;
}

/**
 * Lexical tweaks for TTS engines that mis-phonemize common English.
 * Kokoro/espeak-ng often renders "I am" as /jæm/ ("yam"), so contract it — but
 * English cannot contract a stranded `am`. "Yes, I am." and "who I am and ..."
 * must stay expanded, so only contract when a predicate complement follows:
 * whitespace, then something that is neither punctuation nor a coordinating
 * conjunction. The match is case-sensitive so "I AM" keeps its emphasis casing
 * instead of collapsing to "I'm".
 *
 * Kept byte-identical in behaviour with the `@elizaos/shared` copy; core cannot
 * import shared (the dependency runs the other way).
 */
const CONTRACTIBLE_I_AM =
	/\bI am\b(?=\s+(?!and\b|or\b|but\b|nor\b|yet\b)[^\s.,;:!?—–-])/g;

function fixSpeechPronunciations(input: string): string {
	return input.replace(CONTRACTIBLE_I_AM, "I'm");
}

export function sanitizeSpeechText(input: string): string {
	const normalized = input.normalize("NFKC");
	const stripped = stripThinkingAndMarkup(normalized);
	const withoutDirections = stripNonSpeechDirections(stripped);
	return collapseWhitespace(
		fixSpeechPronunciations(sanitizeSpeechPunctuation(withoutDirections)),
	);
}
