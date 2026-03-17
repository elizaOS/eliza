/**
 * ActionFilterService — dynamically filters which actions are shown to the LLM
 * based on relevance to the current message.
 *
 * Two-tier ranking:
 *   1. Vector search: embed action descriptions + similes at registration time.
 *      At message time, embed the query (user message + context). Use cosine
 *      similarity to get the top candidates.
 *   2. BM25 reranking: rerank the vector-search candidates using BM25
 *      (term-frequency * inverse-document-frequency). BM25 is especially good
 *      at matching specific keywords that vector search might miss.
 *
 * Graceful degradation:
 *   - If the embedding model is unavailable → BM25-only ranking.
 *   - If BM25 also fails → return all actions (same as before).
 */

import { logger } from "../logger.ts";
import type {
	Action,
	IAgentRuntime,
	Memory,
	Provider,
} from "../types/index.ts";
import { ModelType } from "../types/model.ts";
import { Service } from "../types/service.ts";
import type { State } from "../types/state.ts";
import { BM25Index } from "./bm25.ts";
import { cosineSimilarity } from "./cosine-similarity.ts";

declare module "../types/service.ts" {
	interface ServiceTypeRegistry {
		ACTION_FILTER: "action_filter";
	}
}

export interface RankedAction {
	action: Action;
	/** Cosine similarity against the query embedding (0-1 range, 0 if unavailable). */
	vectorScore: number;
	/** BM25 score against the query text (0+ range, 0 if unavailable). */
	bm25Score: number;
	/** Weighted combination of vectorScore and bm25Score, plus momentum boost. */
	combinedScore: number;
}

export interface FilterConfig {
	/** Master switch — if false the service is a no-op. */
	enabled: boolean;
	/** Minimum registered action count before filtering kicks in. */
	threshold: number;
	/** How many candidates to pull from the vector search stage. */
	vectorTopK: number;
	/** Final number of actions returned after reranking. */
	finalTopK: number;
	/** Weight for the normalized vector score in the combined score (0-1). */
	vectorWeight: number;
	/** Weight for the normalized BM25 score in the combined score (0-1). */
	bm25Weight: number;
	/** Action names that always bypass filtering (in addition to per-action alwaysInclude). */
	alwaysIncludeActions: string[];
	/** Time window (ms) for conversation momentum decay. */
	momentumDecayMs: number;
	/** Score boost for recently used actions (0-1). */
	momentumBoost: number;
}

export interface FilterMetrics {
	/** Total number of filter() invocations. */
	filterCalls: number;
	/** How many times filtering was actually applied (vs. passthrough). */
	filteredCalls: number;
	/** How many times we fell back to BM25-only (embedding unavailable). */
	bm25OnlyFallbacks: number;
	/** How many times we fell back to returning all actions (complete failure). */
	fullFallbacks: number;
	/** Reported misses — actions that were filtered out but then selected by the LLM. */
	missCount: number;
	/** Names of missed actions for debugging (bounded ring buffer). */
	missedActions: string[];
	/** Average combined-score of returned actions (last call). */
	lastAvgScore: number;
	/** Number of actions in the embedding index. */
	indexedActionCount: number;
	/** Number of actions whose embedding failed during buildIndex or addAction. */
	embedFailureCount: number;
}

interface RecentActionEntry {
	name: string;
	timestamp: number;
	roomId: string;
}

const DEFAULT_CONFIG: FilterConfig = {
	enabled: true,
	threshold: 15,
	vectorTopK: 30,
	finalTopK: 15,
	vectorWeight: 0.6,
	bm25Weight: 0.4,
	// Core actions that must always appear in the LLM prompt.
	alwaysIncludeActions: ["REPLY", "IGNORE", "NONE"],
	momentumDecayMs: 300_000, // 5 minutes
	momentumBoost: 0.15,
};

/** Maximum number of missed-action names we keep in memory. */
const MAX_MISSED_ACTIONS = 100;
/** When the ring buffer overflows, keep the most recent half. */
const MISSED_ACTIONS_TRIM = 50;

/** Default number of top-scoring providers to return from filterProviders. */
const DEFAULT_PROVIDER_TOP_K = 5;

