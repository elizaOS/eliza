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
 *
 * Kokoro/espeak-ng renders "I am" as /jæm/ ("yam"), so contract it — but English
 * blocks contraction wherever the copula is STRANDED, i.e. its complement has
 * moved left out of the clause. Two things have to hold:
 *
 *   before: the match is not preceded by a wh-word or a fronted deictic, which
 *           is what strands it — "who I am today", "Here I am at last",
 *           "Wherever I am is home" are all ungrammatical when contracted.
 *   after:  a predicate complement actually follows — not punctuation (which
 *           strands it at a clause end: "Yes, I am.") and not a coordinator
 *           ("who I am and ...").
 *
 * A following-token test alone is not sufficient: it accepts "Here I am at
 * last" because a word follows. Both directions are required.
 *
 * The match is case-insensitive because "I AM" and "i am" mis-phonemize exactly
 * the same way; the replacement re-applies the observed casing.
 *
 * `@elizaos/shared` carries its own copy of this rule (core cannot import
 * shared — the dependency runs the other way). The two are kept in step by
 * their respective suites, which assert the same contraction cases; nothing
 * mechanically binds them, so they are not assumed identical elsewhere.
 */
const STRANDING_ANTECEDENT =
	"who|whom|whose|what|whatever|whoever|which|where|wherever|when|whenever|why|how|however|here|there";

const CONTRACTIBLE_I_AM = new RegExp(
	`(?<!\\b(?:${STRANDING_ANTECEDENT})\\s)\\b(I)(\\s+)(am)\\b(?=\\s+(?!and\\b|or\\b|but\\b|nor\\b|yet\\b)[^\\s.,;:!?])`,
	"gi",
);

function fixSpeechPronunciations(input: string): string {
	return input.replace(
		CONTRACTIBLE_I_AM,
		(_match, i: string, _sp, am: string) => {
			if (i === "I" && am === "AM") return "I'M";
			if (i === "i") return "i'm";
			return "I'm";
		},
	);
}

export function sanitizeSpeechText(input: string): string {
	const normalized = input.normalize("NFKC");
	const stripped = stripThinkingAndMarkup(normalized);
	const withoutDirections = stripNonSpeechDirections(stripped);
	return collapseWhitespace(
		fixSpeechPronunciations(sanitizeSpeechPunctuation(withoutDirections)),
	);
}
