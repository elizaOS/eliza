import { countActionSearchKeywordMatches } from "../i18n/action-search-keywords";
import type { ActionCatalog, ActionCatalogParent } from "./action-catalog";
import { normalizeActionName } from "./action-catalog";

export type RetrievalStageName =
	| "exact"
	| "regex"
	| "keyword"
	| "bm25"
	| "embedding"
	| "contextMatch";

export type ActionEmbeddingTieBreaker = {
	enabled?: boolean;
	scoresByParentName?: Record<string, number>;
};

export type RetrieveActionsInput = {
	catalog: ActionCatalog;
	messageText?: string;
	recentConversationText?: string | readonly string[];
	candidateActions?: string[];
	parentActionHints?: string[];
	embedding?: ActionEmbeddingTieBreaker;
	limit?: number;
	/**
	 * The messageHandler-selected contexts for this turn. Used as a *weight*
	 * (boost actions whose declared `contexts` intersect this set) — never
	 * as a filter. Filtering by context masked LIFE/CALENDAR/etc. when the
	 * messageHandler routed to "general"; weighting keeps them retrievable
	 * while still preferring on-context candidates when scores are close.
	 */
	selectedContexts?: readonly string[];
	/**
	 * When `true`, capture each stage's full pre-fusion output and emit it
	 * in `response.measurement`. Default `false` — no allocation cost in
	 * production. Toggle via the `MILADY_RETRIEVAL_MEASUREMENT=1` env var
	 * on the caller side.
	 */
	measurementMode?: boolean;
	/**
	 * Optional per-tier overrides for retrieval. When provided, the call
	 * uses these instead of the in-file constants. Wired by the benchmark
	 * harness from `RETRIEVAL_DEFAULTS_BY_TIER`.
	 */
	tierOverrides?: {
		topK?: number;
		stageWeights?: Partial<Record<RetrievalStageName, number>>;
	};
};

export type RetrievalStageEntry = {
	actionName: string;
	score: number;
	rank: number;
};

export type RetrievalPerStageScores = {
	exact: RetrievalStageEntry[];
	regex: RetrievalStageEntry[];
	keyword: RetrievalStageEntry[];
	bm25: RetrievalStageEntry[];
	embedding: RetrievalStageEntry[];
	contextMatch: RetrievalStageEntry[];
};

export type RetrievalMeasurement = {
	perStageScores: RetrievalPerStageScores;
	fusedTopK: Array<{ actionName: string; rrfScore: number; rank: number }>;
};

export type ActionRetrievalResult = {
	parent: ActionCatalogParent;
	name: string;
	normalizedName: string;
	score: number;
	rank: number;
	rrfScore: number;
	stageScores: Partial<Record<RetrievalStageName, number>>;
	matchedBy: RetrievalStageName[];
};

export type ActionRetrievalResponse = {
	results: ActionRetrievalResult[];
	warnings: ActionCatalog["warnings"];
	query: {
		text: string;
		tokens: string[];
		candidateActions: string[];
		parentActionHints: string[];
	};
	/**
	 * Per-stage retrieval funnel. Populated only when
	 * `input.measurementMode === true`. The benchmark harness consumes
	 * this to compute stage-by-stage recall.
	 */
	measurement?: RetrievalMeasurement;
};

const BM25_K1 = 0.9;
const BM25_B = 0.4;
const RRF_K = 60;

/**
 * Per-tier retrieval defaults inlined in core to avoid taking a runtime
 * dep on `@elizaos-benchmarks/lib`. Kept in sync by hand with
 * `packages/benchmarks/lib/src/retrieval-defaults.ts` — the benchmark
 * package is the source of truth (it's where the Pareto sweep emits
 * recommended values); this copy exists so the runtime can read
 * `MODEL_TIER` without crossing the dep boundary. If the two drift,
 * fix this file from the benchmarks copy.
 */
const RETRIEVAL_TIER_DEFAULTS: Record<
	"small" | "mid" | "large" | "frontier",
	{ topK: number; stageWeights: Partial<Record<RetrievalStageName, number>> }