function freshMetrics(): FilterMetrics {
	return {
		filterCalls: 0,
		filteredCalls: 0,
		bm25OnlyFallbacks: 0,
		fullFallbacks: 0,
		missCount: 0,
		missedActions: [],
		lastAvgScore: 0,
		indexedActionCount: 0,
		embedFailureCount: 0,
	};
}

/**
 * Build a rich text blob from an action's metadata, suitable for both
 * embedding and BM25 indexing.
 */
export function getActionEmbeddingText(action: Action): string {
	const parts: string[] = [action.name.replace(/_/g, " ")];
	if (action.description) parts.push(action.description);
	if (action.similes?.length) parts.push(action.similes.join(", "));
	if (action.tags?.length) parts.push(action.tags.join(", "));
	if (action.parameters?.length) {
		for (const p of action.parameters) {
			parts.push(`${p.name}: ${p.description}`);
		}
	}
	return parts.join(" | ");
}

/**
 * Build a text blob from a provider's metadata for BM25 indexing.
 * Includes name, description, and relevanceKeywords.
 */
export function getProviderIndexText(provider: Provider): string {
	const parts: string[] = [provider.name.replace(/_/g, " ")];
	if (provider.description) parts.push(provider.description);
	if (provider.relevanceKeywords?.length) {
		parts.push(provider.relevanceKeywords.join(", "));
	}
	return parts.join(" | ");
}

/**
 * Build the query text used for vector + BM25 matching against the action
 * index. Includes the user message, recent conversation context, and any
 * detected intent keywords.
 */
export function buildQueryText(message: Memory, state: State): string {
	const parts: string[] = [];

	// Current message text
	const messageText = message.content?.text;
	if (messageText) {
		parts.push(messageText);
	}

	// Recent messages from state (providers populate this).
	// We look at a few known locations where conversation context may live.
	const recentMessagesValue = state.values?.recentMessages;
	if (
		typeof recentMessagesValue === "string" &&
		recentMessagesValue.length > 0
	) {
		// Truncate to last ~500 chars to keep the query focused
		const trimmed =
			recentMessagesValue.length > 500
				? recentMessagesValue.slice(-500)
				: recentMessagesValue;
		parts.push(trimmed);
	}

	// Action plan context (if the agent is mid-plan, bias toward plan actions)
	const steps = state.data?.actionPlan?.steps as
		| Array<{ status: string; action?: string }>
		| undefined;
	if (steps) {
		const pending = steps
			.filter(
				(s): s is typeof s & { action: string } =>
					s.status === "pending" && Boolean(s.action),
			)
			.map((s) => s.action);
		if (pending.length > 0) {
			parts.push(`Planned actions: ${pending.join(", ")}`);
		}
	}

	return parts.join("\n");
}

/**
 * Normalize an array of scores to [0, 1] using min-max normalization.
 * Returns an array of the same length. If all values are the same,
 * returns an array of 1s (or 0s if all are 0).
 *
 * NaN and Infinity values are sanitized to 0 before normalization.
 */
export function minMaxNormalize(scores: number[]): number[] {
	if (scores.length === 0) return [];

	// Sanitize: NaN / Infinity → 0
	const sanitized = scores.map((s) => (Number.isFinite(s) ? s : 0));

	let min = sanitized[0];
	let max = sanitized[0];
	for (let i = 1; i < sanitized.length; i++) {
		if (sanitized[i] < min) min = sanitized[i];
		if (sanitized[i] > max) max = sanitized[i];
	}
	const range = max - min;
	if (range === 0 || !Number.isFinite(range)) {
		// All scores identical or range overflowed — return 1 if non-zero, 0 otherwise
		return sanitized.map((s) => (s > 0 ? 1 : 0));
	}
	return sanitized.map((s) => {
		const normalized = (s - min) / range;
		return Number.isFinite(normalized) ? normalized : 0;
	});
}

export class ActionFilterService extends Service {
	static serviceType = "action_filter" as const;
	capabilityDescription =
		"Filters actions by relevance using vector search and BM25 reranking";

	private actionEmbeddings: Map<string, number[]> = new Map();

