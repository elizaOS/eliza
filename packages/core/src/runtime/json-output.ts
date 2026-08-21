/**
 * Tolerant parsers for raw model output: unwrap code fences, extract every
 * top-level `{...}` object from noisy text, repair invalid JSON string escapes,
 * and strip leaked tool-call markup / punctuation-only replies. Used wherever
 * the runtime must salvage structure from a weak model's not-quite-valid JSON.
 */
import { formatError } from "../utils/format-error.ts";

export function parseJsonObject<T extends object>(raw: string): T | null {
	const trimmed = raw.trim();
	if (!trimmed) {
		return null;
	}

	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	const candidate = fenced?.[1] ?? trimmed;

	const parsedCandidate =
		parseObjectCandidate<T>(candidate) ??
		parseObjectCandidate<T>(repairJsonStringEscapes(candidate));
	if (parsedCandidate) {
		return parsedCandidate;
	}

	const repairedCandidate = repairJsonStringEscapes(candidate);
	const objectText =
		extractJsonObjects(candidate)[0] ??
		(repairedCandidate === candidate
			? null
			: extractJsonObjects(repairedCandidate)[0]);
	if (!objectText) return null;

	return (
		parseObjectCandidate<T>(objectText) ??
		parseObjectCandidate<T>(repairJsonStringEscapes(objectText))
	);
}

function parseObjectCandidate<T extends object>(candidate: string): T | null {
	try {
		const parsed = JSON.parse(candidate);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as T;
		}
	} catch {
		// error-policy:J3 untrusted-input sanitizing — raw model output that isn't
		// a bare JSON object is expected; retry once against the first embedded
		// object substring before reporting the candidate as invalid.
		const objectText = extractJsonObjects(candidate)[0];
		if (!objectText) return null;
		try {
			const parsed = JSON.parse(objectText);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as T;
			}
		} catch {
			// error-policy:J3 untrusted-input sanitizing — unparseable model output;
			// null is the explicit "invalid" signal, never a fake-valid default.
			return null;
		}
	}
	return null;
}

/**
 * Extract every top-level `{...}` JSON object substring from `raw`, in order.
 * Brace-depth scan that respects string literals and escapes, so braces inside
 * string values never confuse the boundaries. Weak models routinely narrate
 * multiple intents as concatenated objects (`{...}\n{...}`) rather than one
 * array — callers that took only the first silently dropped the rest.
 */
export function extractJsonObjects(raw: string): string[] {
	const objects: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < raw.length; index++) {
		const char = raw[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			if (depth === 0) {
				start = index;
			}
			depth++;
			continue;
		}
		if (char !== "}" || depth === 0) {
			continue;
		}
		depth--;
		if (depth === 0 && start >= 0) {
			objects.push(raw.slice(start, index + 1));
			start = -1;
		}
	}
	return objects;
}

export function repairJsonStringEscapes(raw: string): string {
	let output = "";
	let inString = false;
	let escaped = false;

	for (let index = 0; index < raw.length; index++) {
		const char = raw[index] ?? "";
		if (!inString) {
			output += char;
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (escaped) {
			if (char === '"' && looksLikeJsonDelimiterAfterString(raw, index + 1)) {
				output += '\\\\"';
				inString = false;
				escaped = false;
				continue;
			}
			if (isValidJsonEscape(raw, index)) {
				output += `\\${char}`;
				if (char === "u") {
					output += raw.slice(index + 1, index + 5);
					index += 4;
				}
			} else {
				output += `\\\\${escapeRawJsonStringChar(char)}`;
			}
			escaped = false;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') {
			inString = false;
			output += char;
			continue;
		}
		output += escapeRawJsonStringChar(char);
	}

	if (escaped) {
		output += "\\\\";
	}

	return output;
}

function looksLikeJsonDelimiterAfterString(
	raw: string,
	index: number,
): boolean {
	for (let cursor = index; cursor < raw.length; cursor++) {
		const char = raw[cursor];
		if (char === " " || char === "\n" || char === "\r" || char === "\t") {
			continue;
		}
		return char === "," || char === "}" || char === "]";
	}
	return true;
}

function isValidJsonEscape(raw: string, index: number): boolean {
	const char = raw[index];
	if (
		char === '"' ||
		char === "\\" ||
		char === "/" ||
		char === "b" ||
		char === "f" ||
		char === "n" ||
		char === "r" ||
		char === "t"
	) {
		return true;
	}
	if (char !== "u") {
		return false;
	}
	const hex = raw.slice(index + 1, index + 5);
	return /^[0-9a-fA-F]{4}$/.test(hex);
}

function escapeRawJsonStringChar(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default: {
			const code = char.codePointAt(0) ?? 0;
			return code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : char;
		}
	}
}

