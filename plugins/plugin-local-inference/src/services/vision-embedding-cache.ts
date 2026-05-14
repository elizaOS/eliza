/**
 * Content-hashed cache for projected vision-language tokens (WS1 deliverable).
 *
 * Vision models in the Eliza-1 stack (Qwen3-VL, Florence-2, future
 * Apothic-VL) all go through the same expensive projector step: raw pixel
 * bytes → patch embeddings → projector → tokens that the text decoder
 * actually consumes. When the user pastes the same screenshot three times
 * in a row, or when computer-use takes near-duplicate frames of an idle
 * screen, we want to skip the projector entirely and reuse the cached
 * tokens.
 *
 * Contract:
 *   - Caller computes a stable hash of the *normalized* input bytes
 *     (downscaled to the model's input resolution, then SHA-256 of the
 *     packed pixels). The hash is the cache key.
 *   - Caller pairs the hash with the projected token tensor (a flat
 *     `Float32Array` of length `tokens * hiddenSize`) AND the geometry
 *     `{ tokens, hiddenSize }` so a reader can reshape on the way out.
 *   - `get(hash)` returns `null` on miss or expiry, the entry on hit.
 *     A hit also "touches" the entry to keep it warm under LRU.
 *   - `set(hash, entry, ttlMs?)` inserts with a TTL (default 5 min); if
 *     the LRU is full, the coldest entry is evicted.
 *
 * Why a separate module:
 *   - The arbiter owns the *model handle*; the cache holds *per-input
 *     projected weights* that survive across model loads/unloads of the
 *     same family. Keeping the cache in a sibling module lets the vision
 *     plugin reuse it even when the arbiter swapped the underlying model
 *     for memory pressure (the projector tokens are still valid as long
 *     as the model family + hash match — we encode the family in the key
 *     to be safe).
 *
 * What this is NOT:
 *   - A blob cache for the encoder *weights*. Those live in mmap regions
 *     owned by the arbiter / SharedResourceRegistry and are evicted via
 *     `MmapRegionHandle.evictPages()`.
 *   - A cache for downstream LLM generations. Prefix-cache for text is
 *     handled by `cache-bridge.ts` and the backend session pool.
 */

interface CacheEntry {
	tokens: Float32Array;
	tokenCount: number;
	hiddenSize: number;
	expiresAtMs: number;
}

export interface VisionEmbeddingEntry {
	/** Flat row-major buffer: `tokenCount * hiddenSize` floats. */
	tokens: Float32Array;
	tokenCount: number;
	hiddenSize: number;
	/** True when this entry is still within its TTL. */
	live: boolean;
}

export interface VisionEmbeddingCacheConfig {
	/** Max entries retained. LRU evicts beyond this. Default 32. */
	maxEntries: number;
	/** Default TTL when `set()` is called without one. Default 5 min. */
	defaultTtlMs: number;
}

const DEFAULTS: VisionEmbeddingCacheConfig = {
	maxEntries: 32,
	defaultTtlMs: 5 * 60_000,
};

export class VisionEmbeddingCache {
	private readonly config: VisionEmbeddingCacheConfig;
	/**
	 * `Map` preserves insertion order; we re-insert on hit to bubble entries
	 * to the back, so the first key in iteration order is the LRU candidate.
	 */
	private readonly entries = new Map<string, CacheEntry>();
	private readonly now: () => number;

	constructor(opts: { config?: Partial<VisionEmbeddingCacheConfig>; now?: () => number } = {}) {
		this.config = {
			maxEntries: Math.max(1, opts.config?.maxEntries ?? DEFAULTS.maxEntries),
			defaultTtlMs: Math.max(0, opts.config?.defaultTtlMs ?? DEFAULTS.defaultTtlMs),
		};
		this.now = opts.now ?? (() => Date.now());
	}

	/**
	 * Lookup. Returns the entry on hit (and refreshes LRU position), or null
	 * on miss / expiry. Expired entries are deleted on read so they don't
	 * silently consume the LRU budget.
	 */
	get(hash: string): VisionEmbeddingEntry | null {
		const found = this.entries.get(hash);
		if (!found) return null;
		if (found.expiresAtMs <= this.now()) {
			this.entries.delete(hash);
			return null;
		}
		// Touch — re-insert so it moves to the back of the iteration order.
		this.entries.delete(hash);
		this.entries.set(hash, found);
		return {
			tokens: found.tokens,
			tokenCount: found.tokenCount,
			hiddenSize: found.hiddenSize,
			live: true,
		};
	}

	/**
	 * Insert. Replaces any existing entry under the same hash. Evicts the
	 * coldest entry if we're at capacity. `ttlMs` overrides the configured
	 * default; pass 0 to use the default.
	 */
	set(
		hash: string,
		entry: { tokens: Float32Array; tokenCount: number; hiddenSize: number },
		ttlMs?: number,
	): void {
		if (entry.tokens.length !== entry.tokenCount * entry.hiddenSize) {
			throw new Error(
				`[vision-embedding-cache] token buffer length ${entry.tokens.length} does not match tokenCount*hiddenSize (${entry.tokenCount}*${entry.hiddenSize})`,
			);
		}
		const ttl = ttlMs && ttlMs > 0 ? ttlMs : this.config.defaultTtlMs;
		const expiresAtMs = this.now() + ttl;
		this.entries.delete(hash);
		this.entries.set(hash, {
			tokens: entry.tokens,
			tokenCount: entry.tokenCount,
			hiddenSize: entry.hiddenSize,
			expiresAtMs,
		});
		while (this.entries.size > this.config.maxEntries) {
			const firstKey = this.entries.keys().next().value;
			if (firstKey === undefined) break;
			this.entries.delete(firstKey);
		}
	}

	/** Diagnostic: current entry count. */
	size(): number {
		return this.entries.size;
	}

	/** Diagnostic: snapshot of (hash, byteSize, expiresAtMs) for each entry. */
	snapshot(): ReadonlyArray<{ hash: string; bytes: number; expiresAtMs: number }> {
		const out: { hash: string; bytes: number; expiresAtMs: number }[] = [];
		for (const [hash, entry] of this.entries) {
			out.push({
				hash,
				bytes: entry.tokens.byteLength,
				expiresAtMs: entry.expiresAtMs,
			});
		}
		return out;
	}

	/** Drop everything. Cheap; only releases JS-side refs to the Float32Arrays. */
	clear(): void {
		this.entries.clear();
	}

	/**
	 * Drop entries whose TTL has expired. Returns the number removed. Cheap
	 * to call from the arbiter's pressure tick.
	 */
	purgeExpired(nowMs: number = this.now()): number {
		let removed = 0;
		for (const [hash, entry] of this.entries) {
			if (entry.expiresAtMs <= nowMs) {
				this.entries.delete(hash);
				removed++;
			}
		}
		return removed;
	}
}