	private bm25Index: BM25Index = new BM25Index();

	/** Separate BM25 index for provider descriptions, used by filterProviders(). */
	private providerBM25Index: BM25Index = new BM25Index();

	private filterConfig: FilterConfig;

	private recentActions: RecentActionEntry[] = [];
	private readonly maxRecentActions = 200;

	private lastFilteredByRoom: Map<string, Set<string>> = new Map();
	private readonly maxTrackedRooms = 500;

	private metrics: FilterMetrics = freshMetrics();

	private embeddingAvailable = false;

	constructor(runtime?: IAgentRuntime, config?: Partial<FilterConfig>) {
		super(runtime);
		this.filterConfig = { ...DEFAULT_CONFIG, ...config };
	}

	/** Start the service. Reads ACTION_FILTER_* from runtime settings, then builds indices. */
	static async start(runtime: IAgentRuntime): Promise<Service> {
		const configOverrides = readFilterConfigFromRuntime(runtime);
		const service = new ActionFilterService(runtime, configOverrides);

		const embeddingModel = runtime.getModel(ModelType.TEXT_EMBEDDING);
		service.embeddingAvailable = !!embeddingModel;

		if (!service.embeddingAvailable) {
			logger.warn(
				{
					src: "service:action-filter",
					agentId: runtime.agentId,
				},
				"No TEXT_EMBEDDING model registered — ActionFilterService will use BM25-only mode",
			);
		}

		await service.buildIndex(runtime);

		logger.info(
			{
				src: "service:action-filter",
				agentId: runtime.agentId,
				actionCount: runtime.actions.length,
				embeddingAvailable: service.embeddingAvailable,
			},
			"ActionFilterService started",
		);

		return service;
	}

	async stop(): Promise<void> {
		this.actionEmbeddings.clear();
		this.bm25Index = new BM25Index();
		this.providerBM25Index = new BM25Index();
		this.recentActions = [];
		this.lastFilteredByRoom.clear();
		this.metrics = freshMetrics();
		logger.info(
			{ src: "service:action-filter" },
			"ActionFilterService stopped",
		);
	}

	/**
	 * Build (or rebuild) the vector + BM25 index for all registered actions.
	 * Also builds the provider BM25 index for dynamic provider filtering.
	 */
	async buildIndex(runtime: IAgentRuntime): Promise<void> {
		this.actionEmbeddings.clear();
		this.bm25Index = new BM25Index();
		this.providerBM25Index = new BM25Index();

		// ── Action index ───────────────────────────────────────────────
		const actions = runtime.actions;
		if (actions.length > 0) {
			for (const action of actions) {
				const text = getActionEmbeddingText(action);
				this.bm25Index.addDocument(action.name, text);
			}

			if (this.embeddingAvailable) {
				// Embed in batches to avoid flooding the model
				const batchSize = 10;
				for (let i = 0; i < actions.length; i += batchSize) {
					const batch = actions.slice(i, i + batchSize);
					const embedPromises = batch.map(async (action) => {
						try {
							const text = getActionEmbeddingText(action);
							const embedding: number[] = await runtime.useModel(
								ModelType.TEXT_EMBEDDING,
								{ text },
							);
							if (isValidEmbedding(embedding)) {
								this.actionEmbeddings.set(action.name, embedding);
							} else {
								logger.warn(
									{
										src: "service:action-filter",
										action: action.name,
									},
									"Embedding model returned invalid vector (NaN/empty) — action available via BM25 only",
								);
								this.metrics.embedFailureCount++;
							}
						} catch (err) {
							logger.warn(
								{
									src: "service:action-filter",
									action: action.name,
									error: err instanceof Error ? err.message : String(err),
								},
								"Failed to embed action — it will still be available via BM25",
							);
							this.metrics.embedFailureCount++;
						}
					});
					await Promise.all(embedPromises);
				}
			}
		}

		this.metrics.indexedActionCount = actions.length;

		// ── Provider BM25 index ────────────────────────────────────────
		// Index all providers that have a description so filterProviders()
		// can score dynamic providers by relevance.
		const providers = runtime.providers;
		if (providers && providers.length > 0) {
			let indexedProviders = 0;
			for (const provider of providers) {
				if (provider.description) {
					const text = getProviderIndexText(provider);
					this.providerBM25Index.addDocument(provider.name, text);
					indexedProviders++;
				}
			}
			if (indexedProviders > 0) {
				logger.debug(
					{
						src: "service:action-filter",
						indexedProviders,
					},
					"Provider BM25 index built",
				);
			}
		}
	}

