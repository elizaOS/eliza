/**
 * Choose how many items to include so estimated character total stays within a
 * target budget.
 *
 * WHY: Providers often fetch a superset of data, then need to keep prompt size
 * bounded. One fetch + in-memory selection avoids extra DB round trips while
 * still adapting to item size (short items -> more fit, long items -> fewer).
 *
 * @throws {RangeError} When `estimateChars` returns a negative or non-finite
 *   value, because treating a broken estimate as free would violate the budget.
 */

export function sliceToFitBudget<T>(
	items: T[],
	estimateChars: (item: T) => number,
	targetChars: number,
	options?: { fromEnd?: boolean },
): T[] {
	if (items.length === 0) return [];
	// Zero, negative, or non-finite budget means no room - return empty array
	if (!Number.isFinite(targetChars) || targetChars <= 0) return [];

	const fromEnd = options?.fromEnd ?? false;
	let total = 0;
	let count = 0;

	// Calculate all sizes upfront to avoid double estimation
	const sizes = items.map((item) => {
		const size = estimateChars(item);
		if (!Number.isFinite(size) || size < 0) {
			throw new RangeError(
				"estimateChars must return a non-negative finite number",
			);
		}
		return size;
	});

	if (fromEnd) {
		for (let index = items.length - 1; index >= 0; index--) {
			if (total + sizes[index] > targetChars) break;
			total += sizes[index];
			count++;
		}
		return items.slice(items.length - count);
	}

	for (; count < items.length; count++) {
		if (total + sizes[count] > targetChars) break;
		total += sizes[count];
	}

	return items.slice(0, count);
}
