/**
 * Bounded-concurrency map for fan-out over caller-controlled lists. A plain
 * `Promise.all(items.map(fn))` admits every element at once, so the input
 * length decides how many lookups run simultaneously; callers that resolve one
 * database row per item use this to keep that number fixed. Results keep the
 * input order, and the first rejection rejects the whole map after the
 * workers already in flight settle, matching `Promise.all` semantics closely
 * enough for callers that treat one failure as total.
 */

/**
 * Maps `items` through `fn` with at most `limit` calls in flight at once.
 * Returns results in input order. Throws a `RangeError` for a non-positive or
 * non-integer `limit`.
 */
export async function mapWithConcurrency<T, R>(
	items: ReadonlyArray<T>,
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (!Number.isInteger(limit) || limit < 1) {
		throw new RangeError(
			`mapWithConcurrency limit must be a positive integer (got ${String(limit)})`,
		);
	}
	const results: R[] = new Array(items.length);
	if (items.length === 0) {
		return results;
	}
	let nextIndex = 0;
	const state: { failure: { error: unknown } | null } = { failure: null };
	const worker = async (): Promise<void> => {
		while (state.failure === null) {
			// No await sits between the read and the increment, so each worker
			// claims a distinct index in the single-threaded loop.
			const index = nextIndex++;
			if (index >= items.length) {
				return;
			}
			try {
				results[index] = await fn(items[index], index);
			} catch (error) {
				// error-policy:J2 remember the first failure so the map rejects with it once in-flight workers settle
				if (state.failure === null) {
					state.failure = { error };
				}
				return;
			}
		}
	};
	const workers: Array<Promise<void>> = [];
	const workerCount = Math.min(limit, items.length);
	for (let i = 0; i < workerCount; i += 1) {
		workers.push(worker());
	}
	await Promise.all(workers);
	if (state.failure !== null) {
		throw state.failure.error;
	}
	return results;
}
