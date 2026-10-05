/** Sanitizes reasoning tags, end-of-turn sentinels, and model tool syntax at text-delivery boundaries. Fenced and inline code retain literal bytes and spacing. Structured tool calls are handled separately; im_start framing passes through. */
import {
	REASONING_TAG_NAMES,
	stripPairedTagBlocks,
	stripUnclosedTagSuffix,
} from "../utils/reasoning-tags.ts";

const MACHINE_SYNTAX_TAGS = [
	...REASONING_TAG_NAMES,
	// Native model tool-call syntax (glm/qwen-family `<tool_call>`, gemini-style
	// `<function_call>`). Machine syntax, never user-facing prose — strip it
	// like reasoning tags.
	"tool_call",
	"function_call",
] as const;

const MACHINE_SYNTAX_TAG_ALTERNATION = MACHINE_SYNTAX_TAGS.join("|");

const SELF_CLOSING_ARTIFACTS_RE =
	/<(?:STOP|END|end_turn|eot_id)\s*\/?>|<\|(?:end|stop|im_end|eot_id)\|>/gi;
// Cheap pre-filter so clean text (the overwhelmingly common case) returns
// without any code-block extraction or per-tag regex passes. Must recognize
// every shape SELF_CLOSING_ARTIFACTS_RE strips (delta 1: the Discord original
// omitted `eot_id` here, so a lone sentinel slipped through to the wire).
const QUICK_TAG_RE = new RegExp(
	`<\\s*\\/?\\s*(?:${MACHINE_SYNTAX_TAG_ALTERNATION})(?=[\\s/>])|<\\/?(?:final|STOP|END|end_turn|eot_id)\\b|<\\|(?:end|stop|im_end|eot_id)`,
	"i",
);
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
// An inline code span: a backtick run, non-backtick single-line content, and a
// closing run of exactly the same length (CommonMark's matched-run rule; the
// trailing lookahead rejects a longer closing run). Runs after fence
// extraction, so any backticks still present are inline.
const INLINE_CODE_RE = /(`+)[^`\n]+?\1(?!`)/g;
// NUL cannot be produced by model tokenizers or survive the JSON transport in
// between, so the sentinel cannot collide with content. Restoration still uses
// a FUNCTION replacement (delta 2): with a string replacement, a `$&` inside
// saved code re-inserts the matched sentinel itself, delivering a raw
// NUL-marker on the wire.
const CODE_SENTINEL_PREFIX = "\x00CB";

const PSEUDO_LINK_START_RE = /\[LINK:/gi;

function isValidPseudoLinkUrl(url: string): boolean {
	if (/\s/.test(url)) return false;
	try {
		const protocol = new URL(url).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		// error-policy:J3 model-authored pseudo-link URLs fail closed.
		return false;
	}
}

function findBalancedLabelEnd(text: string, start: number): number | undefined {
	let depth = 1;
	for (let index = start; index < text.length; index++) {
		if (text[index] === "\\") {
			index++;
			continue;
		}
		if (text[index] === "(") depth++;
		if (text[index] !== ")") continue;
		depth--;
		if (depth === 0) return index;
	}
	return undefined;
}

function formatPseudoLink(url: string, label: string | undefined): string {
	if (!label?.trim()) return url;
	const safeLabel = label.trim().replace(/\\|\[|\]/g, "\\$&");
	const safeDestination = url
		.replace(/\\/g, "%5C")
		.replace(/</g, "%3C")
		.replace(/>/g, "%3E")
		.replace(/[()]/g, "\\$&");
	return `[${safeLabel}](${safeDestination})`;
}

/**
 * Degrade model-invented `[LINK:<url>](label)` / `[LINK:<url>]` markers to
 * ordinary Markdown without allowing label delimiters to change the link
 * destination. Parentheses in labels are balanced because generated titles
 * commonly contain them; malformed markers remain visible instead of being
 * partially rewritten.
 */
function degradePseudoLinks(text: string): string {
	let output = "";
	let cursor = 0;
	PSEUDO_LINK_START_RE.lastIndex = 0;
	for (
		let match = PSEUDO_LINK_START_RE.exec(text);
		match;
		match = PSEUDO_LINK_START_RE.exec(text)
	) {
		const markerStart = match.index;
		const urlStart = PSEUDO_LINK_START_RE.lastIndex;
		const urlEnd = text.indexOf("]", urlStart);
		if (urlEnd < 0) break;
		const url = text.slice(urlStart, urlEnd);
		if (!isValidPseudoLinkUrl(url)) continue;

		let markerEnd = urlEnd + 1;
		let label: string | undefined;
		if (text[markerEnd] === "(") {
			const labelEnd = findBalancedLabelEnd(text, markerEnd + 1);
			if (labelEnd === undefined) continue;
			label = text.slice(markerEnd + 1, labelEnd);
			markerEnd = labelEnd + 1;
		}

		output += text.slice(cursor, markerStart);
		output += formatPseudoLink(url, label);
		cursor = markerEnd;
		PSEUDO_LINK_START_RE.lastIndex = markerEnd;
	}
	return cursor === 0 ? text : output + text.slice(cursor);
}

/**
 * Strip machine syntax from outbound agent text. Paired tags are removed with
 * their contents; an unclosed tag is removed to end-of-text (the live-observed
 * drift shape); `<final>` wrappers are unwrapped keeping their contents;
 * fenced ``` blocks and inline `code` spans pass through untouched so
 * documentation examples of the syntax survive. Idempotent — sanitizing
 * already-sanitized text is a no-op.
 */
export interface OutboundLiteralSpan {
	start: number;
	end: number;
}

/** Literal ranges are supplied by trusted structured renderers, never inferred
 * from serialized message metadata. Cosmetic cleanup cannot rewrite their bytes. */
export function sanitizeOutboundTextWithLiterals(
	text: string,
	literalSpans: readonly OutboundLiteralSpan[],
): { text: string; literalSpans: OutboundLiteralSpan[] } {
	let previousEnd = 0;
	for (const span of literalSpans) {
		if (
			!Number.isInteger(span.start) ||
			!Number.isInteger(span.end) ||
			span.start < previousEnd ||
			span.end <= span.start ||
			span.end > text.length
		)
			throw new TypeError("Invalid outbound literal range");
		previousEnd = span.end;
	}
	// A model must not assemble its own control tag across a quoted-data boundary.
	const controls = new RegExp(
		`</?(?:${MACHINE_SYNTAX_TAG_ALTERNATION}|final)\\b[^>]*(?:>|$)`,
		"gi",
	);
	for (const match of text.matchAll(controls)) {
		const start = match.index;
		const end = start + match[0].length;
		if (
			literalSpans.some(
				(span) =>
					span.start < end &&
					span.end > start &&
					!(span.start <= start && span.end >= end),
			)
		)
			throw new TypeError("Outbound literal splits control syntax");
	}
	if (!text || (!QUICK_TAG_RE.test(text) && !PSEUDO_LINK_START_RE.test(text))) {
		return { text, literalSpans: literalSpans.map((span) => ({ ...span })) };
	}
	PSEUDO_LINK_START_RE.lastIndex = 0;

	const namespaces = new Set(
		[...text.matchAll(new RegExp(`${CODE_SENTINEL_PREFIX}(\\d+):`, "g"))].map(
			(match) => match[1],
		),
	);
	let namespace = 0;
	while (namespaces.has(String(namespace))) namespace++;
	const sentinelPrefix = `${CODE_SENTINEL_PREFIX}${namespace}:`;
	const literalIndices = new Map<number, number>();
	const restoredLiterals: OutboundLiteralSpan[] = [];
	const codeSpans: string[] = [];
	const saveSpan = (match: string): string => {
		const index = codeSpans.length;
		codeSpans.push(match);
		return `${sentinelPrefix}${index}${sentinelPrefix}`;
	};
	// Fences first (they may contain backticks), then inline spans (delta 4).
	let processed = "";
	let cursor = 0;
	literalSpans.forEach((span, index) => {
		literalIndices.set(codeSpans.length, index);
		processed +=
			text.slice(cursor, span.start) +
			saveSpan(text.slice(span.start, span.end));
		cursor = span.end;
	});
	processed += text.slice(cursor);
	processed = processed.replace(CODE_BLOCK_RE, saveSpan);
	processed = processed.replace(INLINE_CODE_RE, saveSpan);

	processed = processed.replace(SELF_CLOSING_ARTIFACTS_RE, "");

	processed = degradePseudoLinks(processed);

	for (const tag of MACHINE_SYNTAX_TAGS) {
		processed = stripPairedTagBlocks(processed, tag);
		processed = stripUnclosedTagSuffix(processed, tag);
	}

	processed = processed.replace(/<final\b[^>]*>([\s\S]*?)<\/final>/gi, "$1");

	// Collapse the whitespace stripped blocks leave behind BEFORE restoring
	// code (delta 3): running it after restoration reformatted intentional
	// blank-line spacing inside fences.
	processed = processed.replace(/\n{3,}/g, "\n\n");

	// Restore in REVERSE order. Phase 2 (inline spans) runs over text that
	// already holds phase-1 fence sentinels, and the inline content class
	// matches a sentinel, so a later-indexed span can contain an earlier one.
	// Forward restoration then no-ops on the buried sentinel and re-injects it
	// raw. Nesting only ever runs later-contains-earlier, because fences are
	// extracted from the original text and cannot hold an inline sentinel.
	processed = processed.trim();
	for (let index = codeSpans.length - 1; index >= 0; index--) {
		const token = `${sentinelPrefix}${index}${sentinelPrefix}`;
		const at = processed.indexOf(token);
		const literalIndex = literalIndices.get(index);
		if (
			literalIndex !== undefined &&
			(at < 0 || processed.indexOf(token, at + token.length) >= 0)
		)
			throw new TypeError("Outbound cleanup removed or duplicated a literal");
		if (at < 0) continue;
		const delta = codeSpans[index].length - token.length;
		for (const span of restoredLiterals) {
			if (span && span.start >= at) {
				span.start += delta;
				span.end += delta;
			}
		}
		if (literalIndex !== undefined)
			restoredLiterals[literalIndex] = {
				start: at,
				end: at + codeSpans[index].length,
			};
		processed =
			processed.slice(0, at) +
			codeSpans[index] +
			processed.slice(at + token.length);
	}
	return { text: processed, literalSpans: restoredLiterals };
}

/** Existing string-only callers retain the same cosmetic policy. */
export function sanitizeOutboundText(text: string): string {
	return sanitizeOutboundTextWithLiterals(text, []).text;
}
