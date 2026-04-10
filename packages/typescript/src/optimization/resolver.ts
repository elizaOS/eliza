import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
	ArtifactFile,
	OptimizedPromptArtifact,
	PromptKey,
	SlotKey,
} from "./types.ts";

/**
 * Sanitize a model ID string for safe use as a filesystem directory name.
 * e.g. "gpt-4o-mini" -> "gpt-4o-mini", "llama3:24b" -> "llama3__24b"
 */
export function sanitizeModelId(modelId: string): string {
	return modelId
		.replace(/:/g, "__")
		.replace(/\//g, "_")
		.replace(/[^a-zA-Z0-9._\-]/g, "_");
}

/**
 * Result from resolveWithAB: the artifact entry and which variant was selected.
 */
export interface ResolvedArtifact {
	artifact: OptimizedPromptArtifact | null;
	/** "baseline" when no artifact exists or baseline variant was selected */
	selectedVariant: "baseline" | "optimized";
}

/**
 * PromptArtifactResolver manages reading and writing artifact.json files.
 *
 * WHY write-through LRU: artifact resolution happens on every DPE call (hot
 * path). Disk reads on every call would add 1-5ms latency. But disk must
 * remain the source of truth because artifacts can be modified externally
 * (CLI optimization, file copy between projects). Write-through ensures the
 * cache is always consistent with disk without requiring invalidation signals.
 *
 * WHY JS Map as LRU: Map preserves insertion order. Delete+re-insert on read
 * moves the entry to the end, giving us LRU eviction by deleting the first
 * key. No external LRU library needed.
 */
export class PromptArtifactResolver {
	private readonly rootDir: string;
	/** In-memory cache: "modelId/slotKey" -> ArtifactFile */
	private readonly cache = new Map<string, ArtifactFile>();
	private readonly MAX_CACHE_ENTRIES = 200;
	/** WHY a counter instead of Date.now(): Date.now() % N is non-deterministic
	 *  and makes debugging impossible. A monotonic counter ensures reproducible
	 *  A/B assignment while still distributing traffic evenly. */
	private abCounter = 0;
	/** Per-path write serialization to prevent read-modify-write races */
	private readonly writeLocks = new Map<string, Promise<void>>();

	/** Run fn under a per-key serial lock so concurrent writes don't interleave */
	private async withWriteLock(key: string, fn: () => Promise<void>): Promise<void> {
		const prev = this.writeLocks.get(key) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		this.writeLocks.set(key, next);
		await next;
	}

	constructor(rootDir: string) {
		this.rootDir = rootDir;
	}

	getArtifactDir(modelId: string, slotKey: SlotKey): string {
		return join(this.rootDir, sanitizeModelId(modelId), slotKey);
	}

	private getArtifactPath(modelId: string, slotKey: SlotKey): string {
		return join(this.getArtifactDir(modelId, slotKey), "artifact.json");
	}

	private cacheKey(modelId: string, slotKey: SlotKey): string {
		return `${sanitizeModelId(modelId)}/${slotKey}`;
	}

	private evictIfNeeded(): void {
		if (this.cache.size >= this.MAX_CACHE_ENTRIES) {
			// Evict the first (oldest) entry
			const firstKey = this.cache.keys().next().value;
			if (firstKey) this.cache.delete(firstKey);
		}
	}

	/** Load artifact file from disk (no cache) */
	private async loadFromDisk(
		modelId: string,
		slotKey: SlotKey,
	): Promise<ArtifactFile | null> {
		const path = this.getArtifactPath(modelId, slotKey);
		let content: string;
		try {
			content = await readFile(path, "utf-8");
		} catch {
			return null; // File doesn't exist
		}
		try {
			return JSON.parse(content) as ArtifactFile;
		} catch {
			return null; // Corrupt JSON — return null rather than overwriting blindly
		}
	}

	/** Get artifact file from cache or disk */
	private async getArtifactFile(
		modelId: string,
		slotKey: SlotKey,
	): Promise<ArtifactFile | null> {
		const key = this.cacheKey(modelId, slotKey);
		if (this.cache.has(key)) {
			// Refresh LRU position: delete + re-insert moves key to end of Map
			const cached = this.cache.get(key)!;
			this.cache.delete(key);
			this.cache.set(key, cached);
			return cached;
		}
		const file = await this.loadFromDisk(modelId, slotKey);
		if (file) {
			this.evictIfNeeded();
			this.cache.set(key, file);
		}
		return file;
	}

	/**
	 * Resolve an artifact entry for a given model/slot/promptKey.
	 * Returns null if no artifact exists for this key.
	 */
	async resolve(
		modelId: string,
		slotKey: SlotKey,
		promptKey: PromptKey,
	): Promise<OptimizedPromptArtifact | null> {
		const file = await this.getArtifactFile(modelId, slotKey);
		return file?.[promptKey] ?? null;
	}

	/**
	 * Resolve with A/B variant selection.
	 *
	 * Variant selection uses deterministic hashing based on the promptKey + a
	 * random-ish selector so the same call site consistently gets the same
	 * variant within a session, but traffic is split across many calls.
	 */
	async resolveWithAB(
		modelId: string,
		slotKey: SlotKey,
		promptKey: PromptKey,
		/** Optional seed for deterministic testing */
		abSeed?: number,
	): Promise<ResolvedArtifact> {
		const artifact = await this.resolve(modelId, slotKey, promptKey);
		if (!artifact) {
			return { artifact: null, selectedVariant: "baseline" };
		}

		const { trafficSplit } = artifact.abConfig;

		// Fully promoted (trafficSplit = 1.0) -> always optimized
		if (trafficSplit >= 1.0) {
			return { artifact, selectedVariant: "optimized" };
		}
		// Fully rolled back (trafficSplit = 0.0) -> always baseline
		if (trafficSplit <= 0.0) {
			return { artifact, selectedVariant: "baseline" };
		}

		// Deterministic split using hash of promptKey + seed.
		// When no external seed is provided we use an internal counter so that
		// traffic is spread across calls without relying on wall-clock time.
		const seed = abSeed ?? this.abCounter++;
		const hash = simpleHash(`${promptKey}:${seed}`);
		const selectedVariant =
			hash % 10000 < Math.round(trafficSplit * 10000) ? "optimized" : "baseline";

		return { artifact, selectedVariant };
	}

	/**
	 * Write an artifact entry to disk and update the cache.
	 * Serialized per model/slot path to prevent read-modify-write races.
	 */
	async writeArtifact(
		modelId: string,
		slotKey: SlotKey,
		promptKey: PromptKey,
		artifact: OptimizedPromptArtifact,
	): Promise<void> {
		const lockKey = this.cacheKey(modelId, slotKey);
		await this.withWriteLock(lockKey, async () => {
			const dir = this.getArtifactDir(modelId, slotKey);
			await mkdir(dir, { recursive: true });

			const path = this.getArtifactPath(modelId, slotKey);

			// Read existing file to merge (don't overwrite other prompt keys).
			// Only ignore ENOENT (file doesn't exist); rethrow permission errors,
			// corrupt JSON, or any other unexpected I/O failure.
			let existing: ArtifactFile = {};
			try {
				const content = await readFile(path, "utf-8");
				existing = JSON.parse(content) as ArtifactFile;
			} catch (err: unknown) {
				const isNotFound =
					err instanceof Error &&
					"code" in err &&
					(err as NodeJS.ErrnoException).code === "ENOENT";
				if (!isNotFound) {
					throw err;
				}
			}

			const updated: ArtifactFile = { ...existing, [promptKey]: artifact };
			await writeFile(path, JSON.stringify(updated, null, 2), "utf-8");

			const key = this.cacheKey(modelId, slotKey);
			// Refresh LRU position: delete first so re-insert moves to end
			this.cache.delete(key);
			this.evictIfNeeded();
			this.cache.set(key, updated);
		});
	}

	/** Invalidate in-memory cache for a specific model/slot */
	invalidate(modelId: string, slotKey: SlotKey): void {
		this.cache.delete(this.cacheKey(modelId, slotKey));
	}

	/** Force a fresh read from disk on next resolve */
	invalidateAll(): void {
		this.cache.clear();
	}
}

/** Simple djb2-style hash for deterministic A/B split */
function simpleHash(str: string): number {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) {
		hash = (hash * 33) ^ str.charCodeAt(i);
	}
	return Math.abs(hash);
}
