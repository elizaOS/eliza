/**
 * Short-TTL, in-flight-shared read memo backing the runtime's turn-scoped DB
 * read coalescing (getRoom and the room messages-scan). A Stage-1 compose
 * fans ~12 providers out concurrently and several of them issue the same
 * room/messages queries; on a single-threaded store (PGlite WASM) those
 * duplicates serialize and their latencies add up rather than overlap, so
 * collapsing N identical reads into one round-trip directly shrinks the
 * composeState wall. The stored value is the promise, so concurrent callers
 * within one compose share a single in-flight query even before the TTL
 * matters (same shipped pattern as identity-clusters.ts); a rejected fetch
 * self-evicts so failures are retried, never cached. `meta` carries
 * fetch-shape bookkeeping (e.g. the fetched window size) so a caller can
 * decide whether a live entry is a superset of what it needs.
 *
 * Correctness leans on invalidation, not the TTL: AgentRuntime busts the
 * relevant key inside every mutation wrapper (createMemory/updateRooms/…).
 * The TTL only bounds staleness from writers outside this process.
 */
export class SingleFlightMemo<V, Meta = undefined> {
	private readonly entries = new Map<
		string,
		{ at: number; meta: Meta; promise: Promise<V> }
	>();

	constructor(
		private readonly ttlMs: number,
		private readonly maxEntries: number,
	) {}

	/** The live (unexpired) entry for `key`, or null. Never triggers a fetch. */
	peek(key: string): { meta: Meta; promise: Promise<V> } | null {
		const entry = this.entries.get(key);
		if (!entry || Date.now() - entry.at >= this.ttlMs) return null;
		return entry;
	}

	/**
	 * Store an in-flight fetch under `key`, replacing any existing entry. The
	 * promise is returned unchanged so callers can `return memo.put(...)`.
	 */
	put(key: string, meta: Meta, promise: Promise<V>): Promise<V> {
		// error-policy:J5 The unchanged promise is returned to every caller; this
		// observer only evicts a rejected single-flight entry so it can be retried.
		promise.catch(() => {
			// Evict only if this promise is still the resident entry — a newer
			// fetch stored after invalidation must not be dropped by an old
			// rejection arriving late.
			if (this.entries.get(key)?.promise === promise) {
				this.entries.delete(key);
			}
		});
		if (this.entries.size >= this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
		this.entries.set(key, { at: Date.now(), meta, promise });
		return promise;
	}

	/** Drop one key, or every entry when called without a key. */
	invalidate(key?: string): void {
		if (key === undefined) {
			this.entries.clear();
			return;
		}
		this.entries.delete(key);
	}
}
