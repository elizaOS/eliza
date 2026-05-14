/**
 * Tokenizer client for the running llama-server.
 *
 * llama.cpp's `llama-server` exposes a `POST /tokenize` endpoint that runs
 * the loaded model's tokenizer over an input string and returns the token
 * id sequence. Token-tree construction (`./token-tree.ts`) needs this once
 * per (model, action_name) pair — the result is then cached so the trie
 * for a turn assembles in O(|active_actions|) ID array copies plus a single
 * /tokenize round-trip per cache miss (or a bulk one for cold-start).
 *
 * The class is intentionally small and decoupled from `DflashLlamaServer`:
 * the harness passes in the `baseUrl` (typically
 * `dflashLlamaServer["baseUrl"]` or the `LocalInferenceEngine`'s
 * `currentBaseUrl()` once that landing is finalised). Production callers
 * should wire it through whatever service holds the live llama-server
 * reference; tests instantiate with a stub `fetch`.
 *
 * Caching strategy
 * ----------------
 * Two layers:
 *   1. `tokenCache: Map<modelId, Map<text, number[]>>` — token-id arrays
 *      per (model, text) pair. Stable across turns; only invalidates on
 *      model swap (the loader calls `forgetModel(prevModelId)` on
 *      `unload()` / `load(newPath)`).
 *   2. The trie itself is NOT cached here — it's a per-turn assembly
 *      because the exposed-actions set varies per turn. The work that's
 *      stable across turns (the token-id arrays) is what we cache.
 *
 * Eviction: bounded by entry count, default 8 192 unique strings per
 * model — comfortably above the union of all action names + enum values
 * the agent could ever expose. Two-tier LRU is overkill at this size; we
 * just clear the per-model sub-map when it grows past the cap (the next
 * turn re-tokenizes; tolerable since /tokenize is fast).
 */

export interface TokenizerClientOptions {
	/**
	 * Override the default `fetch` for tests / streaming-buffer-pool reuse.
	 * Production passes the global.
	 */
	fetch?: typeof fetch;
	/** Per-call timeout. Defaults to 5 s — `/tokenize` is in-process for the
	 *  loaded model; anything over a few hundred ms means the server is
	 *  blocked on another decode. */
	timeoutMs?: number;
	/** Soft cap on cached entries per model before the per-model map is cleared. */
	maxEntriesPerModel?: number;
}

interface PerModelCache {
	tokens: Map<string, number[]>;
}

/** Bare-minimum shape of llama-server's `/tokenize` response. */
interface TokenizeResponseBody {
	tokens: number[];
}

export class TokenizerClient {
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly maxEntriesPerModel: number;
	private readonly cache = new Map<string, PerModelCache>();

	constructor(options: TokenizerClientOptions = {}) {
		this.fetchImpl = options.fetch ?? fetch;
		this.timeoutMs = options.timeoutMs ?? 5_000;
		this.maxEntriesPerModel = options.maxEntriesPerModel ?? 8_192;
	}

	/**
	 * Tokenize a single string against the model at `baseUrl` (`modelId` is
	 * the cache key — the URL alone isn't a stable identity because the
	 * same llama-server may load a different model later). Returns the
	 * cached array if present.
	 */
	async tokenize(
		modelId: string,
		baseUrl: string,
		text: string,
	): Promise<number[]> {
		const perModel = this.getOrCreateModelCache(modelId);
		const hit = perModel.tokens.get(text);
		if (hit) return hit;
		const ids = await this.fetchTokenize(baseUrl, text);
		// Re-check after the network round-trip — another concurrent caller
		// may have populated the same entry; keep the first to make repeat
		// reads pointer-stable.
		const winner = perModel.tokens.get(text);
		if (winner) return winner;
		perModel.tokens.set(text, ids);
		this.evictIfNeeded(modelId, perModel);
		return ids;
	}

	/**
	 * Tokenize a batch of strings. Cache hits return synchronously; misses
	 * are issued in parallel against `/tokenize`. The result is a Map
	 * keyed by the original input strings, with each value being the
	 * token-id array (always non-null — `/tokenize` is total on byte
	 * strings).
	 */
	async tokenizeMany(
		modelId: string,
		baseUrl: string,
		texts: ReadonlyArray<string>,
	): Promise<Map<string, number[]>> {
		const perModel = this.getOrCreateModelCache(modelId);
		const out = new Map<string, number[]>();
		const missing: string[] = [];
		const missingSeen = new Set<string>();
		for (const text of texts) {
			const hit = perModel.tokens.get(text);
			if (hit) {
				out.set(text, hit);
			} else if (!missingSeen.has(text)) {
				missingSeen.add(text);
				missing.push(text);
			}
		}
		if (missing.length > 0) {
			const fetched = await Promise.all(
				missing.map((text) =>
					this.fetchTokenize(baseUrl, text).then(
						(ids) => [text, ids] as const,
					),
				),
			);
			for (const [text, ids] of fetched) {
				const winner = perModel.tokens.get(text) ?? ids;
				if (!perModel.tokens.has(text)) perModel.tokens.set(text, winner);
				out.set(text, winner);
			}
			this.evictIfNeeded(modelId, perModel);
		}
		return out;
	}

	/**
	 * Drop the cached tokenizations for `modelId`. Call on model unload /
	 * swap — token ids are not portable across distillations even when the
	 * BPE vocabulary is nominally the same (special-token re-ordering /
	 * added tokens shift ids).
	 */
	forgetModel(modelId: string): void {
		this.cache.delete(modelId);
	}

	/** Test / diagnostic accessor. */
	cachedSize(modelId: string): number {
		return this.cache.get(modelId)?.tokens.size ?? 0;
	}

	private getOrCreateModelCache(modelId: string): PerModelCache {
		let entry = this.cache.get(modelId);
		if (!entry) {
			entry = { tokens: new Map() };
			this.cache.set(modelId, entry);
		}
		return entry;
	}

	private evictIfNeeded(modelId: string, perModel: PerModelCache): void {
		if (perModel.tokens.size <= this.maxEntriesPerModel) return;
		// Simplest eviction that satisfies the bound: clear the model's
		// per-text cache. Action / enum names will re-tokenize on the next
		// turn. A finer LRU is unnecessary at this scale (every realistic
		// agent stays well under the cap).
		perModel.tokens.clear();
	}

	private async fetchTokenize(
		baseUrl: string,
		text: string,
	): Promise<number[]> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await this.fetchImpl(`${baseUrl}/tokenize`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				// `add_special` defaults to false in llama.cpp's /tokenize and
				// that's what we want — action names / enum values are
				// midstream JSON string contents, never the start of a turn.
				body: JSON.stringify({ content: text }),
				signal: controller.signal,
			});
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new Error(
					`[tokenizer-client] HTTP ${res.status} from ${baseUrl}/tokenize${
						body ? `: ${body}` : ""
					}`,
				);
			}
			const json = (await res.json()) as TokenizeResponseBody;
			if (!Array.isArray(json.tokens)) {
				throw new Error(
					`[tokenizer-client] Unexpected /tokenize body shape (missing tokens[]): ${JSON.stringify(json)}`,
				);
			}
			// Defensive copy: callers may mutate (or we may hand the ref out
			// of the cache later). One small allocation per cold miss.
			return json.tokens.slice();
		} finally {
			clearTimeout(timer);
		}
	}
}

/**
 * Process-wide singleton — matches the pattern used by `dflashLlamaServer`
 * (one instance per process, multiple consumers). Tests should construct
 * their own `new TokenizerClient({...})` rather than reuse this.
 */
export const tokenizerClient = new TokenizerClient();
