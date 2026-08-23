/**
 * Lightweight document sorting comparators.
 * Extracted from DocumentService so regression tests can import them without
 * pulling the heavy service graph (provider-integrations → @noble/hashes).
 * Keeps Number.isFinite guards defensive; the filters in the service make them
 * effectively unreachable today but they fail safe if upstream changes.
 */

export function compareDocumentBySimilarity(
	a: { id?: string; similarity: number },
	b: { id?: string; similarity: number },
): number {
	const bS =
		typeof b.similarity === "number" && Number.isFinite(b.similarity)
			? b.similarity
			: 0;
	const aS =
		typeof a.similarity === "number" && Number.isFinite(a.similarity)
			? a.similarity
			: 0;
	if (bS !== aS) return bS - aS;
	return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

export function compareDocumentByCreatedAt(
	a: { id?: string; createdAt?: number },
	b: { id?: string; createdAt?: number },
): number {
	const bT =
		typeof b.createdAt === "number" && Number.isFinite(b.createdAt)
			? b.createdAt
			: 0;
	const aT =
		typeof a.createdAt === "number" && Number.isFinite(a.createdAt)
			? a.createdAt
			: 0;
	if (bT !== aT) return bT - aT;
	return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

export const __testCompareDocumentBySimilarity = compareDocumentBySimilarity;
export const __testCompareDocumentByCreatedAt = compareDocumentByCreatedAt;
