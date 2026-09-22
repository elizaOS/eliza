/**
 * Lenient JSON parsing for model output. Strips a leading private-reasoning
 * preamble and a ```json / ```json5 code fence, then `JSON.parse`s the
 * remainder — returning `null` rather than throwing on any failure.
 * `parseJsonModelRecord` / `parseJsonModelArray` add shape guards for the common
 * object / array cases.
 */
import { unwrapWholeCodeFence } from "../utils/code-fence.ts";
import {
	findNextCloseTag,
	findNextOpenTag,
	REASONING_TAG_NAMES,
} from "../utils/reasoning-tags.ts";

const REASONING_TAG_ALTERNATION = REASONING_TAG_NAMES.join("|");

/** A payload opener: a JSON value start, or a code fence introducing one. */
const PAYLOAD_OPENER_RE = /[`{[]/;

/**
 * Drop a private-reasoning preamble, matching reasoning tags the way the rest
 * of the codebase does (all of `REASONING_TAG_NAMES`, case-insensitively, with
 * the whitespace tolerance of `reasoning-tags.ts`) instead of an exact
 * lowercase `<think>` literal.
 *
 * Both branches are deliberately ANCHORED to the head of the candidate,
 * because reasoning markup is also ordinary string data: `{"text":"</think>"}`
 * and a fenced body containing a close tag are valid payloads, and stripping
 * inside them would silently rewrite a value or break the parse. Only text
 * that cannot be payload is removed.
 */
function stripReasoningPreamble(candidate: string): string {
	// The candidate OPENS with a reasoning tag, so nothing up to its close can
	// be payload. First close only, matching the previous `indexOf` semantics.
	const open = findNextOpenTag(candidate, 0, REASONING_TAG_ALTERNATION);
	if (open?.start === 0) {
		const close = findNextCloseTag(
			candidate,
			open.end,
			REASONING_TAG_ALTERNATION,
		);
		return close ? candidate.slice(close.end).trim() : candidate;
	}
	// Close-only residue: a dangling close tag left by an earlier stripping pass
	// (the evaluator's `None</think>` repair, #20080). Only when no payload
	// opener precedes it — otherwise the close tag is inside the payload.
	const close = findNextCloseTag(candidate, 0, REASONING_TAG_ALTERNATION);
	if (close && !PAYLOAD_OPENER_RE.test(candidate.slice(0, close.start))) {
		return candidate.slice(close.end).trim();
	}
	return candidate;
}

function stripModelWrappers(raw: string): string {
	let candidate = stripReasoningPreamble(raw.trim());
	candidate = (
		unwrapWholeCodeFence(candidate, ["json", "json5"]) ?? candidate
	).trim();
	return candidate;
}

export function parseJsonModelOutput(raw: string): unknown | null {
	const candidate = stripModelWrappers(raw);
	if (candidate.length === 0) {
		return null;
	}
	try {
		return JSON.parse(candidate) as unknown;
	} catch {
		// error-policy:J3 model output is untrusted input; malformed JSON is an
		// explicit invalid parse result for the caller to handle.
		return null;
	}
}

export function parseJsonModelRecord<
	T extends Record<string, unknown> = Record<string, unknown>,
>(raw: string): T | null {
	const parsed = parseJsonModelOutput(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	return parsed as T;
}

export function parseJsonModelArray<T = unknown>(raw: string): T[] | null {
	const parsed = parseJsonModelOutput(raw);
	return Array.isArray(parsed) ? (parsed as T[]) : null;
}
