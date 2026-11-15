/**
 * Parses colon-delimited response fields without losing multiline values. Only a known field
 * at the beginning of a line ends the preceding value; blank lines remain content. Detection
 * prevents raw control fields from reaching delivered prose.
 */

/**
 * Canonical field names the response-handler emits. Kept in sync with the
 * response-handler field evaluators. Used to anchor
 * segmentation: only these names delimit a new field, so a `value:` that
 * happens to appear inside prose (e.g. "the ratio is 3:1") does not split a
 * field.
 */
export const RESPONSE_HANDLER_FIELD_NAMES = [
	"shouldRespond",
	"contexts",
	"intents",
	"candidateActionNames",
	"replyText",
	"replyEffectStatus",
	"facts",
	"relationships",
	"addressedTo",
	"topics",
	"emotion",
] as const;

export type ResponseHandlerFieldName =
	(typeof RESPONSE_HANDLER_FIELD_NAMES)[number];

/**
 * Anchored regex that matches a line which STARTS a known field:
 * `^<knownField>:`. Case-sensitive on the field name (the model emits the
 * canonical camelCase); a leading whitespace tolerance covers the odd
 * bullet/indent. Capture group 1 = field name, group 2 = inline value (rest of
 * the line after the colon).
 */
const FIELD_LINE = new RegExp(
	`^\\s{0,3}(${RESPONSE_HANDLER_FIELD_NAMES.join("|")})\\s*:\\s?(.*)$`,
);

const LINE_BREAK = /\r?\n/;

/**
 * CommonMark fence line: 0–3 spaces, then a backtick or tilde run of at least
 * 3. Same shape as the scanner in `markdown/code.ts`. A tab is not indent.
 */
const FENCE_MARKER_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

interface OpenFence {
	char: "`" | "~";
	length: number;
}

function readFenceMarker(
	line: string,
): { char: "`" | "~"; length: number; rest: string } | null {
	const match = FENCE_MARKER_LINE.exec(line);
	if (!match) return null;
	const marker = match[2] ?? "";
	const char = marker[0];
	if (char !== "`" && char !== "~") return null;
	return { char, length: marker.length, rest: match[3] ?? "" };
}

/**
 * A line opens a fence only when it is a real delimiter. A backtick info
 * string cannot contain a backtick, so an inline span (` ```npm i``` `) stays
 * prose. A tilde fence may carry any info string.
 */
function openFenceFromLine(line: string): OpenFence | null {
	const marker = readFenceMarker(line);
	if (!marker) return null;
	if (marker.char === "`" && marker.rest.includes("`")) return null;
	return { char: marker.char, length: marker.length };
}

/**
 * A closer must use the same character, be at least as long as the opener,
 * and have only spaces or tabs after the marker. ` ```js ` inside an open
 * fence is content, and a 3-backtick line does not close a 4-backtick fence.
 */
function closesFence(line: string, open: OpenFence): boolean {
	const marker = readFenceMarker(line);
	if (!marker) return false;
	return (
		marker.char === open.char &&
		marker.length >= open.length &&
		/^[ \t]*$/.test(marker.rest)
	);
}

/**
 * Cheap skeleton detector for the fail-closed send-boundary guard. Returns true
 * when `text` IS a raw field transcript that must NOT be shipped to a user
 * channel — as opposed to a composed reply that merely QUOTES one.
 * Intentionally cheap: line scan + regex, no full parse.
 *
 * Structural rule: a genuine text-mode envelope echo IS the message — its
 * first substantive line (outside code fences) is a known field line, and a
 * hallmark field (`shouldRespond:` / `replyText:`) appears at the top level.
 * A reply that opens with prose (e.g. a diagnosis of a transcript the user
 * pasted, which legitimately quotes `replyText:` lines) or whose field lines
 * sit inside a code fence is CONTENT, not a leak — flagging it would make the
 * send boundary silently replace the whole answer with the quoted replyText
 * value, destroying the diagnosis.
 */
export function looksLikeRawFieldTranscript(text: unknown): boolean {
	if (typeof text !== "string" || text.length === 0) return false;
	let fence: OpenFence | null = null;
	let leadsWithFieldLine = false;
	for (const line of text.split(LINE_BREAK)) {
		if (fence) {
			if (closesFence(line, fence)) fence = null;
			continue;
		}
		const opened = openFenceFromLine(line);
		if (opened) {
			fence = opened;
			continue;
		}
		if (line.trim().length === 0) continue;
		const match = FIELD_LINE.exec(line);
		if (!leadsWithFieldLine) {
			// The first substantive unfenced line decides authorship: prose means
			// the model composed a reply (which may quote a transcript); a known
			// field line means the output is the envelope skeleton itself.
			if (!match) return false;
			leadsWithFieldLine = true;
		}
		if (match && (match[1] === "shouldRespond" || match[1] === "replyText")) {
			return true;
		}
		// `contexts: ``` ` opens quoted mode for the following lines. A later
		// `replyText:` inside that fence is part of the sample, not the envelope.
		if (match?.[2]) fence = openFenceFromLine(match[2]);
	}
	return false;
}

