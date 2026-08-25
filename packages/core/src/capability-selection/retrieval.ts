/**
 * Deterministic capability retrieval over the normalized capability catalog.
 * Given an intent's text, it scores compact catalog entries (id, domain,
 * keywords, summary — never provider/MCP schemas) and returns a bounded,
 * relevance-ranked subset plus prompt-flooding metrics so callers can prove
 * the model context carries only the relevant slice of the catalog. An empty
 * or non-matching intent yields a designed-empty result, never the full
 * catalog. Consumed by the planner-side capability router and by the
 * evaluation harness in `./evaluation`.
 */
import { ElizaError } from "../errors";

/**
 * Normalized, provider-neutral catalog entry. `promptTokenEstimate` is the
 * producer-measured token cost of rendering this capability into model
 * context; it powers the flood-reduction metrics.
 */
export interface CapabilityCatalogEntry {
	capabilityId: string;
	domain: string;
	summary: string;
	keywords: readonly string[];
	operations: readonly string[];
	promptTokenEstimate: number;
}

export interface CapabilityRetrievalMatch {
	entry: CapabilityCatalogEntry;
	score: number;
	rank: number;
	matchedTokens: readonly string[];
}

/**
 * Ambiguity is reported, never silently resolved: when the top two matches
 * come from different domains and their score margin is below the threshold,
 * the caller must disambiguate (clarify or confirm) instead of dispatching.
 */
export interface CapabilityRetrievalAmbiguity {
	ambiguous: boolean;
	margin: number | null;
	contenders: readonly string[];
}

export interface CapabilityRetrievalMetrics {
	catalogSize: number;
	retrievedCount: number;
	catalogPromptTokenEstimate: number;
	retrievedPromptTokenEstimate: number;
	/** retrievedTokens / catalogTokens — lower means less prompt flooding. */
	floodRatio: number;
}

export interface CapabilityRetrievalResult {
	results: readonly CapabilityRetrievalMatch[];
	ambiguity: CapabilityRetrievalAmbiguity;
	metrics: CapabilityRetrievalMetrics;
	queryTokens: readonly string[];
}

export interface RetrieveCapabilitiesInput {
	catalog: readonly CapabilityCatalogEntry[];
	intentText: string;
	/** Maximum entries returned. Defaults to 5; must be a positive integer. */
	limit?: number;
	/** Score margin (relative to the top score) below which cross-domain ties are ambiguous. Defaults to 0.25. */
	ambiguityMargin?: number;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_AMBIGUITY_MARGIN = 0.25;

const KEYWORD_WEIGHT = 3;
const IDENTITY_WEIGHT = 2;
const OPERATION_WEIGHT = 2;
const SUMMARY_WEIGHT = 1;

export function tokenizeCapabilityIntent(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 1);
}

function invalidRetrievalInput(
	message: string,
	context: Record<string, unknown>,
): never {
	throw new ElizaError(message, {
		code: "INVALID_CAPABILITY_RETRIEVAL_INPUT",
		context,
		severity: "fatal",
	});
}

function validateCatalog(catalog: readonly CapabilityCatalogEntry[]): void {
	const seen = new Set<string>();
	for (const entry of catalog) {
		if (entry.capabilityId.trim().length === 0) {
			invalidRetrievalInput(
				"Capability catalog entry has an empty capabilityId.",
				{},
			);
		}
		if (seen.has(entry.capabilityId)) {
			invalidRetrievalInput(
				"Capability catalog contains a duplicate capabilityId.",
				{
					capabilityId: entry.capabilityId,
				},
			);
		}
		seen.add(entry.capabilityId);
		if (
			!Number.isSafeInteger(entry.promptTokenEstimate) ||
			entry.promptTokenEstimate <= 0
		) {
			invalidRetrievalInput(
				"Capability catalog entry promptTokenEstimate must be a positive safe integer.",
				{
					capabilityId: entry.capabilityId,
					promptTokenEstimate: entry.promptTokenEstimate,
				},
			);
		}
	}
}

