/**
 * Bounded-concurrency map for fan-out over caller-controlled lists. A plain
 * `Promise.all(items.map(fn))` admits every element at once, so the input
 * length decides how many lookups run simultaneously; callers that resolve one
 * database row per item use this to keep that number fixed. Results keep the
 * input order. The first rejection rejects the map immediately and stops
 * further admission, matching `Promise.all`'s prompt failure; items already in
 * flight run to completion and their outcomes are dropped.
 */

/**
 * Maps `items` through `fn` with at most `limit` calls in flight at once.
 * Returns results in input order. Throws a `RangeError` for a non-positive or
 * non-integer `limit`.
 */
export function mapWithConcurrency<T, R>(
	items: ReadonlyArray<T>,
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (!Number.isInteger(limit) || limit < 1) {
		return Promise.reject(
			new RangeError(
				`mapWithConcurrency limit must be a positive integer (got ${String(limit)})`,
			),
		);
	}
	const results: R[] = new Array(items.length);
	if (items.length === 0) {
		return Promise.resolve(results);
	}
	return new Promise<R[]>((resolve, reject) => {
		let nextIndex = 0;
		let inFlight = 0;
		let settled = false;

		const fail = (error: unknown): void => {
			if (settled) {
				// error-policy:J5 the map already rejected with the first failure;
				// a later rejection from an item admitted before it is observed
				// here and dropped so it cannot surface as an unhandled rejection.
				return;
			}
			settled = true;
			reject(error);
		};

		const admit = (): void => {
			while (!settled && inFlight < limit && nextIndex < items.length) {
				const index = nextIndex++;
				inFlight += 1;
				let pending: Promise<R>;
				try {
					pending = fn(items[index], index);
				} catch (error) {
					inFlight -= 1;
					fail(error);
					return;
				}
				pending.then(
					(value) => {
						inFlight -= 1;
						if (settled) return;
						results[index] = value;
						if (nextIndex >= items.length && inFlight === 0) {
							settled = true;
							resolve(results);
							return;
						}
						admit();
					},
					(error: unknown) => {
						inFlight -= 1;
						fail(error);
					},
				);
			}
		};

		admit();
	});
}