> = {
	small: {
		topK: 5,
		stageWeights: {
			exact: 1.5,
			regex: 1.3,
			bm25: 1.2,
			keyword: 1,
			embedding: 0.7,
			contextMatch: 0.9,
		},
	},
	mid: {
		topK: 8,
		stageWeights: {
			exact: 1.4,
			regex: 1.2,
			bm25: 1.15,
			keyword: 1,
			embedding: 0.85,
			contextMatch: 1,
		},
	},
	large: {
		topK: 12,
		stageWeights: {
			exact: 1.2,
			regex: 1.1,
			bm25: 1,
			keyword: 1,
			embedding: 1,
			contextMatch: 1,
		},
	},
	frontier: {
		topK: 20,
		stageWeights: {
			exact: 1,
			regex: 1,
			bm25: 1,
			keyword: 1.1,
			embedding: 1.2,
			contextMatch: 1,
		},
	},
};

// Cerebras "compress" mode caps top-K at 8 regardless of tier default.
// When `MILADY_PROMPT_COMPRESS=1` is set we trade retrieval breadth for a
// tighter token budget on the available-actions block.
const COMPRESS_MODE_TOP_K_CAP = 8;

function resolveTierOverridesFromEnv():
	| { topK: number; stageWeights: Partial<Record<RetrievalStageName, number>> }
	| undefined {
	const raw =
		typeof process !== "undefined"
			? process.env?.MODEL_TIER?.trim()
			: undefined;
	const compress =
		typeof process !== "undefined" &&
		process.env?.MILADY_PROMPT_COMPRESS === "1";
	if (
		raw !== "small" &&
		raw !== "mid" &&
		raw !== "large" &&
		raw !== "frontier"
	) {
		if (compress) {
			return {
				topK: COMPRESS_MODE_TOP_K_CAP,
				stageWeights: {},
			};
		}
		return undefined;
	}
	const entry = RETRIEVAL_TIER_DEFAULTS[raw];
	const topK = compress
		? Math.min(entry.topK, COMPRESS_MODE_TOP_K_CAP)
		: entry.topK;
	return {
		topK,
		stageWeights: { ...entry.stageWeights },
	};
}

