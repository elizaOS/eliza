import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeModelId } from "./resolver.ts";
import { ScoreCard } from "./score-card.ts";
import type {
	ExecutionTrace,
	PromptKey,
	SlotKey,
	SlotProfile,
} from "./types.ts";
import { SLOT_PROFILE_DEFAULTS } from "./types.ts";

/** Sanitize a prompt key for safe use in filenames */
function sanitizePromptKey(key: string): string {
	return key
		.replace(/\//g, "_")
		.replace(/\.\./g, "__")
		.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Manages per-slot statistics and re-optimization triggers.
 *
 * WHY incremental stats (lerp) instead of recomputing from traces: traces can
 * number in the thousands. Recomputing averages on every new trace would
 * require loading the full history. Incremental running averages (O(1) per
 * trace) keep `recordTrace` cheap enough for fire-and-forget use.
 *
 * WHY a separate profile file per prompt key: slot profiles are read/written
 * frequently (every trace). Storing all prompts in one file would create write
 * contention and make partial reads impossible.
 */
export class SlotProfileManager {
	private readonly rootDir: string;
	private readonly profiles = new Map<string, SlotProfile>();
	/** Per-slot latency samples for p95 computation, keyed by profileKey */
	private readonly latencySamples = new Map<string, number[]>();
	private readonly SCORE_HISTOGRAM_BUCKETS = 10;
	/** Per-key write serialization to prevent concurrent persist races */
	private readonly writeLocks = new Map<string, Promise<void>>();
	private readonly signalWeights?: Record<string, number>;

	constructor(rootDir: string, signalWeights?: Record<string, number>) {
		this.rootDir = rootDir;
		this.signalWeights = signalWeights;
	}

	private async withWriteLock(
		key: string,
		fn: () => Promise<void>,
	): Promise<void> {
		const prev = this.writeLocks.get(key) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		this.writeLocks.set(key, next);
		await next;
	}

	private profileKey(
		modelId: string,
		slotKey: SlotKey,
		promptKey: PromptKey,
	): string {
		return `${sanitizeModelId(modelId)}/${slotKey}/${promptKey}`;
	}

	/**
	 * Drop cached profile + latency samples for this key so the next `get()`
	 * reads from disk.
	 *
	 * **Why:** `OptimizationRunner` uses its own `SlotProfileManager` for
	 * `markOptimized`; the hot-path singleton would otherwise keep stale
	 * `needsReoptimization` and run auto-opt repeatedly per RUN_ENDED trace.
	 */
	invalidateCachedProfile(
		modelId: string,
		slotKey: SlotKey,
		promptKey: PromptKey,
	): void {
		const pKey = this.profileKey(modelId, slotKey, promptKey);
		this.profiles.delete(pKey);
		this.latencySamples.delete(pKey);
	}

	private getProfilePath(
		modelId: string,
		slotKey: SlotKey,
		promptKey: PromptKey,
	): string {
		return join(
			this.rootDir,
			sanitizeModelId(modelId),
			slotKey,
			`profile_${sanitizePromptKey(promptKey)}.json`,
		);
	}

	private emptyProfile(
		modelId: string,
		modelSlot: SlotKey,
		promptKey: PromptKey,
	): SlotProfile {
		return {
			modelId,
			modelSlot,
			promptKey,
			stats: {
				totalTraces: 0,
				successRate: 0,
				avgCompositeScore: 0,
				avgLatencyMs: 0,
				avgTokenEstimate: 0,
				p95LatencyMs: 0,
				scoreDistribution: new Array(this.SCORE_HISTOGRAM_BUCKETS).fill(0),
				signalAverages: {},
			},
			optimization: {
				currentArtifactVersion: null,
				lastOptimizedAt: null,
				lastScore: null,
				optimizationCount: 0,
				tracesSinceLastOptimization: 0,
				needsReoptimization: false,
			},
			updatedAt: Date.now(),
		};
	}

	async get(
		modelId: string,
		slotKey: SlotKey,
		promptKey: PromptKey,
	): Promise<SlotProfile> {
		const key = this.profileKey(modelId, slotKey, promptKey);
		if (this.profiles.has(key)) {
			return this.profiles.get(key)!;
		}
		// Try loading from disk
		const path = this.getProfilePath(modelId, slotKey, promptKey);
		try {
			const content = await readFile(path, "utf-8");
			const profile = JSON.parse(content) as SlotProfile;
			this.profiles.set(key, profile);
			return profile;
		} catch {
			const profile = this.emptyProfile(modelId, slotKey, promptKey);
			this.profiles.set(key, profile);
			return profile;
		}
	}

	/**
	 * Update profile stats with a new trace and persist under the write lock.
	 *
	 * **Why `await withWriteLock`?** Callers (e.g. RUN_ENDED finalizer) chain
	 * `maybeRunAutoPromptOptimization` after `recordTrace`; the profile row and
	 * `needsReoptimization` must be flushed before that read or auto-opt races
	 * and sees stale counts.
	 */
	async recordTrace(
		modelId: string,
		slotKey: SlotKey,
		promptKey: PromptKey,
		trace: ExecutionTrace,
	): Promise<void> {
		const pKey = this.profileKey(modelId, slotKey, promptKey);

		// Both in-memory mutation and disk persist happen inside the lock
		// to prevent concurrent recordTrace calls from clobbering each other.
		await this.withWriteLock(pKey, async () => {
			const profile = await this.get(modelId, slotKey, promptKey);

			const n = profile.stats.totalTraces;
			const compositeScore = ScoreCard.fromJSON(trace.scoreCard).composite(
				this.signalWeights,
			);

			profile.stats.totalTraces = n + 1;
			profile.stats.successRate = lerp(
				profile.stats.successRate,
				trace.parseSuccess ? 1 : 0,
				n,
			);
			profile.stats.avgCompositeScore = lerp(
				profile.stats.avgCompositeScore,
				compositeScore,
				n,
			);
			profile.stats.avgLatencyMs = lerp(
				profile.stats.avgLatencyMs,
				trace.latencyMs,
				n,
			);
			profile.stats.avgTokenEstimate = lerp(
				profile.stats.avgTokenEstimate,
				trace.tokenEstimate,
				n,
			);

			const bucket = Math.min(
				Math.floor(compositeScore * this.SCORE_HISTOGRAM_BUCKETS),
				this.SCORE_HISTOGRAM_BUCKETS - 1,
			);
			profile.stats.scoreDistribution[bucket]++;

			for (const signal of trace.scoreCard.signals) {
				const sigKey = `${signal.source}:${signal.kind}`;
				if (sigKey in profile.stats.signalAverages) {
					profile.stats.signalAverages[sigKey] = lerp(
						profile.stats.signalAverages[sigKey],
						signal.value,
						n,
					);
				} else {
					profile.stats.signalAverages[sigKey] = signal.value;
				}
			}

			if (!this.latencySamples.has(pKey)) {
				this.latencySamples.set(pKey, []);
			}
			const slotLatencies = this.latencySamples.get(pKey)!;
			slotLatencies.push(trace.latencyMs);
			if (slotLatencies.length > 1000) {
				slotLatencies.shift();
			}
			const sorted = [...slotLatencies].sort((a, b) => a - b);
			const p95idx = Math.floor(sorted.length * 0.95);
			profile.stats.p95LatencyMs = sorted[p95idx] ?? trace.latencyMs;

			profile.optimization.tracesSinceLastOptimization++;
			profile.optimization.needsReoptimization = this.shouldReoptimize(profile);
			profile.updatedAt = Date.now();

			await this.persist(modelId, slotKey, promptKey, profile);
		});
	}

	/** Determine if a slot needs re-optimization */
	shouldReoptimize(profile: SlotProfile): boolean {
		const opt = profile.optimization;
		const stats = profile.stats;

		// First optimization: need enough traces to bootstrap an artifact
		if (opt.lastOptimizedAt === null) {
			return (
				profile.stats.totalTraces >=
				SLOT_PROFILE_DEFAULTS.MIN_TRACES_FIRST_ARTIFACT
			);
		}

		// Cooldown: don't reoptimize too soon after the last run
		const elapsed = Date.now() - opt.lastOptimizedAt;
		if (elapsed < SLOT_PROFILE_DEFAULTS.REOPT_COOLDOWN_MS) {
			return false;
		}

		// Re-optimization: need enough new traces since last run
		if (
			opt.tracesSinceLastOptimization <
			SLOT_PROFILE_DEFAULTS.MIN_NEW_TRACES_REOPT
		) {
			return false;
		}

		// Score regression: current score has dropped significantly
		if (opt.lastScore !== null) {
			const scoreDrop = opt.lastScore - stats.avgCompositeScore;
			if (scoreDrop >= SLOT_PROFILE_DEFAULTS.SCORE_DROP_THRESHOLD) {
				return true;
			}
		}

		// Enough new data accumulated past cooldown
		return true;
	}

	/** Mark optimization as completed */
	async markOptimized(
		modelId: string,
		slotKey: SlotKey,
		promptKey: PromptKey,
		artifactVersion: number,
		score: number,
	): Promise<void> {
		const pKey = this.profileKey(modelId, slotKey, promptKey);
		await this.withWriteLock(pKey, async () => {
			const profile = await this.get(modelId, slotKey, promptKey);
			profile.optimization.currentArtifactVersion = artifactVersion;
			profile.optimization.lastOptimizedAt = Date.now();
			profile.optimization.lastScore = score;
			profile.optimization.optimizationCount++;
			profile.optimization.tracesSinceLastOptimization = 0;
			profile.optimization.needsReoptimization = false;
			profile.updatedAt = Date.now();
			await this.persist(modelId, slotKey, promptKey, profile);
		});
	}

	private async persist(
		modelId: string,
		slotKey: SlotKey,
		promptKey: PromptKey,
		profile: SlotProfile,
	): Promise<void> {
		const dir = join(this.rootDir, sanitizeModelId(modelId), slotKey);
		await mkdir(dir, { recursive: true });
		const path = this.getProfilePath(modelId, slotKey, promptKey);
		await writeFile(path, JSON.stringify(profile, null, 2), "utf-8");
	}
}

/** Incremental running average: avg_{n+1} = (avg_n * n + newValue) / (n + 1) */
function lerp(prevAvg: number, newValue: number, n: number): number {
	if (n === 0) return newValue;
	return (prevAvg * n + newValue) / (n + 1);
}
