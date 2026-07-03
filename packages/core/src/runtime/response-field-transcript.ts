/**
 * response-field-transcript — tolerant parser + detector for the plain-text
 * "keyed field transcript" shape that models occasionally emit instead of the
 * canonical JSON HANDLE_RESPONSE envelope.
 *
 * The response-handler prompts the model with a set of named fields
 * (`shouldRespond`, `replyText`, `contexts`, `topics`, `emotion`, ...). The
 * canonical path is a JSON object (native tool call or JSON-as-text). But some
 * providers — notably cli-inference / claude-sdk warm sessions in *text mode* —
 * echo the field set back as a colon-delimited transcript:
 *
 *   shouldRespond: RESPOND
 *
 *   replyText: it's live https://example/
 *
 *   built it out at /workspace, go click around.
 *
 *   contexts: simple
 *
 *   topics: website build, aurora
 *
 *   emotion: none
 *
 * Two properties make this hard and were the root cause of issue #11712:
 *   1. A field VALUE can span multiple lines and can contain embedded blank
 *      lines (see `replyText` above — a URL line, a blank line, then more
 *      prose). Naive "split on blank line" segmentation drops the tail of the
 *      value or, worse, fails to recognise the shape at all so the WHOLE raw
 *      transcript falls through as the reply and is sent verbatim to the user.
 *   2. Because the JSON parser rejects it, the tolerant plain-text fallback
 *      treated the transcript as a "simple reply" and shipped the raw
 *      `shouldRespond: RESPOND\n\nreplyText: ...` block to the channel.
 *
 * The grammar here segments on the rule: **a field's value terminates only at
 * the next line that starts with `^<knownField>:`, never at a blank line.**
 * That preserves multi-line values with embedded blank lines.
 */

/**
 * Canonical field names the response-handler emits. Kept in sync with the
 * builtin field evaluators (see ./builtin-field-evaluators.ts). Used to anchor
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
	"facts",
	"relationships",
	"addressedTo",
	"topics",
	"emotion",
] as const;

export type ResponseHandlerFieldName =
	(typeof RESPONSE_HANDLER_FIELD_NAMES)[number];

const FIELD_NAME_SET = new Set<string>(RESPONSE_HANDLER_FIELD_NAMES);

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

/**
 * Cheap skeleton detector for the fail-closed send-boundary guard. Returns true
 * when `text` looks like a raw field transcript that must NOT be shipped to a
 * user channel. Intentionally cheap: regex only, no full parse.
 *
 * Matches when the text either:
 *  - starts (after optional leading whitespace) with `shouldRespond:`, or
 *  - contains a line beginning with `replyText:`.
 *
 * Both are hallmarks of the leaked HANDLE_RESPONSE transcript. Normal replies
 * never contain a line that starts with `replyText:` or lead with
 * `shouldRespond:`.
 */
export function looksLikeRawFieldTranscript(text: unknown): boolean {
	if (typeof text !== "string" || text.length === 0) return false;
	if (/^\s*shouldRespond\s*:/.test(text)) return true;
	if (/(^|\n)\s*replyText\s*:/.test(text)) return true;
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
 * Returns null when no known field line is found (the text is not a transcript
 * — let the caller fall through to its plain-text handling).
 */
export function parseFieldTranscript(
	raw: string | null | undefined,
): ParsedFieldTranscript | null {
	if (typeof raw !== "string") return null;
	const text = raw.replace(/\r\n/g, "\n");
	const lines = text.split("\n");

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
				fields[currentField] = buffer
					.join("\n")
					.replace(/^\n+|\n+$/g, "")
					.trim();
			}
		}
		buffer = [];
	};

	for (const line of lines) {
		const match = FIELD_LINE.exec(line);
		if (match && FIELD_NAME_SET.has(match[1])) {
			// New field boundary — close the previous field first.
			flush();
			currentField = match[1] as ResponseHandlerFieldName;
			foundAny = true;
			const inline = match[2];
			buffer = inline && inline.length > 0 ? [inline] : [];
		} else if (currentField !== null) {
			// Continuation line of the current field value (including blank lines).
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
	const parsed = parseFieldTranscript(raw);
	if (!parsed) return null;
	const reply = parsed.fields.replyText;
	if (typeof reply !== "string") return null;
	const trimmed = reply.trim();
	return trimmed.length > 0 ? trimmed : null;
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