export function retrieveActions(
	input: RetrieveActionsInput,
): ActionRetrievalResponse {
	const candidateActions = dedupeNormalizedStrings(input.candidateActions);
	const parentActionHints = dedupeNormalizedStrings(input.parentActionHints);
	const queryText = [input.messageText ?? "", ...candidateActions].join("\n");
	const queryTokens = tokenizeActionSearchText(queryText);
	const keywordQueryTexts = [
		input.messageText ?? "",
		...normalizeTextList(input.recentConversationText),
		...candidateActions,
	].filter((text) => text.trim().length > 0);
	const exactScores = scoreExactHints(input.catalog.parents, parentActionHints);
	const regexScores = scoreCandidateRegex(
		input.catalog.parents,
		candidateActions,
	);
	const keywordScores = scoreKeywordMatches(
		input.catalog.parents,
		keywordQueryTexts,
	);
	const bm25Scores = scoreBm25(input.catalog.parents, queryTokens);
	const embeddingScores = scoreEmbeddingTieBreaker(
		input.catalog.parents,
		input.embedding,
	);
	const isBareSingleTokenQuery =
		parentActionHints.length === 0 &&
		candidateActions.length === 0 &&
		queryTokens.length <= 1;

	const stageRankings: Partial<
		Record<RetrievalStageName, Map<string, number>>
	> = {
		exact: rankScores(exactScores),
		regex: rankScores(regexScores),
		keyword: rankScores(keywordScores),
		bm25: rankScores(bm25Scores),
		embedding: rankScores(embeddingScores),
	};
	const envOverrides = resolveTierOverridesFromEnv();
	const effectiveOverrides = input.tierOverrides ?? envOverrides;
	const stageWeights = effectiveOverrides?.stageWeights;
	const rrfScores = reciprocalRankFusion(stageRankings, stageWeights);
	const maxRrf = Math.max(0, ...rrfScores.values());
	const maxKeyword = Math.max(0, ...keywordScores.values());
	const maxBm25 = Math.max(0, ...bm25Scores.values());
	const maxEmbedding = Math.max(0, ...embeddingScores.values());

	const selectedContextSet = new Set(
		(input.selectedContexts ?? []).map((c) => c.toLowerCase()),
	);
	const results = input.catalog.parents.map((parent) => {
		const normalizedName = parent.normalizedName;
		const exact = exactScores.get(normalizedName) ?? 0;
		const regex = regexScores.get(normalizedName) ?? 0;
		const keywordRaw = keywordScores.get(normalizedName) ?? 0;
		const bm25Raw = bm25Scores.get(normalizedName) ?? 0;
		const embeddingRaw = embeddingScores.get(normalizedName) ?? 0;
		const keyword = maxKeyword > 0 ? keywordRaw / maxKeyword : 0;
		const bm25 = maxBm25 > 0 ? bm25Raw / maxBm25 : 0;
		const embedding = maxEmbedding > 0 ? embeddingRaw / maxEmbedding : 0;
		const rrfRaw = rrfScores.get(normalizedName) ?? 0;
		const rrf = maxRrf > 0 ? rrfRaw / maxRrf : 0;
		const stageScores: ActionRetrievalResult["stageScores"] = {};

		if (exact > 0) {
			stageScores.exact = exact;
		}
		if (regex > 0) {
			stageScores.regex = regex;
		}
		if (keyword > 0) {
			stageScores.keyword = roundScore(keyword);
		}
		if (bm25 > 0) {
			stageScores.bm25 = roundScore(bm25);
		}
		if (embedding > 0) {
			stageScores.embedding = roundScore(embedding);
		}

		const baseScore = Math.max(
			exact,
			regex,
			keyword > 0 ? 0.35 + keyword * 0.5 : 0,
			bm25 > 0 ? 0.28 + bm25 * (isBareSingleTokenQuery ? 0.38 : 0.49) : 0,
			embedding > 0 ? 0.25 + embedding * 0.45 : 0,
			rrf > 0 ? 0.2 + rrf * (isBareSingleTokenQuery ? 0.45 : 0.5) : 0,
		);

		// Context-match boost: when the messageHandler picked contexts that
		// intersect this parent's declared `contexts`, give it a meaningful
		// additive bump. The boost is large enough to reorder tier-A when a
		// context-aligned candidate has a comparable raw retrieval score
		// (e.g. LIFE vs BLOCK both keyword-match "every day" — context says
		// the user is in tasks/general, so LIFE wins). Context alone is not a
		// retrieval signal; otherwise every action sharing a broad context can
		// leak into Tier B without matching the turn.
		const parentContexts: readonly unknown[] = Array.isArray(parent.contexts)
			? parent.contexts
			: [];
		let contextBoost = 0;
		if (
			baseScore > 0 &&
			selectedContextSet.size > 0 &&
			parentContexts.length > 0
		) {
			const intersect = parentContexts.some((c) =>
				selectedContextSet.has(String(c).toLowerCase()),
			);
			if (intersect) {
				contextBoost = 0.3;
				stageScores.contextMatch = contextBoost;
			}
		}

		const score = clampScore(baseScore + contextBoost);

		return {
			parent,
			name: parent.name,
			normalizedName,
			score,
			rank: 0,
			rrfScore: roundScore(rrfRaw),
			stageScores,
			matchedBy: Object.keys(stageScores) as RetrievalStageName[],
		};
	});

	results.sort((left, right) => {
		return (
			right.score - left.score ||
			right.rrfScore - left.rrfScore ||
			left.normalizedName.localeCompare(right.normalizedName)
		);
	});

	const effectiveLimit =
		effectiveOverrides?.topK ??
		(Number.isFinite(input.limit) ? input.limit : undefined);
	const limit = Number.isFinite(effectiveLimit)
		? Math.max(0, effectiveLimit ?? 0)
		: 0;
	const limited = limit > 0 ? results.slice(0, limit) : results;

	for (let index = 0; index < limited.length; index += 1) {
		limited[index].rank = index + 1;
	}

	let measurement: RetrievalMeasurement | undefined;
	if (input.measurementMode === true) {
		// Capture each stage's pre-fusion ranking so the analyzer can compute
		// stage-by-stage recall. Context-match scores are recomputed from the
		// per-parent boost so they're available alongside the other five
		// stages even though they're applied as an additive bump in the main
		// loop, not as a ranking source.
		const selectedContextSetForMeasurement = selectedContextSet;
		const contextMatchScores = new Map<string, number>();
		for (const parent of input.catalog.parents) {
			const parentContexts: readonly unknown[] = Array.isArray(parent.contexts)
				? parent.contexts
				: [];
			if (
				selectedContextSetForMeasurement.size > 0 &&
				parentContexts.length > 0 &&
				parentContexts.some((c) =>
					selectedContextSetForMeasurement.has(String(c).toLowerCase()),
				)
			) {
				contextMatchScores.set(parent.normalizedName, 1);
			}
		}

		measurement = {
			perStageScores: {
				exact: mapToStageEntries(exactScores),
				regex: mapToStageEntries(regexScores),
				keyword: mapToStageEntries(keywordScores),
				bm25: mapToStageEntries(bm25Scores),
				embedding: mapToStageEntries(embeddingScores),
				contextMatch: mapToStageEntries(contextMatchScores),
			},
			fusedTopK: Array.from(rrfScores.entries())
				.sort(([leftName, leftScore], [rightName, rightScore]) => {
					return rightScore - leftScore || leftName.localeCompare(rightName);
				})
				.map(([name, rrfScore], index) => ({
					actionName: name,
					rrfScore: roundScore(rrfScore),
					rank: index + 1,
				})),
		};
	}

	return {
		results: limited,
		warnings: input.catalog.warnings,
		query: {
			text: queryText,
			tokens: queryTokens,
			candidateActions,
			parentActionHints,
		},
		...(measurement ? { measurement } : {}),
	};
}