export function stringifyForModel(value: unknown): string {
	const serialized = JSON.stringify(value, null, 2);
	if (serialized === undefined) {
		throw new TypeError("Model prompt data is not JSON-serializable");
	}
	return serialized;
}

/** Serialize diagnostic context without allowing hostile or cyclic values to mask the original event. */
export function stringifyForDiagnostics(value: unknown): string {
	if (typeof value === "string") return value;
	const seen = new WeakSet<object>();
	try {
		const serialized = JSON.stringify(
			value,
			(_key, nestedValue: unknown) => {
				if (typeof nestedValue === "bigint") return `${nestedValue}n`;
				if (nestedValue && typeof nestedValue === "object") {
					if (seen.has(nestedValue)) return "[Circular]";
					seen.add(nestedValue);
				}
				return nestedValue;
			},
			2,
		);
		return serialized ?? formatError(value);
	} catch {
		// error-policy:J7 diagnostic serialization must not mask the event being reported
		return formatError(value);
	}
}

/**
 * Tag-name shape of an invented pseudo-tool tag: `_`-bearing OR ≥4 uppercase
 * chars, case-sensitive, so quoted real acronyms (`<AI>`) stay prose. Single
 * source of truth shared by the reply stripper below, the planner's embedded
 * tool-call recovery, and the evaluator's user-facing-answer screen — the
 * three must agree on what counts as tool markup, or text screened by one is
 * silently laundered by another (matrix F38, tj-9129a432454364).
 */
export const PSEUDO_TOOL_TAG_NAME_SRC =
	"[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z][A-Z0-9]{3,}";

const PSEUDO_TOOL_TAG_BLOCK_RE = new RegExp(
	`<(${PSEUDO_TOOL_TAG_NAME_SRC})>[\\s\\S]*?</\\1>`,
	"g",
);
const PSEUDO_TOOL_TAG_OPEN_TAIL_RE = new RegExp(
	`<(?:${PSEUDO_TOOL_TAG_NAME_SRC})>[\\s\\S]*$`,
	"g",
);

/**
 * Detects tool-call-shaped markup a model emitted as reply text instead of a
 * structured call: the native `<tool_call>` serialization or an invented
 * `<UPPER_SNAKE>` pseudo-tag. Text matching this is a tool INTENT, never a
 * user-facing answer — deliverers must either recover and dispatch the call
 * or decline the text entirely; stripping the markup and shipping the
 * surviving prose fabricates an effect claim ("saving note." with no note).
 */
export function containsToolCallShapedMarkup(text: string): boolean {
	return (
		/<\/?(?:tool_call|function_call|arg_key|arg_value)\b/i.test(text) ||
		new RegExp(`<(?:${PSEUDO_TOOL_TAG_NAME_SRC})>`).test(text)
	);
}

/**
 * Recover the tool invocations a weak model serialized as
 * `<ACTION_NAME>{json args}</ACTION_NAME>` pseudo-tags (live:
 * `<NOTES_CREATE>{"title":…}</NOTES_CREATE>` beside "saving note." prose,
 * tj-9129a432454364 stage 7 — stripped and never executed). Deliberately
 * conservative: only `_`-bearing tag names with a parseable JSON-object body
 * qualify, so an all-caps tag quoted in prose or wrapping non-JSON text never
 * fabricates a call.
 */
export function parsePseudoTagToolInvocations(
	text: string | undefined,
): Array<{ name: string; params: Record<string, unknown> }> {
	if (!text?.includes("<")) return [];
	const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
	const blockRe =
		/<([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)>\s*(\{[\s\S]*?\})\s*<\/\1>/g;
	for (const match of text.matchAll(blockRe)) {
		try {
			const parsed: unknown = JSON.parse(match[2]);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				calls.push({
					name: match[1],
					params: parsed as Record<string, unknown>,
				});
			}
		} catch {
			// error-policy:J3 a non-JSON body is not a recoverable invocation; the
			// reply stripper still removes the markup and the evaluator screen
			// still declines the text, so nothing is fabricated either way.
		}
	}
	return calls;
}

