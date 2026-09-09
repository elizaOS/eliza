/** Lossless caller-requested historical evidence pages, scoped by the caller's
 * authoritative room read. A page never splits a source or silently clips it. */
import { ElizaError } from "../errors.ts";
import type { Memory } from "../types/index.ts";

export const DEFAULT_MEMORY_EVIDENCE_BATCH_BYTES = 65_536;

export function previousEvidencePage(
	messages: readonly Memory[],
	beforeMessageId: string,
	maxBytes: number,
): { messages: Memory[]; hasEarlier: boolean } {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
		throw new ElizaError("Evidence page requires a positive byte budget", {
			code: "EVALUATOR_BATCH_LIMIT_INVALID",
		});
	const ordered = [...messages].sort(
		(left, right) =>
			(left.createdAt ?? 0) - (right.createdAt ?? 0) ||
			String(left.id).localeCompare(String(right.id)),
	);
	const end = ordered.findIndex((message) => message.id === beforeMessageId);
	if (end < 0)
		throw new ElizaError("Evidence cursor is outside this room snapshot", {
			code: "EVALUATOR_REFERENCE_CURSOR_INVALID",
		});
	let start = end;
	let bytes = 0;
	while (start > 0) {
		const size = new TextEncoder().encode(
			JSON.stringify(ordered[start - 1]),
		).byteLength;
		if (size > maxBytes && start === end)
			throw new ElizaError(
				"One complete reference record exceeds the evidence page budget",
				{ code: "EVALUATOR_SOURCE_TOO_LARGE" },
			);
		if (bytes + size > maxBytes) break;
		bytes += size;
		start--;
	}
	return {
		messages: structuredClone(ordered.slice(start, end)),
		hasEarlier: start > 0,
	};
}