	/**
	 * Add a single action to the index at runtime (e.g. when a plugin
	 * registers a new action after startup).
	 */
	async addAction(action: Action, runtime: IAgentRuntime): Promise<void> {
		const text = getActionEmbeddingText(action);

		this.bm25Index.addDocument(action.name, text);

		if (this.embeddingAvailable) {
			try {
				const embedding: number[] = await runtime.useModel(
					ModelType.TEXT_EMBEDDING,
					{ text },
				);
				if (isValidEmbedding(embedding)) {
					this.actionEmbeddings.set(action.name, embedding);
				}
			} catch (err) {
				logger.warn(
					{
						src: "service:action-filter",
						action: action.name,
						error: err instanceof Error ? err.message : String(err),
					},
					"Failed to embed new action",
				);
				this.metrics.embedFailureCount++;
			}
		}

		this.metrics.indexedActionCount = this.bm25Index.size;
	}

	/**
	 * Remove an action from both indices (e.g. when a plugin is unloaded).
	 */
	removeAction(actionName: string): void {
		this.bm25Index.removeDocument(actionName);
		this.actionEmbeddings.delete(actionName);
		this.metrics.indexedActionCount = this.bm25Index.size;
	}

	/**
	 * Filter the registered actions to the most relevant subset for this message.
	 *
	 * Flow:
	 *  1. If action count <= threshold → return all (same as validate-all path).
	 *  2. Always-include actions bypass filtering and are prepended to results.
	 *  3. Vector search: embed query → cosine similarity → top vectorTopK.
	 *  4. BM25 rerank: score vectorTopK candidates → combine scores.
	 *  5. Apply momentum boost for recently used actions.
	 *  6. Return top finalTopK actions.
	 *
	 * The returned actions have NOT been validated — the caller (actionsProvider)
	 * is responsible for running `validate()` on the returned set.
	 */
	async filter(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<Action[]> {
		this.metrics.filterCalls++;

		const allActions = runtime.actions;

		if (
			!this.filterConfig.enabled ||
			allActions.length <= this.filterConfig.threshold
		) {
			return allActions;
		}

		this.metrics.filteredCalls++;

		const alwaysIncludeSet = new Set(
			this.filterConfig.alwaysIncludeActions.map((n) => n.toUpperCase()),
		);
		const alwaysIncluded: Action[] = [];
		const candidatePool: Action[] = [];

		for (const action of allActions) {
			if (
				alwaysIncludeSet.has(action.name.toUpperCase()) ||
				(action.tags?.includes("always-include") ?? false)
			) {
				alwaysIncluded.push(action);
			} else {
				candidatePool.push(action);
			}
		}

		if (candidatePool.length <= this.filterConfig.finalTopK) {
			return allActions;
		}

		try {
			const ranked = await this.rankActions(
				runtime,
				candidatePool,
				message,
				state,
			);

			const slotsForRanked = Math.max(
				1,
				this.filterConfig.finalTopK - alwaysIncluded.length,
			);
			const topRanked = ranked.slice(0, slotsForRanked);

			if (topRanked.length > 0) {
				const sum = topRanked.reduce((acc, r) => acc + r.combinedScore, 0);
				this.metrics.lastAvgScore = sum / topRanked.length;
			}

			const resultNames = new Set(alwaysIncluded.map((a) => a.name));
			const result = [...alwaysIncluded];
			for (const ra of topRanked) {
				if (!resultNames.has(ra.action.name)) {
					result.push(ra.action);
					resultNames.add(ra.action.name);
				}
			}

			// Track which actions made it through filtering for this room
			// so processActions can detect false negatives later.
			const roomId = message.roomId;
			if (roomId) {
				this.lastFilteredByRoom.set(roomId, resultNames);
				if (this.lastFilteredByRoom.size > this.maxTrackedRooms) {
					const oldest = this.lastFilteredByRoom.keys().next().value;
					if (oldest !== undefined) {
						this.lastFilteredByRoom.delete(oldest);
					}
				}
			}

			return result;
		} catch (err) {
			// Complete failure → return all actions (graceful degradation)
			logger.error(
				{
					src: "service:action-filter",
					error: err instanceof Error ? err.message : String(err),
				},
				"Action filtering failed — returning all actions",
			);
			this.metrics.fullFallbacks++;
			return allActions;
		}
	}

	/**
	 * Score providers by relevance to the current message using BM25.
	 * Returns provider names sorted by relevance score, highest first.
	 * Only scores providers that have been indexed (i.e. have a description).
	 *
	 * This is used by composeState() to auto-include dynamic providers
	 * that are relevant to the current message, without requiring explicit
	 * relevanceKeywords on each provider.
	 *
	 * @param providers - The candidate providers to score (typically dynamic providers).
	 * @param message - The current message being processed.
	 * @param state - The current state (used to build query context).
	 * @param topK - Maximum number of provider names to return (default: 5).
	 * @returns Provider names sorted by descending BM25 relevance score.
	 */
	filterProviders(
		providers: Provider[],
		message: Memory,
		state: State,
		topK: number = DEFAULT_PROVIDER_TOP_K,
	): string[] {
		if (this.providerBM25Index.size === 0 || providers.length === 0) {
			return [];
		}

		// Build query text from the message (reuse the same logic as action filtering)
		const queryText = buildQueryText(message, state);
		if (!queryText || queryText.trim().length === 0) {
			return [];
		}

		// Only score providers that are in our index
		const candidateIds = providers
			.filter((p) => this.providerBM25Index.has(p.name))
			.map((p) => p.name);

		if (candidateIds.length === 0) {
			return [];
		}

		const results = this.providerBM25Index.searchSubset(
			queryText,
			candidateIds,
			topK,
		);

		return results.map((r) => r.id);
	}

	/**
	 * Record that an action was used, so future queries in the same room
	 * receive a momentum boost for that action.
	 */
	recordActionUse(actionName: string, roomId: string): void {
		this.recentActions.push({
			name: actionName,
			timestamp: Date.now(),
			roomId,
		});

		if (this.recentActions.length > this.maxRecentActions) {
			this.recentActions = this.recentActions.slice(-this.maxRecentActions);
		}
	}

	getMetrics(): FilterMetrics {
		return {
			...this.metrics,
			missedActions: [...this.metrics.missedActions],
		};
	}

	reportMiss(actionName: string): void {
		this.metrics.missCount++;
		this.metrics.missedActions.push(actionName);
		// Keep missedActions bounded as a ring buffer
		if (this.metrics.missedActions.length > MAX_MISSED_ACTIONS) {
			this.metrics.missedActions = this.metrics.missedActions.slice(
				-MISSED_ACTIONS_TRIM,
			);
		}
		logger.warn(
			{ src: "service:action-filter", action: actionName },
			"Action filter miss — action was selected by LLM but had been filtered out",
		);
	}

	hasAction(actionName: string): boolean {
		return this.bm25Index.has(actionName);
	}

	getConfig(): Readonly<FilterConfig> {
		return { ...this.filterConfig };
	}

	/**
	 * Check whether an action was in the most recent filtered set for a room.
	 * Returns `true` if filtering was active for that room and the action
	 * WAS in the filtered set, `false` if it was filtered OUT, or `null` if
	 * filtering wasn't active for that room (so the caller should skip
	 * false-negative reporting).
	 */
	wasActionInFilteredSet(actionName: string, roomId: string): boolean | null {
		const filtered = this.lastFilteredByRoom.get(roomId);
		if (!filtered) {
			return null; // no filtering happened for this room
		}
		return filtered.has(actionName);
	}

	/**
	 * Override the tracked action set for a room with the exact list that was
	 * presented in the prompt. This keeps miss detection accurate when callers
	 * use filter() for ranking but still include additional actions.
	 */
	setRoomActionSet(roomId: string, actionNames: Iterable<string>): void {
		this.lastFilteredByRoom.set(roomId, new Set(actionNames));
		if (this.lastFilteredByRoom.size > this.maxTrackedRooms) {
			const oldest = this.lastFilteredByRoom.keys().next().value;
			if (oldest !== undefined) {
				this.lastFilteredByRoom.delete(oldest);
			}
		}
	}

	/**
	 * Run the full two-tier ranking pipeline on a set of candidate actions.
	 * Returns RankedAction[] sorted by combinedScore descending.
	 */
	private async rankActions(
		runtime: IAgentRuntime,
		candidates: Action[],
		message: Memory,
		state: State,
	): Promise<RankedAction[]> {
		const queryText = buildQueryText(message, state);

		// Stage 1: Vector search
		let vectorScores: Map<string, number> | null = null;
		let vectorCandidateNames: string[] | null = null;

		if (this.embeddingAvailable && this.actionEmbeddings.size > 0) {
			try {
				const queryEmbedding: number[] = await runtime.useModel(
					ModelType.TEXT_EMBEDDING,
					{ text: queryText },
				);

				if (isValidEmbedding(queryEmbedding)) {
					// Score all candidates by cosine similarity
					const scored: Array<{ name: string; score: number }> = [];
					for (const action of candidates) {
						const actionEmb = this.actionEmbeddings.get(action.name);
						if (actionEmb) {
							const sim = cosineSimilarity(queryEmbedding, actionEmb);
							if (Number.isFinite(sim)) {
								scored.push({ name: action.name, score: sim });
							}
						}
					}

					scored.sort((a, b) => b.score - a.score);

					// Take top vectorTopK
					const topVector = scored.slice(0, this.filterConfig.vectorTopK);
					vectorScores = new Map(topVector.map((s) => [s.name, s.score]));
					vectorCandidateNames = topVector.map((s) => s.name);
				} else {
					logger.warn(
						{ src: "service:action-filter" },
						"Query embedding invalid — falling back to BM25-only",
					);
					this.metrics.bm25OnlyFallbacks++;
				}
			} catch (err) {
				logger.warn(
					{
						src: "service:action-filter",
						error: err instanceof Error ? err.message : String(err),
					},
					"Vector search failed — falling back to BM25-only",
				);
				this.metrics.bm25OnlyFallbacks++;
			}
		} else {
			this.metrics.bm25OnlyFallbacks++;
		}

		// Stage 2: BM25 scoring
		// If vector search produced candidates, rerank those.
		// Otherwise, BM25 searches the entire candidate pool.

		const bm25CandidateIds =
			vectorCandidateNames ?? candidates.map((a) => a.name);

		const bm25Results = this.bm25Index.searchSubset(
			queryText,
			bm25CandidateIds,
		);
		const bm25Scores = new Map(bm25Results.map((r) => [r.id, r.score]));

		// Stage 3: Combine scores
		// bm25CandidateIds is either vectorCandidateNames (when vectors
		// succeeded) or all candidate names (when BM25-only), so it already
		// contains the complete candidate universe for this ranking pass.
		const candidateNamesList = bm25CandidateIds;
		const rawVectorScores = candidateNamesList.map(
			(name) => vectorScores?.get(name) ?? 0,
		);
		const rawBm25Scores = candidateNamesList.map(
			(name) => bm25Scores.get(name) ?? 0,
		);

		const normVector = minMaxNormalize(rawVectorScores);
		const normBm25 = minMaxNormalize(rawBm25Scores);

		const hasVector = vectorScores !== null && vectorScores.size > 0;
		const effectiveVectorWeight = hasVector
			? this.filterConfig.vectorWeight
			: 0;
		const effectiveBm25Weight = hasVector ? this.filterConfig.bm25Weight : 1;
		const totalWeight = effectiveVectorWeight + effectiveBm25Weight;

		const safeTotalWeight = totalWeight > 0 ? totalWeight : 1;

		const actionByName = new Map<string, Action>();
		for (const action of candidates) {
			actionByName.set(action.name, action);
		}

		const momentumMap = this.computeMomentumBoosts(message);

		const ranked: RankedAction[] = [];

		for (let i = 0; i < candidateNamesList.length; i++) {
			const name = candidateNamesList[i];
			const action = actionByName.get(name);
			if (!action) continue;

			const vScore = normVector[i];
			const bScore = normBm25[i];

			let combined =
				(effectiveVectorWeight * vScore + effectiveBm25Weight * bScore) /
				safeTotalWeight;

			if (!Number.isFinite(combined)) {
				combined = 0;
			}

			const momentumBoost = momentumMap.get(name) ?? 0;
			combined = Math.min(1, combined + momentumBoost);

			ranked.push({
				action,
				vectorScore: rawVectorScores[i],
				bm25Score: rawBm25Scores[i],
				combinedScore: combined,
			});
		}

		ranked.sort((a, b) => b.combinedScore - a.combinedScore);

		return ranked;
	}

	/**
	 * Compute per-action momentum boosts based on recently used actions
	 * in the same room as the current message.
	 */
	private computeMomentumBoosts(message: Memory): Map<string, number> {
		const boosts = new Map<string, number>();
		const now = Date.now();
		const roomId = message.roomId;

		const validEntries: RecentActionEntry[] = [];

		for (const entry of this.recentActions) {
			const age = now - entry.timestamp;
			if (age > this.filterConfig.momentumDecayMs) {
				continue; // expired
			}
			validEntries.push(entry);

			if (roomId && entry.roomId !== roomId) {
				continue;
			}

			const decayFactor = 1 - age / this.filterConfig.momentumDecayMs;
			const boost = this.filterConfig.momentumBoost * decayFactor;

			const existing = boosts.get(entry.name) ?? 0;
			boosts.set(entry.name, Math.max(existing, boost));
		}

		this.recentActions = validEntries;

		return boosts;
	}
}

function readFilterConfigFromRuntime(
	runtime: IAgentRuntime,
): Partial<FilterConfig> {
	const get = (key: string) => runtime.getSetting(key);

	/** Parse a numeric setting. Returns undefined if absent or invalid. */
	const num = (
		key: string,
		min: number,
		max: number,
		integer = false,
	): number | undefined => {
		const raw = get(key);
		if (raw == null) return undefined;
		const n = Number(raw);
		if (!Number.isFinite(n) || n < min || n > max) return undefined;
		return integer ? Math.round(n) : n;
	};

	const overrides: Partial<FilterConfig> = {};

	const enabled = get("ACTION_FILTER_ENABLED");
	if (enabled != null) {
		overrides.enabled = String(enabled).toLowerCase() !== "false";
	}

	overrides.threshold = num("ACTION_FILTER_THRESHOLD", 0, 1e6, true);
	overrides.vectorTopK = num("ACTION_FILTER_VECTOR_TOP_K", 1, 1e6, true);
	overrides.finalTopK = num("ACTION_FILTER_FINAL_TOP_K", 1, 1e6, true);
	overrides.vectorWeight = num("ACTION_FILTER_VECTOR_WEIGHT", 0, 1);
	overrides.bm25Weight = num("ACTION_FILTER_BM25_WEIGHT", 0, 1);
	overrides.momentumDecayMs = num(
		"ACTION_FILTER_MOMENTUM_DECAY_MS",
		1,
		1e9,
		true,
	);
	overrides.momentumBoost = num("ACTION_FILTER_MOMENTUM_BOOST", 0, 1);

	// Strip undefined keys so they don't override defaults during spread
	for (const key of Object.keys(overrides) as (keyof FilterConfig)[]) {
		if (overrides[key] === undefined) {
			delete overrides[key];
		}
	}

	return overrides;
}

function isValidEmbedding(embedding: number[]): boolean {
	if (!Array.isArray(embedding) || embedding.length === 0) {
		return false;
	}
	let hasNonZero = false;
	for (let i = 0; i < embedding.length; i++) {
		if (!Number.isFinite(embedding[i])) {
			return false;
		}
		if (embedding[i] !== 0) {
			hasNonZero = true;
		}
	}
	return hasNonZero;
}