function mapToStageEntries(scores: Map<string, number>): RetrievalStageEntry[] {
	return Array.from(scores.entries())
		.filter(([, score]) => score > 0)
		.sort(([leftName, leftScore], [rightName, rightScore]) => {
			return rightScore - leftScore || leftName.localeCompare(rightName);
		})
		.map(([actionName, score], index) => ({
			actionName,
			score: roundScore(score),
			rank: index + 1,
		}));
}

export function tokenizeActionSearchText(text: string): string[] {
	return String(text ?? "")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_:/.-]+/g, " ")
		.toLowerCase()
		.split(/[^a-z0-9]+/g)
		.map((token) => token.trim())
		.filter((token) => token.length > 1);
}

function scoreExactHints(
	parents: ActionCatalogParent[],
	parentActionHints: string[],
): Map<string, number> {
	const hints = new Set(
		parentActionHints.map(normalizeActionName).filter(Boolean),
	);
	const scores = new Map<string, number>();

	for (const parent of parents) {
		if (hints.has(parent.normalizedName)) {
			scores.set(parent.normalizedName, 1);
		}
	}

	return scores;
}

function scoreCandidateRegex(
	parents: ActionCatalogParent[],
	candidateActions: string[],
): Map<string, number> {
	const patterns = buildCandidatePatterns(candidateActions);
	const scores = new Map<string, number>();

	for (const parent of parents) {
		const searchableNames = [
			parent.normalizedName,
			...parent.childNormalizedNames,
		];

		for (const pattern of patterns) {
			const namespaceHit =
				pattern.namespace && pattern.namespace === parent.normalizedName;
			const nameHit = searchableNames.some((name) => pattern.regex.test(name));
			if (namespaceHit || nameHit) {
				scores.set(
					parent.normalizedName,
					Math.max(scores.get(parent.normalizedName) ?? 0, pattern.score),
				);
			}
		}
	}

	return scores;
}

function scoreBm25(
	parents: ActionCatalogParent[],
	queryTokens: string[],
): Map<string, number> {
	const scores = new Map<string, number>();
	if (parents.length === 0 || queryTokens.length === 0) {
		return scores;
	}

	const documents = parents.map((parent) => ({
		parent,
		tokens: tokenizeActionSearchText(parent.searchText),
	}));
	const averageDocumentLength =
		documents.reduce((sum, document) => sum + document.tokens.length, 0) /
		Math.max(1, documents.length);
	const documentFrequency = new Map<string, number>();
	const queryVocabulary = Array.from(new Set(queryTokens));

	for (const token of queryVocabulary) {
		let count = 0;
		for (const document of documents) {
			if (document.tokens.includes(token)) {
				count += 1;
			}
		}
		documentFrequency.set(token, count);
	}

	for (const document of documents) {
		const termFrequency = new Map<string, number>();
		for (const token of document.tokens) {
			termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
		}

		let score = 0;
		for (const token of queryTokens) {
			const frequency = termFrequency.get(token) ?? 0;
			if (frequency === 0) {
				continue;
			}

			const documentsWithTerm = documentFrequency.get(token) ?? 0;
			const idf = Math.log(
				1 +
					(parents.length - documentsWithTerm + 0.5) /
						(documentsWithTerm + 0.5),
			);
			const denominator =
				frequency +
				BM25_K1 *
					(1 -
						BM25_B +
						BM25_B *
							(document.tokens.length / Math.max(1, averageDocumentLength)));
			score += idf * ((frequency * (BM25_K1 + 1)) / denominator);
		}

		if (score > 0) {
			scores.set(document.parent.normalizedName, score);
		}
	}

	return scores;
}

