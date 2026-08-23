/**
 * Lightweight scored-view comparators — pure, no heavy deps.
 * Extracted so regression tests can import without pulling @elizaos/core
 * (which transitively imports @noble/hashes). Guards remain defensive:
 * scores are normally literal integers but Number.isFinite treats any
 * unexpected Infinity/NaN as 0 so sort never returns NaN.
 */

export function compareScoredView(
	a: { view: { id: string }; score: number },
	b: { view: { id: string }; score: number },
): number {
	const bS =
		typeof b.score === "number" && Number.isFinite(b.score) ? b.score : 0;
	const aS =
		typeof a.score === "number" && Number.isFinite(a.score) ? a.score : 0;
	if (bS !== aS) return bS - aS;
	return String(a.view.id).localeCompare(String(b.view.id));
}

export function compareScoredViewShow(
	a: { view: { id: string }; score: number },
	b: { view: { id: string }; score: number },
): number {
	const bS =
		typeof b.score === "number" && Number.isFinite(b.score) ? b.score : 0;
	const aS =
		typeof a.score === "number" && Number.isFinite(a.score) ? a.score : 0;
	if (bS !== aS) return bS - aS;
	return String(a.view.id).localeCompare(String(b.view.id));
}

export function compareCandidateScore(
	a: { candidate: { id: string }; score: number },
	b: { candidate: { id: string }; score: number },
): number {
	const bS =
		typeof b.score === "number" && Number.isFinite(b.score) ? b.score : 0;
	const aS =
		typeof a.score === "number" && Number.isFinite(a.score) ? a.score : 0;
	if (bS !== aS) return bS - aS;
	return String(a.candidate.id).localeCompare(String(b.candidate.id));
}

export function compareScoredViewClose(
	a: { view: { id: string }; score: number },
	b: { view: { id: string }; score: number },
): number {
	const bS =
		typeof b.score === "number" && Number.isFinite(b.score) ? b.score : 0;
	const aS =
		typeof a.score === "number" && Number.isFinite(a.score) ? a.score : 0;
	if (bS !== aS) return bS - aS;
	return String(a.view.id).localeCompare(String(b.view.id));
}

export const __testCompareScoredView = compareScoredView;
export const __testCompareScoredViewShow = compareScoredViewShow;
export const __testCompareCandidateScore = compareCandidateScore;
export const __testCompareScoredViewClose = compareScoredViewClose;
