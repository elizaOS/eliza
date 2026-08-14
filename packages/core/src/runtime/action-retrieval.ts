/**
 * Multi-stage action retrieval for the planner: scores catalog parents by
 * exact-hint, candidate-regex, keyword, BM25, embedding tie-breaker, and
 * context-match signals, then fuses the per-stage rankings with reciprocal-rank
 * fusion into a tier-sized candidate set.
 */
import { countActionSearchKeywordMatches } from "../i18n/action-search-keywords";
import { logger } from "../logger";
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
	 * as a filter. Filtering by context masked OWNER_TODOS/CALENDAR/etc. when the
	 * messageHandler routed to "general"; weighting keeps them retrievable
	 * while still preferring on-context candidates when scores are close.
	 */
	selectedContexts?: readonly string[];
	/**
	 * When `true`, capture each stage's full pre-fusion output and emit it
	 * in `response.measurement`. Default `false` — no allocation cost in
	 * production. Toggle via the `ELIZA_RETRIEVAL_MEASUREMENT=1` env var
	 * on the caller side.
	 */
	measurementMode?: boolean;
	/**
	 * Optional per-tier overrides for retrieval. When provided, the call
	 * uses these instead of the in-file constants. Wired by the external benchmark
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
 * Per-tier retrieval defaults inlined in core so the runtime never takes a
 * dep on the benchmark tooling. Kept in sync by hand with
 * `retrieval-defaults.ts` in https://github.com/elizaOS/benchmarks — the
 * benchmark repo is the source of truth (it's where the Pareto sweep emits
 * recommended values). If the two drift, fix this file from that copy.
 */
const RETRIEVAL_TIER_DEFAULTS: Record<
	"small" | "mid" | "large" | "frontier",
	{ topK: number; stageWeights: Partial<Record<RetrievalStageName, number>> }