function scoreKeywordMatches(
	parents: ActionCatalogParent[],
	queryTexts: readonly string[],
): Map<string, number> {
	const scores = new Map<string, number>();
	if (parents.length === 0 || queryTexts.length === 0) {
		return scores;
	}

	for (const parent of parents) {
		const terms = parent.keywordText
			.split(/\n+/)
			.map((term) => term.trim())
			.filter(Boolean);
		if (terms.length === 0) {
			continue;
		}
		const score = countActionSearchKeywordMatches(queryTexts, terms);
		if (score > 0) {
			scores.set(parent.normalizedName, score);
		}
	}

	return scores;
}

function scoreEmbeddingTieBreaker(
	parents: ActionCatalogParent[],
	embedding?: ActionEmbeddingTieBreaker,
): Map<string, number> {
	const scores = new Map<string, number>();
	if (!embedding?.enabled || !embedding.scoresByParentName) {
		return scores;
	}

	for (const parent of parents) {
		const score =
			embedding.scoresByParentName[parent.name] ??
			embedding.scoresByParentName[parent.normalizedName] ??
			embedding.scoresByParentName[parent.normalizedName.toLowerCase()];
		if (typeof score === "number" && Number.isFinite(score) && score > 0) {
			scores.set(parent.normalizedName, score);
		}
	}

	return scores;
}

function buildCandidatePatterns(candidateActions: string[]): Array<{
	regex: RegExp;
	namespace?: string;
	score: number;
}> {
	const patterns: Array<{ regex: RegExp; namespace?: string; score: number }> =
		[];

	for (const candidateAction of candidateActions) {
		const normalized = normalizeActionName(candidateAction);
		if (!normalized) {
			continue;
		}

		if (candidateAction.includes("*")) {
			patterns.push({
				regex: new RegExp(
					`^${escapeRegex(normalized).replace(/\\\*/g, ".*")}$`,
				),
				namespace: normalized.split("_")[0],
				score: 0.8,
			});
			continue;
		}

		patterns.push({
			regex: new RegExp(`^${escapeRegex(normalized)}$`),
			score: 0.95,
		});

		const [namespace] = normalized.split("_");
		if (namespace && namespace === normalized) {
			patterns.push({
				regex: new RegExp(`^${escapeRegex(namespace)}(?:_|$)`),
				namespace,
				score: 0.8,
			});
		}
	}

	return patterns;
}

function rankScores(scores: Map<string, number>): Map<string, number> {
	const ranked = new Map<string, number>();
	Array.from(scores.entries())
		.filter(([, score]) => score > 0)
		.sort(([leftName, leftScore], [rightName, rightScore]) => {
			return rightScore - leftScore || leftName.localeCompare(rightName);
		})
		.forEach(([name], index) => {
			ranked.set(name, index + 1);
		});
	return ranked;
}

function reciprocalRankFusion(
	stageRankings: Partial<Record<RetrievalStageName, Map<string, number>>>,
	stageWeights?: Partial<Record<RetrievalStageName, number>>,
): Map<string, number> {
	const scores = new Map<string, number>();

	for (const [stageName, ranking] of Object.entries(stageRankings) as Array<
		[RetrievalStageName, Map<string, number> | undefined]
	>) {
		if (!ranking) {
			continue;
		}
		const weight = stageWeights?.[stageName] ?? 1;

		for (const [name, rank] of ranking.entries()) {
			scores.set(name, (scores.get(name) ?? 0) + weight / (RRF_K + rank));
		}
	}

	return scores;
}

function dedupeNormalizedStrings(values: string[] | undefined): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const value of values ?? []) {
		if (typeof value !== "string") {
			continue;
		}

		const trimmed = value.trim();
		const normalized = normalizeActionName(trimmed);
		if (!trimmed || !normalized || seen.has(normalized)) {
			continue;
		}

		seen.add(normalized);
		result.push(trimmed);
	}

	return result;
}

function normalizeTextList(
	value: string | readonly string[] | undefined,
): string[] {
	if (typeof value === "string") {
		return [value];
	}
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function clampScore(value: number): number {
	return roundScore(Math.max(0, Math.min(1, value)));
}

function roundScore(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}
