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
 * {@link MAX_NON_SPEECH_STRIP_PASSES} bounds the compatibility peel. If it
 * exhausts that budget, a linear interval scan removes every remaining
 * balanced direction rather than exposing text from the outer layers. Lines
 * with more star markers than that budget can represent are removed between
 * their outer markers before peeling, preventing emphasis nesting from
 * exposing alternating layers without rescans.
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

const STAR_DIRECTION_PATTERN = /\*{1,2}[^*\n]+\*{1,2}/g;

const BALANCED_DIRECTION_PATTERNS = [
	/\([^()]*\)/g,
	/\[[^[\]]*\]/g,
	/\{[^{}]*\}/g,
];

/** Honest stage directions nest a handful of delimiters. Each peel rescan is
 * O(remaining); uncapped nested `((((…))))` hangs TTS. */
export const MAX_NON_SPEECH_STRIP_PASSES = 8 as const;

const DIRECTION_OPENERS = new Map([
	["(", ")"],
	["[", "]"],
	["{", "}"],
] as const);

const DIRECTION_CLOSERS = new Map([
	[")", "("],
	["]", "["],
	["}", "{"],
] as const);

/**
 * Removes all balanced bracket regions in linear time. Independent stacks
 * preserve the legacy sanitizer's permissive handling of crossed delimiter
 * types while ensuring that a deeply nested outer direction cannot become
 * speech merely because the compatibility peel reached its pass budget.
 */
function stripResidualBalancedDirections(input: string): string {
	const removals = new Int32Array(input.length + 1);
	const openerStacks = new Map<string, number[]>(
		[...DIRECTION_OPENERS.keys()].map((opener) => [opener, []]),
	);

	for (let index = 0; index < input.length; index += 1) {
		const char = input[index] ?? "";
		if (DIRECTION_OPENERS.has(char as "(" | "[" | "{")) {
			openerStacks.get(char)?.push(index);
			continue;
		}
		const opener = DIRECTION_CLOSERS.get(char as ")" | "]" | "}");
		if (!opener) continue;
		const start = openerStacks.get(opener)?.pop();
		if (start === undefined) continue;
		removals[start] = (removals[start] ?? 0) + 1;
		removals[index + 1] = (removals[index + 1] ?? 0) - 1;
	}

	const parts: string[] = [];
	let activeIntervals = 0;
	let visibleStart = 0;
	for (let index = 0; index < input.length; index += 1) {
		const previous = activeIntervals;
		activeIntervals += removals[index] ?? 0;
		if (previous === 0 && activeIntervals > 0) {
			if (visibleStart < index) parts.push(input.slice(visibleStart, index));
			parts.push(" ");
		} else if (previous > 0 && activeIntervals === 0) {
			visibleStart = index;
		}
	}
	if (activeIntervals === 0 && visibleStart < input.length) {
		parts.push(input.slice(visibleStart));
	}
	return parts.join("");
}

/** Fail-closes lines whose emphasis markers exceed the peel budget. */
function stripExcessiveStarDirections(input: string): string {
	return input
		.split("\n")
		.map((line) => {
			let markerCount = 0;
			let first = -1;
			let last = -1;
			for (let index = 0; index < line.length; ) {
				if (line[index] !== "*") {
					index += 1;
					continue;
				}
				if (first < 0) first = index;
				const runStart = index;
				while (line[index] === "*") index += 1;
				markerCount += Math.ceil((index - runStart) / 2);
				last = index - 1;
			}
			return markerCount > MAX_NON_SPEECH_STRIP_PASSES * 2 && last > first
				? `${line.slice(0, first)} ${line.slice(last + 1)}`
				: line;
		})
		.join("\n");
}

function stripNonSpeechDirections(input: string): string {
	let text = stripExcessiveStarDirections(input);
	let stabilized = false;
	for (let pass = 0; pass < MAX_NON_SPEECH_STRIP_PASSES; pass += 1) {
		const previous = text;
		text = text.replace(STAR_DIRECTION_PATTERN, " ");
		for (const pattern of BALANCED_DIRECTION_PATTERNS) {
			text = text.replace(pattern, " ");
		}
		if (text === previous) {
			stabilized = true;
			break;
		}
	}
	if (!stabilized) {
		text = stripResidualBalancedDirections(text);
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