function scoreEntry(
	entry: CapabilityCatalogEntry,
	queryTokens: readonly string[],
): { score: number; matchedTokens: string[] } {
	const keywordSet = new Set(
		entry.keywords.map((keyword) => keyword.toLowerCase()),
	);
	const identityTokens = new Set([
		...tokenizeCapabilityIntent(entry.capabilityId),
		...tokenizeCapabilityIntent(entry.domain),
	]);
	const operationTokens = new Set(
		entry.operations.flatMap((operation) =>
			tokenizeCapabilityIntent(operation),
		),
	);
	const summaryTokens = new Set(tokenizeCapabilityIntent(entry.summary));

	let score = 0;
	const matchedTokens: string[] = [];
	for (const token of new Set(queryTokens)) {
		let tokenScore = 0;
		if (keywordSet.has(token)) tokenScore += KEYWORD_WEIGHT;
		if (identityTokens.has(token)) tokenScore += IDENTITY_WEIGHT;
		if (operationTokens.has(token)) tokenScore += OPERATION_WEIGHT;
		if (summaryTokens.has(token)) tokenScore += SUMMARY_WEIGHT;
		if (tokenScore > 0) {
			score += tokenScore;
			matchedTokens.push(token);
		}
	}
	return { score, matchedTokens };
}

/**
 * Scores and ranks catalog entries against the intent text. Fully
 * deterministic: identical inputs always produce identical rankings, with
 * `capabilityId` ascending as the final tie-breaker.
 */
export function retrieveCapabilities(
	input: RetrieveCapabilitiesInput,
): CapabilityRetrievalResult {
	const limit = input.limit ?? DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit <= 0) {
		invalidRetrievalInput(
			"Capability retrieval limit must be a positive integer.",
			{ limit },
		);
	}
	const ambiguityMargin = input.ambiguityMargin ?? DEFAULT_AMBIGUITY_MARGIN;
	if (!(ambiguityMargin >= 0 && ambiguityMargin < 1)) {
		invalidRetrievalInput(
			"Capability retrieval ambiguityMargin must be in [0, 1).",
			{
				ambiguityMargin,
			},
		);
	}
	validateCatalog(input.catalog);

	const catalogPromptTokenEstimate = input.catalog.reduce(
		(sum, entry) => sum + entry.promptTokenEstimate,
		0,
	);
	// Per-entry estimates are safe integers, but their sum can still exceed
	// the safe range and corrupt the flood metrics; fail closed instead.
	if (!Number.isSafeInteger(catalogPromptTokenEstimate)) {
		invalidRetrievalInput(
			"Capability catalog aggregate promptTokenEstimate exceeds the safe integer range.",
			{ catalogSize: input.catalog.length },
		);
	}
	const queryTokens = tokenizeCapabilityIntent(input.intentText);

	const scored = input.catalog
		.map((entry) => ({ entry, ...scoreEntry(entry, queryTokens) }))
		.filter((candidate) => candidate.score > 0)
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			// Code-unit comparison keeps the tie-breaker locale-independent.
			if (a.entry.capabilityId === b.entry.capabilityId) return 0;
			return a.entry.capabilityId < b.entry.capabilityId ? -1 : 1;
		})
		.slice(0, limit);

	const results: CapabilityRetrievalMatch[] = scored.map(
		(candidate, index) => ({
			entry: candidate.entry,
			score: candidate.score,
			rank: index + 1,
			matchedTokens: Object.freeze(candidate.matchedTokens.sort()),
		}),
	);

	let ambiguity: CapabilityRetrievalAmbiguity = {
		ambiguous: false,
		margin: null,
		contenders: Object.freeze([]),
	};
	if (results.length >= 2) {
		const [first, second] = results;
		const margin = (first.score - second.score) / first.score;
		if (
			first.entry.domain !== second.entry.domain &&
			margin < ambiguityMargin
		) {
			ambiguity = {
				ambiguous: true,
				margin,
				contenders: Object.freeze([
					first.entry.capabilityId,
					second.entry.capabilityId,
				]),
			};
		} else {
			ambiguity = { ambiguous: false, margin, contenders: Object.freeze([]) };
		}
	}

	const retrievedPromptTokenEstimate = results.reduce(
		(sum, match) => sum + match.entry.promptTokenEstimate,
		0,
	);

	return {
		results: Object.freeze(results),
		ambiguity,
		metrics: {
			catalogSize: input.catalog.length,
			retrievedCount: results.length,
			catalogPromptTokenEstimate,
			retrievedPromptTokenEstimate,
			floodRatio:
				catalogPromptTokenEstimate === 0
					? 0
					: retrievedPromptTokenEstimate / catalogPromptTokenEstimate,
		},
		queryTokens: Object.freeze(queryTokens),
	};
}
