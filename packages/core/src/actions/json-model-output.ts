/**
 * Lenient JSON parsing for model output. Strips a leading private-reasoning
 * preamble and a ```json / ```json5 code fence, then `JSON.parse`s the
 * remainder — returning `null` rather than throwing on any failure.
 * `parseJsonModelRecord` / `parseJsonModelArray` add shape guards for the common
 * object / array cases.
 */

import { unwrapWholeCodeFence } from "../markdown/code.ts";
import {
	findNextCloseTag,
	findNextOpenTag,
	REASONING_TAG_NAMES,
} from "../utils/reasoning-tags.ts";

const REASONING_TAG_ALTERNATION = REASONING_TAG_NAMES.join("|");

/**
 * Drop a reasoning block only when the candidate OPENS with one (any shared
 * reasoning tag name, any case). A candidate starting with `<` cannot be a
 * JSON value, so this never rewrites a payload; reasoning markup elsewhere is
 * ordinary string data and is left untouched. An unclosed block is kept so
 * the parse fails closed.
 */
function stripReasoningPreamble(candidate: string): string {
	const open = findNextOpenTag(candidate, 0, REASONING_TAG_ALTERNATION);
	if (open?.start !== 0) return candidate;
	const close = findNextCloseTag(
		candidate,
		open.end,
		REASONING_TAG_ALTERNATION,
	);
	return close ? candidate.slice(close.end).trim() : candidate;
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