/**
 * Clean a model-produced reply field before it reaches the user. Removes
 * structural junk that weak models emit as plain text but which is never
 * user-facing content:
 *   1. the model's NATIVE tool-call serialization emitted as text instead of a
 *      structured call, e.g.
 *      `<tool_call>WEB_FETCH<arg_key>url</arg_key><arg_value>...</arg_value></tool_call>`
 *      (observed on cerebras gpt-oss / zai; eliza routes real tool calls
 *      structurally, and this markup never appears in eliza's own format), and
 *   2. a reply that is ONLY JSON punctuation (braces/brackets/quotes/commas).
 *
 * Structural artifact removal - the sibling of the existing `[tool output:]`
 * markup stripping - not semantic-content matching. The truncated-open branch is
 * deliberately conservative: it only swallows to end-of-string when the markup is
 * unmistakably a serialized call (an uppercase ACTION token or the native
 * `<arg_key>`/`<arg_value>` markup follows), so a reply that merely *mentions*
 * `<tool_call>` in prose is preserved.
 */
export function stripJsonStructuralJunkReply(value: string): string {
	const withoutMarkup = value
		// Fully-serialized (paired) tool-call markup leaked as text.
		.replace(/<tool_call\b[\s\S]*?<\/tool_call>/gi, "")
		// Truncated-open markup (no closing tag): only strip to end when it is
		// clearly a leaked serialization - an uppercase ACTION token or the native
		// `<arg_key>`/`<arg_value>` markup follows. Case-SENSITIVE on purpose: the
		// uppercase action token is what distinguishes a real leaked call from a
		// bare prose mention of `<tool_call>` (which must be preserved).
		.replace(
			/<tool_call\b[^>]*>\s*(?=[A-Z][A-Z0-9_]{2,}|[\s\S]*?<arg_(?:key|value)\b)[\s\S]*$/g,
			"",
		)
		// Invented pseudo-tool-invocation tags: a weak model reaching for a
		// capability it cannot call structurally emits a bare `<UPPER_SNAKE>`
		// tag block instead (observed on cerebras zai/gemma:
		// `<BROWSE_PAGE><url>…</url></BROWSE_PAGE>`). Uppercase-snake XML tags are
		// never legitimate reply prose, so strip the paired block and any
		// truncated-open tail. Case-SENSITIVE + `_`-bearing OR ≥4-char to avoid
		// touching real acronyms a user might quote (`<AI>` stays).
		.replace(PSEUDO_TOOL_TAG_BLOCK_RE, "")
		.replace(PSEUDO_TOOL_TAG_OPEN_TAIL_RE, "")
		.trim();
	const cleaned = stripLeadingModelProtocolObjects(withoutMarkup);
	if (!cleaned) return "";
	return /^[\s{}[\]":,]+$/.test(cleaned) ? "" : cleaned;
}

const MODEL_PROTOCOL_OBJECT_KEYS = new Set([
	"action",
	"arguments",
	"effect",
	"parameters",
	"tool",
	"toolCall",
	"toolName",
]);

/**
 * Removes leading, balanced JSON objects that are unmistakably model/tool
 * protocol before a natural-language reply. This is structural output cleanup,
 * not semantic intent matching: the objects must parse as JSON, carry a tool
 * protocol key, and be followed by more output. Ordinary JSON answers are left
 * untouched.
 *
 * Cerebras gpt-oss has emitted adjacent protocol objects in a no-tools final
 * synthesis, for example `{action...}text: {effect...}Notes opened.`. Letting
 * that reach chat exposes internals even though the trailing prose is usable.
 */
function stripLeadingModelProtocolObjects(value: string): string {
	let remaining = value.trim();
	for (let count = 0; count < 4 && remaining.startsWith("{"); count++) {
		const objectText = extractJsonObjects(remaining)[0];
		if (!objectText || !remaining.startsWith(objectText)) break;

		let parsed: Record<string, unknown>;
		try {
			const candidate: unknown = JSON.parse(objectText);
			if (
				!candidate ||
				typeof candidate !== "object" ||
				Array.isArray(candidate)
			) {
				break;
			}
			parsed = candidate as Record<string, unknown>;
		} catch {
			break;
		}

		if (
			!Object.keys(parsed).some((key) => MODEL_PROTOCOL_OBJECT_KEYS.has(key))
		) {
			break;
		}
		const suffix = remaining.slice(objectText.length).trimStart();
		if (!suffix) return "";
		remaining = suffix.startsWith("text:")
			? suffix.slice("text:".length).trimStart()
			: suffix;
	}
	return remaining.trim();
}
