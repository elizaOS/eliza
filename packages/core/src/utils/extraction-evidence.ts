/** Shared read-side rule for retired inference evidence. Explicit/manual facts
 * remain authoritative independently of a conversational extractor's receipts. */
import { isObjectRecord } from "./type-guards.ts";

export function isProtectedMemoryEvidence(memory: {
	source?: unknown;
	metadata?: unknown;
	content?: unknown;
}): boolean {
	const metadata = isObjectRecord(memory.metadata) ? memory.metadata : {};
	const content = isObjectRecord(memory.content) ? memory.content : {};
	return (
		memory.source === "MEMORY" ||
		metadata.source === "MEMORY" ||
		content.source === "MEMORY" ||
		metadata.verificationStatus === "confirmed"
	);
}

export function isActiveMemoryEvidence(memory: {
	source?: unknown;
	metadata?: unknown;
	content?: unknown;
}): boolean {
	if (isProtectedMemoryEvidence(memory)) return true;
	const metadata = isObjectRecord(memory.metadata) ? memory.metadata : {};
	return (
		metadata.extractionStatus !== "source_invalidated" &&
		metadata.extractionReviewRequired !== true
	);
}
