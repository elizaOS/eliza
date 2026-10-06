import MarkdownIt from "markdown-it";

/**
 * Cleans assistant text for display by detecting and stripping roleplay stage
 * directions (`*beams*`, `*blushes*`, etc.). The leading-word set gates which
 * asterisk-wrapped spans are treated as stage directions rather than emphasis,
 * while Markdown code is preserved byte-for-byte.
 */
const STAGE_DIRECTION_FIRST_WORDS = new Set([
	"beam",
	"beams",
	"beaming",
	"blink",
	"blinks",
	"blinking",
	"blush",
	"blushes",
	"blushing",
	"bow",
	"bows",
	"bowing",
	"breathe",
	"breathes",
	"breathing",
	"cheer",
	"cheers",
	"cheering",
	"chuckle",
	"chuckles",
	"chuckling",
	"clap",
	"claps",
	"clapping",
	"cry",
	"cries",
	"crying",
	"curtsy",
	"curtsies",
	"curtsying",
	"dance",
	"dances",
	"dancing",
	"frown",
	"frowns",
	"frowning",
	"gasp",
	"gasps",
	"gasping",
	"gesture",
	"gestures",
	"gesturing",
	"giggle",
	"giggles",
	"giggling",
	"glance",
	"glances",
	"glancing",
	"grin",
	"grins",
	"grinning",
	"laugh",
	"laughs",
	"laughing",
	"lean",
	"leans",
	"leaning",
	"look",
	"looks",
	"looking",
	"nod",
	"nods",
	"nodding",
	"pause",
	"pauses",
	"pausing",
	"point",
	"points",
	"pointing",
	"pose",
	"poses",
	"posing",
	"pout",
	"pouts",
	"pouting",
	"raise",
	"raises",
	"raising",
	"shrug",
	"shrugs",
	"shrugging",
	"sigh",
	"sighs",
	"sighing",
	"smile",
	"smiles",
	"smiling",
	"smirk",
	"smirks",
	"smirking",
	"spin",
	"spins",
	"spinning",
	"stare",
	"stares",
	"staring",
	"stretch",
	"stretches",
	"stretching",
	"sway",
	"sways",
	"swaying",
	"tilt",
	"tilts",
	"tilting",
	"wave",
	"waves",
	"waving",
	"whisper",
	"whispers",
	"whispering",
	"wink",
	"winks",
	"winking",
	"yawn",
	"yawns",
	"yawning",
]);

function collapseInlineWhitespace(input: string): string {
	return input.replace(/[ \t]+/g, " ").trim();
}

function looksLikeStageDirection(input: string): boolean {
	const normalized = collapseInlineWhitespace(input).trim();
	if (!normalized || normalized.length > 100) return false;

	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ASCII-range check to reject non-ASCII input
	if (/[^\x00-\x7F]/.test(normalized)) {
		return false;
	}

	const wordMatch = normalized.match(/^[^\w]*([A-Za-z]+)/);
	if (!wordMatch) return false;

	const firstWord = wordMatch[1].toLowerCase();
	return STAGE_DIRECTION_FIRST_WORDS.has(firstWord);
}

