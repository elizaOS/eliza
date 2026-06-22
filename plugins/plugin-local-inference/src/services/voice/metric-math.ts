/**
 * Pure rounding + percentile helpers shared by the voice E2E harness and the
 * voice workbench report (#8785). No models, filesystem, or network — just
 * numeric formatting so both consumers report identical metric values.
 */

export function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

export function round4(value: number): number {
	return Math.round(value * 1e4) / 1e4;
}

/** Nearest-rank percentile over a sample (null when empty), non-finite filtered. */
export function percentile(
	values: ReadonlyArray<number>,
	p: number,
): number | null {
	const finite = values.filter((v) => Number.isFinite(v));
	if (finite.length === 0) return null;
	const sorted = [...finite].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	return round1(sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]);
}