export interface ParsedFieldTranscript {
	/** Map of field name → raw multi-line value string (trimmed of edge whitespace). */
	fields: Partial<Record<ResponseHandlerFieldName, string>>;
	/** Number of distinct known fields found (used to gauge confidence). */
	fieldCount: number;
}

/**
 * Parse a keyed field transcript into a map of field name → value string.
 *
 * Segmentation rule: scan line by line. A line matching `^<knownField>:` opens
 * a new field; its value is the inline remainder plus every subsequent line up
 * to (but not including) the next `^<knownField>:` line. Blank lines inside a
 * value are preserved (then trimmed at the value edges). This is what lets a
 * multi-line `replyText` with an embedded blank line survive intact.
 *
 * Fence rule: field lines inside a fenced code block (``` / ~~~) are QUOTED
 * content, never boundaries — a replyText value that quotes an envelope inside
 * a fence (the agent diagnosing a leaked transcript) keeps the whole fenced
 * block instead of being split at the quoted `contexts:`/`replyText:` lines.
 * A fence follows the Markdown delimiter rules: the closer must be at least
 * as long as the opener and cannot carry an info string, and a backtick line
 * whose info string contains a backtick (an inline span such as ```npm i```)
 * is not a fence.
 *
 * Returns null when no known field line is found (the text is not a transcript
 * — let the caller fall through to its plain-text handling).
 */
export function parseFieldTranscript(
	raw: string | null | undefined,
): ParsedFieldTranscript | null {
	if (typeof raw !== "string") return null;
	const lines = raw.split(LINE_BREAK);

	const fields: Partial<Record<ResponseHandlerFieldName, string>> = {};
	let currentField: ResponseHandlerFieldName | null = null;
	let buffer: string[] = [];
	let foundAny = false;

	const flush = () => {
		if (currentField !== null) {
			// Only set the first occurrence of a field (first-wins, matches the
			// registry de-dup contract). Trim edge whitespace / blank lines but
			// keep embedded blanks.
			if (fields[currentField] === undefined) {
				fields[currentField] = buffer.join("\n").trim();
			}
		}
		buffer = [];
	};

	let fence: OpenFence | null = null;
	for (const line of lines) {
		if (fence) {
			// The closing line belongs to the value. A shorter marker, or a
			// marker with an info string, stays inside the fence.
			if (closesFence(line, fence)) fence = null;
			if (currentField !== null) buffer.push(line);
			continue;
		}
		const opened = openFenceFromLine(line);
		if (opened) {
			fence = opened;
			if (currentField !== null) buffer.push(line);
			continue;
		}
		const match = FIELD_LINE.exec(line);
		if (match) {
			// New field boundary — close the previous field first.
			flush();
			currentField = match[1] as ResponseHandlerFieldName;
			foundAny = true;
			const inline = match[2] ?? "";
			buffer = inline ? [inline] : [];
			// The value opened a fence on the field line itself
			// (`replyText: ```bash`), so the next real closer ends quoted mode
			// instead of leaving every later field inside the reply.
			fence = openFenceFromLine(inline);
		} else if (currentField !== null) {
			// Continuation line of the current field value (including blank lines
			// and any fenced quoted content).
			buffer.push(line);
		}
		// Lines before the first field marker are preamble; ignore them.
	}
	flush();

	if (!foundAny) return null;
	const fieldCount = Object.keys(fields).length;
	return { fields, fieldCount };
}

/**
 * Extract just the `replyText` value from a raw field transcript, if present.
 * Convenience wrapper used by the fail-closed send-boundary guard: given a
 * leaked transcript, recover the intended user-facing reply. Returns null when
 * the text is not a transcript or has no non-empty replyText.
 */
export function extractReplyTextFromTranscript(
	raw: string | null | undefined,
): string | null {
	// Field values are already edge-trimmed.
	return parseFieldTranscript(raw)?.fields.replyText || null;
}

/**
 * Comma-splitter for list-shaped field values in a transcript (`contexts`,
 * `topics`, `candidateActionNames`, `intents`, `addressedTo`, `facts`). The
 * JSON path carries real arrays; the text transcript carries a comma- or
 * newline-separated string. `none`/`n/a`/empty collapse to [].
 */
export function splitTranscriptList(value: string | undefined): string[] {
	if (typeof value !== "string") return [];
	const trimmed = value.trim();
	if (!trimmed) return [];
	const lowered = trimmed.toLowerCase();
	if (lowered === "none" || lowered === "n/a" || lowered === "[]") return [];
	return trimmed
		.split(/[\n,]/)
		.map((item) => item.trim())
		.filter(Boolean);
}
