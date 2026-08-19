/**
 * Reduces a model's written-form output to speakable prose for TTS.
 * `sanitizeSpeechText` NFKC-normalizes the input, then strips thinking /
 * analysis / tool tags, code fences and inline code, markdown links, raw HTML,
 * and URLs, removes parenthetical and bracketed stage directions, normalizes
 * punctuation and unusual glyphs, and collapses whitespace.
 *
 * Stage-direction stripping peels one innermost `()` / `[]` / `{}` / `**`
 * layer per pass. Honest asides nest a handful of delimiters; each miss
 * rescan is O(remaining), so an uncapped `((((…hello…))))` bomb hangs TTS.
 * {@link MAX_NON_SPEECH_STRIP_PASSES} fail-closes the peel; leftover
 * delimiter glyphs are then dropped in a single linear pass.
 */

function collapseWhitespace(input: string): string {
	return input.replace(/\s+/g, " ").trim();
}

function stripUrls(input: string): string {
	return input.replace(/\bhttps?:\/\/\S+/gi, " ");
}

function stripThinkingAndMarkup(input: string): string {
	let text = input;
	text = text.replace(
		/<(think|analysis|reasoning|tool_calls?|tools?)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi,
		" ",
	);
	text = text.replace(
		/<(?:think|analysis|reasoning|tool_calls?|tools?)\b[^>]*$/gi,
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

/** Honest stage directions nest a handful of delimiters. Each peel rescan is
 * O(remaining); uncapped nested `((((…))))` hangs TTS. */
export const MAX_NON_SPEECH_STRIP_PASSES = 8 as const;

function stripNonSpeechDirections(input: string): string {
	let text = input;
	for (let pass = 0; pass < MAX_NON_SPEECH_STRIP_PASSES; pass += 1) {
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
	// Collapse repeated punctuation BEFORE the spacing rules separate the
	// repeats ("Wait!!!" must speak as "Wait!", not "Wait! ! !"). Twin of
	// packages/shared/src/spoken-text.ts (#20519) — change both together.
	text = text.replace(/([,.!?，。！？])\1+/g, "$1");
	text = text.replace(/\s{0,32}([,;:，；：])\s{0,32}/g, "$1 ");
	text = text.replace(/\s{0,32}([.!?。！？])\s{0,32}/g, "$1 ");
	text = text.replace(/[^\p{L}\p{N}\s.,!?'"%/$:+，。！？；：-]/gu, " ");
	text = text.replace(/([,.!?，。！？])\1+/g, "$1");
	text = text.replace(/^[,;:.!?，。！？；：]+/g, " ");
	return text;
}

export function sanitizeSpeechText(input: string): string {
	const normalized = input.normalize("NFKC");
	const stripped = stripThinkingAndMarkup(normalized);
	const withoutDirections = stripNonSpeechDirections(stripped);
	return collapseWhitespace(sanitizeSpeechPunctuation(withoutDirections));
}