function stripWrappedStageDirections(input: string, pattern: RegExp): string {
	return input.replace(
		pattern,
		(match: string, inner: string, offset: number, source: string) => {
			const prev = source[offset - 1] ?? "";
			const next = source[offset + match.length] ?? "";
			const hasSafeLeftBoundary =
				offset === 0 || /[\s([{>"'“‘.!?,;:-]/.test(prev);
			const hasSafeRightBoundary =
				offset + match.length >= source.length ||
				/[\s)\]}<"'”’.!?,;:-]/.test(next);
			if (
				!hasSafeLeftBoundary ||
				!hasSafeRightBoundary ||
				!looksLikeStageDirection(inner)
			) {
				return match;
			}
			return " ";
		},
	);
}

function tidyAssistantTextSpacing(input: string): string {
	return input
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/ ?([,.;!?])/g, "$1")
		.replace(/\(\s+/g, "(")
		.replace(/\s+\)/g, ")");
}

function normalizeProse(input: string): string {
	let normalized = stripWrappedStageDirections(
		input,
		/(?<!\*)\*([^*\n]+)\*(?!\*)/g,
	);
	normalized = stripWrappedStageDirections(
		normalized,
		/(?<!_)_([^_\n]+)_(?!_)/g,
	);
	return normalized === input ? input : tidyAssistantTextSpacing(normalized);
}

// Use the same CommonMark parser as core's Markdown rendering. Token line maps
// identify code in nested lists/quotes and unfinished fences without reimplementing
// container rules. Slice the original source so CRLF, tabs and indentation survive.
const assistantMarkdown = new MarkdownIt("commonmark");

function normalizeInlineParagraph(input: string): string {
	// Backtick runs close only a run of exactly the same length. Index them once
	// so a long streamed reply with unmatched runs does not trigger quadratic scans.
	const runs = Array.from(input.matchAll(/`+/g));
	const byLength = new Map<number, number[]>();
	for (let index = 0; index < runs.length; index++) {
		const length = runs[index][0].length;
		const group = byLength.get(length) ?? [];
		group.push(index);
		byLength.set(length, group);
	}
	const cursors = new Map<number, number>();
	let output = "";
	let offset = 0;
	for (let index = 0; index < runs.length; index++) {
		const opener = runs[index];
		let escapeStart = opener.index;
		while (escapeStart > 0 && input[escapeStart - 1] === "\\") escapeStart--;
		if ((opener.index - escapeStart) % 2 !== 0) continue;
		const length = opener[0].length;
		const group = byLength.get(length);
		if (!group) continue;
		let cursor = cursors.get(length) ?? 0;
		while (cursor < group.length && group[cursor] <= index) cursor++;
		cursors.set(length, cursor);
		const closingIndex = group[cursor];
		if (closingIndex === undefined) continue;
		const closer = runs[closingIndex];
		output += normalizeProse(input.slice(offset, opener.index));
		const end = closer.index + length;
		output += input.slice(opener.index, end);
		offset = end;
		index = closingIndex;
	}
	output += normalizeProse(input.slice(offset));
	// Remove horizontal padding introduced by a removed direction only at this
	// prose segment's edges; never trim newlines or whitespace inside code spans.
	if (output !== input) output = output.replace(/^[ \t]+|[ \t]+$/g, "");
	return output;
}

// Indentation and quote markers that open each line place a paragraph in its
// list item or blockquote. Chat bubbles render this text with `white-space:
// pre-wrap`, so normalize only the prose after them and keep them byte-for-byte.
function normalizeContainedParagraph(source: string): string {
	const lines = source.split(/(\r\n|\r|\n)/);
	const prefixes: string[] = [];
	for (let index = 0; index < lines.length; index += 2) {
		const prefix = /^(?:[ \t]*>)*[ \t]*/.exec(lines[index])?.[0] ?? "";
		prefixes.push(prefix);
		lines[index] = lines[index].slice(prefix.length);
	}
	const prose = lines.join("");
	const normalized = normalizeInlineParagraph(prose);
	if (normalized === prose) return source;
	const output = normalized.split(/(\r\n|\r|\n)/);
	// Parenthesis cleanup can join lines. Later prefixes then have no line to
	// return to, but the first line still opens the paragraph.
	if (output.length !== lines.length) return prefixes[0] + normalized;
	for (let index = 0; index < output.length; index += 2) {
		output[index] = prefixes[index / 2] + output[index];
	}
	return output.join("");
}

function tryParseObject(input: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(input);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		// error-policy:J3 input is not a JSON object
		return null;
	}
}

function isResponseHandlerPayload(
	value: Record<string, unknown>,
): value is Record<string, unknown> & { replyText: string } {
	const shouldRespond = value.shouldRespond;
	return (
		typeof value.replyText === "string" &&
		(shouldRespond === "RESPOND" ||
			shouldRespond === "IGNORE" ||
			shouldRespond === "STOP" ||
			Array.isArray(value.contexts) ||
			Array.isArray(value.intents) ||
			Array.isArray(value.threadOps) ||
			Array.isArray(value.candidateActionNames))
	);
}

// Structural keys an elizaOS reply object may legitimately carry alongside the
// user-facing `reply`. When a parsed object's keys are ALL within this set and
// it has a string `reply`, the model emitted its whole response object as text
// (e.g. `{"reply":"107"}` or `{"reply":"…","action":"NONE"}`) — unwrap it. The
// allow-list keeps us from stripping real chat content that merely happens to be
// JSON with a `reply` field plus unrelated data.
const REPLY_PAYLOAD_KEYS = new Set([
	"reply",
	"response",
	"text",
	"message",
	"thought",
	"action",
	"actions",
	"simple",
	"providers",
	"evaluators",
	"inReplyTo",
	"attachments",
]);

// The model wraps its answer under `reply` or `response` (the key drifts by
// model/image — both observed on cloud agents). Return the primitive value from
// whichever is present, but only when EVERY key is a known response-shape key,
// so ordinary chat text that merely contains JSON is never rewritten. Allows a
// primitive value (`{"reply":42}` / `{"response":true}`), not just strings;
// objects/arrays aren't user-facing text and are rejected.
const PRIMARY_REPLY_KEYS = ["reply", "response"] as const;

function getSimpleReplyValue(value: Record<string, unknown>): string | null {
	let found: string | number | boolean | undefined;
	for (const key of PRIMARY_REPLY_KEYS) {
		const candidate = value[key];
		if (
			typeof candidate === "string" ||
			typeof candidate === "number" ||
			typeof candidate === "boolean"
		) {
			found = candidate;
			break;
		}
	}
	if (found === undefined) return null;
	for (const key of Object.keys(value)) {
		if (!REPLY_PAYLOAD_KEYS.has(key)) return null;
	}
	return String(found);
}

/**
 * Extracts the user-facing reply from a response-handler payload that leaked as
 * plain text. Local models can emit tool arguments as text when function-call
 * transport is unavailable, for example:
 *
 * "RESPOND", "contexts": ["simple"], "replyText": "Hello"
 *
 * That string is valid object content once the first value is named
 * `shouldRespond`, so parse that shape without touching ordinary chat text.
 */
export function extractAssistantReplyText(input: string): string | null {
	if (typeof input !== "string") return null;
	const trimmed = input.trim();

	// Shape 1: a leaked response-handler payload keyed by `replyText` — either the
	// full object or a bare argument fragment (`"RESPOND", "replyText": "Hi"`).
	if (trimmed.includes("replyText")) {
		const candidates = [trimmed];
		if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
			candidates.push(`{"shouldRespond":${trimmed}}`);
			if (trimmed.endsWith("}")) {
				candidates.push(`{"shouldRespond":${trimmed.slice(0, -1)}}`);
			}
		}

		for (const candidate of candidates) {
			const parsed = tryParseObject(candidate);
			if (!parsed || !isResponseHandlerPayload(parsed)) continue;
			const replyText = parsed.replyText.trim();
			if (!replyText) return null;
			return stripAssistantStageDirections(replyText).trim() || null;
		}
	}

	// Shape 2: the model emitted its whole reply object as text, e.g.
	// `{"reply":"107"}`, `{"response":"54"}`, or `{"reply":"…","action":"NONE"}`
	// (observed from gpt-oss/glm on cloud agents; the wrapper key drifts between
	// `reply` and `response`). Only unwrap a well-formed object whose keys are all
	// known response-shape keys, so ordinary chat text that merely contains JSON
	// is never rewritten.
	if (
		trimmed.startsWith("{") &&
		trimmed.endsWith("}") &&
		(trimmed.includes('"reply"') || trimmed.includes('"response"'))
	) {
		const parsed = tryParseObject(trimmed);
		const reply = parsed ? getSimpleReplyValue(parsed) : null;
		if (reply !== null) {
			const trimmedReply = reply.trim();
			if (!trimmedReply) return null;
			return stripAssistantStageDirections(trimmedReply).trim() || null;
		}
	}

	return null;
}

/** Remove stage directions from prose while preserving Markdown code source. */
export function stripAssistantStageDirections(input: string): string {
	if (typeof input !== "string") return "";
	const lineOffsets = [0];
	for (const match of input.matchAll(/\r\n|\r|\n/g)) {
		lineOffsets.push(match.index + match[0].length);
	}
	lineOffsets.push(input.length);
	let output = "";
	let offset = 0;
	for (const token of assistantMarkdown.parse(input, {})) {
		const isCode = token.type === "fence" || token.type === "code_block";
		if ((!isCode && token.type !== "inline") || !token.map) continue;
		const start = lineOffsets[token.map[0]];
		const end = lineOffsets[token.map[1]] ?? input.length;
		// Paragraph/heading/list boundaries also delimit inline code. Preserve
		// intervening block syntax rather than pairing backticks across blocks.
		output += input.slice(offset, start);
		const source = input.slice(start, end);
		output += isCode ? source : normalizeContainedParagraph(source);
		offset = end;
	}
	output += input.slice(offset);
	return output;
}