> = {
	small: {
		// measured: K=5 saturates (W6-G2 Pareto 2026-05-11; heuristic was 5)
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
		// measured: K=5 saturates at 0.98 recall (heuristic was 8)
		topK: 6,
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
		// measured: K=5 saturates at 0.98 recall (heuristic was 12)
		topK: 8,
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
		// measured: K=5 saturates at 0.98 recall (heuristic was 20)
		topK: 12,
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
// When `ELIZA_PROMPT_COMPRESS=1` is set we trade retrieval breadth for a
// tighter token budget on the available-actions block.
const COMPRESS_MODE_TOP_K_CAP = 8;
// A candidate name can hint MORE than one parent when the phrasing is genuinely
// ambiguous between surfaces. "OPEN_APP" can mean the apps *page* (VIEWS) or
// launching the application itself (APP) — hint both and let the planner
// arbitrate from the exposed descriptions (#9950).
const CANDIDATE_ACTION_PARENT_ALIASES: Record<string, readonly string[]> = {
	ADD_GOAL: ["OWNER_GOALS"],
	// Habit/reminder-shaped candidates hint BOTH the owner-life umbrella and the
	// always-registered TRIGGER scheduler. Stage-1 routinely invents these names
	// ("can u help me to brush my teeth everyday" → SET_HABIT), and on
	// deployments without @elizaos/plugin-personal-assistant the OWNER_* similes
	// resolve to nothing — the candidate narrow then demoted the retrieved
	// TRIGGER_* actions off the planner surface entirely, leaving only
	// PAGE_DELEGATE guesses ("CREATE_HABIT is not available on the owner page"
	// x4, live trajectory tj-9e6b825e91d725). With the TRIGGER hint the only
	// real scheduled-work capability stays exposed; on full deployments the
	// owner umbrella is also kept and its de-claim description still routes new
	// habits to OWNER_ROUTINES_CREATE (#10722).
	ADD_HABIT: ["OWNER_ROUTINES", "TRIGGER"],
	ADD_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	CONFIRM_GOAL: ["OWNER_GOALS"],
	CREATE_HABIT: ["OWNER_ROUTINES", "TRIGGER"],
	CREATE_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	CREATE_ROUTINE: ["OWNER_ROUTINES", "TRIGGER"],
	DAILY_HABIT: ["OWNER_ROUTINES", "TRIGGER"],
	DAILY_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	HABIT_CREATE: ["OWNER_ROUTINES", "TRIGGER"],
	NEW_HABIT: ["OWNER_ROUTINES", "TRIGGER"],
	NEW_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	RECURRING_REMINDER: ["OWNER_REMINDERS", "TRIGGER"],
	REMINDER_CREATE: ["OWNER_REMINDERS", "TRIGGER"],
	SAVE_HABIT: ["OWNER_ROUTINES", "TRIGGER"],
	SET_HABIT: ["OWNER_ROUTINES", "TRIGGER"],
	TRACK_HABIT: ["OWNER_ROUTINES", "TRIGGER"],
	CROSS_CHANNEL_SEARCH: ["MESSAGE"],
	CREATE_GOAL: ["OWNER_GOALS"],
	CREATE_SAVINGS_PLAN: ["OWNER_GOALS"],
	GOAL_CREATE: ["OWNER_GOALS"],
	GOAL_SAVE: ["OWNER_GOALS"],
	GOALS_CREATE: ["OWNER_GOALS"],
	GOALS_SAVE: ["OWNER_GOALS"],
	SEARCH_EMAIL: ["MESSAGE"],
	SEARCH_INBOX: ["MESSAGE"],
	SEARCH_MESSAGES: ["MESSAGE"],
	SAVE_GOAL: ["OWNER_GOALS"],
	SAVE_MONEY_FOR_TRIP: ["OWNER_GOALS"],
	SAVINGS_PLAN: ["OWNER_GOALS"],
	MESSAGE_SEARCH: ["MESSAGE"],
	TRAVEL_SAVINGS_PLAN: ["OWNER_GOALS"],
	TRIP_SAVINGS_PLAN: ["OWNER_GOALS"],
	SEARCH_CHATS: ["MESSAGE"],
	SEARCH_CHAT: ["MESSAGE"],
	FIND_MESSAGES: ["MESSAGE"],
	FIND_MESSAGE: ["MESSAGE"],
	ARRANGE_VIEWS: ["VIEWS"],
	CLOSE_ALL_VIEWS: ["VIEWS"],
	CLOSE_VIEW: ["VIEWS"],
	LIST_VIEWS: ["VIEWS"],
	OPEN_APP: ["VIEWS", "APP"],
	OPEN_APPLICATION: ["VIEWS", "APP"],
	OPEN_VIEW: ["VIEWS"],
	SHOW_APP: ["VIEWS", "APP"],
	SHOW_APPLICATION: ["VIEWS", "APP"],
	SHOW_VIEW: ["VIEWS"],
	SPLIT_VIEW: ["VIEWS"],
	SPLIT_VIEWS: ["VIEWS"],
	SWITCH_VIEW: ["VIEWS"],
	TILE_VIEWS: ["VIEWS"],
	VIEW_MANAGER: ["VIEWS"],
};

const VIEW_SURFACE_TOKENS = new Set([
	"VIEW",
	"VIEWS",
	"WINDOW",
	"WINDOWS",
	"PANEL",
	"PANELS",
	"APP",
	"APPS",
	"APPLICATION",
	"APPLICATIONS",
	"PLUGIN",
	"PLUGINS",
]);

const VIEW_OPERATION_TOKENS = new Set([
	"ADD",
	"ARRANGE",
	"CLOSE",
	"CREATE",
	"DELETE",
	"DISMISS",
	"GET",
	"GO",
	"HIDE",
	"LAYOUT",
	"LIST",
	"MANAGER",
	"NAVIGATE",
	"OPEN",
	"PIN",
	"READ",
	"REMOVE",
	"SELECT",
	"SET",
	"SHOW",
	"SPLIT",
	"SWITCH",
	"TILE",
	"UPDATE",
]);

function resolveTierOverridesFromEnv():
	| { topK: number; stageWeights: Partial<Record<RetrievalStageName, number>> }
	| undefined {
	const raw =
		typeof process !== "undefined" ? process.env.MODEL_TIER?.trim() : undefined;
	const compress =
		typeof process !== "undefined" && process.env.ELIZA_PROMPT_COMPRESS === "1";
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
	const catalogParentNames = new Set(
		input.catalog.parents.map((parent) => parent.normalizedName),
	);
	const parentActionHints = dedupeNormalizedStrings([
		...(input.parentActionHints ?? []),
		// A Stage-1 candidate that names an exposed parent is already an exact
		// catalog reference. Preserve that signal instead of forcing it through
		// fuzzy retrieval, where unrelated keyword-heavy parents can outrank it.
		...candidateActions.filter((actionName) =>
			catalogParentNames.has(normalizeActionName(actionName)),
		),
		...candidateActions.flatMap((actionName) =>
			candidateNamespaceParentExists(input.catalog.parents, actionName)
				? []
				: parentAliasesForCandidateAction(actionName),
		),
		// Stage-1 routinely hints an action by one of its similes — the canonical
		// documented example is candidateActions=["BASH"] for the SHELL parent
		// (message-handler.ts). Similes feed the fuzzy search text but carry no
		// rank guarantee, so a simile hint can lose the surface cut to unrelated
		// keyword matches and reach the planner as a dead hint (it then improvises
		// with whatever tools did rank, or falsely reports missing tool access).
		// Resolve simile hints to their catalog parent so they exact-score like
		// any explicit parent hint.
		...resolveSimileParentHints(input.catalog.parents, candidateActions),
	]);
	const recentConversationText = shouldUseRecentConversationForActionSearch(
		input.messageText ?? "",
	)
		? normalizeTextList(input.recentConversationText)
		: [];
	const candidateActionsForSearch =
		recentConversationText.length > 0
			? candidateActions.filter(
					(actionName) =>
						parentAliasesForCandidateAction(actionName).length > 0,
				)
			: candidateActions;
	const queryText = [
		input.messageText ?? "",
		...recentConversationText,
		...candidateActionsForSearch,
	].join("\n");
	const queryTokens = tokenizeActionSearchText(queryText);
	const keywordQueryTexts = [
		input.messageText ?? "",
		...recentConversationText,
		...candidateActionsForSearch,
	].filter((text) => text.trim().length > 0);
	const exactScores = scoreExactHints(input.catalog.parents, parentActionHints);
	const regexScores = scoreCandidateRegex(
		input.catalog.parents,
		candidateActionsForSearch,
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
		// (e.g. OWNER_ROUTINES vs BLOCK both keyword-match "every day" — context
		// says the user is in tasks/general, so OWNER_ROUTINES wins). Context alone is not a
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

	// Evidence this parent earned from the MESSAGE rather than from Stage-1's
	// hint. `exact` and `regex` are both computed from `candidateActions`, so
	// they only say "Stage-1 named me"; keyword/bm25/embedding/contextMatch say
	// "the user's words and this turn's context point here".
	const independentEvidence = (result: {
		stageScores: ActionRetrievalResult["stageScores"];
	}): number =>
		(result.stageScores.keyword ?? 0) +
		(result.stageScores.bm25 ?? 0) +
		(result.stageScores.embedding ?? 0) +
		(result.stageScores.contextMatch ?? 0);

	results.sort((left, right) => {
		return (
			right.score - left.score ||
			// Both saturated at the ceiling. An exact hint is a FLOOR — it keeps a
			// named parent from losing to fuzzy noise (#18948: OWNER_REMINDERS lost
			// to CALENDAR on "remind me in 2 minutes to stretch") — but it must not
			// also win ties, or a WRONG Stage-1 guess outranks a genuine match, as
			// candidate VIEWS did to WEB_FETCH on "weather in tokyo". When
			// confidence is equal, prefer the parent the message itself points at.
			independentEvidence(right) - independentEvidence(left) ||
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
	return String(text)
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

interface ParentScoringTokens {
	tokens: string[];
	length: number;
	set: Set<string>;
	termFrequency: Map<string, number>;
}

// Per-catalog-parent scoring tokens, memoized by the parent object. The parent's
// searchText is static, so tokenization + the term-frequency map are pure
// functions of it. Keyed by object identity in a WeakMap so it's recomputed only
// when the catalog rebuilds (new parent objects) and auto-collected when the
// catalog is dropped. The returned termFrequency map is read-only at the call
// sites, so sharing it across calls is safe.
const parentScoringCache = new WeakMap<
	ActionCatalogParent,
	ParentScoringTokens
>();

function getParentScoringTokens(
	parent: ActionCatalogParent,
): ParentScoringTokens {
	const cached = parentScoringCache.get(parent);
	if (cached) {
		return cached;
	}
	const tokens = tokenizeActionSearchText(parent.searchText);
	const termFrequency = new Map<string, number>();
	for (const token of tokens) {
		termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
	}
	const computed: ParentScoringTokens = {
		tokens,
		length: tokens.length,
		set: new Set(tokens),
		termFrequency,
	};
	parentScoringCache.set(parent, computed);
	return computed;
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
		scoring: getParentScoringTokens(parent),
	}));
	const averageDocumentLength =
		documents.reduce((sum, document) => sum + document.scoring.length, 0) /
		Math.max(1, documents.length);
	const documentFrequency = new Map<string, number>();
	const queryVocabulary = Array.from(new Set(queryTokens));

	for (const token of queryVocabulary) {
		let count = 0;
		for (const document of documents) {
			if (document.scoring.set.has(token)) {
				count += 1;
			}
		}
		documentFrequency.set(token, count);
	}

	for (const document of documents) {
		const { termFrequency, length: documentLength } = document.scoring;

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
						BM25_B * (documentLength / Math.max(1, averageDocumentLength)));
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

export function parentAliasesForCandidateAction(actionName: string): string[] {
	const normalized = normalizeActionName(actionName);
	const explicit = CANDIDATE_ACTION_PARENT_ALIASES[normalized];
	if (explicit) {
		return [...explicit];
	}
	// Permission/access management is SETTINGS (grant/revoke an app's fs/net
	// namespace, OS permission requests, shell access) — never view navigation.
	// Checked before the view/app surface heuristics because Stage-1 invents
	// names like SET_APP_NETWORK_PERMISSION / REVOKE_NETWORK_ACCESS whose SET+APP
	// tokens otherwise trip looksLikeViewCandidateAction and route the write to
	// the VIEWS catalog, so "revoke network access for the weather app" never
	// reaches the SETTINGS writer (#14622).
	if (looksLikeSettingsPermissionCandidateAction(normalized)) {
		return ["SETTINGS"];
	}
	const aliases: string[] = [];
	if (looksLikeViewCandidateAction(normalized)) {
		aliases.push("VIEWS");
	}
	// App-operation candidates (LIST_APPS, GET_INSTALLED_APPS, LAUNCH_APP, …)
	// hint the APP parent alongside any views hint: Stage-1 models routinely
	// describe an installed-apps request with such names, and without this hint
	// the VIEWS token overlap (APP/APPS are also view-surface words) routed
	// every app ask to the views catalog (#9950).
	if (looksLikeAppCandidateAction(normalized) && !aliases.includes("APP")) {
		aliases.push("APP");
	}
	return aliases;
}

const APP_SURFACE_TOKENS = new Set([
	"APP",
	"APPS",
	"APPLICATION",
	"APPLICATIONS",
]);

const APP_OPERATION_TOKENS = new Set([
	"BUILD",
	"CREATE",
	"GET",
	"INSTALL",
	"INSTALLED",
	"LAUNCH",
	"LIST",
	"OPEN",
	"REGISTER",
	"RELAUNCH",
	"RESTART",
	"RUN",
	"RUNNING",
	"SCAFFOLD",
	"SHOW",
	"START",
	"STOP",
]);

function looksLikeAppCandidateAction(normalizedActionName: string): boolean {
	if (!normalizedActionName) return false;
	const tokens = new Set(normalizedActionName.split(/_+/).filter(Boolean));
	return (
		hasAnyToken(tokens, APP_SURFACE_TOKENS) &&
		hasAnyToken(tokens, APP_OPERATION_TOKENS)
	);
}

// A permission namespace/surface must accompany a bare ACCESS token before it
// counts as a settings-permission ask: this keeps "REVOKE_NETWORK_ACCESS" /
// "GRANT_FILESYSTEM_ACCESS" / "REVOKE_SHELL_ACCESS" (permission writes SETTINGS
// owns) mapping to SETTINGS while leaving a person-scoped "REVOKE_ACCESS" (which
// is BLOCK, not a settings write) untouched.
const SETTINGS_PERMISSION_NAMESPACE_TOKENS = new Set([
	"APP",
	"APPS",
	"CAMERA",
	"FILESYSTEM",
	"FS",
	"LOCATION",
	"MIC",
	"MICROPHONE",
	"NET",
	"NETWORK",
	"NOTIFICATION",
	"NOTIFICATIONS",
	"SCREEN",
	"SHELL",
]);

const SETTINGS_PERMISSION_OPERATION_TOKENS = new Set([
	"ALLOW",
	"CHANGE",
	"DENY",
	"DISABLE",
	"ENABLE",
	"GRANT",
	"REQUEST",
	"REVOKE",
	"SET",
	"TOGGLE",
	"TURN",
	"UPDATE",
]);

function looksLikeSettingsPermissionCandidateAction(
	normalizedActionName: string,
): boolean {
	if (!normalizedActionName) return false;
	const tokens = new Set(normalizedActionName.split(/_+/).filter(Boolean));
	if (!hasAnyToken(tokens, SETTINGS_PERMISSION_OPERATION_TOKENS)) return false;
	const namesAPermission =
		tokens.has("PERMISSION") || tokens.has("PERMISSIONS");
	const namesAScopedAccess =
		tokens.has("ACCESS") &&
		hasAnyToken(tokens, SETTINGS_PERMISSION_NAMESPACE_TOKENS);
	return namesAPermission || namesAScopedAccess;
}

function looksLikeViewCandidateAction(normalizedActionName: string): boolean {
	if (!normalizedActionName) return false;
	const tokens = new Set(normalizedActionName.split(/_+/).filter(Boolean));
	const hasViewSurface = hasAnyToken(tokens, VIEW_SURFACE_TOKENS);
	const hasViewOperation = hasAnyToken(tokens, VIEW_OPERATION_TOKENS);
	const hasGeneratedCapabilityShape =
		hasViewOperation && tokens.size >= 2 && !hasOnlyOperationTokens(tokens);
	return hasViewOperation && (hasViewSurface || hasGeneratedCapabilityShape);
}

function hasAnyToken(tokens: Set<string>, expected: Set<string>): boolean {
	for (const token of tokens) {
		if (expected.has(token)) return true;
	}
	return false;
}

function hasOnlyOperationTokens(tokens: Set<string>): boolean {
	for (const token of tokens) {
		if (!VIEW_OPERATION_TOKENS.has(token)) return false;
	}
	return true;
}

/** Once-per-process dedupe for the ambiguous-simile warn — the resolver runs
 *  on every retrieval and the catalog is stable within a process. */
const warnedAmbiguousSimiles = new Set<string>();

function resolveSimileParentHints(
	parents: readonly ActionCatalogParent[],
	candidateActions: readonly string[],
): string[] {
	if (candidateActions.length === 0) {
		return [];
	}
	const parentNames = new Set(parents.map((parent) => parent.normalizedName));
	const parentBySimile = new Map<string, string>();
	// A simile claimed by MORE than one parent is ambiguous and must not route
	// at all (#16561): first-writer-wins silently steals the intent from the
	// other parent (catalog order is alphabetical, not semantic — e.g. a
	// LIST_FILES simile on both a file-ops action and a stored-media action).
	// The warn dedupes per process: this resolver runs on every retrieval.
	const ambiguousSimiles = new Set<string>();
	for (const parent of parents) {
		const ownSimiles = new Set(
			[
				...parent.similes,
				...parent.children.flatMap((child) => child.similes),
			].flatMap((simile) => {
				const normalized = normalizeActionName(simile);
				// A simile that collides with a real parent name must not hijack it.
				return !normalized || parentNames.has(normalized) ? [] : [normalized];
			}),
		);
		for (const normalized of ownSimiles) {
			const claimedBy = parentBySimile.get(normalized);
			if (claimedBy !== undefined && claimedBy !== parent.normalizedName) {
				if (!warnedAmbiguousSimiles.has(normalized)) {
					warnedAmbiguousSimiles.add(normalized);
					logger.warn(
						{
							src: "action-retrieval",
							simile: normalized,
							parents: [claimedBy, parent.normalizedName],
						},
						"simile claimed by multiple parents — dropped from routing as ambiguous",
					);
				}
				ambiguousSimiles.add(normalized);
				continue;
			}
			parentBySimile.set(normalized, parent.normalizedName);
		}
	}
	for (const normalized of ambiguousSimiles) {
		parentBySimile.delete(normalized);
	}
	return candidateActions.flatMap((actionName) => {
		if (parentNames.has(actionName)) {
			return [];
		}
		const parent = parentBySimile.get(actionName);
		return parent ? [parent] : [];
	});
}

export function candidateNamespaceParentExists(
	parents: readonly Pick<ActionCatalogParent, "normalizedName">[],
	actionName: string,
): boolean {
	const normalized = normalizeActionName(actionName);
	const tokens = normalized.split("_").filter(Boolean);
	if (
		tokens.length < 2 ||
		normalized === "VIEWS" ||
		hasAnyToken(new Set(tokens), VIEW_SURFACE_TOKENS)
	) {
		return false;
	}
	const domainTokens = tokens.filter(
		(token) => !VIEW_OPERATION_TOKENS.has(token) && token !== "VIEWS",
	);
	return parents.some((parent) =>
		domainTokens.some((token) => actionTokenMatchesParent(token, parent)),
	);
}

function actionTokenMatchesParent(
	token: string,
	parent: Pick<ActionCatalogParent, "normalizedName">,
): boolean {
	const parentName = parent.normalizedName;
	return (
		parentName === token ||
		parentName === `${token}S` ||
		(parentName.endsWith("S") && parentName.slice(0, -1) === token)
	);
}

function shouldUseRecentConversationForActionSearch(
	messageText: string,
): boolean {
	const normalized = messageText.toLowerCase().replace(/\s+/g, " ").trim();
	if (!normalized) return false;
	return (
		/\b(?:again|continue|redo|rerun|retry|same|another\s+one|one\s+more|also|too)\b/iu.test(
			normalized,
		) ||
		/\b(?:do|run|make|build|check|try|send|show|open|fix|update|use|add|remove|delete|change|repeat)\b[\s\S]{0,80}\b(?:it|that|this|these|those|them|there|above|previous|last|same|one)\b/iu.test(
			normalized,
		)
	);
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
