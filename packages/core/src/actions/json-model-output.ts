/**
 * Lenient JSON parsing for model output. Strips a leading `<think>…</think>`
 * reasoning preamble and a ```json / ```json5 code fence, then `JSON.parse`s the
 * remainder — returning `null` rather than throwing on any failure.
 * `parseJsonModelRecord` / `parseJsonModelArray` add shape guards for the common
 * object / array cases.
 */
import { unwrapWholeCodeFence } from "../utils/code-fence.ts";

function stripModelWrappers(raw: string): string {
	let candidate = raw.trim();
	const thinkEnd = candidate.indexOf("</think>");
	if (candidate.startsWith("<think>") && thinkEnd !== -1) {
		candidate = candidate.slice(thinkEnd + "</think>".length).trim();
	}
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
